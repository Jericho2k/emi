import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouter, ProviderError } from "../src/llm/openrouter";
import { LlmResponseError } from "../src/llm/provider";

const messages = [{ role: "user" as const, content: "hi" }];
const completion = (content: unknown, extra: Record<string, unknown> = {}) => ({
  id: "test-request", model: "test-model", choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.01 }, ...extra,
});
const response = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "test-web-request", model: "test-model", status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 30, output_tokens: 40, cost: 0.02 }, ...extra,
});
function network(...bodies: unknown[]) {
  const fetch = vi.fn();
  for (const body of bodies) fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const payload = (fetch: ReturnType<typeof network>, index = 0) => JSON.parse(fetch.mock.calls[index]![1].body);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("OpenRouter reply recovery", () => {
  it("recovers from a reasoning-only response without exposing thinking and accounts for both attempts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = network(completion(null, {
      choices: [{ message: { content: null, reasoning: "PRIVATE THINKING" }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 500 }, cost: 0.01 },
    }), completion("hey"));
    const result = await openRouter("private-api-key").chat(messages, { model: "test-model", maxTokens: 500 });
    expect(result.text).toBe("hey");
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 520, costUsd: 0.02 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(payload(fetch).max_tokens).toBeGreaterThan(500);
    expect(payload(fetch, 1).max_tokens).toBeGreaterThan(payload(fetch).max_tokens);
    expect(payload(fetch).reasoning).toEqual({ effort: "low", exclude: true });
    expect(JSON.stringify(warn.mock.calls)).toContain("reasoning_tokens=500");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/PRIVATE THINKING|private-api-key/);
  });

  it("bounds empty-answer recovery and returns useful metadata and billed usage", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = network(completion(""), completion(""));
    await expect(openRouter("key").chat(messages, { model: "test-model" })).rejects.toMatchObject({
      name: "LlmResponseError", message: expect.stringContaining("request=test-request"), usage: { inputTokens: 20, outputTokens: 40, costUsd: 0.02, model: "test-model" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts typed text parts while ignoring reasoning parts", async () => {
    network(completion([{ type: "reasoning", text: "hidden" }, { type: "text", text: "visible" }]));
    expect((await openRouter("key").chat(messages, { model: "test-model" })).text).toBe("visible");
  });

  it("retries truncated or malformed extraction JSON instead of treating it as an empty extraction", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = network(completion('{"memories":'), completion('{"memories":[]}'));
    expect((await openRouter("key").chat(messages, { model: "test-model", json: true, web: true })).text).toBe('{"memories":[]}');
    expect(payload(fetch).response_format).toEqual({ type: "json_object" });
    expect(payload(fetch).tools).toBeUndefined();
  });

  it("does not retry refusals or reinterpret them as reasoning", async () => {
    const fetch = network(completion(null, { choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: "stop" }] }));
    expect((await openRouter("key").chat(messages, { model: "test-model" })).text).toBe("I can't help with that.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry rejected keys", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(openRouter("key").chat(messages, { model: "test-model" })).rejects.toBeInstanceOf(ProviderError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains earlier billed usage if the recovery request fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = network(completion(""));
    fetch.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    await expect(openRouter("key").chat(messages, { model: "test-model" })).rejects.toMatchObject({ kind: "request_failed", usage: expect.objectContaining({ costUsd: 0.01 }) });
  });
});

describe("OpenRouter read-only web tools", () => {
  it("offers search and fetch with a bounded budget, preserves history, and parses final-answer citations", async () => {
    const fetch = network(response("current answer", {
      output: [
        { type: "reasoning", content: [{ type: "text", text: "hidden" }] },
        { type: "web_search_call", status: "completed" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "current answer", annotations: [
          { type: "url_citation", url: "https://example.com/news", title: "News" },
          { type: "url_citation", url: "javascript:alert(1)", title: "bad" },
        ] }] },
      ],
    }));
    const result = await openRouter("key").chat(messages, { model: "test-model", web: true });
    expect(fetch.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/responses");
    expect(payload(fetch).input).toEqual(messages);
    expect(payload(fetch).max_tool_calls).toBe(4);
    expect(payload(fetch).tools.map((t: { type: string }) => t.type)).toEqual(["openrouter:web_search", "openrouter:web_fetch"]);
    expect(payload(fetch).tools[0].parameters).toMatchObject({ max_uses: 2, max_results: 3 });
    expect(payload(fetch).tools[1].parameters).toMatchObject({ max_uses: 2, max_content_tokens: 6000 });
    expect(result).toMatchObject({ text: "current answer", usage: { inputTokens: 30, outputTokens: 40, costUsd: 0.02 }, citations: [{ title: "News", url: "https://example.com/news" }] });
    expect(result.text).not.toContain("hidden");
  });

  it("does not enable web on utility calls or when explicitly disabled", async () => {
    const fetch = network(completion("ok"), completion("ok"));
    const llm = openRouter("key", { webEnabled: false });
    expect(llm.capabilities?.web).toBe(false);
    await llm.chat(messages, { model: "test-model", web: true });
    await openRouter("key").chat(messages, { model: "utility" });
    expect(payload(fetch).tools).toBeUndefined();
    expect(payload(fetch, 1).tools).toBeUndefined();
  });

  it("recovers incomplete web responses without leaking intermediate outputs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = network(response("", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", content: [{ text: "hidden" }] }] }), response("answer"));
    const result = await openRouter("key").chat(messages, { model: "test-model", web: true });
    expect(result.text).toBe("answer");
    expect(result.usage.costUsd).toBe(0.04);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports tool/model permission failures without calling a working key invalid or silently guessing offline", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("tool blocked", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(openRouter("key").chat(messages, { model: "test-model", web: true })).rejects.toMatchObject({ kind: "web_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not automatically replay potentially billed web work after an ambiguous network failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection lost"));
    vi.stubGlobal("fetch", fetch);
    await expect(openRouter("key").chat(messages, { model: "test-model", web: true })).rejects.toThrow("connection lost");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
