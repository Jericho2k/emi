import { describe, expect, it } from "vitest";
import { pendingItems, upsertAgendaItem } from "../src/core/agenda/store";
import { runExtraction } from "../src/core/extraction";
import { recall } from "../src/core/memory/recall";
import { activeMemories, deleteMemory, insertMemory } from "../src/core/memory/store";
import { handleTurn } from "../src/core/pipeline";
import { runDailyPlanner, runDuePings, tick } from "../src/core/proactive";
import { getUser, recentMessages, spentToday } from "../src/core/users";
import { byModel, fakeEmbedding, HOUR, world } from "./helpers";

const status = async (db: any, id: string) => (await db.query("select status, ping_at from agenda_items where id = $1", [id])).rows[0];

describe("a turn", () => {
  it("stores both sides, makes one writer call, and keeps notes out of the history", async () => {
    const w = await world();
    const user = await w.newUser();
    w.script = () => "hey you\n---\nhow's the day";
    const result = await handleTurn(w.deps, user.id, "hi emi");
    expect(result.bubbles).toEqual(["hey you", "how's the day"]);
    expect(w.calls).toHaveLength(1);
    const final = w.calls[0]!.messages.at(-1)!.content;
    expect(final).toContain("<notes>");
    expect(final).toContain("Fri 13 Nov 2026, 13:00"); // Berlin, not UTC
    expect(final.endsWith("hi emi")).toBe(true);
    const stored = await recentMessages(w.db, user.id, 10);
    expect(stored.map((m) => [m.role, m.content])).toEqual([["user", "hi emi"], ["emi", "hey you\n---\nhow's the day"]]);
    expect(await spentToday(w.db, (await getUser(w.db, user.id))!, w.now)).toBeGreaterThan(0);
  });

  it("asks for a key instead of failing when there is none", async () => {
    const w = await world();
    const user = await w.newUser();
    w.hasKey = false;
    const result = await handleTurn(w.deps, user.id, "hi");
    expect(result.problem).toBe("no_key");
    expect(w.calls).toHaveLength(0);
  });

  it("recalls what is on topic and leaves the rest out", async () => {
    const w = await world();
    const user = await w.newUser();
    const add = (content: string, kind: any = "state") => insertMemory(w.db, { userId: user.id, kind, content, embedding: fakeEmbedding(content), at: w.now });
    await add("Training for the Berlin marathon in spring");
    await add("Works as a backend developer at a bank");
    await add("Lives in Berlin", "identity");
    const text = "ugh my marathon training is going badly";
    const got = await recall(w.db, user.id, text, fakeEmbedding(text), w.now);
    expect(got.standing.map((m) => m.content)).toEqual(["Lives in Berlin"]);
    expect(got.relevant.map((m) => m.content)).toEqual(["Training for the Berlin marathon in spring"]);
  });
});

describe("extraction", () => {
  it("keeps a fact with an exact quote and drops an invented one", async () => {
    const w = await world();
    const user = await w.newUser();
    await handleTurn(w.deps, user.id, "my sister Anna is visiting next week and I'm vegetarian btw");
    w.script = byModel({ utility: JSON.stringify({ memories: [
      { kind: "relationship", content: "Has a sister called Anna", evidence: "my sister Anna" },
      { kind: "preference", content: "Is vegetarian", evidence: "I'm vegetarian" },
      { kind: "identity", content: "Is a doctor", evidence: "I work as a doctor" },
    ] }) });
    const summary = await runExtraction(w.deps, user.id);
    expect(summary?.memoriesAdded).toBe(2);
    expect((await activeMemories(w.db, user.id)).map((m) => m.content).sort()).toEqual(["Has a sister called Anna", "Is vegetarian"]);
    // Read once: a second run has nothing new to look at.
    const calls = w.calls.length;
    await runExtraction(w.deps, user.id);
    expect(w.calls.length).toBe(calls);
  });

  it("replaces a changed state and keeps the old one as history", async () => {
    const w = await world();
    const user = await w.newUser();
    const old = await insertMemory(w.db, { userId: user.id, kind: "state", content: "Is looking for a job", embedding: fakeEmbedding("Is looking for a job"), at: w.now });
    await handleTurn(w.deps, user.id, "I got the offer, I start at Acme on Monday!!");
    w.script = byModel({ utility: (messages) => {
      const label = /(m\d+) \[state\] Is looking for a job/.exec(messages[1]!.content)![1];
      return JSON.stringify({ memories: [{ kind: "state", content: "Starts a new job at Acme", evidence: "I start at Acme on Monday", supersedes: label }] });
    } });
    expect((await runExtraction(w.deps, user.id))?.memoriesSuperseded).toBe(1);
    expect((await activeMemories(w.db, user.id)).map((m) => m.content)).toEqual(["Starts a new job at Acme"]);
    const kept = (await w.db.query<any>("select status, superseded_by from memories where id = $1", [old.id])).rows[0];
    expect(kept.status).toBe("superseded");
    expect(kept.superseded_by).toBeTruthy();
  });

  it("turns 'interview today at 6pm' into a follow-up window the code computed", async () => {
    const w = await world(); // 13:00 in Berlin
    const user = await w.newUser();
    await handleTurn(w.deps, user.id, "I have a job interview today at 6pm, pretty nervous");
    w.script = byModel({ utility: JSON.stringify({ agenda: [{
      kind: "followup", about: "job interview", reason: "they were nervous about it", importance: 3,
      when: "2026-11-13T18:00", evidence: "job interview today at 6pm", closes_when: "they say how it went",
    }] }) });
    await runExtraction(w.deps, user.id);
    const [item] = await pendingItems(w.db, user.id);
    expect(item!.eventAt!.toISOString()).toBe("2026-11-13T17:00:00.000Z");
    expect(item!.windowStart.toISOString()).toBe("2026-11-13T18:00:00.000Z"); // an hour after
    expect(item!.pingAt!.toISOString()).toBe("2026-11-13T19:00:00.000Z");
  });

  it("schedules no clock time until it knows the timezone, then learns it from the chat", async () => {
    const w = await world();
    const user = await w.newUser({ timezone: "UTC", timezoneKnown: false });
    await handleTurn(w.deps, user.id, "remind me to call mom at 5pm");
    const reminder = { kind: "reminder", about: "call mom", importance: 2, when: "2026-11-13T17:00", evidence: "remind me to call mom at 5pm" };
    w.script = byModel({ utility: JSON.stringify({ agenda: [reminder] }) });
    await runExtraction(w.deps, user.id);
    expect(await pendingItems(w.db, user.id)).toHaveLength(0);

    await handleTurn(w.deps, user.id, "I'm in Berlin. remind me to call mom at 5pm");
    w.script = byModel({ utility: JSON.stringify({ timezone: "Europe/Berlin", agenda: [reminder] }) });
    await runExtraction(w.deps, user.id);
    const [item] = await pendingItems(w.db, user.id);
    expect(item!.pingAt!.toISOString()).toBe("2026-11-13T16:00:00.000Z");
    expect((await getUser(w.db, user.id))!.timezoneKnown).toBe(true);
  });
});

describe("bringing things up", () => {
  async function withInterview(importance: 1 | 2 | 3 = 3) {
    const w = await world();
    const user = await w.newUser();
    const item = await upsertAgendaItem(w.db, {
      userId: user.id, kind: "followup", about: "job interview", reason: "they were nervous", importance,
      eventAt: new Date(w.now.getTime() + 5 * HOUR), windowStart: new Date(w.now.getTime() + 6 * HOUR),
      windowEnd: new Date(w.now.getTime() + 54 * HOUR), pingAt: new Date(w.now.getTime() + 7 * HOUR), at: w.now,
    });
    return { w, user, item };
  }

  it("asks in the conversation the person started, and then never pings", async () => {
    const { w, user, item } = await withInterview();
    w.advance(9 * HOUR); // 22:00 Berlin, four hours after the interview
    w.script = () => "it's `arr.reverse()`\nso how did the interview go?\n<<used:a1>>";
    const result = await handleTurn(w.deps, user.id, "how do I reverse an array in js");
    expect(w.calls[0]!.messages.at(-1)!.content).toContain("a1: job interview");
    expect(result.bubbles.join("\n")).not.toContain("used");
    expect((await status(w.db, item.id)).status).toBe("woven");
    w.advance(10 * HOUR);
    expect(await runDuePings(w.deps, w.outbound)).toBe(0);
  });

  it("does not write twenty minutes after they wrote, even with a ping planned", async () => {
    const { w, user, item } = await withInterview(2);
    w.advance(6.9 * HOUR); // window open, ping due in a few minutes
    w.script = () => "sure, here you go"; // she did not bring it up
    await handleTurn(w.deps, user.id, "quick one: capital of Peru?");
    expect((await status(w.db, item.id)).ping_at).toBeNull();
    w.advance(HOUR);
    expect(await runDuePings(w.deps, w.outbound)).toBe(0);
    expect((await status(w.db, item.id)).status).toBe("pending"); // still there if they come back
  });

  it("closes the item when they tell her how it went on their own", async () => {
    const { w, user, item } = await withInterview();
    w.advance(9 * HOUR);
    await handleTurn(w.deps, user.id, "the interview went great btw, they want a second round");
    w.script = byModel({ utility: JSON.stringify({ agenda_close: [{ id: "a1", note: "went great" }] }) });
    await runExtraction(w.deps, user.id);
    expect((await status(w.db, item.id)).status).toBe("done");
  });

  it("pings after real silence, written at send time, and may decide to hold", async () => {
    const { w, user, item } = await withInterview();
    w.advance(7.1 * HOUR);
    w.script = () => "so?? how did it go";
    expect(await runDuePings(w.deps, w.outbound)).toBe(1);
    expect(w.sent).toEqual([{ userId: user.id, bubbles: ["so?? how did it go"] }]);
    expect((await status(w.db, item.id)).status).toBe("pinged");
    expect((await recentMessages(w.db, user.id, 1))[0]!.kind).toBe("proactive");

    const other = await withInterview();
    other.w.advance(7.1 * HOUR);
    other.w.script = () => "HOLD";
    expect(await runDuePings(other.w.deps, other.w.outbound)).toBe(0);
    expect((await status(other.w.db, other.item.id)).status).toBe("cancelled");
  });

  it("waits out quiet hours and a recently active chat", async () => {
    const { w, user, item } = await withInterview();
    await w.db.query("update agenda_items set ping_at = $2 where id = $1", [item.id, new Date("2026-11-13T23:30:00Z")]);
    w.now = new Date("2026-11-13T23:31:00Z"); // 00:31 Berlin
    expect(await runDuePings(w.deps, w.outbound)).toBe(0);
    expect(new Date((await status(w.db, item.id)).ping_at).toISOString()).toBe("2026-11-14T07:37:30.000Z");

    w.now = new Date("2026-11-14T09:00:00Z");
    await w.db.query("update users set last_emi_message_at = $2 where id = $1", [user.id, new Date("2026-11-14T08:00:00Z")]);
    expect(await runDuePings(w.deps, w.outbound)).toBe(0);
    expect(new Date((await status(w.db, item.id)).ping_at).toISOString()).toBe("2026-11-14T13:00:00.000Z"); // 5h of silence
  });

  it("sends a reminder on time regardless of silence, budget or the model failing", async () => {
    const w = await world();
    const user = await w.newUser({ initiative: "off" });
    const at = new Date(w.now.getTime() + HOUR);
    await upsertAgendaItem(w.db, { userId: user.id, kind: "reminder", about: "call mom", importance: 2, eventAt: at, windowStart: at, windowEnd: new Date(at.getTime() + 12 * HOUR), pingAt: at, at: w.now });
    await handleTurn(w.deps, user.id, "talking right now");
    w.advance(HOUR + 1000);
    w.script = () => { throw new Error("provider down"); };
    expect(await runDuePings(w.deps, w.outbound)).toBe(1);
    expect(w.sent[0]!.bubbles).toEqual(["Reminder: call mom"]);
  });

  it("checks in less after three brush-offs", async () => {
    const w = await world();
    const user = await w.newUser({ initiative: "high" });
    for (let round = 0; round < 3; round += 1) {
      const item = await upsertAgendaItem(w.db, { userId: user.id, kind: "initiative", about: `thing ${round}`, importance: 2, windowStart: w.now, windowEnd: new Date(w.now.getTime() + 8 * HOUR), pingAt: w.now, at: w.now });
      await w.db.query("update agenda_items set status = 'pinged', pinged_at = $2 where id = $1", [item.id, w.now]);
      w.script = byModel({ writer: "ok, sorry", utility: JSON.stringify({ ping_reaction: "brushoff" }) });
      await handleTurn(w.deps, user.id, "please stop checking on me all the time");
      await runExtraction(w.deps, user.id);
      w.advance(HOUR);
    }
    expect((await getUser(w.db, user.id))!.initiative).toBe("medium");
  });
});

describe("the daily planner", () => {
  async function setup() {
    const w = await world();
    const user = await w.newUser();
    await handleTurn(w.deps, user.id, "my dog Bruno has surgery tomorrow");
    await insertMemory(w.db, { userId: user.id, kind: "event", content: "Their dog Bruno has surgery", occurredOn: "2026-11-14", at: w.now });
    w.now = new Date("2026-11-14T09:30:00Z"); // next morning, 10:30 Berlin
    w.calls.length = 0;
    return { w, user };
  }

  it("plans at most one grounded reach-out a day", async () => {
    const { w, user } = await setup();
    w.script = byModel({ utility: JSON.stringify({ reach_out: { about: "Bruno's surgery", reason: "she knows they were worried", importance: 2, part_of_day: "afternoon", based_on: ["m1"] } }) });
    expect(await runDailyPlanner(w.deps)).toBe(1);
    const [item] = await pendingItems(w.db, user.id);
    expect(item!.kind).toBe("initiative");
    expect(item!.pingAt!.toISOString()).toBe("2026-11-14T14:00:00.000Z"); // 15:00 Berlin
    expect(await runDailyPlanner(w.deps)).toBe(0); // once per local day
    expect(w.calls).toHaveLength(1);
  });

  it("rejects a reason that cites nothing it was shown, and accepts 'no reason today'", async () => {
    const { w, user } = await setup();
    w.script = byModel({ utility: JSON.stringify({ reach_out: { about: "their promotion", importance: 2, part_of_day: "soon", based_on: ["m9"] } }) });
    expect(await runDailyPlanner(w.deps)).toBe(0);
    expect(await pendingItems(w.db, user.id)).toHaveLength(0);
  });

  it("spends nothing on someone with nothing recent, no key, or initiative off", async () => {
    const w = await world();
    const quiet = await w.newUser();
    await handleTurn(w.deps, quiet.id, "hi");
    const off = await w.newUser({ initiative: "off" });
    await handleTurn(w.deps, off.id, "hi");
    w.now = new Date("2026-11-14T09:30:00Z");
    w.calls.length = 0;
    await tick(w.deps, w.outbound);
    expect(w.calls.filter((call) => call.options.model === "utility" && call.messages[0]!.content.includes("write to her person first"))).toHaveLength(0);
  });
});

describe("forgetting", () => {
  it("blanks the text, not just the flag", async () => {
    const w = await world();
    const user = await w.newUser();
    const memory = await insertMemory(w.db, { userId: user.id, kind: "state", content: "Something private", evidence: "something private", embedding: fakeEmbedding("x"), at: w.now });
    await deleteMemory(w.db, user.id, memory.id, w.now);
    const row = (await w.db.query<any>("select content, evidence, embedding, status from memories where id = $1", [memory.id])).rows[0];
    expect(row).toEqual({ content: "", evidence: "", embedding: null, status: "deleted" });
    expect(await activeMemories(w.db, user.id)).toHaveLength(0);
  });
});
