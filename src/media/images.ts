// Image inspection and processing (sharp/libvips). Kept separate from storage
// and HTTP so it can be replaced where native modules are unavailable.
import { open, writeFile } from "node:fs/promises";
import sharp, { type Metadata } from "sharp";
import type { CropRect } from "../domain/posts.ts";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 100_000_000;
export const MAX_DIMENSION = 20_000;
export const SUPPORTED_FORMATS = ["jpeg", "png", "webp"] as const;
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

// libvips can parse dozens of formats (SVG, TIFF, PDF, …), each a native-code
// attack surface. Only the decoders this app needs may run in this process.
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({
  operation: [
    "VipsForeignLoadJpegFile",
    "VipsForeignLoadJpegBuffer",
    "VipsForeignLoadPngFile",
    "VipsForeignLoadPngBuffer",
    "VipsForeignLoadWebpFile",
    "VipsForeignLoadWebpBuffer",
  ],
});

// Bound memory and CPU: libvips threads per image, and how many images at once.
sharp.concurrency(2);
sharp.cache({ memory: 64, files: 0, items: 50 });
const MAX_PARALLEL = 2;
let active = 0;
const waiting: (() => void)[] = [];

/** Runs `fn` with at most MAX_PARALLEL image jobs in flight. */
export async function withImageSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export class ImageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejected";
  }
}

export interface ImageProbe {
  format: SupportedFormat;
  /** Display dimensions, after EXIF orientation. */
  width: number;
  height: number;
  hasLocation: boolean;
}

const input = (file: string) => sharp(file, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", sequentialRead: true });

/** Identifies the real format from the bytes and enforces limits. Never trusts the file name. */
export async function probeImage(file: string): Promise<ImageProbe> {
  return withImageSlot(() => probe(file));
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis"]);

/** Identifies the container from its leading bytes, before any decoder sees the file. */
export function sniffFormat(head: Buffer): SupportedFormat | "heif" | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (head.toString("latin1", 4, 8) === "ftyp" && HEIF_BRANDS.has(head.toString("latin1", 8, 12))) return "heif";
  return null;
}

async function readHead(file: string): Promise<Buffer> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buf, 0, 32, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function probe(file: string): Promise<ImageProbe> {
  const sniffed = sniffFormat(await readHead(file));
  if (sniffed === "heif") {
    throw new ImageRejected(
      "HEIC/HEIF photos aren't supported yet. In Photos, choose File › Export › Export 1 Photo with Kind set to JPEG, then upload that file.",
    );
  }
  if (sniffed === null) throw new ImageRejected("This file isn't a JPEG, PNG or WebP image.");
  let meta: Metadata;
  try {
    // Header only; pixel limits are enforced below with a clear message.
    meta = await sharp(file, { limitInputPixels: false }).metadata();
  } catch {
    throw new ImageRejected("This file isn't an image the app can read.");
  }
  if (meta.format !== sniffed) throw new ImageRejected("The file's contents don't match a supported image format.");
  if (!meta.width || !meta.height) throw new ImageRejected("The image has no dimensions.");
  if ((meta.pages ?? 1) > 1) throw new ImageRejected("Animated or multi-page images aren't supported.");
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION || meta.width * meta.height > MAX_INPUT_PIXELS) {
    throw new ImageRejected("The image is too large. The limit is 100 megapixels and 20,000 pixels on a side.");
  }
  // Decode once fully so truncated or corrupt files are rejected at upload, not at publish time.
  try {
    await input(file).resize(64, 64, { fit: "inside" }).raw().toBuffer();
  } catch {
    throw new ImageRejected("The image file is damaged or incomplete.");
  }
  const rotated = (meta.orientation ?? 1) >= 5;
  return {
    format: meta.format as SupportedFormat,
    width: rotated ? meta.height : meta.width,
    height: rotated ? meta.width : meta.height,
    hasLocation: meta.exif !== undefined && exifHasGps(meta.exif),
  };
}

// The GPS IFD pointer tag (0x8825) appears in EXIF when location data is present.
// A byte-pattern check can over-report but never under-reports a tagged GPS IFD;
// it is only used to tell the user that the original contains location data.
function exifHasGps(exif: Buffer): boolean {
  return exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88]));
}

/** Small WebP preview for the gallery. Oriented, sRGB, no metadata. */
export async function makeThumbnail(file: string, out: string): Promise<void> {
  await withImageSlot(() =>
    input(file).rotate().resize(480, 480, { fit: "inside", withoutEnlargement: true }).toColorspace("srgb").webp({ quality: 78 }).toFile(out),
  );
}

export interface DerivativeSpec {
  crop: CropRect;
  maxWidth: number;
  maxBytes: number;
}

export const DERIVATIVE_SPECS = {
  // Instagram: JPEG only, ≤ 8 MB, width scaled to ≤ 1440.
  instagram: { maxWidth: 1440, maxBytes: 8 * 1024 * 1024 },
  // Pinterest: JPEG; exact limits unverified, so stay conservative.
  pinterest: { maxWidth: 2000, maxBytes: 10 * 1024 * 1024 },
} as const;

export interface DerivativeResult {
  width: number;
  height: number;
  bytes: number;
}

/**
 * Publishing derivative: oriented, cropped exactly as previewed, sRGB JPEG with
 * all metadata (including location) removed. Lowers quality until it fits.
 */
export async function makeDerivative(file: string, out: string, spec: DerivativeSpec): Promise<DerivativeResult> {
  return withImageSlot(async () => {
    for (const quality of [90, 84, 78, 70, 60]) {
      const { data, info } = await input(file)
        .rotate()
        .extract(spec.crop)
        .resize({ width: Math.min(spec.maxWidth, spec.crop.width), withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .toColorspace("srgb")
        .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
        .toBuffer({ resolveWithObject: true });
      if (data.length <= spec.maxBytes) {
        await writeFile(out, data, { mode: 0o600 });
        return { width: info.width, height: info.height, bytes: data.length };
      }
    }
    throw new ImageRejected("The photo can't be compressed under the platform's file size limit.");
  });
}
