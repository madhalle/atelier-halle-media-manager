// Photo library API: multi-file upload, listing, thumbnails, deletion.
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PLATFORMS } from "../../domain/accounts.ts";
import { DomainError } from "../../domain/errors.ts";
import { computeCrop, CROP_ASPECTS, PLATFORM_ASPECTS } from "../../domain/posts.ts";
import { ImageRejected, MAX_UPLOAD_BYTES } from "../../media/images.ts";
import type { MediaAsset, MediaStore } from "../../storage/media-store.ts";

export const MAX_FILES_PER_UPLOAD = 20;

export interface MediaView {
  id: string;
  width: number;
  height: number;
  format: MediaAsset["format"];
  byteSize: number;
  originalFilename: string | null;
  hasLocation: boolean;
  usedByPosts: number;
  thumbUrl: string;
  createdAt: string;
}

export function toMediaView(a: MediaAsset, usedByPosts: number): MediaView {
  return {
    id: a.id,
    width: a.width,
    height: a.height,
    format: a.format,
    byteSize: a.byteSize,
    originalFilename: a.originalFilename,
    hasLocation: a.hasLocation,
    usedByPosts,
    thumbUrl: `/api/media/${a.id}/thumb`,
    createdAt: a.createdAt,
  };
}

const IdParams = z.object({ id: z.uuid() });
// Focus is rounded to whole percent so previews map onto a bounded set of cached files.
const focus = z.coerce.number().min(0).max(1).transform((v) => Math.round(v * 100) / 100);
const PreviewQuery = z.object({ platform: z.enum(PLATFORMS), aspect: z.enum(CROP_ASPECTS), fx: focus, fy: focus });

type UploadResult =
  | { filename: string | null; ok: true; created: boolean; media: MediaView }
  | { filename: string | null; ok: false; error: string };

export async function registerMediaRoutes(api: FastifyInstance, media: MediaStore): Promise<void> {
  await api.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_UPLOAD, fields: 0, parts: MAX_FILES_PER_UPLOAD, headerPairs: 50 },
  });

  api.post("/media", async (req, reply) => {
    if (!req.isMultipart()) return reply.code(415).send({ error: "validation", message: "Upload photos as multipart form data." });
    const declared = Number(req.headers["content-length"] ?? 0);
    if (!(await media.hasSpaceFor(declared))) {
      return reply.code(507).send({ error: "insufficient_storage", message: "Not enough free disk space for this upload. Free up space and try again." });
    }
    const results: UploadResult[] = [];
    for await (const part of req.files()) {
      const filename = part.filename || null;
      const tmp = media.tmpFile();
      await pipeline(part.file, createWriteStream(tmp, { mode: 0o600 }));
      if (part.file.truncated) {
        await rm(tmp, { force: true });
        results.push({ filename, ok: false, error: `This file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
        continue;
      }
      try {
        const { asset, created } = await media.ingest(tmp, part.filename);
        results.push({ filename, ok: true, created, media: toMediaView(asset, media.usageCount(asset.id)) });
      } catch (err) {
        if (!(err instanceof ImageRejected)) throw err;
        results.push({ filename, ok: false, error: err.message });
      }
    }
    if (results.length === 0) return reply.code(400).send({ error: "validation", message: "No files were uploaded." });
    return { results };
  });

  api.get("/media", async () => ({
    media: media.list().map((a) => toMediaView(a, media.usageCount(a.id))),
  }));

  api.get("/media/:id/thumb", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const asset = media.get(id);
    // Originals are immutable, so a photo's thumbnail never changes.
    return reply
      .type("image/webp")
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(createReadStream(media.thumbFile(asset)));
  });

  // Exact publishing derivative for a crop that may not be saved yet.
  api.get("/media/:id/derivative", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const q = PreviewQuery.parse(req.query);
    if (!PLATFORM_ASPECTS[q.platform].allowed.includes(q.aspect)) {
      throw new DomainError("validation", `The ${q.aspect} crop isn't available for this platform.`);
    }
    const asset = media.get(id);
    const { file } = await media.derivative(asset, q.platform, computeCrop(asset.width, asset.height, q.aspect, q.fx, q.fy));
    return reply.type("image/jpeg").header("cache-control", "private, max-age=3600").send(createReadStream(file));
  });

  api.delete("/media/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    await media.remove(id);
    return { ok: true };
  });
}
