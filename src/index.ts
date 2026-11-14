import pg from "pg";
import { createTelegram } from "./channels/telegram";
import { llmResolver, loadConfig } from "./config";
import { tick } from "./core/proactive";
import { elevenLabs, supportsAudioTags } from "./core/voice";
import { startHttp } from "./http";
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
  // An idle connection dropped by the database or the network must not take
  // the process down; the pool opens a new one on the next query.
  pool.on("error", (error) => console.warn("[db] idle connection lost:", error.message));
  const db = pgDb(pool);
  const applied = await migrate(db);
  if (applied.length) console.log(`[db] applied ${applied.join(", ")}`);

  const deps: Deps = { db, clock: () => new Date(), random: Math.random, models: config.models, llmFor: llmResolver(config) };
  const telegram = createTelegram(deps, config);
  const { bot, outbound } = telegram;
  deps.expression = {
    stickers: telegram.stickerEmoji,
    speak: config.voice ? elevenLabs(config.voice) : undefined,
    voiceTags: config.voice ? supportsAudioTags(config.voice.model) : false,
  };
  deps.integrations = config.integrations;
  // Google and Spotify send people back here after they approve access.
  startHttp({ port: config.port ?? 8080, db, integrations: config.integrations, clock: deps.clock, onConnected: telegram.announceConnection });
  const stickerCount = await telegram.loadStickers();
  console.log(`[emi] ${stickerCount} stickers, ${telegram.stickerEmoji().length} moods; voice ${config.voice ? "on" : "off"}; integrations ${config.integrations ? [config.integrations.google && "google", config.integrations.spotify && "spotify"].filter(Boolean).join("+") : "off"}`);

  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return; // A slow pass is never overlapped by the next.
    ticking = true;
    try {
      await tick(deps, outbound);
    } catch (error) {
      // One line, not a stack: a network outage would otherwise fill the log.
      console.error("[tick]", error instanceof Error ? error.message : error);
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
    { command: "mischief", description: "Whether I may sulk in our chat" },
    { command: "connect", description: "Link your calendar, to-dos or Spotify" },
    { command: "autonomy", description: "How much I do without asking" },
    { command: "usage", description: "What today has cost" },
    { command: "help", description: "Everything you can control" },
  ]);
  console.log("[emi] running");
  await bot.start();
}

// A stray rejection in background work is logged and survived, not fatal.
process.on("unhandledRejection", (reason) => console.error("[unhandled]", reason instanceof Error ? reason.message : reason));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
