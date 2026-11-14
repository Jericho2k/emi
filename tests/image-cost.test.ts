import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { describeImages } from "../src/core/image-descriptions";
import { prepareImage } from "../src/core/image-prep";
import { MAX_IMAGE_PIXELS, loadImages, type ImageInput } from "../src/core/images";
import { handleTurn } from "../src/core/pipeline";
import { addMessage, recentMessages } from "../src/core/users";
import { world } from "./helpers";

const noise = (width: number, height: number) => {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 251;
  return sharp(data, { raw: { width, height, channels: 3 } });
};
const size = async (image: ImageInput) => {
  const meta = await sharp(image.data).metadata();
  return { width: meta.width!, height: meta.height!, exif: !!meta.exif };
};

describe("image preparation", () => {
  it("shrinks a large photo to the pixel budget as JPEG, keeping its aspect ratio", async () => {
    const data = await noise(4000, 3000).jpeg({ quality: 95 }).toBuffer();
    const out = await prepareImage({ mimeType: "image/jpeg", data });
    const { width, height } = await size(out);
    expect(out.mimeType).toBe("image/jpeg");
    expect(width * height).toBeLessThanOrEqual(MAX_IMAGE_PIXELS);
    expect(width * height).toBeGreaterThan(MAX_IMAGE_PIXELS * 0.95);
    expect(width / height).toBeCloseTo(4 / 3, 2);
    expect(out.data.byteLength).toBeLessThan(data.byteLength);
  });

  it("keeps a tall screenshot lossless and legible-sized", async () => {
    const data = await sharp({ create: { width: 1179, height: 2556, channels: 3, background: "#ffffff" } })
      .composite([{ input: Buffer.from('<svg width="1179" height="200"><text x="20" y="100" font-size="40">Order total 12.40</text></svg>'), top: 400, left: 0 }])
      .png().toBuffer();
    const out = await prepareImage({ mimeType: "image/png", data });
    const { width, height } = await size(out);
    expect(out.mimeType).toBe("image/png");
    expect(height).toBeLessThanOrEqual(2048);
    expect(width).toBeGreaterThan(800);
  });

  it("leaves small, upright images untouched and applies EXIF rotation while dropping metadata", async () => {
    const small = await noise(800, 600).png().toBuffer();
    expect((await prepareImage({ mimeType: "image/png", data: small })).data).toBe(small);
    const rotated = await noise(600, 400).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await prepareImage({ mimeType: "image/jpeg", data: rotated });
    expect(await size(out)).toEqual({ width: 400, height: 600, exif: false });
  });

  it("never re-encodes an image that came from storage, and falls back to the original on decode failure", async () => {
    const stored: ImageInput = { mimeType: "image/png", data: Buffer.from("not decoded at all"), storedId: "x" };
    expect(await prepareImage(stored)).toBe(stored);
    const broken: ImageInput = { mimeType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 1, 2]) };
    expect(await prepareImage(broken)).toBe(broken);
  });

  it("stores the shrunk copy, not the upload", async () => {
    const w = await world();
    const user = await w.newUser();
    const data = await noise(2000, 2000).png().toBuffer();
    await handleTurn(w.deps, user.id, [{ text: "big", images: [{ mimeType: "image/png", data }] }]);
    const [message] = await recentMessages(w.db, user.id, 2);
    const [stored] = await loadImages(w.db, user.id, message!.images!);
    const { width, height } = await size(stored!);
    expect(width * height).toBeLessThanOrEqual(MAX_IMAGE_PIXELS);
    expect(Buffer.from(stored!.data)).toEqual(Buffer.from(w.calls[0]!.messages.at(-1)!.images![0]!.data));
  }, 30_000);
});

describe("image descriptions", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4mQAAAAASUVORK5CYII=", "base64");
  const image: ImageInput = { mimeType: "image/png", data: png };

  it("describes each stored picture once, with the caption as context, and records the cost", async () => {
    const w = await world();
    w.deps.models.vision = "vision-model";
    const user = await w.newUser();
    const first = await addMessage(w.db, { userId: user.id, role: "user", content: "my fridge, what can I cook?", images: [image], at: w.now });
    await addMessage(w.db, { userId: user.id, role: "user", content: "again", images: [{ ...image, storedId: first.images![0]!.id }], at: w.now });
    w.script = () => "Photo of an open fridge: eggs, milk, two tomatoes.";
    expect(await describeImages(w.deps, user.id)).toBe(1);
    expect(await describeImages(w.deps, user.id)).toBe(0);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.options).toMatchObject({ model: "vision-model", temperature: 0.2 });
    expect(w.calls[0]!.messages[1]!.content).toContain("what can I cook?");
    expect(w.calls[0]!.messages[1]!.images).toHaveLength(1);
    // The re-sent copy shares the original's description.
    const history = await recentMessages(w.db, user.id, 10);
    expect(history.map((m) => m.images![0]!.description)).toEqual(Array(2).fill("Photo of an open fridge: eggs, milk, two tomatoes."));
    const usage = (await w.db.query<{ purpose: string }>("select purpose from usage_events")).rows;
    expect(usage).toEqual([{ purpose: "describe_image" }]);
  });

  it("gives up after two failures so the picture falls back to pixel replay", async () => {
    const w = await world();
    const user = await w.newUser();
    await addMessage(w.db, { userId: user.id, role: "user", content: "", images: [image], at: w.now });
    w.script = () => { throw new Error("provider down"); };
    expect(await describeImages(w.deps, user.id)).toBe(0);
    expect(await describeImages(w.deps, user.id)).toBe(0);
    expect(await describeImages(w.deps, user.id)).toBe(0);
    expect(w.calls).toHaveLength(2);
  });

  it("does not spend on pictures that have already left the conversation", async () => {
    const w = await world();
    const user = await w.newUser();
    await addMessage(w.db, { userId: user.id, role: "user", content: "", images: [image], at: w.now });
    w.advance(25 * 3_600_000);
    expect(await describeImages(w.deps, user.id)).toBe(0);
    expect(w.calls).toHaveLength(0);
  });

  it("does nothing without a key", async () => {
    const w = await world();
    const user = await w.newUser();
    await addMessage(w.db, { userId: user.id, role: "user", content: "", images: [image], at: w.now });
    w.hasKey = false;
    expect(await describeImages(w.deps, user.id)).toBe(0);
  });
});
