import { describe, expect, it } from "vitest";
import { runConsolidation, timelineFor, timelineView, type Arc, type TimelineEntry } from "../src/core/memory/timeline";
import { handleTurn } from "../src/core/pipeline";
import { addMessage, getUser } from "../src/core/users";
import { HOUR, world, type World } from "./helpers";

const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const arc = (n: number): Arc => ({ id: `a${n}`, startMessageId: n * 20 - 19, endMessageId: n * 20, startedAt: at(n), endedAt: at(n), headline: `headline ${n}`, summary: `summary ${n}` });

/** Twenty messages of chat, an hour apart. */
async function chat(w: World, userId: string, topic: string, count = 20) {
  for (let i = 0; i < count; i += 1) {
    w.advance(HOUR);
    await addMessage(w.db, { userId, role: i % 2 ? "emi" : "user", content: `${topic} message ${i}`, at: w.now });
  }
}

/** A model that writes arcs and folds, and counts how often it was asked for each. */
function scribe(w: World) {
  const seen = { arcs: [] as string[], folds: [] as string[] };
  w.script = (messages, options) => {
    if (options.model !== "utility") return "ok";
    if (messages[0]!.content.includes("about to leave Emi's view")) {
      seen.arcs.push(messages[1]!.content);
      return JSON.stringify({ headline: `headline ${seen.arcs.length}`, summary: `They talked about ${/THEM: (\w+)/.exec(messages[1]!.content)![1]} at length.` });
    }
    if (messages[0]!.content.includes("compressing the long-term record")) {
      seen.folds.push(messages[1]!.content);
      return JSON.stringify({ summary: `folded ${seen.folds.length}` });
    }
    return "{}";
  };
  return seen;
}

describe("timeline view", () => {
  it("shows folded entries first and only the arcs beyond them, oldest first", () => {
    const entries: TimelineEntry[] = [{ level: 1, startMessageId: 1, endMessageId: 120, startedAt: at(1), endedAt: at(6), summary: "chapter one" }];
    const lines = timelineView(entries, [1, 2, 3, 4, 5, 6, 7, 8].map(arc));
    expect(lines.map((line) => line.text)).toEqual(["chapter one", "summary 7", "summary 8"]);
  });
  it("lets a higher level hide the levels it covers", () => {
    const entries: TimelineEntry[] = [
      { level: 2, startMessageId: 1, endMessageId: 120, startedAt: at(1), endedAt: at(6), summary: "part one" },
      { level: 1, startMessageId: 1, endMessageId: 60, startedAt: at(1), endedAt: at(3), summary: "old chapter" },
      { level: 1, startMessageId: 121, endMessageId: 140, startedAt: at(7), endedAt: at(7), summary: "new chapter" },
    ];
    expect(timelineView(entries, [7, 8].map(arc)).map((line) => line.text)).toEqual(["part one", "new chapter", "summary 8"]);
  });
});

describe("consolidation", () => {
  it("does nothing, and asks no model, while everything is still in view", async () => {
    const w = await world();
    const user = await w.newUser();
    const seen = scribe(w);
    await chat(w, user.id, "cats", 40);
    expect(await runConsolidation(w.deps, user.id)).toEqual({ arcs: 0, folds: 0 });
    expect(seen.arcs).toHaveLength(0);
    expect(await timelineFor(w.db, user)).toBe("");
  });

  it("writes one arc for exactly the messages that left the window, once", async () => {
    const w = await world();
    const user = await w.newUser();
    const seen = scribe(w);
    await chat(w, user.id, "marathon", 20);
    await chat(w, user.id, "work", 30);
    expect(await runConsolidation(w.deps, user.id)).toEqual({ arcs: 1, folds: 0 });
    // The writer still sees the newest 30, so only the first 20 were summarised.
    expect(seen.arcs[0]).toContain("marathon message 19");
    expect(seen.arcs[0]).not.toContain("work message");
    expect((await getUser(w.db, user.id))!.consolidatedThrough).toBe(20);
    expect(await runConsolidation(w.deps, user.id)).toEqual({ arcs: 0, folds: 0 });
    expect(seen.arcs).toHaveLength(1);
    expect(await timelineFor(w.db, (await getUser(w.db, user.id))!)).toContain("] They talked about marathon at length.");
  });

  it("gives the writer the timeline with recent chapters in full", async () => {
    const w = await world();
    const user = await w.newUser();
    scribe(w);
    await chat(w, user.id, "marathon", 20);
    await chat(w, user.id, "work", 30);
    await runConsolidation(w.deps, user.id);
    w.calls.length = 0;
    await handleTurn(w.deps, user.id, "thinking about the marathon again, we talked about it at length");
    const [system, ...rest] = w.calls[0]!.messages;
    expect(system!.content).toContain("# Your history together");
    expect(system!.content).toContain("They talked about marathon at length.");
    expect(rest.at(-1)!.content).not.toContain("They talked about marathon at length."); // in the timeline already, not repeated in the notes
    // The summarised messages themselves are no longer sent.
    expect(rest.map((m) => m.content).join("\n")).not.toContain("marathon message 3");
  });

  it("folds a long run of arcs once and never summarises the folded part again", async () => {
    const w = await world();
    const user = await w.newUser();
    const seen = scribe(w);
    await chat(w, user.id, "start", 30);
    for (let block = 1; block <= 8; block += 1) {
      await chat(w, user.id, `topic${block}`);
      await runConsolidation(w.deps, user.id);
    }
    expect(seen.arcs).toHaveLength(8);
    expect(seen.folds).toHaveLength(1);
    expect(seen.folds[0]!.split("\n")).toHaveLength(6);
    const timeline = await timelineFor(w.db, (await getUser(w.db, user.id))!);
    expect(timeline.split("\n").slice(2).map((line) => line.replace(/^- \[[^\]]+\] /, ""))).toEqual(["folded 1", "They talked about topic5 at length.", "They talked about topic6 at length."]);
    // Six more arcs fold the next run; the first fold is not touched again.
    for (let block = 9; block <= 14; block += 1) {
      await chat(w, user.id, `topic${block}`);
      await runConsolidation(w.deps, user.id);
    }
    expect(seen.folds).toHaveLength(2);
    expect(seen.folds[1]).not.toContain("folded 1");

    // A chapter that was folded away comes back in full when the turn is about it.
    w.calls.length = 0;
    await handleTurn(w.deps, user.id, "remember topic2? we talked about it at length");
    const messages = w.calls[0]!.messages;
    expect(messages[0]!.content).not.toContain("They talked about topic2 at length.");
    expect(messages.at(-1)!.content).toContain("From your earlier conversations, in more detail");
    expect(messages.at(-1)!.content).toContain("They talked about topic2 at length.");
  });

  it("leaves the history unread when the model fails, and backs off", async () => {
    const w = await world();
    const user = await w.newUser();
    await chat(w, user.id, "anything", 50);
    w.script = () => { throw new Error("provider down"); };
    expect(await runConsolidation(w.deps, user.id)).toBeNull();
    expect((await getUser(w.db, user.id))!.consolidatedThrough).toBe(0);
    const calls = w.calls.length;
    await runConsolidation(w.deps, user.id);
    expect(w.calls.length).toBe(calls); // not retried straight away
  });
});
