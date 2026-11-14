import { z } from "zod";
import { decryptKey, parseMasterKey } from "./core/keys";
import type { Models, User } from "./core/types";
import { openRouter } from "./llm/openrouter";
import type { Llm } from "./llm/provider";

const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  DATABASE_URL: z.string().min(10),
  EMI_MASTER_KEY: z.string().min(40),
  EMI_SHARED_OPENROUTER_KEY: z.string().optional(),
  EMI_WEB_ENABLED: z.enum(["true", "false"]).default("true"),
  EMI_ALLOWED_TELEGRAM_IDS: z.string().optional(),
  EMI_WRITER_MODEL: z.string().default("deepseek/deepseek-v4.1-flash"),
  EMI_VISION_MODEL: z.string().optional(),
  EMI_UTILITY_MODEL: z.string().default("z-ai/glm-5.3-flash"),
  EMI_EMBEDDING_MODEL: z.string().default("qwen/qwen3-embedding-8b"),
});

export interface Config {
  telegramToken: string;
  databaseUrl: string;
  masterKey: Buffer;
  sharedKey: string | null;
  allowedTelegramIds: Set<string> | null;
  models: Models;
  webEnabled?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${missing}. See .env.example.`);
  }
  const e = parsed.data;
  const ids = (e.EMI_ALLOWED_TELEGRAM_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  return {
    telegramToken: e.TELEGRAM_BOT_TOKEN,
    webEnabled: e.EMI_WEB_ENABLED === "true",
    databaseUrl: e.DATABASE_URL,
    masterKey: parseMasterKey(e.EMI_MASTER_KEY),
    sharedKey: e.EMI_SHARED_OPENROUTER_KEY?.trim() || null,
    allowedTelegramIds: ids.length ? new Set(ids) : null,
    models: { writer: e.EMI_WRITER_MODEL, vision: e.EMI_VISION_MODEL?.trim() || e.EMI_WRITER_MODEL, utility: e.EMI_UTILITY_MODEL, embedding: e.EMI_EMBEDDING_MODEL },
  };
}

/** The person's own key if they set one, else the shared key if there is one. */
export function llmResolver(config: Config): (user: User) => Llm | null {
  const clients = new Map<string, Llm>();
  return (user) => {
    const key = (user.encryptedApiKey ? decryptKey(config.masterKey, user.encryptedApiKey) : null) ?? config.sharedKey;
    if (!key) return null;
    let client = clients.get(key);
    if (!client) {
      client = openRouter(key, { webEnabled: config.webEnabled });
      clients.set(key, client);
    }
    return client;
  };
}
