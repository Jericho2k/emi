/**
 * Talk to Emi from a terminal, with real models and a throwaway in-process
 * database. Nothing is saved between runs, and no Telegram or Postgres is
 * needed. For trying the persona, memory and check-ins quickly.
 *
 *   OPENROUTER=sk-or-... npm run live                          interactive
 *   OPENROUTER=sk-or-... npm run live scripts/scenario.txt     scripted
 *
 * Besides ordinary messages:
 *   +3h / +2d / +30m   move the clock forward and let her act (pings, planner)
 *   /memory            what she has stored
 *   /agenda            what she plans to bring up
 *   /usage             what this run has cost
 * In a scenario file, lines starting with # are comments.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pendingItems } from "../src/core/agenda/store";
import { describeMoment } from "../src/core/clock";
import { runExtraction } from "../src/core/extraction";
import { activeMemories } from "../src/core/memory/store";
import { handleTurn } from "../src/core/pipeline";
import { tick } from "../src/core/proactive";
import type { Deps } from "../src/core/types";
import { getUser, updateUser, userForChannel } from "../src/core/users";
import { migrate, type Db } from "../src/db";
import { openRouter } from "../src/llm/openrouter";

const key = process.env.OPENROUTER ?? process.env.EMI_SHARED_OPENROUTER_KEY;
if (!key) {
  console.error("Set OPENROUTER (or EMI_SHARED_OPENROUTER_KEY) to an OpenRouter key.");
  process.exit(1);
}

const pg = await PGlite.create({ extensions: { vector } });
const db: Db = {
  query: async (sql, params = []) => ({ rows: (await pg.query(sql, params as unknown[])).rows as never[] }),
  exec: async (sql) => { await pg.exec(sql); },
};
await migrate(db);

let offsetMs = 0;
const llm = openRouter(key, { webEnabled: process.env.EMI_WEB_ENABLED === "true" });
const deps: Deps = {
  db, clock: () => new Date(Date.now() + offsetMs), random: Math.random, llmFor: () => llm,
  models: {
    writer: process.env.EMI_WRITER_MODEL ?? "deepseek/deepseek-v4.1-flash",
    utility: process.env.EMI_UTILITY_MODEL ?? "z-ai/glm-5.3-flash",
    embedding: process.env.EMI_EMBEDDING_MODEL ?? "qwen/qwen3-embedding-8b",
  },
};
const tz = process.env.EMI_TZ ?? "Europe/Berlin";
const created = await userForChannel(db, deps.clock(), { channel: "terminal", externalId: "1", chatId: "1", displayName: process.env.EMI_NAME ?? null });
await updateUser(db, created.id, { timezone: tz, timezoneKnown: true, dailyCapUsd: 5 });
const userId = created.id;

const say = (who: string, text: string) => console.log(`\n${who}: ${text.replace(/\n/g, `\n${" ".repeat(who.length + 2)}`)}`);
const outbound = { send: async (_id: string, bubbles: string[]) => { for (const bubble of bubbles) say("emi (wrote first)", bubble); } };
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

async function handle(line: string): Promise<void> {
  const user = (await getUser(db, userId))!;
  const jump = /^\+(\d+(?:\.\d+)?)([mhd])$/.exec(line);
  if (jump) {
    offsetMs += Number(jump[1]) * UNITS[jump[2]!]!;
    console.log(`\n--- now ${describeMoment(deps.clock(), tz)} ---`);
    await tick(deps, outbound);
  } else if (line === "/memory") {
    const memories = await activeMemories(db, userId);
    console.log(memories.length ? memories.map((m) => `  [${m.kind}${m.occurredOn ? ` ${m.occurredOn}` : ""}] ${m.content}`).join("\n") : "  (no memories)");
  } else if (line === "/agenda") {
    const items = await pendingItems(db, userId);
    console.log(items.length ? items.map((i) => `  [${i.kind} !${i.importance}] ${i.about} · from ${describeMoment(i.windowStart, tz)} · ping ${i.pingAt ? describeMoment(i.pingAt, tz) : "never"}`).join("\n") : "  (nothing planned)");
  } else if (line === "/usage") {
    const { rows } = await db.query<{ purpose: string; n: string; cost: string }>("select purpose, count(*) as n, sum(cost_usd) as cost from usage_events group by purpose order by purpose");
    for (const row of rows) console.log(`  ${row.purpose}: ${row.n} calls, $${Number(row.cost).toFixed(5)}`);
    console.log(`  mood: ${JSON.stringify(user.mood)} · initiative: ${user.initiative}`);
  } else {
    say("you", line);
    const result = await handleTurn(deps, userId, line);
    for (const bubble of result.bubbles) say("emi", bubble);
    if (!result.problem) {
      const summary = await runExtraction(deps, userId, { memoryIds: result.recalledIds });
      if (summary && Object.values(summary).some(Boolean)) console.log(`  (kept: ${JSON.stringify(summary)})`);
    }
  }
}

const file = process.argv[2];
if (file) {
  for (const line of readFileSync(file, "utf8").split("\n").map((l) => l.trim())) {
    if (line && !line.startsWith("#")) await handle(line);
  }
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Talking to Emi. It is ${describeMoment(deps.clock(), tz)} there. Ctrl+C to leave.`);
  for (;;) {
    const line = (await rl.question("\n> ")).trim();
    if (line) await handle(line).catch((error) => console.error("failed:", error instanceof Error ? error.message : error));
  }
}
await pg.close();
