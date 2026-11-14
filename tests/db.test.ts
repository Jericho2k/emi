import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { pgDb } from "../src/db";
import { conversationDeps, ConversationReset } from "../src/core/conversation";
import type { Deps } from "../src/core/types";

function poolStub() {
  const client = { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ conversation_version: "0" }] })), release: vi.fn() };
  const pool = { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ conversation_version: "0" }] })), connect: vi.fn(async () => client) };
  return { pool, client, db: pgDb(pool as unknown as Pool) };
}

it("pins root helpers and nested transactions to one checked-out pg client, with rollback and release", async () => {
  const { pool, client, db } = poolStub();
  await expect(db.transaction(async () => {
    await db.query("first statement");
    await db.transaction(async (tx) => { await tx.query("nested statement"); });
    throw new Error("stop");
  })).rejects.toThrow("stop");
  expect(pool.connect).toHaveBeenCalledTimes(1);
  expect(pool.query).not.toHaveBeenCalled();
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["begin", "first statement", "nested statement", "rollback"]);
  expect(client.release).toHaveBeenCalledTimes(1);
  await db.query("outside transaction");
  expect(pool.query).toHaveBeenCalledWith("outside transaction", []);
});

it("checks the version and writes on that same client, rejecting stale writes before execution", async () => {
  const { pool, client, db } = poolStub();
  const scoped = await conversationDeps({ db } as Deps, "person");
  await scoped.db.query("protected write");
  expect(pool.query).toHaveBeenCalledTimes(1); // capture only
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["begin", "select conversation_version from users where id = $1 for update", "protected write", "commit"]);
  client.query.mockClear();
  client.query.mockImplementation(async () => ({ rows: [{ conversation_version: "1" }] }));
  await expect(scoped.db.query("stale write")).rejects.toBeInstanceOf(ConversationReset);
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["begin", "select conversation_version from users where id = $1 for update", "rollback"]);
  expect(client.release).toHaveBeenCalledTimes(2);
});

it("does not let an async child reuse a transaction connection after release", async () => {
  const { pool, client, db } = poolStub();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let child!: Promise<unknown>;
  await db.transaction(async () => {
    child = ready.then(() => db.query("late child"));
    await db.query("inside transaction");
  });
  release(); await child;
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["begin", "inside transaction", "commit"]);
  expect(pool.query).toHaveBeenCalledWith("late child", []);
});
