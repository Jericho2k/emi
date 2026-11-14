import { z } from "zod";
import { LlmResponseError, parseJsonObject, type ChatMessage } from "../llm/provider";
import { ConversationReset, conversationEffect, inConversation } from "./conversation";
import { DAILY_PING_BUDGET, SILENCE_HOURS } from "./agenda/policy";
import { claimDuePings, expireStale, hasOpenInitiative, setPing, setStatus, upsertAgendaItem } from "./agenda/store";
import { bondLines, bondSnapshot, currentIrritation, IRRITATION_HOLDS_INITIATIVE, type BondSnapshot } from "./bond";
import { ensureInnerDay, onHerMind, sweepInnerDays } from "./inner";
import { allowance, allowanceLines, permitted, storedExtras, sweepMakeups } from "./expression";
import { describeGap, describeMoment, inQuietHours, localParts, localToUtc, nextAwake } from "./clock";
import { runExtraction } from "./extraction";
import { activeMemories } from "./memory/store";
import { sweepConsolidation } from "./memory/timeline";
import { messageContent } from "./message";
import { attachSources, webContext } from "./web";
import { PERSONA } from "./persona";
import { parseReply, renderHistory, storedReply } from "./prompt";
import type { AgendaItem, Deps, Extras, Outbound, User } from "./types";
import { addMessage, getUser, proactiveSentToday, recentMessages, recordUsage, underDailyCap, updateUser } from "./users";

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * Whether Emi may write first right now, and if not, when to look again.
 * Null `retryAt` means: do not ping for this at all; it stays available to
 * bring up if they write.
 */
export async function pingVerdict(deps: Deps, user: User, item: AgendaItem, now: Date): Promise<{ send: true } | { send: false; retryAt: Date | null; why: string }> {
  if (item.kind === "reminder") return { send: true }; // They asked for it, at this time.
  const within = (date: Date) => (date.getTime() <= item.windowEnd.getTime() ? date : null);

  if (user.initiative === "off") return { send: false, retryAt: null, why: "initiative is off" };
  // Annoyed people don't text first. It fades in hours, so look again later.
  if (currentIrritation(user.bond, now) >= IRRITATION_HOLDS_INITIATIVE) {
    return { send: false, retryAt: within(new Date(now.getTime() + 3 * HOUR)), why: "she is still annoyed" };
  }
  if (inQuietHours(now, user.timezone, user.quietStart, user.quietEnd)) {
    const awake = nextAwake(now, user.timezone, user.quietStart, user.quietEnd);
    return { send: false, retryAt: within(new Date(awake.getTime() + (15 + deps.random() * 45) * MINUTE)), why: "quiet hours" };
  }
  const lastActivity = Math.max(user.lastUserMessageAt?.getTime() ?? 0, user.lastEmiMessageAt?.getTime() ?? 0);
  const quietUntil = lastActivity + SILENCE_HOURS[user.initiative] * HOUR;
  if (quietUntil > now.getTime()) return { send: false, retryAt: within(new Date(quietUntil)), why: "the chat was active recently" };

  // If her last word was already an unanswered check-in, a second one is nagging.
  const [latest] = await recentMessages(deps.db, user.id, 1);
  if (latest?.role === "emi" && latest.kind === "proactive") return { send: false, retryAt: null, why: "previous check-in is unanswered" };
  if ((await proactiveSentToday(deps.db, user, now)) >= DAILY_PING_BUDGET[user.initiative]) return { send: false, retryAt: null, why: "daily budget used" };
  if (!(await underDailyCap(deps.db, user, now))) return { send: false, retryAt: null, why: "daily spend cap reached" };
  return { send: true };
}

/**
 * Writes the message at the moment it is sent, against the conversation as it
 * is now. Only a goal was stored, never wording, so nothing composed against
 * an older conversation can reach the person.
 */
interface Composed { bubbles: string[]; extras: Extras }

async function compose(deps: Deps, user: User, item: AgendaItem, now: Date): Promise<Composed | null> {
  const fallback = item.kind === "reminder" ? { bubbles: [`Reminder: ${item.about}`], extras: {} } : null;
  const llm = deps.llmFor(user);
  if (!llm) return fallback;
  // Something she found for them is worth real links; a check-in is not worth a search.
  const web = item.spontaneous && !!llm.capabilities?.web;

  const notes = item.kind === "reminder"
    ? `They asked you to remind them about this, and now is the time: "${item.about}". Tell them, briefly, in your own voice.`
    : item.spontaneous ? [
      "Nobody wrote to you. You are writing just because: you're together, and this made you think of them.",
      `What it's about: "${item.about}".`,
      item.reason ? `Why it made you think of them: ${item.reason}.` : "",
      "Read the conversation above first. If the moment is wrong (they're busy, stressed, or it would land oddly now), reply with exactly HOLD.",
      web ? "If it fits, look online for something real and recent that connects (an article, a video, a bit of news) and send it with its link, the way people send each other things they saw. Only a link you actually found; if nothing good turns up, send it without one." : "",
      "Otherwise text it the way you'd send something to the person you're with: short, light, specific, a little sweet. Not a bare \"thinking of you\" or \"just checking in\", and no question they have to answer. A sticker on top can say the rest.",
    ].filter(Boolean).join("\n") : [
      "Nobody wrote to you. You are writing first, because you thought of them.",
      `What it's about: "${item.about}".`,
      // Without this she guesses, and "yesterday" for something from this morning reads as not having listened.
      item.eventAt ? `When it was for them: ${describeMoment(item.eventAt, user.timezone)}, which is ${describeGap(now.getTime() - item.eventAt.getTime())} ago.` : "",
      item.reason ? `Why you care: ${item.reason}.` : "",
      item.attempts > 0 ? "You already asked about this once and they said later." : "",
      "Read the conversation above first. If they already told you how this went, if the conversation has moved somewhere this would be intrusive, or if it simply no longer makes sense, reply with exactly HOLD.",
      "Otherwise write what you'd text: short, specific to them, no greeting formula, no \"just checking in\", nothing about remembering, notes or schedules.",
    ].filter(Boolean).join("\n");
  const messages: ChatMessage[] = [{ role: "system", content: `${PERSONA}\n\n${webContext(web)}` }, ...renderHistory(await recentMessages(deps.db, user.id, 20), user.timezone)];
  // Writing first is never the moment for a pinned sulk.
  const allowed = item.kind === "reminder" ? { stickers: [], voice: false, pin: false } : { ...(await allowance(deps, user, now)), pin: false };
  const bond = await bondSnapshot(deps.db, user, now);
  const inner = onHerMind(user, now);
  const final = [
    "<notes>", "Private notes for you. They cannot see these.",
    `Now, where they are: ${describeMoment(now, user.timezone)}.`,
    ...bondLines(bond, user, now, null),
    ...(inner ? [`On your mind ${inner.today ? "today" : "lately"}: ${inner.thought}`] : []),
    ...allowanceLines(allowed, deps.expression?.voiceTags),
    notes, "</notes>",
  ].join("\n");
  const last = messages[messages.length - 1];
  if (last?.role === "user") last.content += `\n${final}`;
  else messages.push({ role: "user", content: final });

  try {
    const reply = await llm.chat(messages, { model: deps.models.writer, temperature: 0.9, maxTokens: web ? 1200 : 300, web });
    await recordUsage(deps.db, user.id, "proactive", reply.usage, now);
    if (/^\W*HOLD\W*$/i.test(reply.text.trim())) return fallback;
    const parsed = parseReply(reply.text, "social");
    const { extras, asText } = permitted(parsed.extras, allowed);
    const bubbles = attachSources([...parsed.bubbles, ...asText], reply.citations);
    return bubbles.length || extras.sticker || extras.voice ? { bubbles, extras } : fallback;
  } catch (error) {
    if (error instanceof ConversationReset) throw error;
    if (error instanceof LlmResponseError) await recordUsage(deps.db, user.id, "proactive_failed", error.usage, now);
    console.warn("[proactive] compose failed", error instanceof Error ? error.message : error);
    // A reminder is a promise, so it goes out even when the model does not.
    return fallback;
  }
}

export async function runDuePings(deps: Deps, outbound: Outbound): Promise<number> {
  const now = deps.clock();
  let sent = 0;
  for (const item of await claimDuePings(deps.db, now)) {
    const delivered = await inConversation(deps, item.userId, async (deps) => {
      try {
        // The lease may have been selected before a wipe on another worker.
        const { rows } = await deps.db.query("select id from agenda_items where id = $1 and user_id = $2 and status = 'pending'", [item.id, item.userId]);
        if (!rows.length) return false;
        const user = await getUser(deps.db, item.userId);
        if (!user) return false;
        const verdict = await pingVerdict(deps, user, item, now);
        if (!verdict.send) {
          await setPing(deps.db, item.id, verdict.retryAt, now);
          return false;
        }
        const composed = await compose(deps, user, item, now);
        if (!composed) {
          await setStatus(deps.db, item.id, "cancelled", "held: no longer fit the conversation", now);
          return false;
        }
        // A send already begun completes before wipe confirms. A composition
        // still in flight when wipe wins never sends or saves its old content.
        await conversationEffect(deps.db, async () => {
          const sent = await outbound.send(user.id, composed.bubbles, composed.extras);
          await addMessage(deps.db, { userId: user.id, role: "emi", content: storedReply(composed.bubbles, undefined, storedExtras(sent)), kind: "proactive", agendaItemId: item.id, at: now });
          await setStatus(deps.db, item.id, item.kind === "reminder" ? "done" : "pinged", "sent", now);
        });
        return true;
      } catch (error) {
        if (error instanceof ConversationReset) throw error;
        // The ten-minute lease expires and the item is tried again.
        console.warn("[proactive] ping failed", item.id, error instanceof Error ? error.message : error);
        return false;
      }
    });
    if (delivered) sent += 1;
  }
  return sent;
}

// ---- the daily planner ----

const PLANNER_SYSTEM = `You decide whether Emi, a companion and assistant, has a real reason to write to her person first today. Emi is not a notification service. She writes first the way a friend does: rarely, and only when something specific in the other person's life gives her a reason.

You get what Emi knows about the person, their recent conversation, and the current time where they are.

Return JSON: {"reach_out": null} or
{"reach_out": {"about": a few words, "reason": why she would think of them now, in human terms, "importance": 1 | 2, "part_of_day": "soon" | "afternoon" | "evening", "based_on": ["m3"]}}

Rules:
- null is the normal answer. Most days there is no real reason.
- It must come from something listed, and "based_on" must name the memories it rests on. Never invent an event, a plan or a feeling they did not mention.
- Never a bare "how are you", "how's your day", or anything that could be sent to anyone.
- Not something they already settled in the recent conversation.
- importance 1: she would mention it only if they happen to write. importance 2: worth a message of her own.
- If they have seemed busy, stressed or short lately, null.
- "just_because" is false for all of the above.

Sometimes the input says Emi and they are together (she's their girlfriend), so she may write just because. Then she may also reach out with no event behind it, the way partners send each other things: a thought on her mind today ("t1") that connects to something they love, a callback to a joke or pet name between them, a fact they would enjoy given what they like, or a follow-up on something the two of them talked about lately (something she could look up for them). Then "just_because" is true, "importance" is 2, and "based_on" cites what it connects (at least one of their memories). It must be something that would make THEM smile, specific to them; never "thinking of you", never a question they owe an answer to. Even then, null is still the most common answer.`;

const ReachOut = z.object({
  about: z.string().trim().min(3).max(160),
  reason: z.string().trim().max(200).default(""),
  importance: z.coerce.number().int().min(1).max(2).catch(1),
  part_of_day: z.enum(["soon", "afternoon", "evening"]).catch("soon"),
  based_on: z.array(z.string()).min(1),
  just_because: z.boolean().catch(false).default(false),
});

/** Days between messages she sends with no reason but that she thought of them. */
export const JUST_BECAUSE_EVERY_DAYS = 3;
/** Closeness stage from which she may write just because (3 = close). */
export const JUST_BECAUSE_FROM_STAGE = 3;

/** Whether she is close enough, calm enough and has waited long enough to write just because. */
export function mayWriteJustBecause(user: User, bond: BondSnapshot, now: Date): boolean {
  if (bond.stage.index < JUST_BECAUSE_FROM_STAGE || bond.irritation >= 0.2 || user.initiative === "low") return false;
  return !user.lastSpontaneousAt || now.getTime() - user.lastSpontaneousAt.getTime() >= JUST_BECAUSE_EVERY_DAYS * 24 * HOUR;
}

/** At most once per local day, and only for people who have been around. */
export async function runDailyPlanner(deps: Deps): Promise<number> {
  const now = deps.clock();
  const { rows } = await deps.db.query(
    "select * from users where initiative <> 'off' and timezone_known and last_user_message_at >= $1",
    [new Date(now.getTime() - 7 * 24 * HOUR)],
  );
  let planned = 0;
  for (const row of rows) {
    const made = await inConversation(deps, String(row.id), async (deps) => {
      // Re-read after capturing the version, rather than using a pre-wipe snapshot.
      const user = await getUser(deps.db, String(row.id));
      if (!user?.lastUserMessageAt || user.initiative === "off" || !user.timezoneKnown
        || user.lastUserMessageAt.getTime() < now.getTime() - 7 * 24 * HOUR) return false;
      const local = localParts(now, user.timezone);
      if (user.lastPlannedOn === local.dateKey || local.hour < 9 || local.hour >= 20) return false;
      // Marked before the work, so a failure costs one day, not a retry loop.
      await updateUser(deps.db, user.id, { lastPlannedOn: local.dateKey });
      try { return await planFor(deps, user, now); }
      catch (error) {
        if (error instanceof ConversationReset) throw error;
        if (error instanceof LlmResponseError) await recordUsage(deps.db, user.id, "planner_failed", error.usage, now);
        console.warn("[planner] failed", user.id, error instanceof Error ? error.message : error);
        return false;
      }
    });
    if (made) planned += 1;
  }
  return planned;
}

async function planFor(deps: Deps, user: User, now: Date): Promise<boolean> {
  const llm = deps.llmFor(user);
  if (!llm || !(await underDailyCap(deps.db, user, now))) return false;
  // She already has something to bring up; a second reason would be noise.
  if (await hasOpenInitiative(deps.db, user.id, now)) return false;

  // Checked in code before paying for a model call: is there anything recent
  // in their life to have a reason about at all?
  const all = await activeMemories(deps.db, user.id);
  const recent = all
    .filter((memory) => (memory.kind === "event" || memory.kind === "state") && now.getTime() - memory.createdAt.getTime() < 21 * 24 * HOUR)
    .slice(-15);
  // Close friends also write with no event behind it, from what they love and what is between them.
  const justBecause = mayWriteJustBecause(user, await bondSnapshot(deps.db, user, now), now);
  const lasting = justBecause ? [
    ...all.filter((memory) => memory.kind === "preference").slice(-6),
    ...all.filter((memory) => memory.kind === "us").slice(-4),
  ] : [];
  if (!recent.length && !lasting.length) return false;
  const labels = [...recent, ...lasting].map((memory, index) => ({ label: `m${index + 1}`, memory }));
  const inner = justBecause ? await ensureInnerDay(deps, user.id) : null;
  const history = await recentMessages(deps.db, user.id, 12);

  const prompt = [
    `Now, where they are: ${describeMoment(now, user.timezone)}.`,
    "", "What Emi knows that is recent:",
    ...labels.slice(0, recent.length).map(({ label, memory }) => `${label} [${memory.occurredOn ?? localParts(memory.createdAt, user.timezone).dateKey}] ${memory.content}`),
    ...(justBecause ? [
      "", "Emi and they are together, so she may write just because. What they love and what is between them:",
      ...labels.slice(recent.length).map(({ label, memory }) => `${label} [${memory.kind}] ${memory.content}`),
      ...(inner ? [`t1 [on Emi's mind today] ${inner}`] : []),
    ] : []),
    "", "Recent conversation:",
    ...history.map((message) => `${message.role === "user" ? "THEM" : "EMI"} (${describeMoment(message.createdAt, user.timezone)}): ${messageContent(message).slice(0, 400)}`),
  ].join("\n");
  const result = await llm.chat([{ role: "system", content: PLANNER_SYSTEM }, { role: "user", content: prompt }],
    { model: deps.models.utility, temperature: 0.5, maxTokens: 400, json: true });
  await recordUsage(deps.db, user.id, "planner", result.usage, now);

  const parsed = ReachOut.safeParse((parseJsonObject(result.text) as { reach_out?: unknown } | null)?.reach_out);
  if (!parsed.success) return false;
  const plan = parsed.data;
  const cited = plan.based_on.map((label) => label.trim().toLowerCase());
  // Grounding is checked, not trusted: every cited memory has to be one we showed.
  if (!cited.every((label) => labels.some((entry) => entry.label === label) || (label === "t1" && !!inner))) return false;
  // Writing just because needs her to be allowed to, and still has to connect to them.
  if (plan.just_because && (!justBecause || !cited.some((label) => label !== "t1"))) return false;
  if (plan.just_because) plan.importance = 2;

  const local = localParts(now, user.timezone);
  const at = (hour: number) => localToUtc(`${local.dateKey}T${String(hour).padStart(2, "0")}:00`, user.timezone)!;
  const windowEnd = at(Math.min(22, user.quietStart > user.quietEnd ? user.quietStart : 22));
  let pingAt: Date | null = null;
  if (plan.importance === 2) {
    const base = plan.part_of_day === "afternoon" ? at(14).getTime() + deps.random() * 2 * HOUR
      : plan.part_of_day === "evening" ? at(18).getTime() + 30 * MINUTE + deps.random() * 2 * HOUR
      : now.getTime() + (20 + deps.random() * 40) * MINUTE;
    const chosen = Math.max(base, now.getTime() + 20 * MINUTE);
    pingAt = chosen < windowEnd.getTime() ? new Date(chosen) : null;
  }
  if (windowEnd.getTime() <= now.getTime()) return false;
  await upsertAgendaItem(deps.db, {
    userId: user.id, kind: "initiative", about: plan.about, reason: plan.reason, importance: plan.importance as 1 | 2,
    windowStart: now, windowEnd, pingAt, spontaneous: plan.just_because, at: now,
  });
  if (plan.just_because) await updateUser(deps.db, user.id, { lastSpontaneousAt: now });
  return true;
}

// ---- the ticker ----

/** People whose newest messages the extractor has not read yet. */
async function sweepExtraction(deps: Deps): Promise<void> {
  const { rows } = await deps.db.query<{ id: string }>(
    `select u.id from users u where exists (
       select 1 from messages m where m.user_id = u.id and m.role = 'user' and m.id > u.extracted_through and m.created_at < $1
     ) limit 20`,
    [new Date(deps.clock().getTime() - 60_000)],
  );
  for (const row of rows) await runExtraction(deps, row.id).catch(() => undefined);
}

/**
 * Everything Emi does without being spoken to, in one pass. Each step is an
 * indexed query that returns nothing for idle people, so an idle user costs
 * no model calls at all.
 */
export async function tick(deps: Deps, outbound: Outbound): Promise<void> {
  await expireStale(deps.db, deps.clock());
  await runDuePings(deps, outbound);
  await runDailyPlanner(deps);
  await sweepExtraction(deps);
  await sweepConsolidation(deps);
  await sweepInnerDays(deps);
  await sweepMakeups(deps, outbound);
}
