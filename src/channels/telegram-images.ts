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

async function download(api: Pick<Api, "getFile">, token: string, input: TelegramImageFile): Promise<ImageInput> {
  if (input.byteSize && input.byteSize > MAX_IMAGE_BYTES) throw new ImageInputError("that image is too large. send it under 8 MB, or crop the part you want me to read.");
  try {
    const file = await api.getFile(input.fileId);
    if (!file.file_path || !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) || file.file_path.split("/").includes("..")) throw new Error("file unavailable");
    if (file.file_size && file.file_size > MAX_IMAGE_BYTES) throw new ImageInputError("that image is too large. send it under 8 MB.");
    // This token-bearing URL stays inside the Telegram adapter. The model gets
    // private image bytes, never a Telegram file URL or bot credentials.
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!response.ok || !response.body) throw new Error("download failed");
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
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const data = Buffer.concat(chunks, size);
    const mimeType = imageMime(data);
    if (!mimeType) throw new ImageInputError("I couldn't read that file as an image. send a PNG, JPEG, WebP or GIF.");
    return { data, mimeType };
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    // Fetch exceptions may contain the credential-bearing URL: do not propagate
    // them to the logger, the database, or the person.
    throw new ImageInputError("I couldn't download that image from Telegram. please send it again.");
  }
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
