import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { telegramImages } from "../src/channels/telegram-images";
import { loadConfig } from "../src/config";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4mQAAAAASUVORK5CYII=", "base64");
const token = "123456:PRIVATE_SECRET";
const message: Message.PhotoMessage = { message_id: 1, date: 1, chat: { id: 1, type: "private", first_name: "Sam" }, photo: [{ file_id: "private-file-id", file_unique_id: "x", width: 100, height: 100 }] };
const api = (getFile: ReturnType<typeof vi.fn>) => ({ getFile }) as unknown as Pick<Api, "getFile">;
const run = (getFile = vi.fn().mockResolvedValue({ file_path: "photos/file.jpg" })) => telegramImages(api(getFile), token, message, { text: "look at these" });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Telegram image retrieval recovery", () => {
  it("recovers a transient metadata failure before giving up on the album", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getFile = vi.fn().mockRejectedValueOnce(Object.assign(new Error("private detail"), { cause: { code: "ENETUNREACH" } })).mockResolvedValueOnce({ file_path: "photos/file.png" });
    const fetch = vi.fn().mockResolvedValue(new Response(png));
    vi.stubGlobal("fetch", fetch);
    expect((await run(getFile)).images).toHaveLength(1);
    expect(getFile).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("[telegram:image]", expect.objectContaining({ stage: "get_file", code: "ENETUNREACH", attempt: 1, retry: true }));
    expect(fetch.mock.calls[0]![1].dispatcher).toBeDefined();
  });

  it("refreshes a stale file path after HTTP 404 and retries the current file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getFile = vi.fn().mockResolvedValueOnce({ file_path: "photos/expired.png" }).mockResolvedValueOnce({ file_path: "photos/fresh.png" });
    const fetch = vi.fn().mockResolvedValueOnce(new Response("missing", { status: 404 })).mockResolvedValueOnce(new Response(png));
    vi.stubGlobal("fetch", fetch);
    expect((await run(getFile)).images).toHaveLength(1);
    expect(fetch.mock.calls[1]![0]).toContain("photos/fresh.png");
    expect(warn).toHaveBeenCalledWith("[telegram:image]", expect.objectContaining({ stage: "download", status: 404, retry: true }));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/PRIVATE_SECRET|expired|fresh|private-file-id/);
  });

  it("bounds repeated server failures and exposes stage/status without raw response text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn().mockImplementation(async () => new Response(`PRIVATE BODY ${token}`, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(run()).rejects.toThrow("download problem on my side");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith("[telegram:image]", expect.objectContaining({ stage: "download", status: 503, attempt: 2, retry: false }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
  });

  it("follows a bounded Telegram-only file redirect", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: `/file/bot${token}/photos/new.png` } })).mockResolvedValueOnce(new Response(png));
    vi.stubGlobal("fetch", fetch);
    expect((await run()).images).toHaveLength(1);
    expect(fetch.mock.calls[1]![0]).toBe(`https://api.telegram.org/file/bot${token}/photos/new.png`);
    expect(fetch.mock.calls.every(([, options]) => options.redirect === "manual")).toBe(true);
  });

  it("never forwards the bot URL to another host or downgrades it to HTTP", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const location of [`https://evil.example/file/bot${token}/image`, `http://api.telegram.org/file/bot${token}/image`, "https://api.telegram.org/other-path"]) {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
      vi.stubGlobal("fetch", fetch);
      const error = await run().catch((error: Error) => error);
      expect(String(error)).not.toContain(token);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
    expect(warn).toHaveBeenLastCalledWith("[telegram:image]", expect.objectContaining({ stage: "redirect", code: "UNSAFE_REDIRECT", retry: false }));
  });

  it("logs missing metadata paths precisely, without asking the model to guess from missing pixels", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(run(vi.fn().mockResolvedValue({}))).rejects.toThrow("download problem");
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[telegram:image]", expect.objectContaining({ stage: "file_path", code: "INVALID_FILE_PATH", retry: false }));
  });

  it("encodes legitimate filenames without allowing path traversal or query injection", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(png));
    vi.stubGlobal("fetch", fetch);
    await run(vi.fn().mockResolvedValue({ file_path: "documents/my photo #1.png" }));
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(url.pathname).toContain("my%20photo%20%231.png");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(run(vi.fn().mockResolvedValue({ file_path: "photos/../private" }))).rejects.toThrow("download problem");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry permanent API/HTTP errors, certificate failures or long rate limits", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const getFile = vi.fn().mockRejectedValue({ error_code: 400, description: `PRIVATE ${token}` });
    await expect(run(getFile)).rejects.toThrow("download problem");
    expect(getFile).toHaveBeenCalledTimes(1);
    for (const error of [new Response("forbidden", { status: 403 }), new Response("slow down", { status: 429, headers: { "retry-after": "60" } })]) {
      const fetch = vi.fn().mockResolvedValue(error);
      vi.stubGlobal("fetch", fetch);
      await expect(run()).rejects.toThrow("download problem");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn().mockRejectedValue({ cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: token } });
    vi.stubGlobal("fetch", fetch);
    await expect(run()).rejects.toThrow("download problem");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes surrounding token whitespace consistently", () => {
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: ` ${token}\n`, DATABASE_URL: "postgres://localhost/db", EMI_MASTER_KEY: Buffer.alloc(32).toString("base64") }).telegramToken).toBe(token);
  });
});
