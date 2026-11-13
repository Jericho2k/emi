import pg from "pg";
import { createTelegram } from "./channels/telegram";
import { llmResolver, loadConfig } from "./config";
import { tick } from "./core/proactive";
import type { Deps } from "./core/types";
import { migrate, pgDb } from "./db";

try {
  process.loadEnvFile();
} catch {
  // No .env file: the environment is already set, as on a host.
}

// Dates stay as "YYYY-MM-DD" text; turning them into a Date shifts the day
// whenever the server is not on UTC.
pg.types.setTypeParser(1082, (value) => value);

const TICK_MS = 30_000;

async function main() {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  const db = pgDb(pool);
  const applied = await migrate(db);
  if (applied.length) console.log(`[db] applied ${applied.join(", ")}`);

  const deps: Deps = { db, clock: () => new Date(), random: Math.random, models: config.models, llmFor: llmResolver(config) };
  const { bot, outbound } = createTelegram(deps, config);

  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return; // A slow pass is never overlapped by the next.
    ticking = true;
    try {
      await tick(deps, outbound);
    } catch (error) {
      console.error("[tick]", error);
    } finally {
      ticking = false;
    }
  }, TICK_MS);

  const stop = async () => {
    clearInterval(timer);
    await bot.stop();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await bot.api.setMyCommands([
    { command: "memory", description: "What I know about you" },
    { command: "agenda", description: "What I'm planning to bring up" },
    { command: "initiative", description: "How often I write first" },
    { command: "usage", description: "What today has cost" },
    { command: "help", description: "Everything you can control" },
  ]);
  console.log("[emi] running");
  await bot.start();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
