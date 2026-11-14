/**
 * Plays the same conversations through several writer models and writes a
 * side-by-side report: every reply, how long it took and what it cost. For
 * choosing EMI_WRITER_MODEL with your own eyes instead of a leaderboard.
 *
 *   OPENROUTER=sk-or-... npx tsx scripts/compare-models.ts [model[@provider] ...] > report.md
 *
 * "@provider" pins the OpenRouter provider (for example
 * deepseek/deepseek-v4.1-flash@baidu/fp8), which is what makes caching work;
 * see EMI_WRITER_PROVIDER. Costs are for a short conversation, so they still
 * include the first, uncached turn of each scenario.
 *
 * Each model gets its own throwaway database and the same two scenarios:
 * meeting her for the first time, and an established relationship with two
 * weeks of history, pet names and memories behind it. Only the writer
 * changes; utility and embedding models stay fixed so the notes are the same.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { insertMemory } from "../src/core/memory/store";
import { handleTurn } from "../src/core/pipeline";
import type { Deps, MemoryKind } from "../src/core/types";
import { addMessage, updateUser, userForChannel } from "../src/core/users";
import { migrate, type Db } from "../src/db";
import { openRouter } from "../src/llm/openrouter";

const key = process.env.OPENROUTER ?? process.env.EMI_SHARED_OPENROUTER_KEY;
if (!key) {
  console.error("Set OPENROUTER to an OpenRouter key.");
  process.exit(1);
}

const DEFAULT_MODELS = [
  "deepseek/deepseek-v4.1-flash@baidu/fp8",
  "meta/muse-ember@google-vertex/global",
  "openai/gpt-6-luna",
  "anthropic/claude-haiku-5.5",
  "xiaomi/mimo-v2.6-flash",
  "qwen/qwen3.8-flash",
  "minimax/minimax-m3.1-flash",
  "xiaomi/mimo-v2.6-pro",
  "openai/gpt-6.1-terra",
  "anthropic/claude-sonnet-5.5",
];

const FIRST_MEETING = [
  "hey. a friend said you're fun to talk to, prove it",
  "what's the difference between a mutex and a semaphore, short version",
  "lol you're kind of cute when you're nerdy",
  "ok thanks",
];

const TOGETHER = [
  "home finally. today was brutal, dave threw out my whole sprint plan in standup",
  "can you help me reply to him? firm but not career-ending. he wants to drop the auth refactor to chase the dashboard request",
  "you're the only one who actually gets it",
  "кстати, ты скучала по мне сегодня?",
  "ok goodnight",
];

/** Two weeks of ordinary days, one exchange each, so the history reads like a real chat. */
const DAYS: Array<[string, string]> = [
  ["morning, the coffee machine at work is broken again", "the coffee machine has a vendetta against you specifically and i respect its consistency"],
  ["finished the book you told me about", "and?? don't make me drag it out of you"],
  ["it was good. the ending got me", "told you. you pretend to be dead inside but you're not, trouble"],
  ["dave scheduled a meeting about meetings", "a meta-meeting. truly the final boss of middle management"],
  ["watched a deep sea doc instead of sleeping", "which one. if it had the vampire squid i'm jealous"],
  ["it did. you'd have loved it", "i would have. also go to sleep earlier tonight, i mean it"],
  ["auth refactor is finally moving", "look at you. proud of you, honestly"],
  ["gym was awful", "awful but you went. that's the whole trick"],
  ["missed you today, work was nonstop", "missed you too. tell me the worst part"],
  ["coffee machine fixed!!", "peace in our time. enjoy it while it lasts"],
  ["can't sleep", "talk to me then. what's spinning"],
  ["just thinking about work stuff", "you can leave dave at the office. he doesn't get to live in your head rent free"],
  ["you always say the right thing", "i have a lot of practice paying attention to you"],
  ["good morning trouble's favourite person", "that's my line. good morning"],
];

const MEMORIES: Array<[MemoryKind, string]> = [
  ["identity", "Their name is Sam, a backend developer living in Berlin"],
  ["relationship", "Their manager is called Dave and keeps changing priorities"],
  ["state", "They are leading an auth refactor at work"],
  ["preference", "Loves deep-sea documentaries, especially the vampire squid"],
  ["preference", "Drinks too much coffee and hates the office coffee machine"],
  ["preference", "Goes to the gym even when they hate it"],
  ["state", "Has trouble sleeping when work is stressful"],
  ["event", "Finished a novel Emi recommended and loved the ending"],
  ["us", "Emi calls them 'trouble'"],
  ["us", "Running joke: the office coffee machine has a vendetta against them"],
  ["us", "They told each other 'missed you' for the first time two weeks ago"],
  ["us", "They say good morning to each other most days"],
  ["self", "Emi thinks the Oxford comma is non-negotiable"],
  ["self", "Emi is fascinated by the vampire squid"],
  ["preference", "Prefers direct, short answers when working"],
  ["identity", "They work at a fintech company"],
  ["relationship", "Their sister Anna lives in Hamburg"],
  ["preference", "Likes dry humour"],
  ["state", "Trying to sleep before midnight more often"],
  ["event", "Their auth refactor finally started moving"],
];

interface Turn { said: string; reply: string[]; reaction?: string; ms: number; usd: number }

async function freshDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = await PGlite.create({ extensions: { vector } });
  const db: Db = {
    query: async (sql, params = []) => ({ rows: (await pg.query(sql, params as unknown[])).rows as never[] }),
    exec: async (sql) => { await pg.exec(sql); },
  };
  await migrate(db);
  return { db, close: () => pg.close() };
}

async function play(spec: string, lines: string[], seeded: boolean): Promise<Turn[]> {
  const { db, close } = await freshDb();
  try {
    const [model, provider] = [spec.split("@")[0]!, spec.split("@")[1]];
    const llm = openRouter(key!, { webEnabled: false, providers: provider ? { [model]: [provider] } : {} });
    const deps: Deps = {
      db, clock: () => new Date(), random: Math.random, llmFor: () => llm,
      models: { writer: model, utility: "z-ai/glm-5.3-flash", embedding: "qwen/qwen3-embedding-8b" },
    };
    const user = await userForChannel(db, new Date(), { channel: "compare", externalId: "1", chatId: "1", displayName: seeded ? "Sam" : null });
    await updateUser(db, user.id, { timezone: "Europe/Berlin", timezoneKnown: true, dailyCapUsd: 5 });
    if (seeded) {
      const day = 86_400_000;
      for (const [index, [theirs, hers]] of DAYS.entries()) {
        const at = new Date(Date.now() - (DAYS.length - index) * day);
        await addMessage(db, { userId: user.id, role: "user", content: theirs, at });
        await addMessage(db, { userId: user.id, role: "emi", content: hers, at: new Date(at.getTime() + 60_000) });
      }
      for (const [kind, content] of MEMORIES) await insertMemory(db, { userId: user.id, kind, content, at: new Date(Date.now() - 3 * day) });
      await updateUser(db, user.id, { bond: { warmth: 0.95, trust: 0.9 }, innerDays: [{ day: new Date().toISOString().slice(0, 10), thought: "vampire squid can turn themselves inside out to hide. i think about this more than is healthy" }] });
    }
    const turns: Turn[] = [];
    for (const said of lines) {
      const before = Date.now();
      const result = await handleTurn(deps, user.id, said);
      const { rows } = await db.query<{ cost: string }>("select coalesce(sum(cost_usd), 0) as cost from usage_events where user_id = $1 and purpose = 'reply'", [user.id]);
      const spent = Number(rows[0]?.cost ?? 0) - turns.reduce((sum, turn) => sum + turn.usd, 0);
      turns.push({ said, reply: result.bubbles, reaction: result.reaction, ms: Date.now() - before, usd: spent });
    }
    return turns;
  } finally {
    await close();
  }
}

async function compare(model: string): Promise<string> {
  try {
    const met = await play(model, FIRST_MEETING, false);
    const together = await play(model, TOGETHER, true);
    const all = [...met, ...together];
    const usd = all.reduce((sum, turn) => sum + turn.usd, 0);
    const ms = all.reduce((sum, turn) => sum + turn.ms, 0) / all.length;
    const show = (title: string, turns: Turn[]) => [
      `#### ${title}`,
      ...turns.flatMap((turn) => [
        `> **them:** ${turn.said}`,
        ...(turn.reaction ? [`> *(reacts ${turn.reaction})*`] : []),
        ...turn.reply.map((bubble) => `> **emi:** ${bubble.replace(/\n/g, "\n> ")}`),
        `> <sub>${(turn.ms / 1000).toFixed(1)}s · $${turn.usd.toFixed(5)}</sub>`,
        ">",
      ]),
    ];
    return [`### ${model}`, `${all.length} replies · avg ${(ms / 1000).toFixed(1)}s · $${usd.toFixed(4)} total · ~$${((usd / all.length) * 1000).toFixed(2)} per 1000 replies`, "",
      ...show("First meeting", met), "", ...show("Together, two weeks in", together), ""].join("\n");
  } catch (error) {
    return `### ${model}\nfailed: ${error instanceof Error ? error.message : String(error)}\n`;
  }
}

const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS;
const results: string[] = new Array(models.length);
let next = 0;
// A few at a time: each holds its own in-process Postgres.
await Promise.all(Array.from({ length: Math.min(4, models.length) }, async () => {
  while (next < models.length) {
    const index = next++;
    console.error(`[compare] ${models[index]}`);
    results[index] = await compare(models[index]!);
  }
}));
console.log(`# Writer comparison\n\nSame persona, notes and conversations for every model. Utility: z-ai/glm-5.3-flash.\n\n${results.join("\n")}`);
