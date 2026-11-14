import { Agent, type Dispatcher } from "undici";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { ImageInputError, MAX_IMAGE_BYTES, imageMime, type ImageInput } from "../core/images";
import type { IncomingMessage } from "../core/types";

export interface TelegramImageFile { fileId: string; byteSize?: number }

export function telegramImageFile(message?: Message): TelegramImageFile | null {
  const photo = message?.photo?.toSorted((a, b) => a.width * a.height - b.width * b.height).at(-1);
  if (photo) return { fileId: photo.file_id, byteSize: photo.file_size };
  const document = message?.document;
  if (document && (/^image\/(?:png|jpeg|webp|gif)$/.test(document.mime_type ?? "") || /\.(?:png|jpe?g|webp|gif)$/i.test(document.file_name ?? ""))) {
    return { fileId: document.file_id, byteSize: document.file_size };
  }
  return null;
}

// Railway's outbound IPv6 is opt-in. Keep this scoped to Telegram files;
// never replace the process-wide dispatcher used by models or other services.
const fileDispatcher = new Agent({ connect: { family: 4, timeout: 10_000 }, connections: 2 });
const ATTEMPTS = 2;
const RETRY_MS = 500;

type Stage = "get_file" | "file_path" | "download" | "redirect" | "body";
class RetrievalFailure extends Error {
  constructor(readonly stage: Stage, readonly code: string, readonly retryable: boolean, readonly status?: number) { super(code); }
}
const networkCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "ABORT_ERR",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

/** Extract known codes only. Error messages/causes can contain the bot URL. */
function safeNetworkCode(error: unknown, depth = 0): string {
  if (!error || typeof error !== "object" || depth > 3) return "NETWORK_ERROR";
  const e = error as { code?: unknown; name?: unknown; cause?: unknown; error?: unknown; errors?: unknown[] };
  if (typeof e.code === "string" && networkCodes.has(e.code)) return e.code;
  if (e.name === "TimeoutError" || e.name === "AbortError") return "TIMEOUT";
  for (const nested of [e.cause, e.error, ...(Array.isArray(e.errors) ? e.errors.slice(0, 4) : [])]) {
    const code = safeNetworkCode(nested, depth + 1);
    if (code !== "NETWORK_ERROR") return code;
  }
  return "NETWORK_ERROR";
}

function fileUrl(token: string, path: string | undefined): URL {
  if (!path || path.startsWith("/") || /^[a-z]+:/i.test(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new RetrievalFailure("file_path", "INVALID_FILE_PATH", false);
  }
  // Encode path segments, rather than rejecting legitimate spaces/Unicode or
  // letting query/fragment characters change the credential-bearing request.
  return new URL(`https://api.telegram.org/file/bot${token}/${path.split("/").map(encodeURIComponent).join("/")}`);
}

async function fileResponse(initial: URL, signal: AbortSignal): Promise<Response> {
  let url = initial;
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    const options: RequestInit & { dispatcher: Dispatcher } = { signal, redirect: "manual", dispatcher: fileDispatcher };
    const response = await fetch(url.href, options);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === 2) throw new RetrievalFailure("redirect", "REDIRECT_LIMIT", false);
    let next: URL;
    try { next = new URL(location, url); } catch { throw new RetrievalFailure("redirect", "INVALID_REDIRECT", false); }
    const prefix = initial.pathname.slice(0, initial.pathname.indexOf("/", "/file/bot".length));
    if (next.origin !== initial.origin || next.username || next.password || !next.pathname.startsWith(`${prefix}/`)) {
      throw new RetrievalFailure("redirect", "UNSAFE_REDIRECT", false);
    }
    url = next;
  }
  throw new RetrievalFailure("redirect", "REDIRECT_LIMIT", false);
}

async function download(api: Pick<Api, "getFile">, token: string, input: TelegramImageFile): Promise<ImageInput> {
  if (input.byteSize && input.byteSize > MAX_IMAGE_BYTES) throw new ImageInputError("that image is too large. send it under 8 MB, or crop the part you want me to read.");
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let stage: Stage = "get_file";
    try {
      // Refresh getFile on retry instead of repeating an expired file path.
      const signal = AbortSignal.timeout(30_000);
      // grammY 1.x declares a polyfill AbortSignal; its node-fetch transport
      // accepts Node's native signal, which we also use for the file body.
      const file = await api.getFile(input.fileId, signal as unknown as Parameters<Api["getFile"]>[1]);
      stage = "file_path";
      const url = fileUrl(token, file.file_path);
      if (file.file_size && file.file_size > MAX_IMAGE_BYTES) throw new ImageInputError("that image is too large. send it under 8 MB.");
      stage = "download";
      const response = await fileResponse(url, signal);
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel().catch(() => undefined);
        // Long server-requested backoffs are left to a later user retry.
        const retryAfter = Number(response.headers.get("retry-after") ?? 0);
        throw new RetrievalFailure("download", "HTTP_ERROR", status === 404 || status >= 500 || (status === 429 && retryAfter <= RETRY_MS / 1000), status);
      }
      if (!response.body) throw new RetrievalFailure("body", "EMPTY_BODY", true);
      stage = "body";
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES) throw new ImageInputError("that image is too large. send it under 8 MB.");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const data = Buffer.concat(chunks, size);
      const mimeType = imageMime(data);
      if (!mimeType) throw new ImageInputError("I couldn't read that file as an image. send a PNG, JPEG, WebP or GIF.");
      return { data, mimeType };
    } catch (error) {
      if (error instanceof ImageInputError) throw error;
      const apiCode = error && typeof error === "object" && "error_code" in error ? Number(error.error_code) : undefined;
      const code = safeNetworkCode(error);
      const status = apiCode && Number.isInteger(apiCode) && apiCode >= 400 && apiCode <= 599 ? apiCode : undefined;
      const failure = error instanceof RetrievalFailure ? error : new RetrievalFailure(stage, status ? "TELEGRAM_API_ERROR" : code,
        status ? status >= 500 : !["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(code), status);
      const retry = failure.retryable && attempt < ATTEMPTS;
      // Intentionally omit raw errors, URLs, paths, file IDs, captions and keys.
      console.warn("[telegram:image]", { stage: failure.stage, code: failure.code, status: failure.status, attempt, retry });
      if (retry) { await new Promise((resolve) => setTimeout(resolve, RETRY_MS)); continue; }
      throw new ImageInputError("I couldn't retrieve that image from Telegram. it's a download problem on my side; the bot logs have the reason.");
    }
  }
  throw new ImageInputError("I couldn't retrieve that image. please send it again.");
}

export async function telegramImages(api: Pick<Api, "getFile">, token: string, message: Message, input: IncomingMessage): Promise<IncomingMessage> {
  const files = [
    { file: telegramImageFile(message), origin: undefined },
    { file: telegramImageFile(message.reply_to_message), origin: "reply" as const },
  ];
  const images: ImageInput[] = [];
  for (const { file, origin } of files) {
    if (file) images.push({ ...await download(api, token, file), ...(origin ? { origin } : {}) });
  }
  return images.length ? { ...input, images } : input;
}
