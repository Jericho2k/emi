import { vectorLiteral, type Db } from "../../db";
import { LlmResponseError, parseJsonObject } from "../../llm/provider";
import { ConversationReset, inConversation } from "../conversation";
import { describeDay, localParts } from "../clock";
import { IMAGE_REFERENCES_SQL } from "../images";
import { messageContent } from "../message";
import { historyWindow } from "../prompt";
import type { Deps, User } from "../types";
import { getUser, messageCount, recordUsage, updateUser } from "../users";

/**
 * THE PERMANENT TIMELINE: WRITTEN ONCE, NEVER REWRITTEN.
 *
 * The writer sees the newest messages in full. When a block of older messages
 * leaves that window, one cheap call writes an ARC for exactly that block: a
 * short chapter summary and a one-line headline. The timeline is built from
 * those:
 *
 *   newest arcs        shown in full, a short paragraph each
 *   a run of arcs      folded ONCE into a level 1 chapter
 *   a run of chapters  folded ONCE into a level 2 part, and so on
 *
 * A rolling summary that is rewritten on every pass turns into a game of
 * telephone: by the fiftieth rewrite old events have merged, swapped order or
 * dropped out. Here nothing above the newest lines is ever summarised again,
 * so the sequence of events cannot drift, and the size grows only
 * logarithmically with the length of the chat.
 *
 * The design is Afterglow's. What changes is the clock: lines are dated on the
 * person's real calendar instead of a story day.
 */

/** Arcs or entries folded into one entry of the level above. */
export const FOLD_SIZE = 6;
/** How many of the newest items at each level stay unfolded, for detail. */
export const KEEP_RECENT = 2;
const MAX_LEVEL = 5;
/** The most messages one arc may cover. A long backlog is written in several passes. */
const MAX_BATCH = 60;
/** Fewer than this and the block is left to grow. */
const MIN_BATCH = 10;

export interface Span {
  startMessageId: number;
  endMessageId: number;
  startedAt: Date;
  endedAt: Date;
}
export interface Arc extends Span {
  id: string;
  headline: string;
  summary: string;
}
export interface TimelineEntry extends Span {
  level: number;
  summary: string;
}
export interface TimelineLine extends Span {
  /** 0 for an arc headline, otherwise the entry's level. */
  level: number;
  text: string;
}

type Row = Record<string, any>;
const toDate = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));
const span = (row: Row): Span => ({
  startMessageId: Number(row.start_message_id), endMessageId: Number(row.end_message_id),
  startedAt: toDate(row.started_at), endedAt: toDate(row.ended_at),
});
const byEnd = (a: Span, b: Span) => a.endMessageId - b.endMessageId;

/**
 * The visible timeline, oldest first.
 *
 * Coverage is decided from the top down: the highest level's entries are
 * shown, then each lower level shows only what lies beyond everything above
 * it, and finally the arcs beyond every entry appear as headlines.
 */
export function timelineView(entries: TimelineEntry[], arcs: Arc[]): TimelineLine[] {
  const lines: TimelineLine[] = [];
  let covered = 0;
  const top = entries.reduce((max, entry) => Math.max(max, entry.level), 0);
  for (let level = top; level >= 1; level -= 1) {
    for (const entry of entries.filter((item) => item.level === level).sort(byEnd)) {
      if (entry.endMessageId <= covered) continue;
      lines.push({ ...entry, text: entry.summary });
      covered = entry.endMessageId;
    }
  }
  for (const arc of [...arcs].sort(byEnd)) {
    if (arc.endMessageId <= covered) continue;
    // In full, not as its headline: a one-line headline drops the amounts,
    // names and dates, and the recent past is where people ask for them.
    lines.push({ ...arc, level: 0, text: arc.summary });
    covered = arc.endMessageId;
  }
  return lines;
}

function dateLabel(line: Span, tz: string): string {
  const from = localParts(line.startedAt, tz), to = localParts(line.endedAt, tz);
  if (from.dateKey === to.dateKey) return `${describeDay(line.startedAt, tz)} ${from.year}`;
  return `${describeDay(line.startedAt, tz)}${from.year === to.year ? "" : ` ${from.year}`} to ${describeDay(line.endedAt, tz)} ${to.year}`;
}

/** The timeline as the writer reads it. Empty when there is none yet. */
export function renderTimeline(lines: TimelineLine[], tz: string): string {
  if (!lines.length) return "";
  return [
    "# Your history together",
    "The record of your earlier conversations with them, oldest first. The recent messages below continue from where it ends.",
    ...lines.map((line) => `- [${dateLabel(line, tz)}] ${line.text}`),
  ].join("\n");
}

async function loadArcs(db: Db, userId: string): Promise<Arc[]> {
  const { rows } = await db.query<Row>(
    "select id, start_message_id, end_message_id, started_at, ended_at, headline, summary from arcs where user_id = $1 order by end_message_id", [userId],
  );
  return rows.map((row) => ({ ...span(row), id: row.id, headline: row.headline, summary: row.summary }));
}

async function loadEntries(db: Db, userId: string): Promise<TimelineEntry[]> {
  const { rows } = await db.query<Row>(
    "select level, start_message_id, end_message_id, started_at, ended_at, summary from timeline_entries where user_id = $1 order by end_message_id", [userId],
  );
  return rows.map((row) => ({ ...span(row), level: Number(row.level), summary: row.summary }));
}

export async function timelineFor(db: Db, user: User): Promise<string> {
  const arcs = await loadArcs(db, user.id);
  if (!arcs.length) return "";
  return renderTimeline(timelineView(await loadEntries(db, user.id), arcs), user.timezone);
}

/**
 * Chapters that have been folded away, brought back in full because the
 * current message is about them. Unfolded arcs are already in the timeline
 * in full, so only folded ones are looked up.
 */
export async function relevantArcs(db: Db, userId: string, vector: number[], floor = 0.35, limit = 2): Promise<Arc[]> {
  const { rows } = await db.query<Row>(
    `select id, start_message_id, end_message_id, started_at, ended_at, headline, summary, 1 - (embedding <=> $2::vector) as similarity
       from arcs where user_id = $1 and embedding is not null
        and end_message_id <= coalesce((select max(end_message_id) from timeline_entries where user_id = $1), 0)
      order by embedding <=> $2::vector limit $3`,
    [userId, vectorLiteral(vector), limit],
  );
  return rows.filter((row) => Number(row.similarity) >= floor)
    .map((row) => ({ ...span(row), id: row.id, headline: row.headline, summary: row.summary }))
    .sort(byEnd);
}

export function arcLine(arc: Arc, tz: string): string {
  return `- [${dateLabel(arc, tz)}] ${arc.summary}`;
}

const ARC_SYSTEM = `You keep the long-term record of one ongoing chat between Emi, a companion and assistant, and the person she talks with. You are given a stretch of older conversation that is about to leave Emi's view. Write down what she should still know about it months from now.

Return JSON: {"headline": "...", "summary": "..."}

"headline": one sentence, at most 25 words, saying what this stretch was about.
"summary": at most 120 words, past tense. What happened in their life and between the two of them. Keep every concrete fact exactly as stated: amounts and prices, dates and durations, names of people, pets and places, who offered or decided what, and how it turned out. These details are what they will ask about later, and a vague phrase like "discussed costs" loses them. Also say how they felt about it. Where Emi helped with a task, say what the task was and how it ended in one clause; never reproduce the content (no code, no long answers, no lists).

Rules: only what the messages say, no speculation. No passwords, keys, card numbers or addresses. Refer to the person as "they" and to Emi by name. Write in the language the person mostly used.`;

const FOLD_SYSTEM = `You are compressing the long-term record of one ongoing chat between Emi, a companion and assistant, and the person she talks with. You are given several consecutive entries of that record, oldest first. Merge them into one.

Return JSON: {"summary": "..."}

At most 130 words, past tense, in chronological order. Keep what still matters long after: names, decisions, outcomes, turning points, lasting changes in their life or between the two of them. Drop one-off tasks and small talk. Only what the entries say. Refer to the person as "they" and to Emi by name. Keep the language of the entries.`;

const running = new WeakSet<Db>();
const retryAfter = new WeakMap<Db, number>();

export interface ConsolidationResult {
  arcs: number;
  folds: number;
}

/**
 * Writes an arc for the messages that have left the writer's window, then
 * folds the timeline if a level has grown long enough. Safe to call often:
 * it does nothing, and costs nothing, until a block has actually left.
 */
export async function runConsolidation(deps: Deps, userId: string): Promise<ConsolidationResult | null> {
  return inConversation(deps, userId, (deps) => consolidateOnce(deps, userId));
}

async function consolidateOnce(deps: Deps, userId: string): Promise<ConsolidationResult | null> {
  if (running.has(deps.db) || (retryAfter.get(deps.db) ?? 0) > deps.clock().getTime()) return null;
  running.add(deps.db);
  try {
    return await consolidate(deps, userId);
  } catch (error) {
    if (error instanceof ConversationReset) throw error;
    // A broken provider must not become a paid request every tick.
    retryAfter.set(deps.db, deps.clock().getTime() + 10 * 60_000);
    console.warn("[timeline] failed", error instanceof Error ? error.message : error);
    return null;
  } finally {
    running.delete(deps.db);
  }
}

async function consolidate(deps: Deps, userId: string): Promise<ConsolidationResult | null> {
  const { db } = deps;
  const user = await getUser(db, userId);
  if (!user) return null;

  // Exactly the messages the writer no longer sees, and nothing it still does.
  const windowSize = historyWindow(await messageCount(db, userId));
  const first = await db.query<{ id: string }>(
    "select id from messages where user_id = $1 order by id desc offset $2 limit 1", [userId, Math.max(0, windowSize - 1)],
  );
  const firstVisible = Number(first.rows[0]?.id ?? 0);
  const { rows } = await db.query<Row>(
    `select messages.*, ${IMAGE_REFERENCES_SQL} from messages where user_id = $1 and id > $2 and id < $3 order by id asc limit $4`,
    [userId, user.consolidatedThrough, firstVisible, MAX_BATCH],
  );
  if (rows.length < MIN_BATCH) return { arcs: 0, folds: 0 };

  const now = deps.clock();
  const last = rows[rows.length - 1]!;
  // What the app displayed for a command is not conversation.
  const spoken = rows.filter((row) => row.kind !== "command");
  if (spoken.length < 2) {
    await updateUser(db, userId, { consolidatedThrough: Number(last.id) });
    return { arcs: 0, folds: 0 };
  }
  const llm = deps.llmFor(user);
  if (!llm) return null; // Left for when they have a key.

  const transcript = spoken.map((row) => {
    const at = localParts(toDate(row.created_at), user.timezone);
    const content = messageContent({ id: Number(row.id), role: row.role, content: row.content, images: row.images, kind: row.kind, replyTo: row.reply_context ?? undefined, agendaItemId: null, createdAt: toDate(row.created_at) });
    return `[${at.dateKey} ${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}] ${row.role === "user" ? "THEM" : "EMI"}: ${content.slice(0, 1200)}`;
  }).join("\n");

  let result;
  try {
    result = await llm.chat([{ role: "system", content: ARC_SYSTEM }, { role: "user", content: transcript }],
      { model: deps.models.utility, temperature: 0.2, maxTokens: 700, json: true });
  } catch (error) {
    if (error instanceof ConversationReset) throw error;
    if (error instanceof LlmResponseError) await recordUsage(db, userId, "timeline_failed", error.usage, now);
    throw error;
  }
  await recordUsage(db, userId, "timeline", result.usage, now);
  const data = parseJsonObject(result.text) as { headline?: unknown; summary?: unknown } | null;
  const summary = typeof data?.summary === "string" ? data.summary.trim().slice(0, 1200) : "";
  const headline = typeof data?.headline === "string" ? data.headline.trim().slice(0, 300) : "";
  if (!summary || !headline) throw new Error("arc came back without a summary or headline");

  let embedding: number[] | null = null;
  try {
    const embedded = await llm.embed([summary], deps.models.embedding);
    embedding = embedded.vectors[0] ?? null;
    await recordUsage(db, userId, "embed_arc", embedded.usage, now);
  } catch {
    // The arc still appears in the timeline; it just cannot be recalled in full.
  }
  await db.query(
    `insert into arcs (user_id, start_message_id, end_message_id, started_at, ended_at, headline, summary, embedding, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9)`,
    [userId, Number(rows[0]!.id), Number(last.id), toDate(rows[0]!.created_at), toDate(last.created_at), headline, summary, embedding ? vectorLiteral(embedding) : null, now],
  );
  await updateUser(db, userId, { consolidatedThrough: Number(last.id) });
  return { arcs: 1, folds: await fold(deps, user) };
}

/** Folds the oldest run at each level that has grown past what stays unfolded. */
async function fold(deps: Deps, user: User): Promise<number> {
  const { db } = deps;
  const llm = deps.llmFor(user);
  if (!llm) return 0;
  let folds = 0;
  for (let level = 0; level < MAX_LEVEL; level += 1) {
    const entries = await loadEntries(db, user.id);
    const coveredAbove = entries.filter((entry) => entry.level === level + 1).reduce((max, entry) => Math.max(max, entry.endMessageId), 0);
    const items: Array<Span & { text: string }> = level === 0
      ? (await loadArcs(db, user.id)).map((arc) => ({ ...arc, text: arc.summary }))
      : entries.filter((entry) => entry.level === level).map((entry) => ({ ...entry, text: entry.summary }));
    const open = items.filter((item) => item.endMessageId > coveredAbove).sort(byEnd);
    if (open.length < FOLD_SIZE + KEEP_RECENT) break;

    const run = open.slice(0, FOLD_SIZE);
    const now = deps.clock();
    const result = await llm.chat(
      [{ role: "system", content: FOLD_SYSTEM }, { role: "user", content: run.map((item, index) => `${index + 1}. [${dateLabel(item, user.timezone)}] ${item.text}`).join("\n") }],
      { model: deps.models.utility, temperature: 0.2, maxTokens: 700, json: true },
    );
    await recordUsage(db, user.id, "timeline_fold", result.usage, now);
    const data = parseJsonObject(result.text) as { summary?: unknown } | null;
    const summary = typeof data?.summary === "string" ? data.summary.trim().slice(0, 1400) : "";
    if (!summary) throw new Error("fold came back without a summary");
    const head = run[0]!, tail = run[run.length - 1]!;
    await db.query(
      `insert into timeline_entries (user_id, level, start_message_id, end_message_id, started_at, ended_at, summary, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [user.id, level + 1, head.startMessageId, tail.endMessageId, head.startedAt, tail.endedAt, summary, now],
    );
    folds += 1;
  }
  return folds;
}

/** People with enough unread history that a block may have left the window. */
export async function sweepConsolidation(deps: Deps): Promise<void> {
  const { rows } = await deps.db.query<{ id: string }>(
    `select u.id from users u
      where (select count(*) from messages m where m.user_id = u.id and m.id > u.consolidated_through) >= 50 limit 20`,
  );
  for (const row of rows) await runConsolidation(deps, row.id);
}
