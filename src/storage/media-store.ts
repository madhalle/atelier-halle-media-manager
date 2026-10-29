// Application-owned photo library: immutable content-addressed originals,
// gallery thumbnails, and cached publishing derivatives.
//
//   media/originals/ab/<sha256>.<ext>   read-only copy of the upload
//   media/thumbs/ab/<sha256>.webp
//   media/derivatives/<assetId>/<key>.jpg
//   media/tmp/                          in-progress uploads
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Platform } from "../domain/accounts.ts";
import { DomainError } from "../domain/errors.ts";
import { computeCrop, type CropAspect, type CropRect } from "../domain/posts.ts";
import { DERIVATIVE_SPECS, makeDerivative, makeThumbnail, probeImage, type DerivativeResult } from "../media/images.ts";
import { containedPath } from "./data-dir.ts";
import type { Db } from "./db.ts";

/** Uploads are refused when less than this much disk space would remain. */
export const MIN_FREE_BYTES = 1024 * 1024 * 1024;

/** Bump when derivative processing changes so cached files are regenerated. */
const PIPELINE_VERSION = 1;

export interface MediaAsset {
  id: string;
  sha256: string;
  format: "jpeg" | "png" | "webp";
  originalPath: string;
  thumbPath: string;
  originalFilename: string | null;
  byteSize: number;
  width: number;
  height: number;
  hasLocation: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  sha256: string;
  format: MediaAsset["format"];
  original_path: string;
  thumb_path: string;
  original_filename: string | null;
  byte_size: number;
  width: number;
  height: number;
  has_location: 0 | 1;
  created_at: string;
}

const toAsset = (r: Row): MediaAsset => ({
  id: r.id,
  sha256: r.sha256,
  format: r.format,
  originalPath: r.original_path,
  thumbPath: r.thumb_path,
  originalFilename: r.original_filename,
  byteSize: r.byte_size,
  width: r.width,
  height: r.height,
  hasLocation: r.has_location === 1,
  createdAt: r.created_at,
});

const EXT = { jpeg: "jpg", png: "png", webp: "webp" } as const;

/** Display-only file name: base name, no control characters, bounded length. */
export function sanitizeFilename(name: string | undefined): string | null {
  if (!name) return null;
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base === "" ? null : [...base].slice(0, 200).join("");
}

function derivativeName(asset: MediaAsset, platform: Platform, crop: CropRect): string {
  const key = createHash("sha256")
    .update(JSON.stringify([PIPELINE_VERSION, asset.sha256, platform, crop.left, crop.top, crop.width, crop.height]))
    .digest("hex")
    .slice(0, 32);
  return `${platform}-${key}.jpg`;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function createMediaStore(db: Db, mediaRoot: string, now: () => Date = () => new Date()) {
  const dirs = {
    originals: join(mediaRoot, "originals"),
    thumbs: join(mediaRoot, "thumbs"),
    derivatives: join(mediaRoot, "derivatives"),
    tmp: join(mediaRoot, "tmp"),
  };

  const bySha = db.prepare<[string], Row>("SELECT * FROM media_assets WHERE sha256 = ?");
  const byId = db.prepare<[string], Row>("SELECT * FROM media_assets WHERE id = ?");
  const usage = db.prepare<[string], { n: number }>("SELECT count(*) AS n FROM post_media WHERE media_asset_id = ?");

  const abs = (relative: string) => containedPath(mediaRoot, relative);

  return {
    dirs,

    /** Prepares directories and removes files a crash may have left unreferenced. Run before serving. */
    async init(): Promise<{ removedFiles: number }> {
      for (const d of Object.values(dirs)) await mkdir(d, { recursive: true, mode: 0o700 });
      await rm(dirs.tmp, { recursive: true, force: true });
      await mkdir(dirs.tmp, { recursive: true, mode: 0o700 });

      const rows = db.prepare<[], Row>("SELECT * FROM media_assets").all();
      const known = new Set(rows.flatMap((r) => [r.original_path, r.thumb_path]));
      const ids = new Set(rows.map((r) => r.id));
      let removedFiles = 0;
      for (const top of ["originals", "thumbs"] as const) {
        for (const entry of await readdir(dirs[top], { recursive: true, withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const rel = join(top, entry.parentPath.slice(dirs[top].length + 1), entry.name);
          if (!known.has(rel)) {
            await rm(abs(rel), { force: true });
            removedFiles++;
          }
        }
      }
      for (const entry of await readdir(dirs.derivatives, { withFileTypes: true })) {
        if (!ids.has(entry.name)) {
          await rm(join(dirs.derivatives, entry.name), { recursive: true, force: true });
          removedFiles++;
        }
      }
      for (const id of ids) removedFiles += await this.pruneDerivatives(id);
      return { removedFiles };
    },

    async hasSpaceFor(bytes: number): Promise<boolean> {
      const s = await statfs(mediaRoot);
      return s.bavail * s.bsize - bytes >= MIN_FREE_BYTES;
    },

    tmpFile(): string {
      return join(dirs.tmp, `${randomUUID()}.upload`);
    },

    /**
     * Validates an uploaded temp file and adds it to the library. The temp file
     * is always consumed. Re-uploading identical bytes returns the existing asset.
     */
    async ingest(tmp: string, filename: string | undefined): Promise<{ asset: MediaAsset; created: boolean }> {
      try {
        const sha = await sha256File(tmp);
        const existing = bySha.get(sha);
        if (existing) return { asset: toAsset(existing), created: false };

        const probe = await probeImage(tmp);
        const shard = sha.slice(0, 2);
        const originalPath = join("originals", shard, `${sha}.${EXT[probe.format]}`);
        const thumbPath = join("thumbs", shard, `${sha}.webp`);
        await mkdir(join(dirs.originals, shard), { recursive: true, mode: 0o700 });
        await mkdir(join(dirs.thumbs, shard), { recursive: true, mode: 0o700 });

        await rename(tmp, abs(originalPath));
        await chmod(abs(originalPath), 0o400);
        const id = randomUUID();
        try {
          await makeThumbnail(abs(originalPath), abs(thumbPath));
          const { size } = await stat(abs(originalPath));
          db.prepare(
            `INSERT INTO media_assets (id, sha256, format, original_path, thumb_path, original_filename, byte_size,
               width, height, has_location, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(id, sha, probe.format, originalPath, thumbPath, sanitizeFilename(filename), size, probe.width, probe.height, probe.hasLocation ? 1 : 0, now().toISOString());
        } catch (err) {
          // A concurrent identical upload won the race; keep its files.
          const raced = bySha.get(sha);
          if (raced) return { asset: toAsset(raced), created: false };
          await rm(abs(originalPath), { force: true });
          await rm(abs(thumbPath), { force: true });
          throw err;
        }
        return { asset: toAsset(byId.get(id)!), created: true };
      } finally {
        await rm(tmp, { force: true });
      }
    },

    list(): MediaAsset[] {
      return db.prepare<[], Row>("SELECT * FROM media_assets ORDER BY created_at DESC, id").all().map(toAsset);
    },

    get(id: string): MediaAsset {
      const row = byId.get(id);
      if (!row) throw new DomainError("not_found", "Photo not found.");
      return toAsset(row);
    },

    usageCount(id: string): number {
      return usage.get(id)!.n;
    },

    thumbFile(asset: MediaAsset): string {
      return abs(asset.thumbPath);
    },

    /** Returns the cached derivative for this exact crop, generating it if needed. */
    async derivative(asset: MediaAsset, platform: Platform, crop: CropRect): Promise<{ file: string } & Partial<DerivativeResult>> {
      const dir = join(dirs.derivatives, asset.id);
      const file = join(dir, derivativeName(asset, platform, crop));
      if (existsSync(file)) return { file };
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        const result = await makeDerivative(abs(asset.originalPath), tmp, { crop, ...DERIVATIVE_SPECS[platform] });
        await rename(tmp, file);
        return { file, ...result };
      } finally {
        await rm(tmp, { force: true });
      }
    },

    /**
     * Deletes cached derivatives that no post's current crop uses. They are
     * deterministic, so anything removed here is regenerated on demand.
     */
    async pruneDerivatives(assetId: string): Promise<number> {
      const row = byId.get(assetId);
      const dir = join(dirs.derivatives, assetId);
      if (!row || !existsSync(dir)) return 0;
      const asset = toAsset(row);
      const keep = new Set(
        db
          .prepare<[string], { platform: Platform; crop_aspect: CropAspect; crop_focus_x: number; crop_focus_y: number }>(
            `SELECT a.platform, pm.crop_aspect, pm.crop_focus_x, pm.crop_focus_y
             FROM post_media pm JOIN posts p ON p.id = pm.post_id JOIN accounts a ON a.id = p.account_id
             WHERE pm.media_asset_id = ?`,
          )
          .all(assetId)
          .map((r) => derivativeName(asset, r.platform, computeCrop(asset.width, asset.height, r.crop_aspect, r.crop_focus_x, r.crop_focus_y))),
      );
      let removed = 0;
      for (const name of await readdir(dir)) {
        if (!keep.has(name)) {
          await rm(join(dir, name), { force: true });
          removed++;
        }
      }
      return removed;
    },

    /** Removes an unreferenced photo and all files derived from it. */
    async remove(id: string): Promise<void> {
      const asset = this.get(id);
      const removed = db.transaction(() => {
        if (usage.get(id)!.n > 0) return false;
        db.prepare("DELETE FROM media_assets WHERE id = ?").run(id);
        return true;
      })();
      if (!removed) {
        throw new DomainError("invalid_state", "This photo is used by a post. Remove it from those posts first.");
      }
      await rm(abs(asset.originalPath), { force: true });
      await rm(abs(asset.thumbPath), { force: true });
      await rm(join(dirs.derivatives, asset.id), { recursive: true, force: true });
    },
  };
}

export type MediaStore = ReturnType<typeof createMediaStore>;
