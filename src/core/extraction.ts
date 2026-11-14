import { z } from "zod";
import type { Db } from "../db";
import { LlmResponseError, parseJsonObject } from "../llm/provider";
import { planWindows } from "./agenda/policy";
import { awaitingReaction, pendingItems, setStatus, upsertAgendaItem } from "./agenda/store";
import { describeMoment, hasTimeOfDay, isValidTimeZone, localParts, localToUtc } from "./clock";
import { decide, evidenceIsExact, looksSensitive, type Candidate } from "./memory/reconcile";
import { activeMemories, deleteMemory, insertMemory, memoriesByIds, nearestMemories, supersedeMemory, type Neighbour } from "./memory/store";
import { messageContent } from "./message";
import { applySignals, type Signal } from "./bond";
import { MOOD_LABELS } from "./persona";
import { USER_MEMORY_KINDS, type AgendaItem, type Deps, type Memory, type MemoryKind, type UserMemoryKind, type User } from "./types";
import { getUser, lowerInitiative, messagesAfter, recordUsage, updateUser } from "./users";

/**
 * THE ONE BACKGROUND CALL.
 *
 * After a reply is sent, a single cheap call reads what the person just said
 * and proposes everything worth keeping: facts, events, things to follow up
 * on, things that are now settled, how they reacted to a check-in, Emi's mood.
 *
 * The model only proposes. Every proposal is checked here in code: a fact
 * needs an exact quote, a time is converted and bounded by the application,
 * a replacement is allowed only by the reconciliation rules. A failure of any
 * kind leaves the conversation untouched.
 */

const SYSTEM = `You maintain the memory of Emi, a companion and assistant who talks with one person in a single ongoing chat. You read the newest messages and report, as JSON, what is worth keeping. You never write to the person.

Small talk, reactions and one-off questions contain nothing worth keeping, and for those empty lists are the right answer. But when they tell you something about their life, keep it with its concrete details: amounts and prices, dates and durations, names of people, pets and places, who offered or decided what. "The surgery costs 1800 euros" and "their sister Anna offered to lend half" are each worth a memory; a friend who forgot the figure a week later was not listening.

Return one JSON object with these fields:

"memories": durable things THE PERSON said about themselves or their life. Each:
  {"kind": "identity" | "boundary" | "relationship" | "preference" | "state" | "event",
   "content": one plain sentence that stands on its own, in the language they used, with the concrete details kept. Refer to the person as "they"; never write their own name as the subject,
   "evidence": an EXACT quote copied from one of their messages,
   "occurred_on": "YYYY-MM-DD" for an event when the day is clear, else null,
   "supersedes": the id (like "m3") of a listed memory this replaces because it changed, else null,
   "storyline": a short lowercase tag if it belongs to an ongoing thread in their life ("job search"), else null}
  identity = who they are (name, job, city). boundary = something they asked Emi to do or never do. relationship = people in their life. preference = lasting likes and dislikes. state = an ongoing situation that can change (looking for a job, training for a race). event = something that happened on a particular day.
  Only what they stated. Temporary command probes and integration-test exchanges are not durable personal facts. No guesses, nothing Emi said, no one-off questions they asked, no passwords, keys, card numbers or addresses. Do not repeat a memory that is already listed.

"agenda": things in THEIR FUTURE that Emi should come back to. Each:
  {"kind": "reminder" | "followup",
   "about": a few words,
   "reason": why Emi cares, in human terms,
   "importance": 1 | 2 | 3,
   "when": "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD" in THEIR local time, or null if they gave no day,
   "evidence": an EXACT quote from their message,
   "closes_when": what would make this settled}
  reminder = they explicitly asked to be reminded or told at a time; "when" must include the time. followup = a concrete event in their life outside this conversation (an interview, a trip, a doctor's visit) that a friend would ask about afterwards; "when" is when THEIR event happens, never when Emi should write.
  Do not create follow-ups for immediate conversational steps, trying a command, debugging Emi, checking what she can see, or one-off questions/tasks. Explicit requests to be reminded are still reminders, even about a technical task. If a personal event has no stated day, keep an appropriate memory instead of guessing an agenda date.
  importance: 1 = idle curiosity, 2 = they care about it, 3 = it clearly matters a lot to them.
  Work out dates from the current date and time given. If the day is ambiguous, use null.

"agenda_close": pending agenda items (by id like "a2") that are now settled because the person talked about how it went, cancelled it, or said to drop it. Each {"id": "a2", "note": short}.

"forget": stored memories (by id like "m3") that the person explicitly asked Emi to forget, or said are wrong and should be removed. Each {"id": "m3", "evidence": an EXACT quote of that request}. Only on an explicit request; a changed fact is "supersedes", not this.

"emi_memories": durable things about EMI herself or about the two of them. Most exchanges have none. Each:
  {"kind": "self" | "us",
   "content": one plain sentence that stands on its own,
   "evidence": an EXACT quote copied from the messages (see below for whose),
   "supersedes": the id of a listed self/us memory this replaces because it changed, else null}
  self = something Emi said about herself that she should stay consistent with later: an opinion or taste she stated, a promise or plan she made to them, a story she told about her own thinking. Write it about Emi ("Emi thinks the Oxford comma is non-negotiable", "Emi promised to quiz them on Spanish verbs on Friday"). The evidence must be quoted from EMI's messages.
  us = something that belongs to the two of them: a nickname or pet name either uses for the other, a running joke or bit, a shared moment worth remembering (a first "i miss you", a date-like evening of talking), a small ritual like saying goodnight. Write it plainly ("They call Emi 'gremlin'", "Running joke: their plant Gerald is plotting against them"). The evidence may be quoted from either side.
  A fact about their life is an ordinary memory, not "us": it becomes "us" only once the two of them have made it a bit, a name or a shared reference.
  Never task content (code, explanations, answers she gave), never small talk, nothing that only mattered in the moment.

"bond": how this exchange moved the relationship, or null if it did not (the usual case). {"warmth": -1 | 0 | 1, "trust": -1 | 0 | 1, "irritation": -1 | 0 | 1, "reason": a few words}.
  warmth 1 = a genuinely warm, fun or romantic exchange (they flirted back, were sweet to her, laughed with her, thanked her and meant it); -1 = they were cold or dismissive toward her, or turned her flirting down.
  trust 1 = they confided something personal or vulnerable, or came back to say her advice helped; -1 only if they deliberately deceived or manipulated her.
  irritation 1 = they were rude, insulting or demeaning TO HER (frustration with a bug, the world or themselves does not count); -1 = they apologised or clearly made up.

"ping_reaction": only when a recent check-in from Emi is shown. How they took it: "satisfied" (they answered it), "later" (not now, but fine to ask again), "brushoff" (they don't want to be checked on), or "none" (their message is unrelated).

"mood": how the exchange leaves EMI feeling, or null if nothing changed. {"label": one of ${MOOD_LABELS.join(", ")}, "reason": a few words}.

"timezone": an IANA timezone like "Europe/Berlin" if they stated where they live or are right now, else null.

"display_name": what they asked to be called, if they said so, else null.`;

const text = (max: number) => z.string().trim().min(1).max(max);
const MemorySchema = z.object({
  kind: z.enum(USER_MEMORY_KINDS as [UserMemoryKind, ...UserMemoryKind[]]),
  content: text(300),
  evidence: text(500),
  occurred_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  supersedes: z.string().nullish(),
  storyline: z.string().trim().max(40).nullish(),
});
const AgendaSchema = z.object({
  kind: z.enum(["reminder", "followup"]),
  about: text(160),
  reason: z.string().trim().max(200).nullish(),
  importance: z.coerce.number().int().min(1).max(3).catch(1),
  when: z.string().nullish(),
  evidence: text(500),
  closes_when: z.string().trim().max(200).nullish(),
});
const SharedSchema = z.object({
  kind: z.enum(["self", "us"]),
  content: text(300),
  evidence: text(500),
  supersedes: z.string().nullish(),
});
const SignalSchema = z.coerce.number().int().min(-1).max(1).catch(0).transform((value) => value as Signal);
const BondSchema = z.object({
  warmth: SignalSchema.default(0), trust: SignalSchema.default(0), irritation: SignalSchema.default(0),
  reason: z.string().trim().max(80).nullish(),
});
const CloseSchema = z.object({ id: z.string(), note: z.string().max(200).nullish() });
const ForgetSchema = z.object({ id: z.string(), evidence: text(500) });

const list = <T>(schema: z.ZodType<T>, value: unknown, max: number): T[] =>
  (Array.isArray(value) ? value : []).map((item) => schema.safeParse(item)).flatMap((r) => (r.success ? [r.data] : [])).slice(0, max);

const running = new Set<string>();
// Failed extraction keeps its cursor, but a persistent provider outage must not
// become a paid request every 30 seconds. Backoff is per database and person.
const failures = new WeakMap<Db, Map<string, { count: number; retryAt: number }>>();
const letters = (value: string) => (value.match(/\p{L}/gu) ?? []).length;

export interface ExtractionSummary {
  memoriesAdded: number;
  memoriesSuperseded: number;
  agendaCreated: number;
  agendaClosed: number;
  memoriesForgotten: number;
}

export async function runExtraction(deps: Deps, userId: string, hint: { memoryIds?: string[] } = {}): Promise<ExtractionSummary | null> {
  if (running.has(userId) || (failures.get(deps.db)?.get(userId)?.retryAt ?? 0) > deps.clock().getTime()) return null;
  running.add(userId);
  try {
    const summary = await extract(deps, userId, hint.memoryIds ?? []);
    if (summary) failures.get(deps.db)?.delete(userId);
    return summary;
  } finally {
    running.delete(userId);
  }
}

async function extract(deps: Deps, userId: string, hintIds: string[]): Promise<ExtractionSummary | null> {
  const { db } = deps;
  let user = await getUser(db, userId);
  if (!user) return null;
  const batch = await messagesAfter(db, userId, user.extractedThrough);
  const last = batch[batch.length - 1];
  if (!last) return null;
  const theirs = batch.filter((message) => message.role === "user" && message.kind !== "command");
  const source = theirs.map((message) => message.content).join("\n");
  // Her own words, for what she said about herself. Commands are the app's, not hers.
  const hers = batch.filter((message) => message.role === "emi" && message.kind !== "command").map((message) => message.content).join("\n");
  const now = deps.clock();
  const summary: ExtractionSummary = { memoriesAdded: 0, memoriesSuperseded: 0, agendaCreated: 0, agendaClosed: 0, memoriesForgotten: 0 };
  const done = async () => { await updateUser(db, userId, { extractedThrough: last.id }); return summary; };

  const awaiting = await awaitingReaction(db, userId, now);
  // "ok", "lol", "thanks": nothing to learn, so nothing to pay for.
  if (!theirs.length || (letters(source) < 8 && !awaiting)) return done();

  const llm = deps.llmFor(user);
  if (!llm) return null; // Left unread on purpose: it is picked up once they have a key.

  const all = await activeMemories(db, userId);
  const shown = new Map<string, Memory>();
  for (const memory of [
    ...all.filter((m) => m.pinned || m.kind === "identity" || m.kind === "boundary"),
    ...(await memoriesByIds(db, userId, hintIds)).filter((m) => m.status === "active"),
    ...all.slice(-8),
  ].slice(0, 30)) shown.set(memory.id, memory);
  const memoryLabels = [...shown.values()].map((memory, index) => ({ label: `m${index + 1}`, memory }));
  const pending = (await pendingItems(db, userId)).slice(0, 12);
  const agendaLabels = pending.map((item, index) => ({ label: `a${index + 1}`, item }));

  const prompt = [
    user.timezoneKnown
      ? `Current date and time where they are: ${describeMoment(now, user.timezone)} (${localParts(now, user.timezone).dateKey}).`
      : `Current date and time: ${describeMoment(now, "UTC")} UTC. Their timezone is NOT known: give "when" only for dates, never for reminders, unless they state a timezone in these messages.`,
    "",
    "Memories already stored:",
    ...(memoryLabels.length ? memoryLabels.map(({ label, memory }) => `${label} [${memory.kind}] ${memory.content}`) : ["(none)"]),
    "",
    "Pending agenda:",
    ...(agendaLabels.length ? agendaLabels.map(({ label, item }) => `${label} [${item.kind}] ${item.about}${item.closesWhen ? ` (settled when: ${item.closesWhen})` : ""}`) : ["(none)"]),
    ...(awaiting ? ["", `Emi recently checked in about: "${awaiting.about}". Report ping_reaction.`] : []),
    "",
    "Newest messages:",
    ...batch.filter((message) => message.kind !== "command").map((message) => `${message.role === "user" ? "THEM" : "EMI"}: ${messageContent(message).slice(0, 6000)}`),
  ].join("\n");

  let data: Record<string, unknown>;
  try {
    const result = await llm.chat([{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      { model: deps.models.utility, temperature: 0.2, maxTokens: 1500, json: true });
    const parsed = parseJsonObject(result.text);
    if (parsed === null) throw new LlmResponseError("Extraction returned invalid JSON", result.usage);
    data = parsed as Record<string, unknown>;
    await recordUsage(db, userId, "extraction", result.usage, now);
  } catch (error) {
    if (error instanceof LlmResponseError) await recordUsage(db, userId, "extraction_failed", error.usage, now);
    const state = failures.get(db) ?? new Map<string, { count: number; retryAt: number }>();
    const count = (state.get(userId)?.count ?? 0) + 1;
    const delay = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(count, 5));
    state.set(userId, { count, retryAt: now.getTime() + delay });
    failures.set(db, state);
    console.warn("[extraction] model call failed", error instanceof Error ? error.message : error, `retry_in_seconds=${delay / 1000}`);
    return null; // Cursor stays unread; a later sweep retries after backoff.
  }

  // Where they are comes first: every time below is read in that timezone.
  if (typeof data.timezone === "string" && isValidTimeZone(data.timezone)) {
    await updateUser(db, userId, { timezone: data.timezone, timezoneKnown: true });
    user = { ...user, timezone: data.timezone, timezoneKnown: true };
  }
  if (typeof data.display_name === "string" && data.display_name.trim() && data.display_name.length <= 40) {
    await updateUser(db, userId, { displayName: data.display_name.trim() });
  }

  const quotedBy = (text: string) => (item: { evidence: string }) => evidenceIsExact(item.evidence, text);
  await applyMemories(deps, user, list(MemorySchema, data.memories, 6).filter(quotedBy(source)), memoryLabels, last.id, now, summary);
  const shared = list(SharedSchema, data.emi_memories, 3)
    .filter((item) => (item.kind === "self" ? quotedBy(hers)(item) : quotedBy(`${source}\n${hers}`)(item)))
    .map((item) => ({ ...item, occurred_on: null, storyline: null }));
  await applyMemories(deps, user, shared, memoryLabels, last.id, now, summary);
  await applyAgenda(deps, user, list(AgendaSchema, data.agenda, 3), source, last.id, now, summary);

  for (const close of list(CloseSchema, data.agenda_close, 6)) {
    const item = agendaLabels.find(({ label }) => label === close.id.trim().toLowerCase())?.item;
    if (!item) continue;
    await setStatus(db, item.id, "done", close.note ?? "settled in conversation", now);
    summary.agendaClosed += 1;
  }
  // "Forget that" in conversation works like /forget, and needs their own words for it.
  for (const forget of list(ForgetSchema, data.forget, 4)) {
    const memory = memoryLabels.find(({ label }) => label === forget.id.trim().toLowerCase())?.memory;
    if (!memory || !evidenceIsExact(forget.evidence, source)) continue;
    await deleteMemory(db, userId, memory.id, now);
    summary.memoriesForgotten += 1;
  }
  if (awaiting) await applyReaction(deps, user, awaiting, String(data.ping_reaction ?? "none"), now);

  const bond = BondSchema.safeParse(data.bond);
  if (bond.success && (bond.data.warmth || bond.data.trust || bond.data.irritation)) {
    const fresh = (await getUser(db, userId)) ?? user;
    await updateUser(db, userId, { bond: applySignals(fresh.bond, { ...bond.data, reason: bond.data.reason ?? undefined }, now) });
  }

  const mood = data.mood as { label?: unknown; reason?: unknown } | null | undefined;
  if (mood && typeof mood.label === "string" && (MOOD_LABELS as readonly string[]).includes(mood.label)) {
    await updateUser(db, userId, { mood: { label: mood.label, reason: typeof mood.reason === "string" ? mood.reason.slice(0, 80) : undefined, at: now.toISOString() } });
  }
  return done();
}

interface ProposedMemory {
  kind: MemoryKind;
  content: string;
  evidence: string;
  occurred_on?: string | null;
  supersedes?: string | null;
  storyline?: string | null;
}

/** Writes memories whose evidence the caller has already checked against the right speaker. */
async function applyMemories(
  deps: Deps, user: User, proposed: ProposedMemory[],
  labels: Array<{ label: string; memory: Memory }>, sourceMessageId: number, now: Date, summary: ExtractionSummary,
): Promise<void> {
  const accepted = proposed.filter((item) => !looksSensitive(item.content) && !looksSensitive(item.evidence));
  if (!accepted.length) return;

  // One embedding call for the whole batch; the vectors both find stored
  // neighbours and are saved with the rows that get written.
  let vectors: Array<number[] | undefined> = [];
  const llm = deps.llmFor(user);
  try {
    if (llm) {
      const embedded = await llm.embed(accepted.map((item) => item.content), deps.models.embedding);
      vectors = embedded.vectors;
      await recordUsage(deps.db, user.id, "embed_memory", embedded.usage, now);
    }
  } catch {
    // Without vectors the memory is still written and still found by words.
  }

  for (const [index, item] of accepted.entries()) {
    const vector = vectors[index] ?? null;
    const neighbours: Neighbour[] = vector
      ? await nearestMemories(deps.db, user.id, vector, 5)
      : labels.map(({ memory }) => ({ memory, similarity: 0 }));
    const candidate: Candidate = {
      kind: item.kind, content: item.content, evidence: item.evidence, occurredOn: item.occurred_on ?? null,
      storyline: item.storyline?.toLowerCase() || null,
      supersedes: labels.find(({ label }) => label === item.supersedes?.trim().toLowerCase())?.memory ?? null,
    };
    const decision = decide(candidate, neighbours);
    if (decision.action === "skip") continue;
    const stored = await insertMemory(deps.db, {
      userId: user.id, kind: candidate.kind, content: candidate.content, evidence: candidate.evidence,
      occurredOn: candidate.kind === "event" ? candidate.occurredOn : null, storyline: candidate.storyline,
      sourceMessageId, embedding: vector, at: now,
    });
    summary.memoriesAdded += 1;
    if (decision.action === "supersede") {
      await supersedeMemory(deps.db, user.id, decision.targetId, stored.id, now);
      summary.memoriesSuperseded += 1;
    }
  }
}

async function applyAgenda(
  deps: Deps, user: User, proposed: z.infer<typeof AgendaSchema>[], source: string,
  sourceMessageId: number, now: Date, summary: ExtractionSummary,
): Promise<void> {
  for (const item of proposed) {
    if (!evidenceIsExact(item.evidence, source)) continue;
    // A clock time means nothing until we know whose clock.
    const when = item.when && user.timezoneKnown ? item.when : null;
    if (item.kind === "reminder" && !when) continue;
    const eventAt = when ? localToUtc(when, user.timezone) : null;
    // Undated chat steps are not durable future events. Do not manufacture a
    // seven-day follow-up from "I'll try /agenda after this message".
    if (item.kind === "followup" && !eventAt) continue;
    // Nothing is scheduled more than a year out on a model's say-so.
    if (eventAt && eventAt.getTime() > now.getTime() + 366 * 86_400_000) continue;
    const windows = planWindows({
      kind: item.kind, importance: item.importance as 1 | 2 | 3, eventAt,
      hasTime: !!when && hasTimeOfDay(when), now, random: deps.random,
    });
    if (!windows) continue;
    await upsertAgendaItem(deps.db, {
      userId: user.id, kind: item.kind, about: item.about, reason: item.reason ?? "", importance: item.importance as 1 | 2 | 3,
      eventAt, closesWhen: item.closes_when ?? "", sourceMessageId, at: now, ...windows,
    });
    summary.agendaCreated += 1;
  }
}

/** What Emi learns from how a check-in landed. */
async function applyReaction(deps: Deps, user: User, item: AgendaItem, reaction: string, now: Date): Promise<void> {
  const { db } = deps;
  if (reaction === "satisfied") {
    await setStatus(db, item.id, "done", "they answered", now);
    await updateUser(db, user.id, { brushoffCount: Math.max(0, user.brushoffCount - 1) });
  } else if (reaction === "later" && item.attempts < 2) {
    const pingAt = new Date(now.getTime() + (20 + deps.random() * 6) * 3_600_000);
    await db.query(
      "update agenda_items set status = 'pending', ping_at = $2, window_end = greatest(window_end, $3), updated_at = $4 where id = $1",
      [item.id, pingAt, new Date(pingAt.getTime() + 12 * 3_600_000), now],
    );
  } else if (reaction === "later") {
    await setStatus(db, item.id, "done", "asked twice, letting it go", now);
  } else if (reaction === "brushoff") {
    await setStatus(db, item.id, "cancelled", "they did not want to be asked", now);
    // Three in a row and she checks in less. Only they can turn her back up.
    if (user.brushoffCount + 1 >= 3) await updateUser(db, user.id, { brushoffCount: 0, initiative: lowerInitiative(user.initiative) });
    else await updateUser(db, user.id, { brushoffCount: user.brushoffCount + 1 });
  }
}
