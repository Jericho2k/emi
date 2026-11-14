import { Bot, InputFile, type Context } from "grammy";
import type { Message, ReactionTypeEmoji } from "grammy/types";
import type { Config } from "../config";
import { exportAccount, wipeAccount } from "../core/account";
import { pendingItems } from "../core/agenda/store";
import { describeMoment, isValidTimeZone } from "../core/clock";
import { describeImages } from "../core/image-descriptions";
import { ImageInputError, MAX_TURN_IMAGES, findStoredImage, loadImages, validateImages } from "../core/images";
import { encryptKey } from "../core/keys";
import { activeMemories, deleteMemory, findByShortId, insertMemory } from "../core/memory/store";
import { afterTurn, handleTurn } from "../core/pipeline";
import { classifyTurn } from "../core/prompt";
import { bubbleWaits, isPaced, typingMs } from "../core/rhythm";
import { INITIATIVE_LEVELS, type Deps, type Initiative, type IncomingMessage, type Outbound, type User } from "../core/types";
import { addMessage, chatIdFor, getUser, spentToday, updateUser, userForChannel } from "../core/users";
import { chunkText, toTelegramHtml } from "./telegram-format";
import { telegramImages, telegramImageFile } from "./telegram-images";
import { telegramInput } from "./telegram-input";

const CHANNEL = "telegram";
/** Messages sent in quick succession are one thought and get one reply. */
const DEBOUNCE_MS = 1200;

const HELP = [
  "/key <openrouter key> — use your own key",
  "/memory — what I know about you",
  "/remember <text> — tell me something to keep",
  "/forget <id> — make me forget one thing",
  "/agenda — what I'm planning to bring up",
  "/initiative off | low | medium | high — how often I write first",
  "/timezone <Area/City> — where you are, e.g. Europe/Berlin",
  "/quiet <from> <to> — hours I stay silent, e.g. /quiet 23 8",
  "/usage — what today has cost, and /cap <usd> to change the limit on what I spend unasked",
  "/export — a file with everything I hold about you",
  "/wipe — erase our whole conversation and everything I remember",
].join("\n");

export function createTelegram(deps: Deps, config: Config): { bot: Bot; outbound: Outbound } {
  const bot = new Bot(config.telegramToken);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const typing = (chatId: string | number) => void bot.api.sendChatAction(chatId, "typing").catch(() => undefined);

  /**
   * Sends bubbles in order. Paced, each one is "typed" first, for about as
   * long as a person would take; `waits` says how long, per bubble.
   */
  async function sendBubbles(chatId: string | number, bubbles: string[], waits?: number[]): Promise<void> {
    const pieces = bubbles.flatMap((bubble, index) => chunkText(bubble).map((piece, part) => ({ piece, wait: part === 0 ? waits?.[index] : undefined })));
    for (const [index, { piece, wait }] of pieces.entries()) {
      if (wait !== undefined && wait > 0) {
        // Telegram shows "typing" for about five seconds, so a longer wait renews it.
        for (let left = wait; left > 0; left -= 4500) {
          typing(chatId);
          await sleep(Math.min(left, 4500));
        }
      } else if (index > 0) {
        // Just enough of a gap that separate messages arrive in order.
        await sleep(350);
      }
      try {
        await bot.api.sendMessage(chatId, toTelegramHtml(piece), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      } catch {
        // Markup Telegram refuses is still worth reading as plain text.
        await bot.api.sendMessage(chatId, piece);
      }
    }
  }

  const outbound: Outbound = {
    async send(userId, bubbles) {
      const chatId = await chatIdFor(deps.db, userId, CHANNEL);
      if (!chatId) throw new Error(`no telegram chat for user ${userId}`);
      // Writing first is chatting: the first message simply arrives (nobody was
      // watching her type it), and any further ones are typed, never dumped.
      await sendBubbles(chatId, bubbles, config.pacing ? bubbles.map((bubble, index) => (index ? typingMs(bubble, deps.random) : 0)) : undefined);
    },
  };

  async function userOf(ctx: Context): Promise<User | null> {
    if (ctx.chat?.type !== "private" || !ctx.from) return null;
    const externalId = String(ctx.from.id);
    if (config.allowedTelegramIds && !config.allowedTelegramIds.has(externalId)) return null;
    return userForChannel(deps.db, deps.clock(), { channel: CHANNEL, externalId, chatId: String(ctx.chat.id), displayName: ctx.from.first_name });
  }

  // Commands share the turn queue so their state changes and confirmations
  // cannot overtake a buffered message or an in-flight model reply.
  const chains = new Map<string, Promise<void>>();
  type PendingInput = { input: IncomingMessage; message: Message };
  const pending = new Map<string, { messages: PendingInput[]; chatId: number; timer: NodeJS.Timeout }>();

  function enqueue(userId: string, work: () => Promise<unknown>): Promise<void> {
    const next = (chains.get(userId) ?? Promise.resolve()).catch(() => undefined).then(work).then(() => undefined);
    chains.set(userId, next);
    const cleanup = () => { if (chains.get(userId) === next) chains.delete(userId); };
    void next.then(cleanup, cleanup);
    return next;
  }

  function flushPending(userId: string): void {
    const entry = pending.get(userId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(userId);
    void enqueue(userId, () => runTurn(userId, entry.chatId, entry.messages))
      .catch((error) => console.error("[telegram]", error));
  }

  type CommandReply = (text: string) => Promise<unknown>;
  const command = (name: string, handler: (ctx: Context, user: User, arg: string, reply: CommandReply) => Promise<unknown>) =>
    bot.command(name, async (ctx) => {
      const message = ctx.message;
      if (!message) return;
      const identity = await userOf(ctx);
      if (!identity) return;
      flushPending(identity.id);
      await enqueue(identity.id, async () => {
        const user = await getUser(deps.db, identity.id);
        if (!user) return;
        const input = telegramInput(message, ctx.me.id);
        await addMessage(deps.db, { userId: user.id, role: "user", content: input.text, replyTo: input.replyTo, kind: "command", at: deps.clock() });
        const reply: CommandReply = async (text) => {
          const sent = await ctx.reply(text);
          await addMessage(deps.db, { userId: user.id, role: "emi", content: text, kind: "command", at: deps.clock() });
          return sent;
        };
        await handler(ctx, user, String(ctx.match ?? "").trim(), reply);
      });
    });

  command("start", async (_ctx, user, _arg, reply) => {
    const hasKey = !!deps.llmFor(user);
    await reply([
      "hey, i'm emi.",
      "this is one chat that never resets: ask me things, have me do things, or just talk. i remember what you tell me and i'll sometimes check in.",
      hasKey ? "tell me what city you're in so i get your time right, and we're good." : "first i need an OpenRouter key: send /key followed by the key. then tell me what city you're in.",
      "/help shows what you can control.",
    ].join("\n\n"));
  });

  command("help", (_ctx, _user, _arg, reply) => reply(HELP));

  command("key", async (ctx, user, arg, reply) => {
    // The key should not sit in the chat history.
    await ctx.deleteMessage().catch(() => undefined);
    if (arg.length < 20 || /\s/.test(arg)) return reply("send it as: /key sk-or-...");
    await updateUser(deps.db, user.id, { encryptedApiKey: encryptKey(config.masterKey, arg) });
    return reply("got it, stored encrypted. i deleted your message with the key. say hi.");
  });

  command("memory", async (_ctx, user, _arg, reply) => {
    const memories = await activeMemories(deps.db, user.id);
    if (!memories.length) return reply("nothing yet.");
    const line = (m: typeof memories[number]) => `${m.id.slice(0, 6)} · ${m.pinned ? "📌 " : ""}${m.kind === "event" && m.occurredOn ? `[${m.occurredOn}] ` : ""}${m.content}`;
    const section = (title: string, items: typeof memories) => (items.length ? [`${title}\n${items.map(line).join("\n")}`] : []);
    const text = [
      ...section("about you", memories.filter((m) => m.kind !== "self" && m.kind !== "us")),
      ...section("about me", memories.filter((m) => m.kind === "self")),
      ...section("us", memories.filter((m) => m.kind === "us")),
    ].join("\n\n");
    for (const piece of chunkText(`${text}\n\n/forget <id> removes one.`)) await reply(piece);
  });

  command("remember", async (_ctx, user, arg, reply) => {
    if (arg.length < 3) return reply("tell me what: /remember my sister is called Anna");
    let embedding: number[] | null = null;
    try {
      embedding = (await deps.llmFor(user)?.embed([arg], deps.models.embedding))?.vectors[0] ?? null;
    } catch { /* stored without a vector; still found by words */ }
    // Written by them, so pinned and never rewritten by a model.
    await insertMemory(deps.db, { userId: user.id, kind: "identity", content: arg.slice(0, 300), source: "user", pinned: true, embedding, at: deps.clock() });
    return reply("i'll keep that.");
  });

  command("forget", async (_ctx, user, arg, reply) => {
    const memory = await findByShortId(deps.db, user.id, arg);
    if (!memory) return reply("i can't find that one. /memory shows the ids.");
    await deleteMemory(deps.db, user.id, memory.id, deps.clock());
    return reply("forgotten.");
  });

  command("agenda", async (_ctx, user, _arg, reply) => {
    const items = await pendingItems(deps.db, user.id);
    if (!items.length) return reply("nothing planned.");
    return reply(items.map((item) => {
      const when = item.kind === "reminder" && item.pingAt ? `remind at ${describeMoment(item.pingAt, user.timezone)}`
        : item.pingAt ? `might write around ${describeMoment(item.pingAt, user.timezone)}` : "only if we're talking";
      return `• ${item.about} — ${when}`;
    }).join("\n"));
  });

  command("initiative", async (_ctx, user, arg, reply) => {
    if (!INITIATIVE_LEVELS.includes(arg as Initiative)) return reply(`it's ${user.initiative} now. options: off, low, medium, high.`);
    await updateUser(deps.db, user.id, { initiative: arg as Initiative, brushoffCount: 0 });
    return reply(arg === "off" ? "ok. i won't write first, except reminders you ask for." : `ok, ${arg}.`);
  });

  command("timezone", async (_ctx, user, arg, reply) => {
    if (!isValidTimeZone(arg)) return reply(`i have ${user.timezoneKnown ? user.timezone : "nothing yet"}. send it like /timezone Europe/Berlin, or just tell me your city.`);
    await updateUser(deps.db, user.id, { timezone: arg, timezoneKnown: true });
    return reply(`so it's ${describeMoment(deps.clock(), arg)} for you. got it.`);
  });

  command("quiet", async (_ctx, user, arg, reply) => {
    const [from, to] = arg.split(/\s+/).map(Number);
    const valid = (hour: number | undefined): hour is number => Number.isInteger(hour) && hour! >= 0 && hour! <= 23;
    if (!valid(from) || !valid(to)) return reply(`quiet from ${user.quietStart}:00 to ${user.quietEnd}:00. change with /quiet 23 8.`);
    await updateUser(deps.db, user.id, { quietStart: from, quietEnd: to });
    return reply(`quiet from ${from}:00 to ${to}:00.`);
  });

  command("usage", async (_ctx, user, _arg, reply) => {
    const spent = await spentToday(deps.db, user, deps.clock());
    return reply(`today: $${spent.toFixed(4)}. once that passes $${user.dailyCapUsd.toFixed(2)} i stop writing first for the day (replies and reminders keep working). change with /cap.`);
  });

  command("cap", async (_ctx, user, arg, reply) => {
    const value = Number(arg);
    if (!Number.isFinite(value) || value < 0 || value > 100) return reply("send a number in dollars, e.g. /cap 0.5");
    await updateUser(deps.db, user.id, { dailyCapUsd: value });
    return reply(`cap set to $${value.toFixed(2)} a day.`);
  });

  command("export", async (ctx, user, _arg, reply) => {
    const data = await exportAccount(deps.db, user.id, deps.clock());
    // Export images as their original files instead of inflating one JSON
    // document past Telegram's file-size limit with embedded base64 bytes.
    const images = data.images;
    const suffix: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
    const filename = (image: Pick<typeof images[number], "id" | "mime_type">) => `emi-image-${image.id}.${suffix[image.mime_type]}`;
    const manifest = { ...data, images: images.map((image) => ({ ...image, file: image.source_image_id ? null : filename(image) })) };
    await ctx.replyWithDocument(new InputFile(Buffer.from(JSON.stringify(manifest, null, 2)), "emi-export.json"));
    // A re-sent or replied-to picture reuses a stored copy; its file is exported once.
    for (const image of images.filter((image) => !image.source_image_id)) {
      const [original] = await loadImages(deps.db, user.id, [image]);
      if (!original) throw new Error("export image is no longer available");
      await ctx.replyWithDocument(new InputFile(original.data, filename(image)));
    }
    return reply("that's everything: messages, memories, plans and settings. your API key is not in it.");
  });

  command("wipe", async (_ctx, user, arg, reply) => {
    if (arg.toLowerCase() !== "yes") {
      return reply("this erases our whole conversation and everything i remember about you. it can't be undone. /export first if you want a copy, then send /wipe yes.");
    }
    await wipeAccount(deps.db, user.id);
    return reply("done. everything is erased. your settings and key are still here, so you can just start talking again.");
  });

  // ---- conversation ----

  /** A reaction on their message; if Telegram refuses it, the emoji is sent as a message instead. */
  async function react(chatId: number, messageId: number, emoji: string, alsoReplying: boolean): Promise<void> {
    try {
      await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: emoji as ReactionTypeEmoji["emoji"] }]);
    } catch {
      if (!alsoReplying) await bot.api.sendMessage(chatId, emoji).catch(() => undefined);
    }
  }

  async function runTurn(userId: string, chatId: number, batch: PendingInput[]): Promise<void> {
    const started = Date.now();
    const kind = classifyTurn(batch.map((item) => item.input.text).join("\n"));
    const paced = !!config.pacing && isPaced(kind) && !batch.some((item) => telegramImageFile(item.message));
    // Paced, she reads for a moment before "typing" shows; the model is already writing meanwhile.
    let typingTimer: NodeJS.Timeout | undefined;
    const startTyping = () => {
      typing(chatId);
      typingTimer = setInterval(() => typing(chatId), 4500);
    };
    const readTimer = setTimeout(startTyping, paced ? 600 + deps.random() * 900 : 0);
    const stopTyping = () => { clearTimeout(readTimer); clearInterval(typingTimer); };
    try {
      // Register arrivals before doing I/O so photos, album entries and nearby
      // text stay in order even when Telegram downloads are slow.
      const fileCount = batch.reduce((count, item) => count + Number(!!telegramImageFile(item.message)) + Number(!!telegramImageFile(item.message.reply_to_message)), 0);
      if (fileCount > MAX_TURN_IMAGES) throw new ImageInputError(`send up to ${MAX_TURN_IMAGES} images at once.`);
      const messages: IncomingMessage[] = [];
      for (const item of batch) {
        messages.push(await telegramImages(bot.api, config.telegramToken, item.message, item.input, (key) => findStoredImage(deps.db, userId, key)));
        validateImages(messages.flatMap((message) => message.images ?? []));
      }
      const result = await handleTurn(deps, userId, messages);
      stopTyping();
      const last = batch.at(-1)?.message;
      if (result.reaction && last) await react(chatId, last.message_id, result.reaction, result.bubbles.length > 0);
      await sendBubbles(chatId, result.bubbles, paced ? bubbleWaits(result.bubbles, Date.now() - started, deps.random) : undefined);
      if (!result.problem) {
        void afterTurn(deps, userId, result).catch((error) => console.warn("[background]", error));
        // Written while the person reads the reply, ready before the picture
        // stops being attached to follow-ups.
        void describeImages(deps, userId).catch((error) => console.warn("[background]", error));
      }
    } catch (error) {
      if (error instanceof ImageInputError) {
        for (const item of batch) await addMessage(deps.db, { userId, role: "user", content: item.input.text || "[Image upload unavailable]", replyTo: item.input.replyTo, at: deps.clock() });
        await bot.api.sendMessage(chatId, error.message);
        await addMessage(deps.db, { userId, role: "emi", content: error.message, kind: "command", at: deps.clock() });
        return;
      }
      console.error("[turn] failed", error);
      await bot.api.sendMessage(chatId, "something broke on my side. try that again in a moment.").catch(() => undefined);
    } finally {
      stopTyping();
    }
  }

  bot.on("message", async (ctx) => {
    if (ctx.message.text?.startsWith("/")) return;
    const user = await userOf(ctx);
    if (!user) return;
    if (!ctx.message.text && !telegramImageFile(ctx.message)) {
      await ctx.reply("I can read text and images for now. send a photo or a PNG, JPEG, WebP or GIF file.");
      return;
    }
    const chatId = ctx.chat.id;
    const entry = pending.get(user.id) ?? { messages: [], chatId, timer: setTimeout(() => undefined, 0) };
    clearTimeout(entry.timer);
    entry.messages.push({ input: telegramInput(ctx.message, ctx.me.id), message: ctx.message });
    entry.timer = setTimeout(() => flushPending(user.id), DEBOUNCE_MS);
    pending.set(user.id, entry);
  });

  bot.catch((error) => console.error("[telegram]", error.message));
  return { bot, outbound };
}
