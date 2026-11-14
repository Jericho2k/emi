import sharp from "sharp";
import { MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, imageMime, type ImageInput } from "./images";

/**
 * Shrink a picture to what vision models actually look at, once, before it is
 * stored or sent.
 *
 * Image tokens grow with pixel count, and providers downscale large inputs
 * themselves (typically to about 0.8–1.2 megapixels), so pixels above the cap
 * cost money without adding detail the model can see. The cap sits above those
 * sizes so screenshots keep legible text.
 *
 * Screenshots and diagrams stay lossless PNG unless a high-quality JPEG is far
 * smaller. Photos become high-quality JPEG. EXIF orientation is applied and
 * metadata (including GPS) is dropped.
 */
export async function prepareImage(image: ImageInput): Promise<ImageInput> {
  if (image.storedId) return image; // Already prepared when it was first stored.
  try {
    const source = sharp(image.data, { limitInputPixels: 60_000_000, failOn: "none" });
    const meta = await source.metadata();
    if (!meta.width || !meta.height) return image;
    // EXIF orientations 5–8 swap width and height.
    const [width, height] = (meta.orientation ?? 1) >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height), Math.sqrt(MAX_IMAGE_PIXELS / (width * height)));
    const resize = scale < 1;
    const rotate = (meta.orientation ?? 1) !== 1;

    // Already small, upright and without metadata to strip: re-encoding could only lose quality.
    if (!resize && !rotate && !meta.exif) return image;

    let pipeline = sharp(image.data, { limitInputPixels: 60_000_000, failOn: "none" }).rotate();
    if (resize) pipeline = pipeline.resize(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)), { fit: "fill", kernel: "lanczos3" });

    let out: { data: Buffer; mimeType: ImageInput["mimeType"] };
    if (image.mimeType === "image/jpeg") {
      out = { data: await pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer(), mimeType: "image/jpeg" };
    } else {
      // PNG, WebP and GIF (first frame) are usually screenshots, diagrams or
      // graphics where lossless text matters.
      const png = await pipeline.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
      out = { data: png, mimeType: "image/png" };
      if (!meta.hasAlpha && png.byteLength > 1_000_000) {
        // A photo saved as PNG. 4:4:4 keeps coloured text edges sharp.
        const jpeg = await pipeline.clone().jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();
        if (jpeg.byteLength < png.byteLength / 2) out = { data: jpeg, mimeType: "image/jpeg" };
      }
    }
    if (!resize && !rotate && !meta.exif && out.data.byteLength >= image.data.byteLength) return image;
    if (imageMime(out.data) !== out.mimeType) return image;
    return { ...image, data: out.data, mimeType: out.mimeType };
  } catch (error) {
    // An image the library cannot decode may still be readable by the model;
    // the original bytes already passed format and size checks.
    console.warn("[image:prepare]", { reason: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    return image;
  }
}

export async function prepareImages(images: ImageInput[]): Promise<ImageInput[]> {
  const out: ImageInput[] = [];
  for (const image of images) out.push(await prepareImage(image));
  return out;
}
