import { describe, expect, it, vi } from "vitest";
import type { Message, Update } from "grammy/types";
import { createTelegram } from "../src/channels/telegram";
import { telegramInput } from "../src/channels/telegram-input";
import type { Config } from "../src/config";
import { decryptKey } from "../src/core/keys";
import { getUser, recentMessages } from "../src/core/users";
import { world } from "./helpers";

// Adapter tests inspect the writer's inputs; extraction has its own integration
// suite and must not race these assertions after a reply has been delivered.
vi.mock("../src/core/extraction", () => ({ runExtraction: vi.fn(async () => null) }));

const botUser = { id: 999, is_bot: true as const, first_name: "Emi", username: "emi_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
const person = { id: 42, is_bot: false as const, first_name: "Sam" };
const replyMessage = (text: string, patch: Partial<Message.TextMessage> = {}) => ({ ...message(text, patch), reply_to_message: undefined });
const message = (text: string, patch: Partial<Message.TextMessage> = {}): Message.TextMessage => ({
  message_id: 1, date: 1_794_571_200, chat: { id: 42, type: "private", first_name: "Sam" }, from: person, text, ...patch,
});

async function setup(failSend: (text: string) => boolean = () => false) {
  const w = await world();
  const config: Config = { telegramToken: "123456:test-token", databaseUrl: "unused", masterKey: Buffer.alloc(32, 7), sharedKey: "shared", allowedTelegramIds: null, models: w.deps.models };
  const { bot } = createTelegram(w.deps, config);
  bot.botInfo = botUser;
  const sent: string[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage" && "text" in payload && failSend(String(payload.text))) throw new Error("Telegram unavailable");
    const result = method === "sendMessage" && "text" in payload ? message(String(payload.text), { from: botUser }) : true;
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
  return { w, config, sent, send, user };
}

describe("Telegram conversation continuity", () => {
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
