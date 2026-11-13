import { z } from "zod";
import { parseJsonObject, type ChatMessage } from "../llm/provider";
import { DAILY_PING_BUDGET, SILENCE_HOURS } from "./agenda/policy";
import { claimDuePings, expireStale, hasOpenInitiative, setPing, setStatus, upsertAgendaItem } from "./agenda/store";
import { describeMoment, inQuietHours, localParts, localToUtc, nextAwake } from "./clock";
import { runExtraction } from "./extraction";
import { activeMemories } from "./memory/store";
import { PERSONA } from "./persona";
import { joinBubbles, parseReply, renderHistory } from "./prompt";
import type { AgendaItem, Deps, Outbound, User } from "./types";
import { addMessage, getUser, proactiveSentToday, recentMessages, recordUsage, underDailyCap, updateUser, userFromRow } from "./users";

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
async function compose(deps: Deps, user: User, item: AgendaItem, now: Date): Promise<string[] | null> {
  const llm = deps.llmFor(user);
  if (!llm) return item.kind === "reminder" ? [`Reminder: ${item.about}`] : null;

  const notes = item.kind === "reminder"
    ? `They asked you to remind them about this, and now is the time: "${item.about}". Tell them, briefly, in your own voice.`
    : [
      "Nobody wrote to you. You are writing first, because you thought of them.",
      `What it's about: "${item.about}".`,
      item.reason ? `Why you care: ${item.reason}.` : "",
      item.attempts > 0 ? "You already asked about this once and they said later." : "",
      "Read the conversation above first. If they already told you how this went, if the conversation has moved somewhere this would be intrusive, or if it simply no longer makes sense, reply with exactly HOLD.",
      "Otherwise write what you'd text: short, specific to them, no greeting formula, no \"just checking in\", nothing about remembering, notes or schedules.",
    ].filter(Boolean).join("\n");
  const messages: ChatMessage[] = [{ role: "system", content: PERSONA }, ...renderHistory(await recentMessages(deps.db, user.id, 20), user.timezone)];
  const final = `<notes>\nPrivate notes for you. They cannot see these.\nNow, where they are: ${describeMoment(now, user.timezone)}.\n${notes}\n</notes>`;
  const last = messages[messages.length - 1];
  if (last?.role === "user") last.content += `\n${final}`;
  else messages.push({ role: "user", content: final });

  try {
    const reply = await llm.chat(messages, { model: deps.models.writer, temperature: 0.9, maxTokens: 300 });
    await recordUsage(deps.db, user.id, "proactive", reply.usage, now);
    if (/^\W*HOLD\W*$/i.test(reply.text.trim())) return item.kind === "reminder" ? [`Reminder: ${item.about}`] : null;
    const { bubbles } = parseReply(reply.text, "social");
    return bubbles.length ? bubbles : null;
  } catch (error) {
    console.warn("[proactive] compose failed", error instanceof Error ? error.message : error);
    // A reminder is a promise, so it goes out even when the model does not.
    return item.kind === "reminder" ? [`Reminder: ${item.about}`] : null;
  }
}

export async function runDuePings(deps: Deps, outbound: Outbound): Promise<number> {
  const now = deps.clock();
  let sent = 0;
  for (const item of await claimDuePings(deps.db, now)) {
    try {
      const user = await getUser(deps.db, item.userId);
      if (!user) continue;
      const verdict = await pingVerdict(deps, user, item, now);
      if (!verdict.send) {
        await setPing(deps.db, item.id, verdict.retryAt, now);
        continue;
      }
      const bubbles = await compose(deps, user, item, now);
      if (!bubbles) {
        await setStatus(deps.db, item.id, "cancelled", "held: no longer fit the conversation", now);
        continue;
      }
      await outbound.send(user.id, bubbles);
      await addMessage(deps.db, { userId: user.id, role: "emi", content: joinBubbles(bubbles), kind: "proactive", agendaItemId: item.id, at: now });
      await setStatus(deps.db, item.id, item.kind === "reminder" ? "done" : "pinged", "sent", now);
      sent += 1;
    } catch (error) {
      // The ten-minute lease expires and the item is tried again.
      console.warn("[proactive] ping failed", item.id, error instanceof Error ? error.message : error);
    }
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
- If they have seemed busy, stressed or short lately, null.`;

const ReachOut = z.object({
  about: z.string().trim().min(3).max(160),
  reason: z.string().trim().max(200).default(""),
  importance: z.coerce.number().int().min(1).max(2).catch(1),
  part_of_day: z.enum(["soon", "afternoon", "evening"]).catch("soon"),
  based_on: z.array(z.string()).min(1),
});

/** At most once per local day, and only for people who have been around. */
export async function runDailyPlanner(deps: Deps): Promise<number> {
  const now = deps.clock();
  const { rows } = await deps.db.query(
    "select * from users where initiative <> 'off' and timezone_known and last_user_message_at >= $1",
    [new Date(now.getTime() - 7 * 24 * HOUR)],
  );
  let planned = 0;
  for (const user of rows.map(userFromRow)) {
    const local = localParts(now, user.timezone);
    if (user.lastPlannedOn === local.dateKey || local.hour < 9 || local.hour >= 20) continue;
    // Marked before the work, so a failure costs one day, not a retry loop.
    await updateUser(deps.db, user.id, { lastPlannedOn: local.dateKey });
    try {
      if (await planFor(deps, user, now)) planned += 1;
    } catch (error) {
      console.warn("[planner] failed", user.id, error instanceof Error ? error.message : error);
    }
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
  const recent = (await activeMemories(deps.db, user.id))
    .filter((memory) => (memory.kind === "event" || memory.kind === "state") && now.getTime() - memory.createdAt.getTime() < 21 * 24 * HOUR)
    .slice(-15);
  if (!recent.length) return false;
  const labels = recent.map((memory, index) => ({ label: `m${index + 1}`, memory }));
  const history = await recentMessages(deps.db, user.id, 12);

  const prompt = [
    `Now, where they are: ${describeMoment(now, user.timezone)}.`,
    "", "What Emi knows that is recent:",
    ...labels.map(({ label, memory }) => `${label} [${memory.occurredOn ?? localParts(memory.createdAt, user.timezone).dateKey}] ${memory.content}`),
    "", "Recent conversation:",
    ...history.map((message) => `${message.role === "user" ? "THEM" : "EMI"} (${describeMoment(message.createdAt, user.timezone)}): ${message.content.slice(0, 400)}`),
  ].join("\n");
  const result = await llm.chat([{ role: "system", content: PLANNER_SYSTEM }, { role: "user", content: prompt }],
    { model: deps.models.utility, temperature: 0.5, maxTokens: 400, json: true });
  await recordUsage(deps.db, user.id, "planner", result.usage, now);

  const parsed = ReachOut.safeParse((parseJsonObject(result.text) as { reach_out?: unknown } | null)?.reach_out);
  if (!parsed.success) return false;
  const plan = parsed.data;
  // Grounding is checked, not trusted: every cited memory has to be one we showed.
  if (!plan.based_on.every((label) => labels.some((entry) => entry.label === label.trim().toLowerCase()))) return false;

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
    windowStart: now, windowEnd, pingAt, at: now,
  });
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
}
