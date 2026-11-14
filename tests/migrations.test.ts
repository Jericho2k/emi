import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, it } from "vitest";
import { migrate, type Db } from "../src/db";

it("upgrades an existing database without losing history and only applies the migration once", async () => {
  const pg = await PGlite.create({ extensions: { vector } });
  const db: Db = {
    query: async (sql, params = []) => ({ rows: (await pg.query(sql, params)).rows as never[] }),
    exec: async (sql) => { await pg.exec(sql); },
  };
  try {
    await pg.exec(await readFile(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    await pg.exec("create table schema_migrations (name text primary key, applied_at timestamptz not null default now()); insert into schema_migrations (name) values ('0001_init.sql')");
    const { rows: [user] } = await pg.query<{ id: string }>("insert into users (created_at) values (now()) returning id");
    await pg.query("insert into messages (user_id, role, content, created_at) values ($1, 'user', 'old conversation', now())", [user!.id]);
    expect(await migrate(db)).toEqual(["0002_message_context.sql", "0003_timeline.sql", "0004_message_images.sql", "0005_image_reuse.sql"]);
    expect((await pg.query("select content, reply_context from messages")).rows).toEqual([{ content: "old conversation", reply_context: null }]);
    await pg.query("insert into messages (user_id, role, content, kind, created_at) values ($1, 'user', '/start', 'command', now())", [user!.id]);
    expect(await migrate(db)).toEqual([]);
    expect((await pg.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'message_images'")).rows[0]!.relrowsecurity).toBe(true);
  } finally {
    await pg.close();
  }
});
