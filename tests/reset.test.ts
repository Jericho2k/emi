import { describe, expect, it } from "vitest";
import { wipeAccount } from "../src/core/account";
import { pendingItems, upsertAgendaItem } from "../src/core/agenda/store";
import { conversationDeps, conversationEffect, ConversationReset } from "../src/core/conversation";
import { runExtraction } from "../src/core/extraction";
import { describeImages } from "../src/core/image-descriptions";
import { ensureInnerDay } from "../src/core/inner";
import { activeMemories, insertMemory } from "../src/core/memory/store";
import { runConsolidation } from "../src/core/memory/timeline";
import { afterTurn, handleTurn } from "../src/core/pipeline";
import { runDailyPlanner, runDuePings } from "../src/core/proactive";
import { addMessage, getUser, recentMessages, updateUser } from "../src/core/users";
import type { ChatMessage, ChatOptions } from "../src/llm/provider";
import { HOUR, world, type World } from "./helpers";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

/** Hold one response AFTER it was generated from the old state. No sleeps. */
function holdResponse(w: World, match: (messages: ChatMessage[], options: ChatOptions) => boolean) {
  const started = deferred(), released = deferred();
  const original = w.deps.llmFor;
  let claimed = false;
  w.deps.llmFor = (user) => {
    const llm = original(user);
    return llm && { ...llm, async chat(messages, options) {
      const reply = await llm.chat(messages, options);
      if (!claimed && match(messages, options)) {
        claimed = true;
        started.resolve();
        await released.promise;
      }
      return reply;
    } };
  };
  return { started: started.promise, release: released.resolve };
}

async function emptyConversation(w: World, userId: string) {
  for (const table of ["messages", "memories", "agenda_items", "arcs", "timeline_entries"]) {
    const { rows } = await w.db.query<{ n: string }>(`select count(*) as n from ${table} where user_id = $1`, [userId]);
    expect(Number(rows[0]!.n), table).toBe(0);
  }
  expect(await getUser(w.db, userId)).toMatchObject({ mood: {}, bond: {}, innerDays: [], extractedThrough: 0, consolidatedThrough: 0, lastUserMessageAt: null, lastEmiMessageAt: null, lastPlannedOn: null, lastSpontaneousAt: null });
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4mQAAAAASUVORK5CYII=", "base64");

describe("the wipe boundary", () => {
  it("discards old extraction, including its child stages, while new-generation work can proceed", async () => {
    const w = await world();
    const user = await w.newUser({ encryptedApiKey: "keep-key", initiative: "low" });
    const other = await w.newUser();
    await insertMemory(w.db, { userId: other.id, kind: "identity", content: "another person's fact", at: w.now });
    await addMessage(w.db, { userId: user.id, role: "user", content: "my sister is called Anna", at: w.now });
    w.script = (messages) => JSON.stringify({ memories: [{ kind: "relationship", content: "Their sister is Anna", evidence: "my sister is called Anna" }], timezone: "Europe/Moscow", display_name: "old nickname", bond: { warmth: 1, trust: 1, irritation: 1 }, mood: { label: "annoyed" } });
    const gate = holdResponse(w, (_messages, options) => options.model === "utility");
    const old = afterTurn(w.deps, user.id, { recalledIds: [] });
    await gate.started;
    // Different Db identity represents another worker, not an in-memory flag.
    const otherWorker = { ...w.db };
    await wipeAccount(otherWorker, user.id);
    await emptyConversation(w, user.id);

    const fresh = await addMessage(w.db, { userId: user.id, role: "user", content: "my dog is named Bruno", at: w.now });
    w.script = () => JSON.stringify({ memories: [{ kind: "relationship", content: "Their dog is Bruno", evidence: "my dog is named Bruno" }] });
    expect(await runExtraction(w.deps, user.id)).toMatchObject({ memoriesAdded: 1 });
    gate.release();
    await old;

    expect((await activeMemories(w.db, user.id)).map((memory) => memory.content)).toEqual(["Their dog is Bruno"]);
    expect(await getUser(w.db, user.id)).toMatchObject({ encryptedApiKey: "keep-key", initiative: "low", timezone: "Europe/Berlin", displayName: "Sam", extractedThrough: fresh.id, mood: {}, bond: {}, innerDays: [] });
    expect(await activeMemories(w.db, other.id)).toHaveLength(1);
    expect(w.calls.some((call) => call.messages[0]!.content.includes("Emi's inner life"))).toBe(false);
    expect((await w.db.query("select * from usage_events where user_id = $1", [user.id])).rows).toHaveLength(3); // both calls and the new memory embedding
    w.script = () => "hi";
    w.calls.length = 0;
    await handleTurn(w.deps, user.id, "hello again");
    expect(JSON.stringify(w.calls)).not.toContain("Anna");
  });

  it("cannot restore a timeline summary that finishes after the wipe", async () => {
    const w = await world(); const user = await w.newUser();
    await w.db.query(`insert into messages (user_id, role, content, created_at)
      select $1, 'user', 'old secret chapter ' || g, $2 from generate_series(1, 50) g`, [user.id, w.now]);
    w.script = () => JSON.stringify({ headline: "Old chapter", summary: "old secret chapter" });
    const gate = holdResponse(w, (messages) => messages[0]!.content.includes("about to leave Emi's view"));
    const old = runConsolidation(w.deps, user.id);
    await gate.started; await wipeAccount(w.db, user.id); gate.release();
    expect(await old).toBeNull();
    await emptyConversation(w, user.id);
    expect(await runConsolidation(w.deps, user.id)).toEqual({ arcs: 0, folds: 0 });
  });

  it("cannot restore a folded timeline that was already being compressed", async () => {
    const w = await world(); const user = await w.newUser();
    await w.db.query(`insert into messages (user_id, role, content, created_at)
      select $1, 'user', 'old chapter ' || g, $2 from generate_series(1, 50) g`, [user.id, w.now]);
    await w.db.query(`insert into arcs (user_id, start_message_id, end_message_id, started_at, ended_at, headline, summary, created_at)
      select $1, g, g, $2, $2, 'old headline', 'old summary', $2 from generate_series(1, 8) g`, [user.id, w.now]);
    w.script = () => JSON.stringify({ headline: "Old chapter", summary: "old compressed memories" });
    const gate = holdResponse(w, (messages) => messages[0]!.content.includes("compressing the long-term record"));
    const old = runConsolidation(w.deps, user.id);
    await gate.started; await wipeAccount(w.db, user.id); gate.release();
    expect(await old).toBeNull(); await emptyConversation(w, user.id);
  });

  it.each(["planner", "ping"])("rejects a pre-wipe %s selection even if its job captures the new version", async (kind) => {
    const w = await world(); const user = await w.newUser({ lastUserMessageAt: w.now });
    await insertMemory(w.db, { userId: user.id, kind: "event", content: "old private event", at: w.now });
    await upsertAgendaItem(w.db, { userId: user.id, kind: "reminder", about: "old private reminder", importance: 2, windowStart: w.now, windowEnd: new Date(w.now.getTime() + HOUR), pingAt: w.now, at: w.now });
    const selected = deferred(), released = deferred();
    const db = w.db;
    const worker = { ...w.deps, db: { ...db, async query<T>(sql: string, params?: unknown[]) {
      const result = await db.query<T>(sql, params);
      if ((kind === "planner" && sql.startsWith("select * from users where initiative")) || (kind === "ping" && sql.includes("with due as"))) {
        selected.resolve(); await released.promise;
      }
      return result;
    } } };
    const job = kind === "planner" ? runDailyPlanner(worker) : runDuePings(worker, w.outbound);
    await selected.promise; await wipeAccount(w.db, user.id); released.resolve();
    expect(await job).toBe(0); expect(w.sent).toHaveLength(0); expect(w.calls).toHaveLength(0);
    await emptyConversation(w, user.id);
  });

  it("discards an inner-day response and allows a new day after a new message", async () => {
    const w = await world(); const user = await w.newUser({ lastUserMessageAt: w.now });
    w.script = () => JSON.stringify({ thought: "the old private thread of thought" });
    const gate = holdResponse(w, (messages) => messages[0]!.content.includes("Emi's inner life"));
    const old = ensureInnerDay(w.deps, user.id);
    await gate.started; await wipeAccount(w.db, user.id); gate.release();
    expect(await old).toBeNull(); await emptyConversation(w, user.id);
    expect(await ensureInnerDay(w.deps, user.id)).toBeNull();
    await addMessage(w.db, { userId: user.id, role: "user", content: "a new day", at: w.now });
    w.script = () => JSON.stringify({ thought: "a fresh thread with no earlier thoughts" });
    expect(await ensureInnerDay(w.deps, user.id)).toBe("a fresh thread with no earlier thoughts");
  });

  it("cannot recreate image descriptions or bytes after their conversation was erased", async () => {
    const w = await world(); const user = await w.newUser();
    await addMessage(w.db, { userId: user.id, role: "user", content: "private old screenshot", images: [{ mimeType: "image/png", data: png }], at: w.now });
    w.script = () => "old image description";
    const gate = holdResponse(w, (messages) => !!messages[1]?.images?.length);
    const old = describeImages(w.deps, user.id);
    await gate.started; await wipeAccount(w.db, user.id); gate.release();
    expect(await old).toBe(0); await emptyConversation(w, user.id);
    expect((await w.db.query("select * from message_images")).rows).toHaveLength(0);
  });

  it("does not resurrect a daily plan written against old memories", async () => {
    const w = await world(); const user = await w.newUser({ lastUserMessageAt: w.now });
    await insertMemory(w.db, { userId: user.id, kind: "event", content: "Old surgery", at: w.now });
    w.script = () => JSON.stringify({ reach_out: { about: "Old surgery", reason: "old worry", importance: 2, part_of_day: "soon", based_on: ["m1"] } });
    const gate = holdResponse(w, (messages) => messages[0]!.content.includes("write to her person first"));
    const old = runDailyPlanner(w.deps);
    await gate.started; await wipeAccount(w.db, user.id); gate.release();
    expect(await old).toBe(0); await emptyConversation(w, user.id);
  });

  it("does not send or save an old reminder whose composition finishes after a wipe", async () => {
    const w = await world(); const user = await w.newUser();
    await upsertAgendaItem(w.db, { userId: user.id, kind: "reminder", about: "old private reminder", importance: 2, windowStart: w.now, windowEnd: new Date(w.now.getTime() + HOUR), pingAt: w.now, at: w.now });
    w.script = () => "old private reminder";
    const gate = holdResponse(w, (_messages, options) => options.model === "writer");
    const old = runDuePings(w.deps, w.outbound);
    await gate.started; await wipeAccount(w.db, user.id); gate.release();
    expect(await old).toBe(0); expect(w.sent).toHaveLength(0);
    await emptyConversation(w, user.id);
  });

  it("makes wipe wait for an already-started send, then erases the sent message", async () => {
    const w = await world(); const user = await w.newUser();
    const scoped = await conversationDeps(w.deps, user.id);
    const started = deferred(), finish = deferred();
    const sending = conversationEffect(scoped.db, async () => {
      // Nested root helpers must use the same transaction connection.
      await w.db.query("select id from users where id = $1", [user.id]);
      started.resolve(); await finish.promise;
      await addMessage(scoped.db, { userId: user.id, role: "emi", content: "already sending", at: w.now });
    });
    await started.promise;
    let wiped = false;
    const wipe = wipeAccount(w.db, user.id).then(() => { wiped = true; });
    await Promise.resolve(); expect(wiped).toBe(false);
    finish.resolve(); await sending; await wipe;
    await emptyConversation(w, user.id);
    await expect(updateUser(scoped.db, user.id, { mood: { label: "annoyed" } })).rejects.toBeInstanceOf(ConversationReset);
  });

  it("rolls back the entire wipe, including its version change, if deletion fails", async () => {
    const w = await world(); const user = await w.newUser({ mood: { label: "cheerful" } });
    await addMessage(w.db, { userId: user.id, role: "user", content: "keep until reset succeeds", at: w.now });
    await insertMemory(w.db, { userId: user.id, kind: "identity", content: "keep this fact", at: w.now });
    await upsertAgendaItem(w.db, { userId: user.id, kind: "followup", about: "keep this plan", importance: 2, windowStart: w.now, windowEnd: new Date(w.now.getTime() + HOUR), pingAt: null, at: w.now });
    await w.db.exec(`create function fail_reset() returns trigger language plpgsql as $$ begin raise exception 'simulated deletion failure'; end $$;
      create trigger fail_reset before delete on memories for each row execute function fail_reset();`);
    await expect(wipeAccount(w.db, user.id)).rejects.toThrow("simulated deletion failure");
    expect(await pendingItems(w.db, user.id)).toHaveLength(1);
    expect(await activeMemories(w.db, user.id)).toHaveLength(1);
    expect(await recentMessages(w.db, user.id, 10)).toHaveLength(1);
    expect((await w.db.query<{ conversation_version: string }>("select conversation_version from users where id = $1", [user.id])).rows[0]!.conversation_version).toBe(0);
    expect(await getUser(w.db, user.id)).toMatchObject({ mood: { label: "cheerful" } });
    await w.db.exec("drop trigger fail_reset on memories");
    await wipeAccount(w.db, user.id); await emptyConversation(w, user.id);
  });
});
