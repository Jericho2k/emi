import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { toTelegramHtml } from "../src/channels/telegram-format";
import { pendingItems } from "../src/core/agenda/store";
import { runExtraction } from "../src/core/extraction";
import { handleTurn } from "../src/core/pipeline";
import { addMessage, getUser, recentMessages, spentToday } from "../src/core/users";
import { attachSources } from "../src/core/web";
import { openRouter } from "../src/llm/openrouter";
import { byModel, fakeEmbedding, world } from "./helpers";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function client() {
  const llm = openRouter("test-key");
  llm.embed = async (texts, model) => ({ vectors: texts.map(fakeEmbedding), usage: { model, inputTokens: 0, outputTokens: 0, costUsd: 0 } });
  return llm;
}

describe("web-grounded conversation", () => {
  it("passes a link and full conversation to the web-capable writer and persists clickable sources", async () => {
    const w = await world();
    const user = await w.newUser();
    await addMessage(w.db, { userId: user.id, role: "user", content: "I care about the release date", at: w.now });
    w.deps.llmFor = () => client();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "web-test", status: "completed", model: "writer", usage: { input_tokens: 10, output_tokens: 20, cost: 0.025 },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "It was released today.", annotations: [{ type: "url_citation", url: "https://example.com/release", title: "Release announcement" }] }] }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const result = await handleTurn(w.deps, user.id, "read https://example.com/release and tell me when it was released");
    const request = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(request.input.map((m: { content: string }) => m.content).join("\n")).toContain("I care about the release date");
    expect(request.input.at(-1).content).toContain("https://example.com/release");
    expect(request.input[0].content).toContain("Web search and page-reading tools are available");
    expect(request.input[0].content).toContain("untrusted source material");
    expect(request.input[0].content).toContain("Keep your usual voice");
    expect(result.bubbles.join("\n")).toContain("[example.com](https://example.com/release)");
    expect(toTelegramHtml(result.bubbles.join("\n"))).toContain('<a href="https://example.com/release">example.com</a>');
    expect((await recentMessages(w.db, user.id, 1))[0]!.content).toContain("https://example.com/release");
    expect(await spentToday(w.db, user, w.now)).toBe(0.025);
  });

  it("keeps failures recoverable, accounts for empty generations and marks the notice as app-generated", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await world();
    const user = await w.newUser();
    w.deps.llmFor = () => client();
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      id: "empty-test", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [],
      usage: { input_tokens: 10, output_tokens: 500, cost: 0.01 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const result = await handleTurn(w.deps, user.id, "what's new today?");
    expect(result.problem).toBe("model_unavailable");
    expect(result.bubbles[0]).toContain("usable answer");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await spentToday(w.db, user, w.now)).toBe(0.02);
    const history = await recentMessages(w.db, user.id, 10);
    expect(history[0]!.content).toBe("what's new today?");
    expect(history.at(-1)!.kind).toBe("command");
  });

  it("leaves failed extraction unread for a later retry instead of silently losing memories", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await world();
    const user = await w.newUser();
    await addMessage(w.db, { userId: user.id, role: "user", content: "my sister is called Anna", at: w.now });
    w.deps.llmFor = () => client();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 1500, cost: 0.01 },
    }), { status: 200 })));
    expect(await runExtraction(w.deps, user.id)).toBeNull();
    expect((await getUser(w.db, user.id))!.extractedThrough).toBe(0);
    expect(await spentToday(w.db, user, w.now)).toBe(0.02);
    const calls = vi.mocked(fetch).mock.calls.length;
    w.advance(30_000);
    await runExtraction(w.deps, user.id);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
    w.advance(31_000);
    await runExtraction(w.deps, user.id);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls + 2);
  });

  it("does not turn an immediate command experiment into a durable agenda follow-up", async () => {
    const w = await world();
    const user = await w.newUser();
    const text = "I'll try /agenda after this message, tell me whether you can see it";
    await handleTurn(w.deps, user.id, text);
    w.script = byModel({ utility: JSON.stringify({ agenda: [{ kind: "followup", about: "whether Emi sees the /agenda command", importance: 1, when: null, evidence: text }] }) });
    expect((await runExtraction(w.deps, user.id))!.agendaCreated).toBe(0);
    expect(await pendingItems(w.db, user.id)).toHaveLength(0);
  });
});

describe("source delivery", () => {
  it("adds nothing when the reply already links its own sources", () => {
    const bubbles = ["Here: [A](https://example.com/a)", "more"];
    expect(attachSources(bubbles, [{ url: "https://example.com/a", title: "A" }, { url: "https://other.example/b", title: "B" }])).toEqual(bubbles);
  });

  it("otherwise adds up to three safe, unique sources by site name, never by page title", () => {
    const result = attachSources(["BTC is around 68k", "down today"], [
      { url: "https://www.example.com/b(x)", title: "[B]\n<script>" },
      { url: "https://www.example.com/b(x)", title: "duplicate" },
      { url: "javascript:alert(1)", title: "unsafe" },
      { url: "https://news.example.org/1", title: "Unrelated headline that was only searched" },
      { url: "https://three.example/1", title: "3" },
      { url: "https://four.example/1", title: "4" },
    ]);
    expect(result[0]).toBe("BTC is around 68k");
    expect(result[1]).toBe("down today\n\n[example.com](https://www.example.com/b%28x%29) · [news.example.org](https://news.example.org/1) · [three.example](https://three.example/1)");
    expect(toTelegramHtml('[source](https://example.com/?q="test")')).toContain('href="https://example.com/?q=&quot;test&quot;"');
  });

  it("configures web explicitly without interpreting the string false as truthy", () => {
    const env = { TELEGRAM_BOT_TOKEN: "123456:token", DATABASE_URL: "postgres://localhost/test", EMI_MASTER_KEY: Buffer.alloc(32, 1).toString("base64") };
    expect(loadConfig(env).webEnabled).toBe(true);
    expect(loadConfig({ ...env, EMI_WEB_ENABLED: "false" }).webEnabled).toBe(false);
    expect(() => loadConfig({ ...env, EMI_WEB_ENABLED: "yes" })).toThrow("EMI_WEB_ENABLED");
  });
});
