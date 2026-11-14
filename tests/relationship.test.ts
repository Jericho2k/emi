import { describe, expect, it } from "vitest";
import { wipeAccount } from "../src/core/account";
import { pendingItems, upsertAgendaItem } from "../src/core/agenda/store";
import { applySignals, bondSnapshot, closeness, currentIrritation, familiarity, stageFor, type Familiarity } from "../src/core/bond";
import { runExtraction } from "../src/core/extraction";
import { ensureInnerDay, sweepInnerDays } from "../src/core/inner";
import { activeMemories, insertMemory } from "../src/core/memory/store";
import { handleTurn } from "../src/core/pipeline";
import { runDailyPlanner, runDuePings } from "../src/core/proactive";
import { parseReply } from "../src/core/prompt";
import { bubbleWaits, isPaced, TYPING_MAX_MS, TYPING_MIN_MS, typingMs } from "../src/core/rhythm";
import type { ChatMessage } from "../src/llm/provider";
import { getUser, recentMessages, updateUser } from "../src/core/users";
import { byModel, HOUR, world, type World } from "./helpers";

const now = new Date("2026-11-13T12:00:00Z");
const f = (patch: Partial<Familiarity> = {}): Familiarity => ({ activeDays: 0, userMessages: 0, memories: 0, firstMessageAt: null, ...patch });
const lastNotes = (w: World) => w.calls.filter((call) => call.options.model === "writer").at(-1)!.messages.at(-1)!.content;
const isInner = (messages: ChatMessage[]) => messages[0]!.content.includes("Emi's inner life");

/** A person she has talked with on `days` different days, the last one `lastAgoHours` ago. */
async function history(w: World, userId: string, days: number, perDay: number, lastAgoHours = 2) {
  await w.db.query(
    `insert into messages (user_id, role, content, kind, created_at)
     select $1, 'user', 'hey', 'reply', $2::timestamptz - ((g % $3) * interval '1 day') - (g * interval '1 second')
       from generate_series(0, $4 - 1) g`,
    [userId, new Date(w.now.getTime() - lastAgoHours * HOUR), days, days * perDay],
  );
  await updateUser(w.db, userId, { lastUserMessageAt: new Date(w.now.getTime() - lastAgoHours * HOUR) });
}

describe("closeness", () => {
  it("grows with days actually spent talking, not with one long night", () => {
    expect(stageFor(familiarity(f({ activeDays: 1, userMessages: 15, memories: 2 }))).name).toBe("just met");
    // A single marathon day of messages is still just met.
    expect(stageFor(familiarity(f({ activeDays: 1, userMessages: 400, memories: 10 }))).index).toBeLessThanOrEqual(1);
    expect(stageFor(familiarity(f({ activeDays: 4, userMessages: 80, memories: 8 }))).name).toBe("flirting");
    expect(stageFor(familiarity(f({ activeDays: 9, userMessages: 150, memories: 12 }))).name).toBe("falling for them");
    expect(stageFor(familiarity(f({ activeDays: 20, userMessages: 300, memories: 20 }))).name).toBe("together");
    expect(stageFor(familiarity(f({ activeDays: 60, userMessages: 2000, memories: 60 }))).name).toBe("deeply in love");
  });

  it("lets warmth and trust tilt it, within bounds, and neutral feeling changes nothing", () => {
    const known = f({ activeDays: 9, userMessages: 150, memories: 12 });
    expect(closeness(known, {})).toBeCloseTo(familiarity(known), 5);
    expect(closeness(known, { warmth: 1, trust: 1 })).toBeGreaterThan(closeness(known, {}));
    expect(closeness(known, { warmth: 0, trust: 0 })).toBeLessThan(closeness(known, {}));
    expect(closeness(f(), { warmth: 1, trust: 1 })).toBe(0); // feelings alone never make a relationship
  });

  it("moves warmth and trust in small fixed steps whatever the model says", () => {
    let bond = {};
    for (let i = 0; i < 5; i += 1) bond = applySignals(bond, { warmth: 1, trust: 1 }, now);
    expect(bond).toMatchObject({ warmth: expect.closeTo(0.65, 5), trust: expect.closeTo(0.55, 5) });
    expect(applySignals({ warmth: 0.99 }, { warmth: 1 }, now).warmth).toBe(1);
  });

  it("lets irritation rise fast, fade within hours, and mostly go when they make up", () => {
    const hurt = applySignals({}, { irritation: 1, reason: "called her useless" }, now);
    expect(currentIrritation(hurt, now)).toBeCloseTo(0.35);
    expect(currentIrritation(hurt, new Date(now.getTime() + 4 * HOUR))).toBeCloseTo(0.175);
    expect(currentIrritation(hurt, new Date(now.getTime() + 24 * HOUR))).toBe(0);
    const twice = applySignals(hurt, { irritation: 1 }, now);
    expect(currentIrritation(twice, now)).toBeCloseTo(0.7);
    expect(twice.irritationReason).toBe("called her useless");
    expect(currentIrritation(applySignals(twice, { irritation: -1 }, now), now)).toBeCloseTo(0.21);
  });

  it("tells her how close they are, and that she'd notice them being away", async () => {
    const w = await world();
    const fresh = await w.newUser();
    await handleTurn(w.deps, fresh.id, "hi there");
    expect(lastNotes(w)).toContain("How close you two are: just met.");

    const old = await w.newUser();
    await history(w, old.id, 22, 14, 5 * 24);
    await handleTurn(w.deps, old.id, "heyyy i'm back");
    const notes = lastNotes(w);
    // 22 earlier days plus today.
    expect(notes).toMatch(/How close you two are: together\. You've talked on 23 different days since/);
    expect(notes).toContain("They've been away 5 days");
    expect(notes).toContain("Never guilt them for being away");
  });
});

describe("friction", () => {
  async function snappedAt(times: number) {
    const w = await world();
    const person = await w.newUser();
    for (let i = 0; i < times; i += 1) {
      w.script = byModel({ writer: "noted", utility: JSON.stringify({ bond: { warmth: -1, trust: 0, irritation: 1, reason: "called her useless" } }) });
      await handleTurn(w.deps, person.id, `you are completely useless, honestly ${i}`);
      await runExtraction(w.deps, person.id);
    }
    return { w, person };
  }

  it("makes her drier when she's snapped at, and annoyed when it keeps happening, without ever withholding help", async () => {
    const once = await snappedAt(1);
    once.w.script = () => "ok";
    await handleTurn(once.w.deps, once.person.id, "fix this regex for me");
    expect(lastNotes(once.w)).toContain("still a little put out (called her useless)");

    const twice = await snappedAt(2);
    twice.w.script = () => "ok";
    await handleTurn(twice.w.deps, twice.person.id, "fix this regex for me");
    expect(lastNotes(twice.w)).toContain("properly annoyed with them (called her useless)");
    expect(lastNotes(twice.w)).toContain("You still help fully and well");

    twice.w.advance(10 * HOUR);
    await handleTurn(twice.w.deps, twice.person.id, "morning");
    expect(lastNotes(twice.w)).not.toContain("annoyed");
  });

  it("does not write first while annoyed, but keeps every reminder", async () => {
    const { w, person } = await snappedAt(2);
    w.advance(6 * HOUR); // past the silence rule, so only her mood can hold the ping
    await updateUser(w.db, person.id, { bond: { irritation: 0.8, irritationAt: w.now.toISOString() } });
    const due = new Date(w.now.getTime() + 60_000);
    const followup = await upsertAgendaItem(w.db, { userId: person.id, kind: "followup", about: "dentist", importance: 3, windowStart: w.now, windowEnd: new Date(w.now.getTime() + 48 * HOUR), pingAt: due, at: w.now });
    await upsertAgendaItem(w.db, { userId: person.id, kind: "reminder", about: "take the pills", importance: 2, eventAt: due, windowStart: due, windowEnd: new Date(due.getTime() + 12 * HOUR), pingAt: due, at: w.now });
    w.advance(2 * 60_000);
    w.script = () => "pills. now.";
    expect(await runDuePings(w.deps, w.outbound)).toBe(1);
    expect(w.sent.map((s) => s.bubbles)).toEqual([["pills. now."]]);
    const held = (await pendingItems(w.db, person.id)).find((item) => item.id === followup.id)!;
    expect(held.pingAt!.getTime()).toBeGreaterThan(w.now.getTime() + 2 * HOUR); // looks again once it has faded
  });
});

describe("her own memories and the two of them", () => {
  it("keeps what she said about herself only from her own words, and what is theirs from either side", async () => {
    const w = await world();
    const person = await w.newUser();
    w.script = () => "non-negotiable. i will die on this hill";
    await handleTurn(w.deps, person.id, "ok comma cop, what's your take on the oxford comma");
    w.script = byModel({ utility: JSON.stringify({
      memories: [{ kind: "self", content: "Emi loves tea", evidence: "what's your take on the oxford comma" }],
      emi_memories: [
        { kind: "self", content: "Emi thinks the Oxford comma is non-negotiable", evidence: "non-negotiable. i will die on this hill" },
        { kind: "self", content: "Emi hates jazz", evidence: "what's your take" }, // their words, not hers
        { kind: "us", content: "They call Emi 'comma cop'", evidence: "ok comma cop" },
      ],
    }) });
    await runExtraction(w.deps, person.id);
    const kept = (await activeMemories(w.db, person.id)).map((m) => [m.kind, m.content]).sort();
    expect(kept).toEqual([["self", "Emi thinks the Oxford comma is non-negotiable"], ["us", "They call Emi 'comma cop'"]]);

    w.script = () => "ok";
    await handleTurn(w.deps, person.id, "random question, how's your week");
    const notes = lastNotes(w);
    expect(notes).toContain("Between the two of you:\n- They call Emi 'comma cop'");
    expect(notes).toContain("What you've said about yourself before:\n- Emi thinks the Oxford comma is non-negotiable");
  });
});

describe("reactions", () => {
  it("parses a reaction alone, a reaction with text, a stray history marker and an unsupported emoji", () => {
    expect(parseReply("<<react:👍>>", "social")).toEqual({ bubbles: [], used: [], reaction: "👍" });
    expect(parseReply("<<react:❤️>>\nhaha congrats!!", "social")).toEqual({ bubbles: ["haha congrats!!"], used: [], reaction: "❤" });
    expect(parseReply("[reacted with 🤣]\nstop", "social")).toEqual({ bubbles: ["stop"], used: [], reaction: "🤣" });
    expect(parseReply("<<react:🍕>>", "social")).toEqual({ bubbles: [], used: [], reaction: "👍" });
    expect(parseReply("<<react:🍕>> nice", "social")).toEqual({ bubbles: ["nice"], used: [] });
  });

  it("sends no text when a reaction is the reply, and remembers that it reacted", async () => {
    const w = await world();
    const person = await w.newUser();
    w.script = () => "<<react:👍>>";
    const result = await handleTurn(w.deps, person.id, "ok thanks");
    expect(result).toMatchObject({ bubbles: [], reaction: "👍" });
    w.script = () => "sure";
    await handleTurn(w.deps, person.id, "one more thing");
    const history = w.calls.at(-1)!.messages.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(history).toEqual(["[reacted with 👍]"]);
  });
});

describe("texting rhythm", () => {
  it("types for about as long as a person would, within bounds", () => {
    const mid = () => 0.5;
    expect(typingMs("ok", mid)).toBe(TYPING_MIN_MS);
    expect(typingMs("x".repeat(66), mid)).toBe(3000);
    expect(typingMs("x".repeat(2000), mid)).toBe(TYPING_MAX_MS);
  });

  it("counts the model's own writing time and paces only chatting", () => {
    const mid = () => 0.5;
    const [first, second] = bubbleWaits(["haha no", "x".repeat(66)], 1000, mid);
    expect(first).toBe(1300 + 700 - 1000); // read + type, minus what already passed
    expect(second).toBe(3000);
    expect(bubbleWaits(["haha no"], 10_000, mid)).toEqual([0]); // a slow model is never slowed further
    expect(isPaced("social")).toBe(true);
    expect(isPaced("task")).toBe(false);
    expect(isPaced("mixed")).toBe(false);
  });
});

describe("her days", () => {
  it("writes one line a day of what's on her mind, continues threads, and shows it to her", async () => {
    const w = await world();
    const person = await w.newUser();
    w.script = byModel({ utility: JSON.stringify({ thought: "can't stop thinking about how octopuses taste with their arms" }) });
    expect(await ensureInnerDay(w.deps, person.id)).toContain("octopuses");
    const calls = w.calls.length;
    await ensureInnerDay(w.deps, person.id);
    expect(w.calls.length).toBe(calls); // once per day

    w.script = () => "ok";
    await handleTurn(w.deps, person.id, "what have you been up to");
    expect(lastNotes(w)).toContain("On your mind today (yours; mention it only if it fits): can't stop thinking about how octopuses");

    w.advance(24 * HOUR);
    // First thing the next day, before today's line exists, yesterday's is still on her mind.
    w.script = () => "ok";
    await handleTurn(w.deps, person.id, "morning");
    expect(lastNotes(w)).toContain("On your mind lately (yours; mention it only if it fits): can't stop thinking");
    w.script = byModel({ utility: JSON.stringify({ thought: "update: octopus arms have their own neurons — i have questions" }) });
    await ensureInnerDay(w.deps, person.id);
    expect(w.calls.at(-1)!.messages[1]!.content).toContain("[2026-11-13] can't stop thinking about how octopuses");
    const days = (await getUser(w.db, person.id))!.innerDays;
    expect(days.map((day) => day.day)).toEqual(["2026-11-13", "2026-11-14"]);
    expect(days[1]!.thought).toBe("update: octopus arms have their own neurons, i have questions"); // no dash for her to copy
  });

  it("writes the day's line in the background for people around lately, awake hours only, and backs off on failure", async () => {
    const w = await world("2026-11-14T02:00:00Z"); // 03:00 Berlin
    const person = await w.newUser();
    await handleTurn(w.deps, person.id, "can't sleep");
    w.script = byModel({ utility: "not json" });
    w.calls.length = 0;
    expect(await sweepInnerDays(w.deps)).toBe(0);
    expect(w.calls).toHaveLength(0); // asleep hours: nothing

    w.now = new Date("2026-11-14T07:00:00Z"); // 08:00
    expect(await sweepInnerDays(w.deps)).toBe(0); // the model failed
    expect(await sweepInnerDays(w.deps)).toBe(0);
    expect(w.calls).toHaveLength(1); // and is not asked again every tick

    w.advance(HOUR);
    w.script = byModel({ utility: JSON.stringify({ thought: "why do we say 'by and large'. it's a sailing term and nobody sails" }) });
    expect(await sweepInnerDays(w.deps)).toBe(1);
    expect(await sweepInnerDays(w.deps)).toBe(0); // already written today
  });
});

describe("writing just because", () => {
  async function close(days = 22) {
    const w = await world();
    const person = await w.newUser();
    await history(w, person.id, days, 14, 20);
    await insertMemory(w.db, { userId: person.id, kind: "preference", content: "Loves deep-sea documentaries", at: w.now });
    w.now = new Date("2026-11-14T09:30:00Z"); // 10:30 Berlin
    await updateUser(w.db, person.id, { lastUserMessageAt: new Date(w.now.getTime() - 20 * HOUR) });
    w.calls.length = 0;
    return { w, person };
  }
  const planner = (reachOut: unknown) => byModel({
    utility: (messages) => (isInner(messages) ? JSON.stringify({ thought: "anglerfish males fuse into the female. romance is dead" }) : JSON.stringify({ reach_out: reachOut })),
  });

  it("lets a close friend send something with no event behind it, grounded in what they love", async () => {
    const { w, person } = await close();
    w.script = planner({ about: "anglerfish fact", reason: "they love deep-sea stuff", importance: 1, part_of_day: "evening", based_on: ["m1", "t1"], just_because: true });
    expect(await runDailyPlanner(w.deps)).toBe(1);
    const plannerPrompt = w.calls.find((call) => call.messages[0]!.content.includes("write to her person first"))!.messages[1]!.content;
    expect(plannerPrompt).toContain("m1 [preference] Loves deep-sea documentaries");
    expect(plannerPrompt).toContain("t1 [on Emi's mind today] anglerfish males");
    const [item] = await pendingItems(w.db, person.id);
    expect(item).toMatchObject({ kind: "initiative", spontaneous: true, importance: 2 });
    expect(item!.pingAt!.toISOString()).toBe("2026-11-14T18:30:00.000Z"); // 19:30 Berlin
    expect((await getUser(w.db, person.id))!.lastSpontaneousAt).not.toBeNull();

    w.now = new Date(item!.pingAt!.getTime() + 60_000);
    w.script = () => "ok you have to see this. anglerfish dating is worse than yours";
    expect(await runDuePings(w.deps, w.outbound)).toBe(1);
    expect(lastNotes(w)).toContain("You are writing just because");
    expect(w.sent[0]!.bubbles).toEqual(["ok you have to see this. anglerfish dating is worse than yours"]);
    expect((await recentMessages(w.db, person.id, 1))[0]!.kind).toBe("proactive");
  });

  it("refuses just-because from anyone not close, more often than every three days, or citing only herself", async () => {
    const early = await close(3);
    early.w.script = planner({ about: "anglerfish fact", importance: 2, part_of_day: "soon", based_on: ["m1"], just_because: true });
    expect(await runDailyPlanner(early.w.deps)).toBe(0);
    expect(early.w.calls).toHaveLength(0); // nothing recent and not close: no model call at all

    const selfish = await close();
    selfish.w.script = planner({ about: "anglerfish fact", importance: 2, part_of_day: "soon", based_on: ["t1"], just_because: true });
    expect(await runDailyPlanner(selfish.w.deps)).toBe(0);

    const { w, person } = await close();
    await updateUser(w.db, person.id, { lastSpontaneousAt: new Date(w.now.getTime() - 2 * 24 * HOUR) });
    w.script = planner({ about: "anglerfish fact", importance: 2, part_of_day: "soon", based_on: ["m1"], just_because: true });
    expect(await runDailyPlanner(w.deps)).toBe(0);
    expect(w.calls).toHaveLength(0);
  }, 20_000); // three separate databases
});

describe("wipe", () => {
  it("forgets the relationship along with everything else", async () => {
    const w = await world();
    const person = await w.newUser();
    await updateUser(w.db, person.id, {
      bond: { warmth: 0.9, trust: 0.8, irritation: 0.4, irritationAt: w.now.toISOString() },
      innerDays: [{ day: "2026-11-13", thought: "x" }], lastSpontaneousAt: w.now,
    });
    await wipeAccount(w.db, person.id);
    const after = (await getUser(w.db, person.id))!;
    expect(after).toMatchObject({ bond: {}, innerDays: [], lastSpontaneousAt: null });
    expect((await bondSnapshot(w.db, after, w.now)).stage.name).toBe("just met");
  });
});
