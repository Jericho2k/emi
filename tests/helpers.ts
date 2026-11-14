import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Deps, Outbound, User } from "../src/core/types";
import { getUser, userForChannel } from "../src/core/users";
import { migrate, transactionalDb, type Db } from "../src/db";
import { EMBEDDING_DIMENSIONS, type ChatMessage, type ChatOptions, type Llm } from "../src/llm/provider";

/** A real Postgres with pgvector, in process. */
export async function testDb(): Promise<Db> {
  const pg = await PGlite.create({ extensions: { vector } });
  const db: Db = transactionalDb({
    query: async (sql, params = []) => ({ rows: (await pg.query(sql, params as any[])).rows as any[] }),
    exec: async (sql) => { await pg.exec(sql); },
  }, (work) => pg.transaction(async (tx) => work({
    query: async (sql, params = []) => ({ rows: (await tx.query(sql, params)).rows as never[] }),
    exec: async (sql) => { await tx.exec(sql); },
  })));
  await migrate(db);
  return db;
}

/** Words hashed into a vector: texts that share words come out similar. */
export function fakeEmbedding(text: string): number[] {
  const out = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    let hash = 7;
    for (const char of word) hash = (hash * 31 + char.codePointAt(0)!) % EMBEDDING_DIMENSIONS;
    out[hash] = (out[hash] ?? 0) + 1;
  }
  const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0)) || 1;
  return out.map((value) => value / norm);
}

export type Script = (messages: ChatMessage[], options: ChatOptions) => string;

export interface World {
  deps: Deps;
  db: Db;
  now: Date;
  calls: Array<{ messages: ChatMessage[]; options: ChatOptions }>;
  /** What the model says. Swap freely inside a test. */
  script: Script;
  sent: Array<{ userId: string; bubbles: string[] }>;
  outbound: Outbound;
  hasKey: boolean;
  advance(ms: number): void;
  newUser(patch?: Partial<User>): Promise<User>;
}

export const HOUR = 3_600_000;

export async function world(start = "2026-11-13T12:00:00Z"): Promise<World> {
  const db = await testDb();
  const w = {
    db, now: new Date(start), calls: [], sent: [], hasKey: true,
    script: () => "ok",
  } as unknown as World;
  const llm: Llm = {
    async chat(messages, options) {
      w.calls.push({ messages, options });
      return { text: w.script(messages, options), usage: { model: options.model, inputTokens: 10, outputTokens: 5, costUsd: 0.001 } };
    },
    async embed(texts, model) {
      return { vectors: texts.map(fakeEmbedding), usage: { model, inputTokens: 1, outputTokens: 0, costUsd: 0 } };
    },
  };
  w.deps = {
    db, clock: () => new Date(w.now), random: () => 0.5,
    models: { writer: "writer", utility: "utility", embedding: "embedding" },
    llmFor: () => (w.hasKey ? llm : null),
  };
  w.outbound = { send: async (userId, bubbles) => { w.sent.push({ userId, bubbles }); } };
  w.advance = (ms) => { w.now = new Date(w.now.getTime() + ms); };
  let counter = 0;
  w.newUser = async (patch = {}) => {
    counter += 1;
    const user = await userForChannel(db, w.now, { channel: "test", externalId: String(counter), chatId: String(counter), displayName: "Sam" });
    const { updateUser } = await import("../src/core/users");
    await updateUser(db, user.id, { timezone: "Europe/Berlin", timezoneKnown: true, ...patch });
    return (await getUser(db, user.id))!;
  };
  return w;
}

/** Routes a scripted reply by which model was asked. */
export function byModel(replies: { writer?: string | Script; utility?: string | Script }): Script {
  return (messages, options) => {
    const reply = options.model === "utility" ? replies.utility : replies.writer;
    return typeof reply === "function" ? reply(messages, options) : reply ?? (options.model === "utility" ? "{}" : "ok");
  };
}
