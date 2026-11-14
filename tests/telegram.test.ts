import { describe, expect, it, vi } from "vitest";
import type { Message, Update } from "grammy/types";
import { createTelegram } from "../src/channels/telegram";
import { telegramInput } from "../src/channels/telegram-input";
import type { Config } from "../src/config";
import { decryptKey } from "../src/core/keys";
import { activeMischief } from "../src/core/expression";
import { completeConnection } from "../src/core/integrations/connect";
import { getUser, recentMessages, updateUser } from "../src/core/users";
import { world } from "./helpers";

// Adapter tests inspect the writer's inputs; extraction has its own integration
// suite and must not race these assertions after a reply has been delivered.
vi.mock("../src/core/extraction", () => ({ runExtraction: vi.fn(async () => null) }));
vi.mock("../src/core/inner", async (original) => ({ ...await original<typeof import("../src/core/inner")>(), ensureInnerDay: vi.fn(async () => null) }));

const botUser = { id: 999, is_bot: true as const, first_name: "Emi", username: "emi_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
const person = { id: 42, is_bot: false as const, first_name: "Sam" };
const replyMessage = (text: string, patch: Partial<Message.TextMessage> = {}) => ({ ...message(text, patch), reply_to_message: undefined });
const message = (text: string, patch: Partial<Message.TextMessage> = {}): Message.TextMessage => ({
  message_id: 1, date: 1_794_571_200, chat: { id: 42, type: "private", first_name: "Sam" }, from: person, text, ...patch,
});

async function setup(failSend: (text: string) => boolean = () => false) {
  const w = await world();
  const config: Config = { telegramToken: "123456:test-token", databaseUrl: "unused", masterKey: Buffer.alloc(32, 7), sharedKey: "shared", allowedTelegramIds: null, models: w.deps.models, stickerPacks: ["catsunicmass"] };
  const telegram = createTelegram(w.deps, config);
  const { bot } = telegram;
  bot.botInfo = botUser;
  const sent: string[] = [];
  const methods: Array<{ method: string; payload: any }> = [];
  bot.api.config.use(async (_prev, method, payload) => {
    methods.push({ method, payload });
    if (method === "sendMessage" && "text" in payload && failSend(String(payload.text))) throw new Error("Telegram unavailable");
    const result = method === "sendMessage" && "text" in payload ? message(String(payload.text), { from: botUser, message_id: 500 + methods.length })
      : method === "getStickerSet" ? { name: "catsunicmass", title: "cats", sticker_type: "regular", stickers: [
        { file_id: "cat-laugh-1", emoji: "😹" }, { file_id: "cat-laugh-2", emoji: "😹" }, { file_id: "cat-grumpy", emoji: "😾" }, { file_id: "no-emoji" },
      ] }
      : true;
    if (method === "sendMessage" && "text" in payload) sent.push(String(payload.text));
    return { ok: true, result } as Awaited<ReturnType<typeof _prev>>;
  });
  let id = 0;
  async function send(text: string, patch: Partial<Message.TextMessage> = {}) {
    id += 1;
    const msg = message(text, { message_id: id, ...patch });
    if (text.startsWith("/")) msg.entities = [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }];
    await bot.handleUpdate({ update_id: id, message: msg } as Update);
  }
  async function user() {
    const rows = (await w.db.query<{ user_id: string }>("select user_id from channel_identities where channel = 'telegram' and external_id = '42'")).rows;
    return (await getUser(w.db, rows[0]!.user_id))!;
  }
  return { w, config, sent, methods, send, user, telegram };
}

describe("Telegram conversation continuity", () => {
  it("starts clean in the same Telegram chat after /wipe yes, retaining only its confirmation", async () => {
    const t = await setup();
    await t.send("my sister is called Anna");
    await t.send("/wipe"); // Flush the earlier chat and show the warning.
    expect(t.sent.at(-1)).toContain("/wipe yes");
    await t.send("/wipe yes");
    const confirmation = t.sent.at(-1)!;
    const user = await t.user();
    expect(await recentMessages(t.w.db, user.id, 20)).toMatchObject([{ kind: "command", content: confirmation }]);
    t.w.calls.length = 0;
    await t.send("hello again");
    await t.send("/agenda"); // Flush the new message.
    const prompt = JSON.stringify(t.w.calls[0]!.messages);
    expect(prompt).not.toContain("Anna");
    expect(prompt).not.toContain("this erases our whole conversation");
    expect(prompt).toContain(confirmation);
    expect(prompt).toContain("hello again");
  });

  it("shows /start, /timezone and their actual confirmations to the next writer call", async () => {
    const t = await setup();
    await t.send("/start");
    await t.send("/timezone Europe/Moscow");
    const confirmation = t.sent.at(-1)!;
    expect(confirmation).toContain("15:00 for you. got it.");
    expect(t.w.calls).toHaveLength(0); // Commands still do not need a model.
    await t.send("Yes) exactly");
    await t.send("/agenda"); // Flush the buffered chat, then execute this command.
    const prompt = t.w.calls[0]!.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("/start");
    expect(prompt).toContain("hey, i'm emi.");
    expect(prompt).toContain("/timezone Europe/Moscow");
    expect(prompt).toContain(confirmation);
    expect(prompt).not.toContain("This is the first time");
    expect((await t.user()).timezone).toBe("Europe/Moscow");
  });

  it("shows Emi a command and its output as the person adjusting her, without changing the visible exchange", async () => {
    const t = await setup();
    await t.send("/timezone probe-482");
    const confirmation = "i have nothing yet. send it like /timezone Europe/Berlin, or just tell me your city.";
    expect(t.sent).toEqual([confirmation]);
    await t.send("what exact argument did I just send, and why did you reject it?");
    await t.send("/agenda");
    const messages = t.w.calls[0]!.messages;
    const command = messages.find((m) => m.role === "user" && m.content.includes("/timezone probe-482"))!;
    expect(command.content).toContain("[They used a command: /timezone probe-482]");
    expect(command.content).toContain(`This is what it showed them:\n${confirmation}`);
    // Nothing the app displayed is ever put in Emi's own voice.
    expect(messages.some((m) => m.role === "assistant" && m.content.includes(confirmation))).toBe(false);
    // She is told what the commands are and that the agenda and memory are hers.
    expect(messages[0]!.content).toContain("/agenda shows what you plan to bring up");
    expect(messages[0]!.content).toContain("Both are yours.");
    const stored = await recentMessages(t.w.db, (await t.user()).id, 20);
    expect(stored.find((m) => m.role === "emi" && m.kind === "command")?.content).toBe(confirmation);
    expect(t.sent.join("\n")).not.toContain("They used a command");
    expect(t.w.calls).toHaveLength(1);
  });

  it("keeps each buffered reply attached to its own target and persists it for later turns", async () => {
    const t = await setup();
    await t.send("/start");
    await t.send("To that", { reply_to_message: replyMessage("so it's 19:16 for you. got it.", { from: botUser }) });
    await t.send("And this", { reply_to_message: replyMessage("I have an interview"), quote: { text: "interview", position: 10 } });
    await t.send("/agenda");
    const final = t.w.calls[0]!.messages.at(-1)!.content;
    expect(final).toContain('"author":"emi","text":"so it\'s 19:16 for you. got it."');
    expect(final).toContain('"author":"user","text":"I have an interview","quote":"interview"');
    expect(final.indexOf("To that")).toBeLessThan(final.indexOf("And this"));
    const history = await recentMessages(t.w.db, (await t.user()).id, 20);
    expect(history.find((m) => m.content === "To that")?.replyTo?.author).toBe("emi");
    await t.send("what did I mean?");
    await t.send("/agenda");
    expect(t.w.calls[1]!.messages.map((m) => m.content).join("\n")).toContain("19:16 for you");
  });

  it("redacts /key arguments from history and quoted replies while storing the encrypted key", async () => {
    const t = await setup();
    const secret = "sk-or-private-test-key-never-in-history";
    await t.send(`/key ${secret}`);
    const user = await t.user();
    expect(decryptKey(t.config.masterKey, user.encryptedApiKey!)).toBe(secret);
    await t.send("that key", { reply_to_message: replyMessage(`/key ${secret}`), quote: { text: secret, position: 5 } });
    await t.send("/agenda");
    expect(JSON.stringify(await recentMessages(t.w.db, user.id, 20))).not.toContain(secret);
    expect(JSON.stringify(t.w.calls)).not.toContain(secret);
    expect(t.w.calls[0]!.messages.map((m) => m.content).join("\n")).toContain("credential message redacted");
  });

  it("delivers a reply with its target through the normal debounce timer", async () => {
    const t = await setup();
    await t.send("/start");
    await t.send("yes", { reply_to_message: replyMessage("19:16 for you", { from: botUser }) });
    await vi.waitFor(() => expect(t.sent.at(-1)).toBe("ok"), { timeout: 5000 });
    expect(t.w.calls[0]!.messages.at(-1)!.content).toContain("19:16 for you");
  });

  it("does not record an unsent confirmation and recovers the queue after a failed command", async () => {
    let fail = true;
    const t = await setup((text) => fail && text === "nothing yet.");
    await t.send("/start");
    await expect(t.send("/memory")).rejects.toThrow("Telegram unavailable");
    let history = await recentMessages(t.w.db, (await t.user()).id, 20);
    expect(history.at(-1)?.content).toBe("/memory");
    fail = false;
    await t.send("/agenda");
    history = await recentMessages(t.w.db, (await t.user()).id, 20);
    expect(history.at(-1)?.content).toBe("nothing planned.");
  });

  it("flushes a pending chat before a command and preserves command state for later chat", async () => {
    const t = await setup();
    await t.send("/start");
    await t.send("hello before the timezone change");
    await t.send("/timezone Asia/Tokyo");
    await t.send("hello after the timezone change");
    await t.send("/agenda");
    const history = await recentMessages(t.w.db, (await t.user()).id, 20);
    const contents = history.map((m) => m.content);
    expect(contents.indexOf("hello before the timezone change")).toBeLessThan(contents.indexOf("/timezone Asia/Tokyo"));
    expect(contents.indexOf("/timezone Asia/Tokyo")).toBeLessThan(contents.indexOf("hello after the timezone change"));
    expect(t.w.calls[1]!.messages.at(-1)!.content).toContain("21:00");
  });

  it("reacts to the last message of a burst instead of writing, when a reaction is the whole reply", async () => {
    const t = await setup();
    t.w.script = () => "<<react:❤️>>";
    await t.send("thank you so much");
    await t.send("seriously");
    await t.send("/agenda");
    const reactions = t.methods.filter((call) => call.method === "setMessageReaction");
    expect(reactions).toHaveLength(1);
    expect(reactions[0]!.payload).toMatchObject({ chat_id: 42, message_id: 2, reaction: [{ type: "emoji", emoji: "❤" }] });
    expect(t.sent).toEqual(["nothing planned."]); // no text bubble, no raw tag
    const stored = await recentMessages(t.w.db, (await t.user()).id, 20);
    expect(stored.find((m) => m.role === "emi" && m.kind === "reply")?.content).toBe("[reacted with ❤]");
  });


});

describe("Telegram stickers, voice notes and mischief", () => {
  async function withKit(voice = true) {
    const t = await setup();
    expect(await t.telegram.loadStickers()).toBe(3);
    t.w.deps.expression = { stickers: t.telegram.stickerEmoji, ...(voice ? { speak: async () => new Uint8Array([1, 2, 3]) } : {}) };
    return t;
  }

  it("loads the pack by emoji and sends a sticker of the mood she asked for", async () => {
    const t = await withKit();
    expect(t.telegram.stickerEmoji().sort()).toEqual(["😹", "😾"]);
    t.w.script = () => "lmao\n<<sticker:😹>>";
    await t.send("i fell off my chair");
    await t.send("/agenda");
    const sticker = t.methods.find((call) => call.method === "sendSticker")!;
    expect(["cat-laugh-1", "cat-laugh-2"]).toContain(sticker.payload.sticker);
    expect(t.sent[0]).toBe("lmao");
  });

  it("sends a voice note, and says it as text without stage directions when the voice fails", async () => {
    const t = await withKit();
    t.w.script = () => "<<voice:[sighs] fine. goodnight.>>";
    await t.send("night");
    await t.send("/agenda");
    expect(t.methods.filter((call) => call.method === "sendVoice")).toHaveLength(1);

    const broken = await withKit();
    broken.w.deps.expression!.speak = async () => { throw new Error("voice provider returned 401"); };
    broken.w.script = () => "<<voice:[sighs] fine. goodnight.>>";
    await broken.send("night");
    await broken.send("/agenda");
    expect(broken.methods.filter((call) => call.method === "sendVoice")).toHaveLength(0);
    expect(broken.sent[0]).toBe("fine. goodnight.");
  });

  it("pins a sulk only when she is annoyed and mischief is on, and takes it down on /mischief off", async () => {
    const t = await withKit(false);
    await t.send("/start");
    const user = await t.user();
    await updateUser(t.w.db, user.id, { bond: { irritation: 0.8, irritationAt: t.w.now.toISOString(), irritationReason: "ignored her" } });
    t.w.script = () => "noted.\n<<pin:emi is not speaking to you>>";
    await t.send("you're so dramatic");
    await t.send("/agenda");
    const pin = t.methods.find((call) => call.method === "pinChatMessage")!;
    expect(pin.payload).toMatchObject({ chat_id: 42, disable_notification: true });
    expect(t.sent).toContain("emi is not speaking to you");
    expect(await activeMischief(t.w.db, user.id)).toHaveLength(1);

    await t.send("/mischief off");
    expect(t.methods.filter((call) => call.method === "unpinChatMessage")).toEqual([{ method: "unpinChatMessage", payload: { chat_id: "42", message_id: pin.payload.message_id } }]);
    expect(t.methods.some((call) => call.method === "deleteMessage" && call.payload.message_id === pin.payload.message_id)).toBe(true);
    expect(await activeMischief(t.w.db, user.id)).toHaveLength(0);
    expect((await t.user()).mischief).toBe(false);
  });
});

describe("Telegram confirmations", () => {
  it("shows a removal with buttons, and only removes it after the tap", async () => {
    const t = await setup();
    const calls: Array<{ method: string; url: string }> = [];
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      const body = url.includes("/token") ? { access_token: "a", refresh_token: "r", expires_in: 3600 }
        : url.includes("/events") && (init?.method ?? "GET") === "GET" ? { items: [{ id: "real-event-1", summary: "Dentist", start: { dateTime: "2026-11-16T10:30:00+01:00" }, end: { dateTime: "2026-11-16T11:00:00+01:00" } }] }
          : url.includes("/tasks") ? { items: [] } : {};
      return new Response(init?.method === "DELETE" ? null : JSON.stringify(body), { status: init?.method === "DELETE" ? 204 : 200 });
    }) as typeof globalThis.fetch;
    t.w.deps.integrations = { masterKey: Buffer.alloc(32, 7), publicUrl: "https://emi.example.com", google: { clientId: "g", clientSecret: "s" }, fetch };
    await t.send("/start");
    const user = await t.user();
    await completeConnection(t.w.db, t.w.deps.integrations, "google", user.id, "code", t.w.now);
    t.w.script = () => 'sure, want me to drop it?\n<<do:{"type":"event.remove","id":"e1"}>>';
    await t.send("cancel my dentist");
    await t.send("/agenda");
    const prompt = t.methods.find((call) => call.method === "sendMessage" && call.payload.reply_markup?.inline_keyboard)!;
    expect(prompt.payload.text).toBe('📅 remove "Dentist"');
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    const yes = prompt.payload.reply_markup.inline_keyboard[0][0].callback_data as string;

    const tap = (id: number) => t.telegram.bot.handleUpdate({ update_id: 900 + id, callback_query: { id: `cb${id}`, from: person, chat_instance: "x", data: yes, message: message('📅 remove "Dentist"', { from: botUser, message_id: 777 }) } } as Update);
    await tap(1);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => new URL(call.url).pathname)).toEqual(["/calendar/v3/calendars/primary/events/real-event-1"]);
    expect(t.methods.find((call) => call.method === "editMessageText")?.payload.text).toBe('📅 removed "Dentist"');
    await tap(2); // a second tap does nothing
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });
});

describe("Telegram reply snapshots", () => {
  it("supports selected quotes without an original message and captions on replied-to media", () => {
    expect(telegramInput(message("that", { quote: { text: "selected passage", position: 12 } }), botUser.id).replyTo)
      .toEqual({ author: "other", text: undefined, quote: "selected passage" });
    const media: Message.PhotoMessage = { message_id: 5, date: 1, chat: message("").chat, from: person, photo: [], caption: "holiday photo" };
    expect(telegramInput(message("nice", { reply_to_message: { ...media, reply_to_message: undefined } }), botUser.id).replyTo?.text).toBe("holiday photo");
  });

  it("redacts a selected credential command even when Telegram omits the original", () => {
    const input = telegramInput(message("this", { quote: { text: "/key sk-or-private", position: 0 } }), botUser.id);
    expect(JSON.stringify(input)).not.toContain("sk-or-private");
  });

  it("does not invent text for inaccessible external replies or follow nested replies", () => {
    const input = telegramInput(message("that", { external_reply: { origin: { type: "hidden_user", sender_user_name: "Someone", date: 1 } } }), botUser.id);
    expect(input.replyTo).toEqual({ author: "other", text: undefined, quote: undefined });
    expect(telegramInput(message("plain"), botUser.id)).toEqual({ text: "plain" });
  });
});
