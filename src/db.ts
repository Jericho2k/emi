import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

/**
 * The only database surface the core uses. Narrow on purpose: production wraps
 * a pg Pool, tests wrap an in-process Postgres, and nothing else needs to know.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs several statements with no parameters. Used by migrations. */
  exec(sql: string): Promise<void>;
}

export function pgDb(pool: Pool): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
  };
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
