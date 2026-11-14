import type { Db } from "../db";
import type { ChatMessage } from "../llm/provider";
import { currentIrritation } from "./bond";
import { describeMoment, inQuietHours, localParts, localToUtc } from "./clock";
import { checkConversation, ConversationReset, conversationEffect, inConversation } from "./conversation";
import { PERSONA } from "./persona";
import { joinBubbles, parseReply, renderHistory } from "./prompt";
import type { Deps, Extras, MischiefAct, Outbound, SentExtras, User } from "./types";
import { addMessage, getUser, recentMessages, recordUsage } from "./users";

/**
 * WHAT SHE SENDS BESIDES WORDS.
 *
 * Stickers and voice notes are how she talks; mischief is what she does when
 * she is in a mood. The writer asks for them with tags, and this file alone
 * decides what is allowed: what the channel has, what today's caps leave, and
 * for mischief, that she really is annoyed and the person has not turned it
 * off. Everything she does as mischief lands only on the person's own chat,
 * is recorded, and is undone by her once she has cooled down.
 */

export const STICKERS_PER_DAY = 4;
export const VOICE_PER_DAY = Number(process.env.EMI_VOICE_PER_DAY ?? 3);
export const MISCHIEF_PER_DAY = 2;
/** She only sulks visibly when she is properly put out. */
export const MISCHIEF_FROM_IRRITATION = 0.35;
/** Below this she has cooled down, and undoes what she did. */
export const MAKEUP_BELOW_IRRITATION = 0.12;
/** Nothing she does stays longer than this, cooled down or not. */
const MAX_MISCHIEF_MS = 24 * 3_600_000;
/** A sulk shorter than this would look like a glitch. */
const MIN_MISCHIEF_MS = 20 * 60_000;

/** Stored markers, so she later sees what she sent, and so today's use can be counted. */
export const MARK = {
  sticker: (emoji: string) => `[sent sticker ${emoji}]`,
  voice: (text: string) => `[voice note: ${text}]`,
  pin: (text: string) => `[pinned: ${text}]`,
};

export const normalizeEmoji = (raw: string) => raw.trim().replace(/️/g, "");

function startOfDay(now: Date, tz: string): Date {
  return localToUtc(localParts(now, tz).dateKey, tz) ?? new Date(now.getTime() - 24 * 3_600_000);
}

async function sentToday(db: Db, user: User, now: Date, marker: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "select count(*) as n from messages where user_id = $1 and role = 'emi' and created_at >= $2 and position($3 in content) > 0",
    [user.id, startOfDay(now, user.timezone), marker],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function activeMischief(db: Db, userId: string): Promise<MischiefAct[]> {
  const { rows } = await db.query<Record<string, any>>(
    "select * from mischief_acts where user_id = $1 and undone_at is null order by created_at", [userId],
  );
  return rows.map((row) => ({ id: row.id, userId: row.user_id, kind: row.kind, detail: typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail, createdAt: new Date(row.created_at) }));
}

async function mischiefToday(db: Db, user: User, now: Date): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "select count(*) as n from mischief_acts where user_id = $1 and created_at >= $2", [user.id, startOfDay(now, user.timezone)],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface Allowance {
  stickers: string[];
  voice: boolean;
  pin: boolean;
}

/** What she may send right now. Computed in code; the writer only sees the result. */
export async function allowance(deps: Deps, user: User, now: Date): Promise<Allowance> {
  const kit = deps.expression;
  const stickers = kit && (await sentToday(deps.db, user, now, "[sent sticker ")) < STICKERS_PER_DAY ? kit.stickers() : [];
  const voice = !!kit?.speak && (await sentToday(deps.db, user, now, "[voice note: ")) < VOICE_PER_DAY;
  const pin = user.mischief && currentIrritation(user.bond, now) >= MISCHIEF_FROM_IRRITATION
    && !(await activeMischief(deps.db, user.id)).length && (await mischiefToday(deps.db, user, now)) < MISCHIEF_PER_DAY;
  return { stickers, voice, pin };
}

/** The lines in her private notes saying what she can send besides text. */
export function allowanceLines(allowed: Allowance, voiceTags = false): string[] {
  const lines: string[] = [];
  if (allowed.stickers.length) lines.push(`Stickers you can send (by emoji): ${allowed.stickers.join(" ")}`);
  if (allowed.voice) lines.push(`You can send a voice note.${voiceTags ? " Audio tags like [sighs], [laughs], [whispers] work in it." : ""}`);
  if (allowed.pin) lines.push("You're annoyed enough to pin a sulky status in the chat, if the moment really calls for it.");
  return lines;
}

/** Keeps only what is allowed. A voice note that isn't is still said, as text. */
export function permitted(extras: Extras, allowed: Allowance): { extras: Extras; asText: string[] } {
  const out: Extras = {};
  const asText: string[] = [];
  if (extras.sticker) {
    const emoji = normalizeEmoji(extras.sticker);
    if (allowed.stickers.map(normalizeEmoji).includes(emoji)) out.sticker = emoji;
  }
  if (extras.voice) {
    if (allowed.voice) out.voice = extras.voice;
    else asText.push(extras.voice.replace(/\[[a-z ]{2,20}\]\s*/gi, "").trim());
  }
  if (extras.pin && allowed.pin) out.pin = extras.pin.slice(0, 100);
  return { extras: out, asText: asText.filter(Boolean) };
}

/** Markers for what was actually sent, appended to the stored reply. */
export function storedExtras(sent: SentExtras): string[] {
  return [
    ...(sent.sticker ? [MARK.sticker(sent.sticker)] : []),
    ...(sent.voice ? [MARK.voice(sent.voice)] : []),
    ...(sent.pinned ? [MARK.pin(sent.pinned.text)] : []),
  ];
}

export async function recordMischief(db: Db, userId: string, sent: SentExtras, now: Date): Promise<void> {
  if (!sent.pinned) return;
  await db.query(
    "insert into mischief_acts (user_id, kind, detail, created_at) values ($1, 'pin', $2::jsonb, $3)",
    [userId, JSON.stringify({ ...sent.pinned.detail, text: sent.pinned.text }), now],
  );
}

async function markUndone(db: Db, act: MischiefAct, now: Date): Promise<void> {
  await db.query("update mischief_acts set undone_at = $2 where id = $1", [act.id, now]);
}

/** Undoes everything at once, silently. For /mischief off and /wipe. */
export async function undoAll(deps: Deps, userId: string, outbound: Outbound): Promise<number> {
  const now = deps.clock();
  let undone = 0;
  for (const act of await activeMischief(deps.db, userId)) {
    await outbound.undo?.(userId, act).catch((error) => console.warn("[mischief] undo failed", error instanceof Error ? error.message : error));
    await markUndone(deps.db, act, now);
    undone += 1;
  }
  return undone;
}

/** One short line, in her voice, as she undoes what she did. */
async function makeupLine(deps: Deps, user: User, act: MischiefAct, now: Date): Promise<string[] | null> {
  const llm = deps.llmFor(user);
  if (!llm) return null;
  const messages: ChatMessage[] = [{ role: "system", content: PERSONA }, ...renderHistory(await recentMessages(deps.db, user.id, 12), user.timezone)];
  const notes = [
    "<notes>", "Private notes for you. They cannot see these.",
    `Now, where they are: ${describeMoment(now, user.timezone)}.`,
    `Earlier, annoyed with them, you pinned "${String(act.detail.text ?? "")}" in your chat. You've cooled down and just unpinned it.`,
    "Tell them in one short line, your voice: you're over it, maybe a little grudgingly. No apology essay, no explaining the pin.",
    "</notes>",
  ].join("\n");
  const last = messages[messages.length - 1];
  if (last?.role === "user") last.content += `\n${notes}`;
  else messages.push({ role: "user", content: notes });
  try {
    const reply = await llm.chat(messages, { model: deps.models.writer, temperature: 0.9, maxTokens: 150 });
    await recordUsage(deps.db, user.id, "makeup", reply.usage, now);
    const { bubbles } = parseReply(reply.text, "social");
    return bubbles.length ? bubbles.slice(0, 2) : null;
  } catch (error) {
    if (error instanceof ConversationReset) throw error;
    console.warn("[mischief] make-up line failed", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * She makes up. Each act is undone once she has cooled down, at the latest
 * after a day, and at once if mischief was turned off. Undoing it is a small
 * moment of its own, so she says something, unless it is night for them or
 * they switched mischief off.
 */
export async function sweepMakeups(deps: Deps, outbound: Outbound): Promise<number> {
  const now = deps.clock();
  const { rows } = await deps.db.query<{ user_id: string }>(
    "select distinct user_id from mischief_acts where undone_at is null and created_at <= $1 limit 50",
    [new Date(now.getTime() - MIN_MISCHIEF_MS)],
  );
  let made = 0;
  for (const { user_id: userId } of rows) {
    const done = await inConversation(deps, userId, async (deps) => {
      const user = await getUser(deps.db, userId);
      if (!user) return false;
      const calm = currentIrritation(user.bond, now) < MAKEUP_BELOW_IRRITATION;
      const acts = (await activeMischief(deps.db, userId)).filter((act) =>
        !user.mischief || calm || now.getTime() - act.createdAt.getTime() >= MAX_MISCHIEF_MS);
      if (!acts.length) return false;
      const quiet = inQuietHours(now, user.timezone, user.quietStart, user.quietEnd);
      // Turned off: undo at once, without a word. At night: wait for morning.
      if (user.mischief && quiet) return false;
      const line = user.mischief ? await makeupLine(deps, user, acts[0]!, now) : null;
      await checkConversation(deps.db);
      await conversationEffect(deps.db, async () => {
        for (const act of acts) {
          await outbound.undo?.(userId, act).catch((error) => console.warn("[mischief] undo failed", error instanceof Error ? error.message : error));
          await markUndone(deps.db, act, now);
        }
        if (line) {
          await outbound.send(userId, line);
          await addMessage(deps.db, { userId, role: "emi", content: joinBubbles(line), kind: "proactive", at: now });
        }
      });
      return true;
    });
    if (done) made += 1;
  }
  return made;
}
