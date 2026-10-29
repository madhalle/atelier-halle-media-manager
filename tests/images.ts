// Deterministic test images generated in memory (no binary fixtures in the repo).
import sharp from "sharp";

export async function jpeg(width = 1200, height = 900, opts: { gps?: boolean; orientation?: number; color?: string } = {}) {
  let img = sharp({ create: { width, height, channels: 3, background: opts.color ?? "#7a5c3e" } });
  if (opts.gps) img = img.withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 44/1 0/1" } });
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return img.jpeg({ quality: 85 }).toBuffer();
}

export const png = (width = 800, height = 1200) =>
  sharp({ create: { width, height, channels: 4, background: { r: 20, g: 120, b: 200, alpha: 0.5 } } }).png().toBuffer();

export const webp = (width = 640, height = 640) =>
  sharp({ create: { width, height, channels: 3, background: "#335533" } }).webp().toBuffer();

export const avif = () => sharp({ create: { width: 64, height: 64, channels: 3, background: "#000" } }).avif().toBuffer();

/** Serializes files into a multipart body using the platform FormData encoder. */
export async function multipart(files: { name: string; data: Buffer; type?: string }[]) {
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([new Uint8Array(f.data)], { type: f.type ?? "application/octet-stream" }), f.name);
  const res = new Response(form);
  return { payload: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type")! };
}
