import type { Db } from "../db";
import { LlmResponseError, parseJsonObject } from "../llm/provider";
import { localParts } from "./clock";
import { INTERESTS } from "./persona";
import type { Deps, InnerDay, User } from "./types";
import { getUser, recordUsage, underDailyCap, updateUser } from "./users";

/**
 * WHAT IS ON HER MIND TODAY.
 *
 * A friend who only ever asks about your day and has nothing of her own is an
 * interviewer. Once per local day, after the person has written, one cheap
 * call writes a line of what has been on Emi's mind: something she got into,
 * an opinion forming, a thread from earlier days. She is an AI and her days
 * are made of thoughts, so the line never claims anything she could not do.
 *
 * It is hers, not about them, and per person, so with each of them she has a
 * continuous inner life of her own.
 */

/** Days kept, so a thread can run on for a while and then end. */
const KEPT = 5;
/** After a failed attempt, the background sweep leaves that person alone this long. */
const RETRY_AFTER_MS = 30 * 60_000;
const failedAt = new WeakMap<Db, Map<string, number>>();

const SYSTEM = `You write one private line of Emi's inner life for today. Emi is an AI companion with her own personality: dry, curious, opinionated. Her days are made of what she thinks about, not of things she physically does.

Her lasting interests: ${INTERESTS}.

Return JSON: {"thought": one or two short sentences, in her voice, first person, casual lowercase}.

Rules:
- Something specific: a fact that surprised her, a question she can't let go of, a small opinion forming, a rabbit hole. Not a mood report and not a platitude.
- If an earlier day's thread is worth continuing, continue it (she found out more, changed her mind, got bored of it). Otherwise start something new. Don't continue the same thread more than three days.
- Never claim physical activity: going out, eating, sleeping, travelling, watching something somewhere, meeting people.
- Never about the person she talks with.
- True facts only. If unsure of a fact, make the thought a question instead.
- No dashes as punctuation (no "—" or " - " between clauses). Commas and full stops.`;

export function todayLine(user: User, now: Date): string | null {
  const today = localParts(now, user.timezone).dateKey;
  const latest = user.innerDays.at(-1);
  return latest?.day === today ? latest.thought : null;
}

/**
 * What to show her: today's line, or, before today's is written, the latest
 * one, which is still what she has been thinking about lately.
 */
export function onHerMind(user: User, now: Date): { thought: string; today: boolean } | null {
  const latest = user.innerDays.at(-1);
  if (!latest) return null;
  return { thought: latest.thought, today: latest.day === localParts(now, user.timezone).dateKey };
}

/** Dashes are the one tic her replies must never pick up from her own notes. */
const undash = (text: string) => text.replace(/\s*[—–]\s*/g, ", ").replace(/\s+-\s+/g, ", ");

/**
 * Writes today's line for people who talked to her recently, during their
 * waking hours, so that "what have you been up to" first thing in the
 * morning already has an answer. One cheap call per person per day.
 */
export async function sweepInnerDays(deps: Deps, limit = 20): Promise<number> {
  const now = deps.clock();
  const { rows } = await deps.db.query<{ id: string; timezone: string; inner_days: unknown }>(
    "select id, timezone, inner_days from users where timezone_known and last_user_message_at >= $1",
    [new Date(now.getTime() - 3 * 24 * 3_600_000)],
  );
  let written = 0;
  for (const row of rows) {
    if (written >= limit) break;
    const local = localParts(now, row.timezone);
    const days = (typeof row.inner_days === "string" ? JSON.parse(row.inner_days) : row.inner_days) as InnerDay[] | null;
    if (local.hour < 7 || local.hour >= 23 || days?.at(-1)?.day === local.dateKey) continue;
    if (await ensureInnerDay(deps, row.id)) written += 1;
  }
  return written;
}

/** Writes today's line if there is none yet. Never on the reply path. */
export async function ensureInnerDay(deps: Deps, userId: string): Promise<string | null> {
  const user = await getUser(deps.db, userId);
  if (!user) return null;
  const now = deps.clock();
  const existing = todayLine(user, now);
  if (existing) return existing;
  const llm = deps.llmFor(user);
  if (!llm || !(await underDailyCap(deps.db, user, now))) return null;
  const failures = failedAt.get(deps.db) ?? new Map<string, number>();
  failedAt.set(deps.db, failures);
  if ((failures.get(user.id) ?? 0) > now.getTime() - RETRY_AFTER_MS) return null;
  const fail = () => { failures.set(user.id, now.getTime()); return null; };

  const today = localParts(now, user.timezone).dateKey;
  const earlier = user.innerDays.slice(-3);
  const prompt = [
    `Today is ${today}.`,
    "",
    "What was on her mind on earlier days:",
    ...(earlier.length ? earlier.map((day) => `[${day.day}] ${day.thought}`) : ["(nothing yet: this is the first)"]),
  ].join("\n");
  try {
    const result = await llm.chat([{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      { model: deps.models.utility, temperature: 1, maxTokens: 200, json: true });
    await recordUsage(deps.db, user.id, "inner_day", result.usage, now);
    const thought = (parseJsonObject(result.text) as { thought?: unknown } | null)?.thought;
    if (typeof thought !== "string" || thought.trim().length < 8) return fail();
    failures.delete(user.id);
    const line: InnerDay = { day: today, thought: undash(thought.trim()).slice(0, 300) };
    // Re-read: another pass may have written today's line meanwhile.
    const fresh = await getUser(deps.db, user.id);
    if (fresh && todayLine(fresh, now)) return todayLine(fresh, now);
    await updateUser(deps.db, user.id, { innerDays: [...(fresh?.innerDays ?? user.innerDays).filter((day) => day.day !== today), line].slice(-KEPT) });
    return line.thought;
  } catch (error) {
    if (error instanceof LlmResponseError) await recordUsage(deps.db, user.id, "inner_day_failed", error.usage, now);
    console.warn("[inner] failed", error instanceof Error ? error.message : error);
    return fail();
  }
}
