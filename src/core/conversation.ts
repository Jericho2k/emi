import type { Db, DbSession } from "../db";
import type { Deps } from "./types";

/** Expected cancellation, not a provider failure or a reason to retry old work. */
export class ConversationReset extends Error {
  constructor() { super("conversation was reset"); }
}

interface Scope { root: Db; userId: string; version: string }
const scopes = new WeakMap<Db, Scope>();
const cached = new WeakMap<Db, Map<string, { version: string; db: Db }>>();

/** Usage survives a wipe: a request already billed still belongs in the ledger. */
export function rootDb(db: Db): Db { return scopes.get(db)?.root ?? db; }

/** Stop a paid job at its response boundary, before starting another stage. */
export async function checkConversation(db: Db): Promise<void> {
  if (scopes.has(db)) await db.transaction(async () => {});
}

async function guard(tx: DbSession, scope: Scope): Promise<void> {
  // The lock and the protected query share one transaction. A wipe either
  // follows that commit (and deletes it), or wins first and rejects the query.
  const { rows } = await tx.query<{ conversation_version: string }>(
    "select conversation_version from users where id = $1 for update", [scope.userId],
  );
  if (!rows[0] || String(rows[0].conversation_version) !== scope.version) throw new ConversationReset();
}

/** Capture once, before reading anything a job may later turn into a write. */
export async function conversationDeps(deps: Deps, userId: string): Promise<Deps> {
  const existing = scopes.get(deps.db);
  if (existing) {
    if (existing.userId !== userId) throw new Error("conversation scope belongs to another person");
    return deps;
  }
  const root = deps.db;
  const { rows } = await root.query<{ conversation_version: string }>("select conversation_version from users where id = $1", [userId]);
  if (!rows[0]) throw new ConversationReset();
  const version = String(rows[0].conversation_version);
  const people = cached.get(root) ?? new Map();
  cached.set(root, people);
  let entry = people.get(userId);
  if (!entry || entry.version !== version) {
    const scope: Scope = { root, userId, version };
    const db: Db = {
      transaction: (work) => root.transaction(async (tx) => { await guard(tx, scope); return work(tx); }),
      query: (sql, params) => db.transaction((tx) => tx.query(sql, params)),
      exec: (sql) => db.transaction((tx) => tx.exec(sql)),
    };
    scopes.set(db, scope);
    entry = { version, db };
    // A slower capture of an older version must not evict the new scope.
    if (!people.has(userId) || BigInt(people.get(userId)!.version) <= BigInt(version)) people.set(userId, entry);
  }
  return { ...deps, db: entry.db };
}

/** Children inherit the parent's version; a reset must not restart its stages. */
export async function inConversation<T>(deps: Deps, userId: string, work: (scoped: Deps) => Promise<T>): Promise<T | null> {
  const nested = scopes.has(deps.db);
  try { return await work(await conversationDeps(deps, userId)); }
  catch (error) {
    if (!nested && error instanceof ConversationReset) return null;
    throw error;
  }
}

/** Serialize an irreversible send with reset, after composition has finished. */
export async function conversationEffect<T>(db: Db, effect: () => Promise<T>): Promise<T> {
  if (!scopes.has(db)) throw new Error("conversation effect needs a captured conversation");
  return db.transaction(() => effect());
}
