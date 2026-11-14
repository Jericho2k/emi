import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

/**
 * The only database surface the core uses. Narrow on purpose: production wraps
 * a pg Pool, tests wrap an in-process Postgres, and nothing else needs to know.
 */
export interface DbSession {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs several statements with no parameters. Used by migrations. */
  exec(sql: string): Promise<void>;
}

export interface Db extends DbSession {
  transaction<T>(work: (tx: DbSession) => Promise<T>): Promise<T>;
}

/** Keep all queries in a transaction on its connection, including nested helpers. */
export function transactionalDb(session: DbSession, run: <T>(work: (tx: DbSession) => Promise<T>) => Promise<T>): Db {
  const current = new AsyncLocalStorage<{ session: DbSession; active: boolean }>();
  const active = () => {
    const context = current.getStore();
    return context?.active ? context.session : undefined;
  };
  return {
    query: (sql, params) => (active() ?? session).query(sql, params),
    exec: (sql) => (active() ?? session).exec(sql),
    // Nested work joins the existing transaction; it does not commit independently.
    transaction: (work) => {
      const tx = active();
      return tx ? work(tx) : run((connection) => {
        const context = { session: connection, active: true };
        return current.run(context, async () => {
          try { return await work(connection); }
          // An async child must not retain a connection returned to the pool.
          finally { context.active = false; }
        });
      });
    },
  };
}

export function pgDb(pool: Pool): Db {
  const session = (connection: Pick<Pool, "query">): DbSession => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await connection.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      await connection.query(sql);
    },
  });
  return transactionalDb(session(pool), async (work) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(session(client));
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally { client.release(); }
  });
}

/** pgvector accepts a vector as its text form. */
export function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

const migrationsDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "migrations");

export async function migrate(db: Db, dir = migrationsDir): Promise<string[]> {
  await db.exec("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((row) => row.name));
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = await readFile(join(dir, name), "utf8");
    await db.exec(`begin;\n${sql}\ninsert into schema_migrations (name) values ('${name.replace(/'/g, "''")}');\ncommit;`);
    applied.push(name);
  }
  return applied;
}
