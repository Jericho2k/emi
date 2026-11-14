import { z } from "zod";
import { decryptKey, parseMasterKey } from "./core/keys";
import type { Models, User } from "./core/types";
import { openRouter } from "./llm/openrouter";
import type { VoiceConfig } from "./core/voice";
import type { IntegrationsConfig } from "./core/integrations/connect";
import type { Llm } from "./llm/provider";

const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(10),
  DATABASE_URL: z.string().min(10),
  EMI_MASTER_KEY: z.string().min(40),
  EMI_SHARED_OPENROUTER_KEY: z.string().optional(),
  EMI_WEB_ENABLED: z.enum(["true", "false"]).default("true"),
  EMI_PACING: z.enum(["true", "false"]).default("true"),
  EMI_ALLOWED_TELEGRAM_IDS: z.string().optional(),
  EMI_WRITER_MODEL: z.string().default("deepseek/deepseek-v4.1-flash"),
  EMI_VISION_MODEL: z.string().optional(),
  EMI_UTILITY_MODEL: z.string().default("z-ai/glm-5.3-flash"),
  EMI_EMBEDDING_MODEL: z.string().default("qwen/qwen3-embedding-8b"),
  // Provider to ask first for each model (OpenRouter endpoint tags, comma-separated).
  EMI_WRITER_PROVIDER: z.string().default("baidu/fp8,deepinfra/fp8"),
  EMI_UTILITY_PROVIDER: z.string().optional(),
  // Stickers: Telegram sticker set names, comma-separated (the part after t.me/addstickers/).
  EMI_STICKER_PACKS: z.string().default("catsunicmass"),
  // Voice notes: ElevenLabs. Both must be set for her to send any.
  ELEVENLABS_API_KEY: z.string().optional(),
  EMI_VOICE_ID: z.string().optional(),
  EMI_TTS_MODEL: z.string().default("eleven_v4"),
  // Integrations. PUBLIC_URL is where this server is reachable (Railway: the
  // service's public domain); Google and Spotify send people back there.
  PUBLIC_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().default(8080),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
});

export interface Config {
  telegramToken: string;
  databaseUrl: string;
  masterKey: Buffer;
  sharedKey: string | null;
  allowedTelegramIds: Set<string> | null;
  models: Models;
  webEnabled?: boolean;
  /** Telegram sticker sets she may send from. */
  stickerPacks?: string[];
  /** Her voice, when configured. */
  voice?: VoiceConfig;
  /** Calendar, to-dos and music, when PUBLIC_URL and at least one app are set. */
  integrations?: IntegrationsConfig;
  port?: number;
  /** Providers to ask first, per model id. See OpenRouterConfig. */
  providers?: Record<string, string[]>;
  /** Type chat replies at a human pace. Off unless set, so tests never wait. */
  pacing?: boolean;
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
    pacing: e.EMI_PACING === "true",
    databaseUrl: e.DATABASE_URL,
    masterKey: parseMasterKey(e.EMI_MASTER_KEY),
    sharedKey: e.EMI_SHARED_OPENROUTER_KEY?.trim() || null,
    allowedTelegramIds: ids.length ? new Set(ids) : null,
    stickerPacks: e.EMI_STICKER_PACKS.split(",").map((name) => name.trim()).filter(Boolean),
    voice: e.ELEVENLABS_API_KEY?.trim() && e.EMI_VOICE_ID?.trim()
      ? { apiKey: e.ELEVENLABS_API_KEY.trim(), voiceId: e.EMI_VOICE_ID.trim(), model: e.EMI_TTS_MODEL }
      : undefined,
    port: e.PORT,
    integrations: integrationsFrom(e),
    providers: providerOrder([[e.EMI_WRITER_MODEL, e.EMI_WRITER_PROVIDER], [e.EMI_UTILITY_MODEL, e.EMI_UTILITY_PROVIDER]]),
    models: { writer: e.EMI_WRITER_MODEL, vision: e.EMI_VISION_MODEL?.trim() || e.EMI_WRITER_MODEL, utility: e.EMI_UTILITY_MODEL, embedding: e.EMI_EMBEDDING_MODEL },
  };
}

function integrationsFrom(e: z.infer<typeof Env>): IntegrationsConfig | undefined {
  const app = (id?: string, secret?: string) => (id?.trim() && secret?.trim() ? { clientId: id.trim(), clientSecret: secret.trim() } : undefined);
  const google = app(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET);
  const spotify = app(e.SPOTIFY_CLIENT_ID, e.SPOTIFY_CLIENT_SECRET);
  if (!e.PUBLIC_URL || (!google && !spotify)) return undefined;
  return { masterKey: parseMasterKey(e.EMI_MASTER_KEY), publicUrl: e.PUBLIC_URL, ...(google ? { google } : {}), ...(spotify ? { spotify } : {}) };
}

/** Model id to provider order. A blank provider means OpenRouter chooses. */
export function providerOrder(pairs: Array<[string, string | undefined]>): Record<string, string[]> {
  const order: Record<string, string[]> = {};
  for (const [model, providers] of pairs) {
    const list = (providers ?? "").split(",").map((provider) => provider.trim()).filter(Boolean);
    if (list.length && !order[model]) order[model] = list;
  }
  return order;
}

/** The person's own key if they set one, else the shared key if there is one. */
export function llmResolver(config: Config): (user: User) => Llm | null {
  const clients = new Map<string, Llm>();
  return (user) => {
    const key = (user.encryptedApiKey ? decryptKey(config.masterKey, user.encryptedApiKey) : null) ?? config.sharedKey;
    if (!key) return null;
    let client = clients.get(key);
    if (!client) {
      client = openRouter(key, { webEnabled: config.webEnabled, providers: config.providers });
      clients.set(key, client);
    }
    return client;
  };
}
