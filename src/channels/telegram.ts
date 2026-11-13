import { Bot, type Context } from "grammy";
import type { Config } from "../config";
import { pendingItems } from "../core/agenda/store";
import { describeMoment, isValidTimeZone } from "../core/clock";
import { runExtraction } from "../core/extraction";
import { encryptKey } from "../core/keys";
import { activeMemories, deleteMemory, findByShortId, insertMemory } from "../core/memory/store";
import { handleTurn } from "../core/pipeline";
import { INITIATIVE_LEVELS, type Deps, type Initiative, type Outbound, type User } from "../core/types";
import { chatIdFor, spentToday, updateUser, userForChannel } from "../core/users";
import { chunkText, toTelegramHtml } from "./telegram-format";

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
].join("\n");

export function createTelegram(deps: Deps, config: Config): { bot: Bot; outbound: Outbound } {
  const bot = new Bot(config.telegramToken);

  async function sendBubbles(chatId: string | number, bubbles: string[]): Promise<void> {
    const pieces = bubbles.flatMap((bubble) => chunkText(bubble));
    for (const [index, piece] of pieces.entries()) {
      // Just enough of a gap that separate messages arrive in order.
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 350));
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
      await sendBubbles(chatId, bubbles);
    },
  };

  async function userOf(ctx: Context): Promise<User | null> {
    if (ctx.chat?.type !== "private" || !ctx.from) return null;
    const externalId = String(ctx.from.id);
    if (config.allowedTelegramIds && !config.allowedTelegramIds.has(externalId)) return null;
    return userForChannel(deps.db, deps.clock(), { channel: CHANNEL, externalId, chatId: String(ctx.chat.id), displayName: ctx.from.first_name });
  }

  /** Registers a command that only runs for a known person in a private chat. */
  const command = (name: string, handler: (ctx: Context, user: User, arg: string) => Promise<unknown>) =>
    bot.command(name, async (ctx) => {
      const user = await userOf(ctx);
      if (user) await handler(ctx, user, String(ctx.match ?? "").trim());
    });

  command("start", async (ctx, user) => {
    const hasKey = !!deps.llmFor(user);
    await ctx.reply([
      "hey, i'm emi.",
      "this is one chat that never resets: ask me things, have me do things, or just talk. i remember what you tell me and i'll sometimes check in.",
      hasKey ? "tell me what city you're in so i get your time right, and we're good." : "first i need an OpenRouter key: send /key followed by the key. then tell me what city you're in.",
      "/help shows what you can control.",
    ].join("\n\n"));
  });

  command("help", (ctx) => ctx.reply(HELP));

  command("key", async (ctx, user, arg) => {
    // The key should not sit in the chat history.
    await ctx.deleteMessage().catch(() => undefined);
    if (arg.length < 20 || /\s/.test(arg)) return ctx.reply("send it as: /key sk-or-...");
    await updateUser(deps.db, user.id, { encryptedApiKey: encryptKey(config.masterKey, arg) });
    return ctx.reply("got it, stored encrypted. i deleted your message with the key. say hi.");
  });

  command("memory", async (ctx, user) => {
    const memories = await activeMemories(deps.db, user.id);
    if (!memories.length) return ctx.reply("nothing yet.");
    const lines = memories.map((m) => `${m.id.slice(0, 6)} · ${m.pinned ? "📌 " : ""}${m.kind === "event" && m.occurredOn ? `[${m.occurredOn}] ` : ""}${m.content}`);
    for (const piece of chunkText(`${lines.join("\n")}\n\n/forget <id> removes one.`)) await ctx.reply(piece);
  });

  command("remember", async (ctx, user, arg) => {
    if (arg.length < 3) return ctx.reply("tell me what: /remember my sister is called Anna");
    let embedding: number[] | null = null;
    try {
      embedding = (await deps.llmFor(user)?.embed([arg], deps.models.embedding))?.vectors[0] ?? null;
    } catch { /* stored without a vector; still found by words */ }
    // Written by them, so pinned and never rewritten by a model.
    await insertMemory(deps.db, { userId: user.id, kind: "identity", content: arg.slice(0, 300), source: "user", pinned: true, embedding, at: deps.clock() });
    return ctx.reply("i'll keep that.");
  });

  command("forget", async (ctx, user, arg) => {
    const memory = await findByShortId(deps.db, user.id, arg);
    if (!memory) return ctx.reply("i can't find that one. /memory shows the ids.");
    await deleteMemory(deps.db, user.id, memory.id, deps.clock());
    return ctx.reply("forgotten.");
  });

  command("agenda", async (ctx, user) => {
    const items = await pendingItems(deps.db, user.id);
    if (!items.length) return ctx.reply("nothing planned.");
    return ctx.reply(items.map((item) => {
      const when = item.kind === "reminder" && item.pingAt ? `remind at ${describeMoment(item.pingAt, user.timezone)}`
        : item.pingAt ? `might write around ${describeMoment(item.pingAt, user.timezone)}` : "only if we're talking";
      return `• ${item.about} — ${when}`;
    }).join("\n"));
  });

  command("initiative", async (ctx, user, arg) => {
    if (!INITIATIVE_LEVELS.includes(arg as Initiative)) return ctx.reply(`it's ${user.initiative} now. options: off, low, medium, high.`);
    await updateUser(deps.db, user.id, { initiative: arg as Initiative, brushoffCount: 0 });
    return ctx.reply(arg === "off" ? "ok. i won't write first, except reminders you ask for." : `ok, ${arg}.`);
  });

  command("timezone", async (ctx, user, arg) => {
    if (!isValidTimeZone(arg)) return ctx.reply(`i have ${user.timezoneKnown ? user.timezone : "nothing yet"}. send it like /timezone Europe/Berlin, or just tell me your city.`);
    await updateUser(deps.db, user.id, { timezone: arg, timezoneKnown: true });
    return ctx.reply(`so it's ${describeMoment(deps.clock(), arg)} for you. got it.`);
  });

  command("quiet", async (ctx, user, arg) => {
    const [from, to] = arg.split(/\s+/).map(Number);
    const valid = (hour: number | undefined): hour is number => Number.isInteger(hour) && hour! >= 0 && hour! <= 23;
    if (!valid(from) || !valid(to)) return ctx.reply(`quiet from ${user.quietStart}:00 to ${user.quietEnd}:00. change with /quiet 23 8.`);
    await updateUser(deps.db, user.id, { quietStart: from, quietEnd: to });
    return ctx.reply(`quiet from ${from}:00 to ${to}:00.`);
  });

  command("usage", async (ctx, user) => {
    const spent = await spentToday(deps.db, user, deps.clock());
    return ctx.reply(`today: $${spent.toFixed(4)}. once that passes $${user.dailyCapUsd.toFixed(2)} i stop writing first for the day (replies and reminders keep working). change with /cap.`);
  });

  command("cap", async (ctx, user, arg) => {
    const value = Number(arg);
    if (!Number.isFinite(value) || value < 0 || value > 100) return ctx.reply("send a number in dollars, e.g. /cap 0.5");
    await updateUser(deps.db, user.id, { dailyCapUsd: value });
    return ctx.reply(`cap set to $${value.toFixed(2)} a day.`);
  });

  // ---- conversation ----

  const pending = new Map<string, { texts: string[]; timer: NodeJS.Timeout }>();
  const chains = new Map<string, Promise<void>>();

  async function runTurn(user: User, chatId: number, text: string): Promise<void> {
    const typing = setInterval(() => void bot.api.sendChatAction(chatId, "typing").catch(() => undefined), 4500);
    void bot.api.sendChatAction(chatId, "typing").catch(() => undefined);
    try {
      const result = await handleTurn(deps, user.id, text);
      clearInterval(typing);
      await sendBubbles(chatId, result.bubbles);
      if (!result.problem) void runExtraction(deps, user.id, { memoryIds: result.recalledIds }).catch((error) => console.warn("[extraction]", error));
    } catch (error) {
      console.error("[turn] failed", error);
      await bot.api.sendMessage(chatId, "something broke on my side. try that again in a moment.").catch(() => undefined);
    } finally {
      clearInterval(typing);
    }
  }

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const user = await userOf(ctx);
    if (!user) return;
    const chatId = ctx.chat.id;
    const entry = pending.get(user.id) ?? { texts: [], timer: setTimeout(() => undefined, 0) };
    clearTimeout(entry.timer);
    entry.texts.push(ctx.message.text);
    entry.timer = setTimeout(() => {
      pending.delete(user.id);
      const text = entry.texts.join("\n");
      // One turn at a time per person, in order.
      const next = (chains.get(user.id) ?? Promise.resolve()).then(() => runTurn(user, chatId, text));
      chains.set(user.id, next.finally(() => { if (chains.get(user.id) === next) chains.delete(user.id); }));
    }, DEBOUNCE_MS);
    pending.set(user.id, entry);
  });

  bot.on("message", async (ctx) => {
    if (ctx.message.text || !(await userOf(ctx))) return;
    await ctx.reply("i can only read text for now.");
  });

  bot.catch((error) => console.error("[telegram]", error.message));
  return { bot, outbound };
}
