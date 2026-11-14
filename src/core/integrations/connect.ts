import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../../db";
import { decryptKey, encryptKey } from "../keys";

/**
 * CONNECTING SOMEONE'S ACCOUNTS.
 *
 * Each person signs in to their own Google or Spotify through a link from the
 * bot. The link carries a signed, expiring `state` naming who asked, so a
 * callback can never attach an account to someone else. Tokens are stored
 * encrypted like API keys, refreshed when they expire, and dropped if the
 * provider revokes them.
 */

export type Provider = "google" | "spotify";
export const PROVIDERS: Provider[] = ["google", "spotify"];

export interface OAuthApp { clientId: string; clientSecret: string }

export interface IntegrationsConfig {
  masterKey: Buffer;
  /** Where this server is reachable from a browser, e.g. https://emi.up.railway.app */
  publicUrl: string;
  google?: OAuthApp;
  spotify?: OAuthApp;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

const ENDPOINTS: Record<Provider, { authorize: string; token: string; scopes: string[]; extra: Record<string, string> }> = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/tasks"],
    // offline + consent: Google returns a refresh token only this way.
    extra: { access_type: "offline", prompt: "consent" },
  },
  spotify: {
    authorize: "https://accounts.spotify.com/authorize",
    token: "https://accounts.spotify.com/api/token",
    scopes: ["playlist-modify-private", "playlist-modify-public"],
    extra: {},
  },
};

const STATE_TTL_MS = 15 * 60_000;

/** A failure the person can be told about in plain words. */
export class IntegrationError extends Error {
  constructor(message: string, readonly status = 0, readonly lost = false) {
    super(message);
    this.name = "IntegrationError";
  }
}

export function configured(config: IntegrationsConfig | undefined, provider: Provider): boolean {
  return !!config?.[provider];
}

export function redirectUri(config: IntegrationsConfig, provider: Provider): string {
  return `${config.publicUrl.replace(/\/+$/, "")}/oauth/${provider}`;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const sign = (config: IntegrationsConfig, payload: string) => createHmac("sha256", config.masterKey).update(`oauth-state:${payload}`).digest("base64url");

export function makeState(config: IntegrationsConfig, userId: string, provider: Provider, now: Date): string {
  const payload = b64url(JSON.stringify({ u: userId, p: provider, e: now.getTime() + STATE_TTL_MS, n: randomBytes(8).toString("hex") }));
  return `${payload}.${sign(config, payload)}`;
}

/** Who started this sign-in, or null if the state was forged, altered or is stale. */
export function readState(config: IntegrationsConfig, state: string, now: Date): { userId: string; provider: Provider } | null {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(config, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: unknown; p?: unknown; e?: unknown };
    if (typeof data.u !== "string" || !PROVIDERS.includes(data.p as Provider) || typeof data.e !== "number" || data.e < now.getTime()) return null;
    return { userId: data.u, provider: data.p as Provider };
  } catch {
    return null;
  }
}

export function connectUrl(config: IntegrationsConfig, provider: Provider, userId: string, now: Date): string {
  const app = config[provider];
  if (!app) throw new IntegrationError(`${provider} is not set up on this server`);
  const endpoint = ENDPOINTS[provider];
  const params = new URLSearchParams({
    client_id: app.clientId, redirect_uri: redirectUri(config, provider), response_type: "code",
    scope: endpoint.scopes.join(" "), state: makeState(config, userId, provider, now), ...endpoint.extra,
  });
  return `${endpoint.authorize}?${params}`;
}

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string }

async function tokenRequest(config: IntegrationsConfig, provider: Provider, form: Record<string, string>): Promise<TokenResponse> {
  const app = config[provider];
  if (!app) throw new IntegrationError(`${provider} is not set up on this server`);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const body = new URLSearchParams(form);
  if (provider === "spotify") headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
  else { body.set("client_id", app.clientId); body.set("client_secret", app.clientSecret); }
  const response = await (config.fetch ?? fetch)(ENDPOINTS[provider].token, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
  const data = (await response.json().catch(() => ({}))) as TokenResponse;
  // Status and error code only: token responses must never reach a log.
  if (!response.ok || !data.access_token) {
    throw new IntegrationError(`${provider} token request failed (${response.status}${data.error ? ` ${data.error}` : ""})`, response.status, data.error === "invalid_grant");
  }
  return data;
}

/** Finishes a sign-in: trades the one-time code for tokens and stores them. */
export async function completeConnection(db: Db, config: IntegrationsConfig, provider: Provider, userId: string, code: string, now: Date): Promise<void> {
  const tokens = await tokenRequest(config, provider, { grant_type: "authorization_code", code, redirect_uri: redirectUri(config, provider) });
  if (!tokens.refresh_token) throw new IntegrationError(`${provider} did not return a refresh token; try connecting again`);
  await db.query(
    `insert into connections (user_id, provider, encrypted_refresh_token, encrypted_access_token, access_expires_at, scopes, connected_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (user_id, provider) do update set encrypted_refresh_token = excluded.encrypted_refresh_token,
       encrypted_access_token = excluded.encrypted_access_token, access_expires_at = excluded.access_expires_at,
       scopes = excluded.scopes, connected_at = excluded.connected_at`,
    [userId, provider, encryptKey(config.masterKey, tokens.refresh_token), encryptKey(config.masterKey, tokens.access_token!),
      new Date(now.getTime() + (tokens.expires_in ?? 3600) * 1000), tokens.scope ?? "", now],
  );
}

export async function connectedProviders(db: Db, userId: string): Promise<Provider[]> {
  const { rows } = await db.query<{ provider: Provider }>("select provider from connections where user_id = $1 order by provider", [userId]);
  return rows.map((row) => row.provider);
}

export async function disconnect(db: Db, userId: string, provider: Provider): Promise<boolean> {
  const { rows } = await db.query("delete from connections where user_id = $1 and provider = $2 returning provider", [userId, provider]);
  return rows.length > 0;
}

/** A working access token, refreshed when needed. A revoked connection is removed. */
export async function accessToken(db: Db, config: IntegrationsConfig, userId: string, provider: Provider, now: Date): Promise<string> {
  const { rows: [row] } = await db.query<{ encrypted_refresh_token: string; encrypted_access_token: string | null; access_expires_at: Date | string | null }>(
    "select encrypted_refresh_token, encrypted_access_token, access_expires_at from connections where user_id = $1 and provider = $2", [userId, provider],
  );
  if (!row) throw new IntegrationError(`${provider} is not connected`, 0, true);
  const expires = row.access_expires_at ? new Date(row.access_expires_at).getTime() : 0;
  const cached = row.encrypted_access_token ? decryptKey(config.masterKey, row.encrypted_access_token) : null;
  if (cached && expires > now.getTime() + 60_000) return cached;
  const refresh = decryptKey(config.masterKey, row.encrypted_refresh_token);
  if (!refresh) throw new IntegrationError(`${provider} connection could not be read; connect it again`, 0, true);
  try {
    const tokens = await tokenRequest(config, provider, { grant_type: "refresh_token", refresh_token: refresh });
    await db.query(
      `update connections set encrypted_access_token = $3, access_expires_at = $4,
         encrypted_refresh_token = coalesce($5, encrypted_refresh_token) where user_id = $1 and provider = $2`,
      [userId, provider, encryptKey(config.masterKey, tokens.access_token!), new Date(now.getTime() + (tokens.expires_in ?? 3600) * 1000),
        tokens.refresh_token ? encryptKey(config.masterKey, tokens.refresh_token) : null],
    );
    return tokens.access_token!;
  } catch (error) {
    // Revoked or expired for good: forget it, so she stops trying and can say so.
    if (error instanceof IntegrationError && error.lost) await disconnect(db, userId, provider);
    throw error;
  }
}

/** JSON over HTTPS with a bearer token. Status only in errors, never bodies. */
export async function api<T>(config: IntegrationsConfig, token: string, method: string, url: string, body?: unknown): Promise<T> {
  const response = await (config.fetch ?? fetch)(url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new IntegrationError(`${method} ${new URL(url).pathname} failed (${response.status})`, response.status);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
