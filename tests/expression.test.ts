import { describe, expect, it } from "vitest";
import { upsertAgendaItem } from "../src/core/agenda/store";
import { activeMischief, allowance, permitted, recordMischief, STICKERS_PER_DAY, sweepMakeups } from "../src/core/expression";
import { handleTurn } from "../src/core/pipeline";
import { runDuePings } from "../src/core/proactive";
import { parseReply } from "../src/core/prompt";
import { getUser, recentMessages, updateUser } from "../src/core/users";
import { HOUR, world, type World } from "./helpers";

const kit = (w: World, voice = true) => {
  w.deps.expression = { stickers: () => ["😹", "😾"], ...(voice ? { speak: async () => new Uint8Array() } : {}), voiceTags: true };
};
const lastNotes = (w: World) => w.calls.filter((call) => call.options.model === "writer").at(-1)!.messages.at(-1)!.content;
const lastStored = async (w: World, userId: string) => (await recentMessages(w.db, userId, 1))[0]!.content;

describe("parsing what she sends besides words", () => {
  it("reads sticker, voice and pin tags, and her own stored markers if she copies them", () => {
    expect(parseReply("lol\n<<sticker:😹>>", "social")).toMatchObject({ bubbles: ["lol"], extras: { sticker: "😹" } });
    expect(parseReply("<<voice:[sighs] fine.>>", "social")).toMatchObject({ bubbles: [], extras: { voice: "[sighs] fine." } });
    expect(parseReply("noted.\n<<pin:emi is not speaking to you>>", "social")).toMatchObject({ bubbles: ["noted."], extras: { pin: "emi is not speaking to you" } });
    expect(parseReply("[sent sticker 😾]\nhm", "social")).toMatchObject({ bubbles: ["hm"], extras: { sticker: "😾" } });
  });

  it("keeps only what is allowed, and still says a voice note it may not send", () => {
    const none = { stickers: [], voice: false, pin: false };
    expect(permitted({ sticker: "😹", voice: "[sighs] fine. whatever.", pin: "x" }, none)).toEqual({ extras: {}, asText: ["fine. whatever."] });
    expect(permitted({ sticker: "😹️" }, { ...none, stickers: ["😹"] })).toEqual({ extras: { sticker: "😹" }, asText: [] });
    expect(permitted({ sticker: "🐶" }, { ...none, stickers: ["😹"] }).extras).toEqual({});
  });
});

describe("in a turn", () => {
  it("tells her what she can send, sends a sticker alone, and remembers it", async () => {
    const w = await world();
    kit(w);
    const person = await w.newUser();
    w.script = () => "<<sticker:😹>>";
    const result = await handleTurn(w.deps, person.id, "i fell off my chair");
    expect(result).toMatchObject({ bubbles: [], extras: { sticker: "😹" } });
    expect(lastNotes(w)).toContain("Stickers you can send (by emoji): 😹 😾");
    expect(lastNotes(w)).toContain("You can send a voice note. Audio tags like [sighs]");
    expect(await lastStored(w, person.id)).toBe("[sent sticker 😹]");
  });

  it("stops offering stickers once today's are used, and says a voice note as text with no voice configured", async () => {
    const w = await world();
    kit(w, false);
    const person = await w.newUser();
    w.script = () => "ha\n<<sticker:😹>>";
    for (let i = 0; i < STICKERS_PER_DAY; i += 1) await handleTurn(w.deps, person.id, `funny thing ${i}`);
    const result = await handleTurn(w.deps, person.id, "another one");
    expect(lastNotes(w)).not.toContain("Stickers you can send");
    expect(result.extras).toBeUndefined();
    expect(result.bubbles).toEqual(["ha"]);

    w.script = () => "<<voice:[sighs] goodnight, trouble>>";
    const night = await handleTurn(w.deps, person.id, "night");
    expect(night.bubbles).toEqual(["goodnight, trouble"]);
    expect(night.extras).toBeUndefined();
  });

  it("pins a sulk only when she is properly annoyed, mischief is on, and nothing is pinned yet", async () => {
    const w = await world();
    const person = await w.newUser();
    w.script = () => "noted.\n<<pin:emi is not speaking to you>>";
    expect((await handleTurn(w.deps, person.id, "calm message")).extras).toBeUndefined();

    await updateUser(w.db, person.id, { bond: { irritation: 0.7, irritationAt: w.now.toISOString(), irritationReason: "ignored her" } });
    const annoyed = await handleTurn(w.deps, person.id, "whatever");
    expect(lastNotes(w)).toContain("annoyed enough to pin a sulky status");
    expect(annoyed.extras).toEqual({ pin: "emi is not speaking to you" });

    await recordMischief(w.db, person.id, { pinned: { text: "emi is not speaking to you", detail: {} } }, w.now);
    expect((await allowance(w.deps, (await getUser(w.db, person.id))!, w.now)).pin).toBe(false); // one at a time
    await updateUser(w.db, person.id, { mischief: false });
    await w.db.query("update mischief_acts set undone_at = $1", [w.now]);
    expect((await allowance(w.deps, (await getUser(w.db, person.id))!, w.now)).pin).toBe(false); // switched off
  });
});

describe("making up", () => {
  async function sulking() {
    const w = await world(); // 13:00 Berlin
    const person = await w.newUser();
    await updateUser(w.db, person.id, { bond: { irritation: 0.4, irritationAt: w.now.toISOString() } });
    await recordMischief(w.db, person.id, { pinned: { text: "emi is not speaking to you", detail: { chatId: "1", messageId: 7 } } }, w.now);
    return { w, person };
  }

  it("takes the pin down herself once she has cooled off, and says so", async () => {
    const { w, person } = await sulking();
    w.script = () => "unpinned. you're forgiven. barely";
    w.advance(HOUR);
    expect(await sweepMakeups(w.deps, w.outbound)).toBe(0); // still annoyed
    w.advance(6 * HOUR); // 20:00, irritation 0.4 has faded below the line
    expect(await sweepMakeups(w.deps, w.outbound)).toBe(1);
    expect(w.undone.map((act) => act.detail.messageId)).toEqual([7]);
    expect(w.sent.map((s) => s.bubbles)).toEqual([["unpinned. you're forgiven. barely"]]);
    expect(lastNotes(w)).toContain('you pinned "emi is not speaking to you"');
    expect(await activeMischief(w.db, person.id)).toHaveLength(0);
    expect((await recentMessages(w.db, person.id, 1))[0]!.kind).toBe("proactive");
  });

  it("waits for morning to make up, but undoes at once and silently when mischief is switched off", async () => {
    const { w, person } = await sulking();
    w.now = new Date("2026-11-13T23:00:00Z"); // midnight in Berlin, long cooled off
    expect(await sweepMakeups(w.deps, w.outbound)).toBe(0);
    await updateUser(w.db, person.id, { mischief: false });
    expect(await sweepMakeups(w.deps, w.outbound)).toBe(1);
    expect(w.undone).toHaveLength(1);
    expect(w.sent).toHaveLength(0);
  });
});

describe("writing first", () => {
  it("can put a sticker on a message she sends because she thought of them", async () => {
    const w = await world();
    kit(w);
    const person = await w.newUser();
    await updateUser(w.db, person.id, { lastUserMessageAt: new Date(w.now.getTime() - 10 * HOUR) });
    await upsertAgendaItem(w.db, {
      userId: person.id, kind: "initiative", about: "anglerfish fact", importance: 2, spontaneous: true,
      windowStart: w.now, windowEnd: new Date(w.now.getTime() + 8 * HOUR), pingAt: w.now, at: w.now,
    });
    w.script = () => "anglerfish dating is worse than yours\n<<sticker:😹>>\n<<pin:should never pin here>>";
    expect(await runDuePings(w.deps, w.outbound)).toBe(1);
    expect(w.sent).toEqual([{ userId: person.id, bubbles: ["anglerfish dating is worse than yours"], extras: { sticker: "😹" } }]);
    expect(lastNotes(w)).toContain("Stickers you can send");
    expect(await lastStored(w, person.id)).toBe("anglerfish dating is worse than yours\n[sent sticker 😹]");
  });
});
