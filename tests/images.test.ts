import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegram } from "../src/channels/telegram";
import { telegramImageFile, telegramImages } from "../src/channels/telegram-images";
import { telegramInput } from "../src/channels/telegram-input";
import { InputFile, type Api } from "grammy";
import type { Message, Update } from "grammy/types";
import { exportAccount, wipeAccount } from "../src/core/account";
import { ImageInputError, MAX_IMAGE_BYTES, MAX_TURN_IMAGES, imageHistory, loadImages, type ImageInput } from "../src/core/images";
import { handleTurn } from "../src/core/pipeline";
import { addMessage, recentMessages } from "../src/core/users";
import { openRouter } from "../src/llm/openrouter";
import { world } from "./helpers";

// A real, tiny PNG. Tests inspect transport and persistence, not model accuracy.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4mQAAAAASUVORK5CYII=", "base64");
const image: ImageInput = { mimeType: "image/png", data: png };
const person = { id: 42, is_bot: false as const, first_name: "Sam" };
const botUser = { id: 999, is_bot: true as const, first_name: "Emi", username: "emi_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
const chat = { id: 42, type: "private" as const, first_name: "Sam" };
const photo = (patch: Partial<Message.PhotoMessage> = {}): Message.PhotoMessage => ({
  message_id: 1, date: 1, from: person, chat,
  photo: [{ file_id: "small", file_unique_id: "a", width: 20, height: 20 }, { file_id: "large", file_unique_id: "b", width: 400, height: 600 }], ...patch,
});
const text = (content: string): Message.TextMessage => ({ message_id: 2, date: 1, from: person, chat, text: content });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

vi.mock("../src/core/extraction", () => ({ runExtraction: vi.fn(async () => null) }));
vi.mock("../src/core/memory/timeline", async (original) => ({ ...await original<typeof import("../src/core/memory/timeline")>(), runConsolidation: vi.fn(async () => null) }));

describe("Telegram image input", () => {
  it("downloads the largest photo privately and detects its actual format", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_id: "large", file_path: "photos/file.png" });
    const fetch = vi.fn().mockResolvedValue(new Response(png));
    vi.stubGlobal("fetch", fetch);
    const msg = photo({ caption: "solve the task on this screenshot" });
    expect(telegramImageFile(msg)?.fileId).toBe("large");
    const input = await telegramImages({ getFile } as unknown as Pick<Api, "getFile">, "private-token", msg, telegramInput(msg, 999));
    expect(input.text).toBe(msg.caption);
    expect(input.images).toEqual([image]);
    expect(getFile).toHaveBeenCalledWith("large", expect.any(AbortSignal));
    expect(JSON.stringify(input)).not.toContain("private-token");
    expect(JSON.stringify(input)).not.toContain("api.telegram.org");
    expect(fetch.mock.calls[0]![1].redirect).toBe("manual");
  });

  it("accepts image files and pictures referenced by a text reply", async () => {
    const document: Message.DocumentMessage = { message_id: 3, date: 1, from: person, chat, document: { file_id: "doc", file_unique_id: "d", mime_type: "application/octet-stream", file_name: "screenshot.PNG" } };
    expect(telegramImageFile(document)?.fileId).toBe("doc");
    const msg = { ...text("what does this say?"), reply_to_message: { ...document, reply_to_message: undefined } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(png)));
    const input = await telegramImages({ getFile: vi.fn().mockResolvedValue({ file_path: "documents/image.png" }) } as unknown as Pick<Api, "getFile">, "token", msg, telegramInput(msg, 999));
    expect(input.images?.[0]).toMatchObject({ mimeType: "image/png", origin: "reply" });
  });

  it("rejects oversized files before downloading and rejects bytes that are not images", async () => {
    const getFile = vi.fn();
    const msg = photo({ photo: [{ file_id: "large", file_unique_id: "x", width: 10, height: 10, file_size: MAX_IMAGE_BYTES + 1 }] });
    await expect(telegramImages({ getFile } as unknown as Pick<Api, "getFile">, "token", msg, { text: "" })).rejects.toBeInstanceOf(ImageInputError);
    expect(getFile).not.toHaveBeenCalled();
    getFile.mockResolvedValue({ file_path: "photos/fake.png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>not an image</html>")));
    await expect(telegramImages({ getFile } as unknown as Pick<Api, "getFile">, "token", photo(), { text: "" })).rejects.toThrow("couldn't read that file");
  });

  it("enforces streaming size limits even without trustworthy file metadata", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/unknown.png" });
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES + 1)); }, cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    await expect(telegramImages({ getFile } as unknown as Pick<Api, "getFile">, "token", photo(), { text: "" })).rejects.toThrow("under 8 MB");
    expect(cancel).toHaveBeenCalled();
  });

  it("never propagates a credential-bearing download exception", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/image.png" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("failed https://api.telegram.org/file/botPRIVATE_TOKEN/photos/image.png")));
    const error = await telegramImages({ getFile } as unknown as Pick<Api, "getFile">, "PRIVATE_TOKEN", photo(), { text: "" }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(ImageInputError);
    expect(String(error)).not.toContain("PRIVATE_TOKEN");
    expect((error as Error).cause).toBeUndefined();
  });

  it("keeps a three-photo album intact when one image needs a download retry", async () => {
    const w = await world();
    const { bot } = createTelegram(w.deps, { telegramToken: "123456:test-token", databaseUrl: "unused", masterKey: Buffer.alloc(32), sharedKey: "shared", allowedTelegramIds: null, models: w.deps.models });
    bot.botInfo = botUser;
    const sent: string[] = [];
    const fetched: string[] = [];
    const exported: Array<string | undefined> = [];
    bot.api.config.use(async (previous, method, payload) => {
      if (method === "sendMessage" && "text" in payload) sent.push(String(payload.text));
      if (method === "getFile" && "file_id" in payload) {
        fetched.push(String(payload.file_id));
        if (fetched.length === 3) throw Object.assign(new Error("temporary metadata connection failure"), { code: "ECONNRESET" });
      }
      if (method === "sendDocument" && "document" in payload && payload.document instanceof InputFile) exported.push(payload.document.filename);
      const result = method === "getFile" ? { file_path: "photos/image.png" } : method === "sendMessage" ? { ...text(String((payload as { text: string }).text)), from: botUser } : true;
      return { ok: true, result } as Awaited<ReturnType<typeof previous>>;
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(png)));
    const send = (message: Message, update_id: number) => bot.handleUpdate({ message, update_id } as Update);
    await send(photo({ caption: "first", media_group_id: "album" }), 1);
    await send(photo({ message_id: 2, caption: "second", media_group_id: "album" }), 2);
    await send(photo({ message_id: 3, caption: "third", media_group_id: "album" }), 3);
    await send(text("compare them"), 4);
    // Flush pending arrivals without waiting for the debounce timeout.
    await send({ ...text("/agenda"), entities: [{ type: "bot_command", offset: 0, length: 7 }] }, 5);
    expect(w.calls).toHaveLength(1);
    const final = w.calls[0]!.messages.at(-1)!;
    expect(final.images).toHaveLength(3);
    expect(final.content.indexOf("first")).toBeLessThan(final.content.indexOf("second"));
    expect(final.content).toContain("compare them");
    expect(fetched).toEqual(["large", "large", "large", "large"]);
    expect(sent).not.toContain("i can only read text for now.");
    await send({ ...text("/export"), entities: [{ type: "bot_command", offset: 0, length: 7 }] }, 6);
    expect(exported[0]).toBe("emi-export.json");
    expect(exported.slice(1)).toEqual(Array.from({ length: 3 }, () => expect.stringMatching(/^emi-image-.+\.png$/)));
  });
});

describe("image conversation storage and follow-ups", () => {
  it("keeps pixels out of text history, replays recent pictures for follow-ups and supports a vision-model override", async () => {
    const w = await world();
    w.deps.models.vision = "vision-model";
    const user = await w.newUser();
    await handleTurn(w.deps, user.id, [{ text: "solve this screenshot", images: [image] }]);
    expect(w.calls[0]!.options.model).toBe("vision-model");
    expect(w.calls[0]!.messages.at(-1)!.images?.[0]?.data).toEqual(png);
    expect(w.calls[0]!.messages[0]!.content).toContain("instead of inventing");
    const stored = await recentMessages(w.db, user.id, 10);
    expect(stored[0]!.content).toBe("solve this screenshot");
    expect(stored[0]!.images).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(png.toString("base64"));
    await handleTurn(w.deps, user.id, "explain the second line");
    expect(w.calls[1]!.messages.flatMap((m) => m.images ?? [])).toHaveLength(1);
    expect(w.calls[1]!.options.model).toBe("vision-model");
  });

  it("uses the normal writer when no image is in context and bounds automatic replay", async () => {
    const w = await world();
    const user = await w.newUser();
    await handleTurn(w.deps, user.id, "hello");
    expect(w.calls[0]!.options.model).toBe("writer");
    for (let n = 0; n < 4; n++) await addMessage(w.db, { userId: user.id, role: "user", content: `image ${n}`, images: [image], at: w.now });
    const history = await recentMessages(w.db, user.id, 20);
    const context = await imageHistory(w.db, user.id, history, []);
    expect([...context.values()].flat()).toHaveLength(2);
    const loadedIds = [...context.keys()];
    expect(loadedIds).toEqual(history.filter((m) => m.images?.length).slice(-2).map((m) => m.id));
    await handleTurn(w.deps, user.id, "look at the pictures again");
    expect(w.calls.at(-1)!.messages.map((m) => m.content).join("\n")).toContain("omitted pixels cannot be inspected");
  });

  it("scopes image loading and export to the owner and erases bytes on wipe", async () => {
    const w = await world();
    const user = await w.newUser();
    const other = await w.newUser();
    const stored = await addMessage(w.db, { userId: user.id, role: "user", content: "private screenshot", images: [image], at: w.now });
    const refs = stored.images!;
    expect(await loadImages(w.db, other.id, refs)).toEqual([]);
    const data = await exportAccount(w.db, user.id, w.now);
    expect(data.images[0]).toMatchObject({ id: refs[0]!.id, byte_size: png.byteLength });
    expect(Buffer.from((await loadImages(w.db, user.id, refs))[0]!.data)).toEqual(png);
    expect(JSON.stringify(data)).not.toContain(png.toString("base64"));
    expect(data.messages[0]).toMatchObject({ id: stored.id, content: "private screenshot" });
    expect((await exportAccount(w.db, other.id, w.now)).images).toEqual([]);
    const otherImage = await addMessage(w.db, { userId: other.id, role: "user", content: "other person's image", images: [image], at: w.now });
    await wipeAccount(w.db, user.id);
    expect(await loadImages(w.db, user.id, refs)).toEqual([]);
    expect(await loadImages(w.db, other.id, otherImage.images!)).toHaveLength(1);
    expect((await w.db.query("select * from message_images")).rows).toHaveLength(1);
  });

  it("rejects too many or invalid images before writing any part of a turn", async () => {
    const w = await world();
    const user = await w.newUser();
    await expect(handleTurn(w.deps, user.id, [{ text: "too many", images: Array.from({ length: MAX_TURN_IMAGES + 1 }, () => image) }])).rejects.toBeInstanceOf(ImageInputError);
    await expect(handleTurn(w.deps, user.id, [{ text: "fake", images: [{ mimeType: "image/png", data: Buffer.from("not an image") }] }])).rejects.toBeInstanceOf(ImageInputError);
    expect(await recentMessages(w.db, user.id, 10)).toHaveLength(0);
  });
});

it.each([true, false])("serializes private image bytes with web enabled=%s", async (webEnabled) => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "the answer is 42" }] }], usage: { input_tokens: 100, output_tokens: 10, cost: 0.01 } }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const result = await openRouter("key", { webEnabled }).chat([{ role: "user", content: "solve this", images: [image] }], { model: "vision-model", web: true });
  const body = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(fetch.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/responses");
  if (webEnabled) expect(body.tools).toHaveLength(2);
  else expect(body.tools).toBeUndefined();
  expect(body.input[0].content[0]).toEqual({ type: "input_text", text: "solve this" });
  expect(body.input[0].content[2]).toMatchObject({ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" });
  expect(result.text).toBe("the answer is 42");
});
