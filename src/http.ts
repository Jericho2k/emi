import { createServer, type Server } from "node:http";
import type { Db } from "./db";
import { completeConnection, PROVIDERS, readState, type IntegrationsConfig, type Provider } from "./core/integrations/connect";

/**
 * The only web pages Emi has: where Google and Spotify send people back after
 * they approve access, and a health check. Everything else is Telegram.
 */

const page = (title: string, line: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 16px;color:#222;background:#fafafa}h1{font-size:1.4rem}@media(prefers-color-scheme:dark){body{color:#eee;background:#161616}}</style>
</head><body><h1>${title}</h1><p>${line}</p></body></html>`;

export interface HttpOptions {
  port: number;
  db: Db;
  integrations?: IntegrationsConfig;
  clock: () => Date;
  /** Tells the person in the chat that it worked. */
  onConnected(userId: string, provider: Provider): Promise<void>;
}

export function startHttp(options: HttpOptions): Server {
  const server = createServer(async (request, response) => {
    const send = (status: number, title: string, line: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      response.end(page(title, line));
    };
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        response.writeHead(200, { "content-type": "text/plain" });
        return response.end("ok");
      }
      const match = /^\/oauth\/([a-z]+)$/.exec(url.pathname);
      const provider = match?.[1] as Provider | undefined;
      if (request.method !== "GET" || !provider || !PROVIDERS.includes(provider) || !options.integrations) return send(404, "Not here", "Nothing to see on this page.");
      const who = readState(options.integrations, url.searchParams.get("state") ?? "", options.clock());
      if (!who || who.provider !== provider) return send(400, "That link has expired", "Go back to Telegram and send /connect again for a fresh one.");
      if (url.searchParams.get("error")) return send(200, "Not connected", "No problem. Nothing was shared. You can close this page.");
      const code = url.searchParams.get("code");
      if (!code) return send(400, "Something went missing", "Go back to Telegram and send /connect again.");
      await completeConnection(options.db, options.integrations, provider, who.userId, code, options.clock());
      send(200, "Connected ✓", "All set. You can close this page and go back to Telegram.");
      await options.onConnected(who.userId, provider).catch((error) => console.warn("[http] connected notice failed", error instanceof Error ? error.message : error));
    } catch (error) {
      console.warn("[http] callback failed", error instanceof Error ? error.message : error);
      if (!response.headersSent) send(502, "That didn't work", "Go back to Telegram and send /connect again in a moment.");
    }
  });
  server.listen(options.port);
  return server;
}
