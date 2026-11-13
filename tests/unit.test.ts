import { describe, expect, it } from "vitest";
import { chunkText, toTelegramHtml } from "../src/channels/telegram-format";
import { dedupeKey, pingAfterUserMessage, planWindows } from "../src/core/agenda/policy";
import { inQuietHours, localDaysBetween, localParts, localToUtc, nextAwake } from "../src/core/clock";
import { decryptKey, encryptKey } from "../src/core/keys";
import { admit } from "../src/core/memory/recall";
import { decide, evidenceIsExact, looksSensitive, type Candidate } from "../src/core/memory/reconcile";
import { classifyTurn, historyWindow, parseReply, renderHistory } from "../src/core/prompt";
import { lowerInitiative } from "../src/core/users";
import type { Memory, StoredMessage } from "../src/core/types";

const HOUR = 3_600_000;
const now = new Date("2026-11-13T12:00:00Z");

const memory = (patch: Partial<Memory> = {}): Memory => ({
  id: "m", userId: "u", kind: "state", content: "Looking for a job", status: "active", pinned: false, source: "stated",
  evidence: "", occurredOn: null, storyline: null, lastRelevantAt: null, createdAt: now, ...patch,
});
const candidate = (patch: Partial<Candidate> = {}): Candidate => ({
  kind: "state", content: "Started a new job", evidence: "x", occurredOn: null, storyline: null, supersedes: null, ...patch,
});

describe("clock", () => {
  it("converts local wall time to the right instant on both sides of DST", () => {
    expect(localToUtc("2026-11-13T18:00", "Europe/Berlin")?.toISOString()).toBe("2026-11-13T17:00:00.000Z");
    expect(localToUtc("2026-07-01T18:00", "Europe/Berlin")?.toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(localToUtc("2026-11-14", "America/New_York")?.toISOString()).toBe("2026-11-14T05:00:00.000Z");
    expect(localToUtc("tomorrow", "UTC")).toBeNull();
  });
  it("knows quiet hours that wrap midnight and when they end", () => {
    const night = new Date("2026-11-13T23:30:00Z"); // 00:30 in Berlin
    expect(inQuietHours(night, "Europe/Berlin", 23, 8)).toBe(true);
    expect(inQuietHours(now, "Europe/Berlin", 23, 8)).toBe(false);
    expect(nextAwake(night, "Europe/Berlin", 23, 8).toISOString()).toBe("2026-11-14T07:00:00.000Z");
    expect(nextAwake(new Date("2026-11-13T22:30:00Z"), "Europe/Berlin", 23, 8).toISOString()).toBe("2026-11-14T07:00:00.000Z");
  });
  it("counts days on the person's calendar, not in UTC", () => {
    expect(localParts(new Date("2026-11-13T23:30:00Z"), "Europe/Berlin").dateKey).toBe("2026-11-14");
    expect(localDaysBetween(new Date("2026-11-13T22:00:00Z"), new Date("2026-11-13T23:30:00Z"), "Europe/Berlin")).toBe(1);
  });
});

describe("agenda policy", () => {
  const base = { now, random: () => 0.5, hasTime: true };
  it("sends a reminder exactly at its time and refuses one in the past", () => {
    const at = new Date(now.getTime() + 5 * HOUR);
    expect(planWindows({ ...base, kind: "reminder", importance: 1, eventAt: at })?.pingAt).toEqual(at);
    expect(planWindows({ ...base, kind: "reminder", importance: 1, eventAt: new Date(now.getTime() - HOUR) })).toBeNull();
    expect(planWindows({ ...base, kind: "reminder", importance: 1, eventAt: at, hasTime: false })).toBeNull();
  });
  it("lets importance decide whether a follow-up earns a ping at all", () => {
    const eventAt = new Date(now.getTime() + 6 * HOUR);
    const plan = (importance: 1 | 2 | 3) => planWindows({ ...base, kind: "followup", importance, eventAt })!;
    expect(plan(1).pingAt).toBeNull();
    expect(plan(1).windowStart.getTime()).toBe(eventAt.getTime() + HOUR);
    expect(plan(3).pingAt!.getTime()).toBe(eventAt.getTime() + 2 * HOUR);
    expect(plan(2).pingAt!.getTime()).toBeGreaterThan(plan(3).pingAt!.getTime());
  });
  it("never pings for something with no day, and drops what is long past", () => {
    expect(planWindows({ ...base, kind: "followup", importance: 3, eventAt: null, hasTime: false })?.pingAt).toBeNull();
    expect(planWindows({ ...base, kind: "followup", importance: 3, eventAt: new Date(now.getTime() - 24 * HOUR) })).toBeNull();
  });
  it("absorbs planned initiative when the person writes first", () => {
    const item = { windowStart: new Date(now.getTime() - HOUR), windowEnd: new Date(now.getTime() + 40 * HOUR), pingAt: new Date(now.getTime() + 20 * 60_000), now, initiative: "medium" as const };
    expect(pingAfterUserMessage({ ...item, kind: "initiative", importance: 2 })).toBeNull();
    expect(pingAfterUserMessage({ ...item, kind: "followup", importance: 2 })).toBeNull();
    // Something that matters keeps a ping, but only after a full silence.
    expect(pingAfterUserMessage({ ...item, kind: "followup", importance: 3 })!.getTime()).toBe(now.getTime() + 5 * HOUR);
    // A reminder is a promise and is never moved.
    expect(pingAfterUserMessage({ ...item, kind: "reminder", importance: 1 })).toEqual(item.pingAt);
    // An event that has not happened yet is not touched by today's chat.
    const future = { ...item, windowStart: new Date(now.getTime() + 5 * HOUR), pingAt: new Date(now.getTime() + 6 * HOUR) };
    expect(pingAfterUserMessage({ ...future, kind: "followup", importance: 2 })).toEqual(future.pingAt);
  });
  it("gives the same subject the same key", () => {
    expect(dedupeKey("followup", "Job interview at Acme!")).toBe(dedupeKey("followup", "job interview at acme"));
  });
});

describe("memory reconciliation", () => {
  it("skips a repeat", () => {
    expect(decide(candidate({ content: "Looking for a job" }), [{ memory: memory(), similarity: 0.95 }])).toEqual({ action: "skip", duplicateOf: "m" });
  });
  it("never merges two events on different days, however alike", () => {
    const stored = memory({ kind: "event", content: "Went for a run", occurredOn: "2026-11-10" });
    const again = candidate({ kind: "event", content: "Went for a run", occurredOn: "2026-11-12" });
    expect(decide(again, [{ memory: stored, similarity: 0.99 }])).toEqual({ action: "add" });
    expect(decide({ ...again, occurredOn: "2026-11-10" }, [{ memory: stored, similarity: 0.99 }]).action).toBe("skip");
  });
  it("replaces a state but never an event, a pinned memory, or one the person wrote", () => {
    expect(decide(candidate({ supersedes: memory() }), [])).toEqual({ action: "supersede", targetId: "m" });
    expect(decide(candidate({ supersedes: memory({ kind: "event" }) }), []).action).toBe("add");
    expect(decide(candidate({ supersedes: memory({ pinned: true }) }), []).action).toBe("add");
    expect(decide(candidate({ supersedes: memory({ source: "user" }) }), []).action).toBe("add");
    expect(decide(candidate({ kind: "event", supersedes: memory() }), []).action).toBe("add");
  });
  it("accepts only a quote the person really wrote", () => {
    expect(evidenceIsExact("interview on Friday", "so I have an Interview on  friday, wish me luck")).toBe(true);
    expect(evidenceIsExact("interview on Monday", "so I have an interview on friday")).toBe(false);
  });
  it("refuses secrets", () => {
    expect(looksSensitive("my key is sk-or-v1-abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(looksSensitive("card 4111 1111 1111 1111")).toBe(true);
    expect(looksSensitive("His sister is called Anna")).toBe(false);
  });
});

describe("recall admission", () => {
  it("recalls nothing when nothing is on topic", () => {
    expect(admit([{ memory: memory(), similarity: 0.1, lexical: 0 }], now)).toEqual([]);
  });
  it("keeps what reaches half the strength of the best match", () => {
    const admitted = admit([
      { memory: memory({ id: "a" }), similarity: 0.8, lexical: 1 },
      { memory: memory({ id: "b" }), similarity: 0.5, lexical: 0 },
      { memory: memory({ id: "c" }), similarity: 0.32, lexical: 0 },
    ], now);
    expect(admitted.map((item) => item.memory.id)).toEqual(["a", "b"]);
  });
});

describe("prompt", () => {
  it("guesses the kind of turn in English and Russian", () => {
    expect(classifyTurn("lol same")).toBe("social");
    expect(classifyTurn("ну как ты там")).toBe("social");
    expect(classifyTurn("write a python function that reverses a list")).toBe("mixed");
    expect(classifyTurn("напиши функцию на питоне")).toBe("mixed");
    expect(classifyTurn("что такое монада")).toBe("mixed");
    expect(classifyTurn("fix this:\n```js\nlet a = ;\n```")).toBe("task");
  });
  it("lets the writer choose its breaks, up to three", () => {
    expect(parseReply("omg\n---\ntell me everything", "social").bubbles).toEqual(["omg", "tell me everything"]);
    expect(parseReply("a\n---\nb\n---\nc\n---\nd", "social").bubbles).toEqual(["a", "b", "c\nd"]);
    expect(parseReply("one thought", "social").bubbles).toEqual(["one thought"]);
    // A blank line between short chat lines is the same choice, spelled differently.
    expect(parseReply("yeah i've had it\n\nwhat should i look up?", "social").bubbles).toEqual(["yeah i've had it", "what should i look up?"]);
    expect(parseReply(`${"long ".repeat(60)}\n\nsecond paragraph`, "mixed").bubbles).toHaveLength(1);
  });
  it("never splits a task answer or anything structured", () => {
    expect(parseReply("here\n---\n```js\nx\n```", "social").bubbles).toHaveLength(1);
    expect(parseReply("part one\n---\npart two", "task").bubbles).toEqual(["part one\n\npart two"]);
  });
  it("strips the used tag, stray notes tags and an imitated timestamp", () => {
    const parsed = parseReply("[Fri 13 Nov 2026, 22:04]\nhow did the interview go?\n<<used:a1>>", "social");
    expect(parsed).toEqual({ bubbles: ["how did the interview go?"], used: ["a1"] });
  });
  it("moves the history window in blocks so the prompt prefix stays stable", () => {
    expect(historyWindow(10)).toBe(10);
    expect([50, 51, 60, 69].map((total) => total - historyWindow(total))).toEqual([20, 20, 20, 20]);
    expect(70 - historyWindow(70)).toBe(40);
  });
  it("shows a command and what the app displayed on the person's side, never in Emi's voice", () => {
    const base = { agendaItemId: null, createdAt: now };
    const history: StoredMessage[] = [
      { ...base, id: 1, role: "user", kind: "command", content: "/timezone probe-482" },
      { ...base, id: 2, role: "emi", kind: "command", content: "invalid timezone" },
      { ...base, id: 3, role: "emi", kind: "reply", content: "here's what happened" },
      { ...base, id: 4, role: "user", kind: "reply", content: "that one", replyTo: { author: "emi", text: "invalid timezone" } },
    ];
    const rendered = renderHistory(history, "UTC");
    expect(rendered.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(rendered[0]!.content).toContain("[They used a command: /timezone probe-482]");
    expect(rendered[0]!.content).toContain("This is what it showed them:\ninvalid timezone\n]");
    expect(rendered[1]!.content).toBe("here's what happened");
    expect(rendered.at(-1)!.content).toContain('"author":"emi","text":"invalid timezone"');
    expect(rendered.at(-1)!.content).not.toContain("They used a command");
    expect(history[1]!.content).toBe("invalid timezone");
  });
  it("stamps a message when the day changes or an hour passes, and merges same-side turns", () => {
    const at = (iso: string) => new Date(iso);
    const rendered = renderHistory([
      { id: 1, role: "user", content: "hi", kind: "reply", agendaItemId: null, createdAt: at("2026-11-12T10:00:00Z") },
      { id: 2, role: "emi", content: "hey", kind: "reply", agendaItemId: null, createdAt: at("2026-11-12T10:00:05Z") },
      { id: 3, role: "user", content: "quick q", kind: "reply", agendaItemId: null, createdAt: at("2026-11-12T10:05:00Z") },
      { id: 4, role: "user", content: "back", kind: "reply", agendaItemId: null, createdAt: at("2026-11-13T09:00:00Z") },
    ], "UTC");
    expect(rendered).toEqual([
      { role: "user", content: "[Thu 12 Nov 2026, 10:00]\nhi" },
      { role: "assistant", content: "hey" },
      { role: "user", content: "quick q\n[Fri 13 Nov 2026, 09:00]\nback" },
    ]);
  });
});

describe("telegram formatting", () => {
  it("converts the markdown Telegram can show and escapes the rest", () => {
    expect(toTelegramHtml("use **this** and `a<b`")).toBe("use <b>this</b> and <code>a&lt;b</code>");
    expect(toTelegramHtml("```js\nif (a < b) {}\n```")).toBe('<pre><code class="language-js">if (a &lt; b) {}</code></pre>');
    expect(toTelegramHtml("2 * 3 * 4 and <tag>")).toBe("2 * 3 * 4 and &lt;tag&gt;");
  });
  it("splits long answers and keeps a code block closed in each piece", () => {
    const text = `intro\n\`\`\`py\n${"print('x')\n".repeat(60)}\`\`\`\nend`;
    const chunks = chunkText(text, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(310);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });
});

describe("misc", () => {
  it("round-trips an API key and rejects a wrong master key", () => {
    const master = Buffer.alloc(32, 7);
    const stored = encryptKey(master, "sk-or-secret");
    expect(stored).not.toContain("secret");
    expect(decryptKey(master, stored)).toBe("sk-or-secret");
    expect(decryptKey(Buffer.alloc(32, 8), stored)).toBeNull();
  });
  it("quietens but never switches off, and never turns her back on", () => {
    expect(lowerInitiative("high")).toBe("medium");
    expect(lowerInitiative("low")).toBe("low");
    expect(lowerInitiative("off")).toBe("off");
  });
});
