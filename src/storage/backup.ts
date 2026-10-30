// Local backups of the database and photo library, and restore.
//
//   backups/<id>/media-manager.db    consistent snapshot (SQLite online backup)
//   backups/<id>/media/originals/…   hard links to the immutable originals
//   backups/<id>/media/thumbs/…      hard links to the thumbnails
//   backups/<id>/manifest.json       written last; a backup without it is incomplete
//
// Originals and thumbnails are written once and never modified, so hard links
// cost no extra space and keep a photo even after it's deleted from the
// library. Derivatives are caches and are rebuilt on demand. Secrets live in
// the Keychain and are never part of a backup.
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, copyFile, cp, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { containedPath, type DataPaths } from "./data-dir.ts";
import type { Db } from "./db.ts";
import { loadMigrations } from "./migrate.ts";

export const BACKUP_FORMAT = 1;
export type BackupReason = "daily" | "manual" | "pre-migration" | "pre-restore";

/** How many of each kind are kept; older ones are pruned after each backup. */
export const RETENTION: Record<BackupReason, number> = { daily: 7, manual: 10, "pre-migration": 3, "pre-restore": 3 };

export interface BackupManifest {
  format: number;
  id: string;
  reason: BackupReason;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  databaseSha256: string;
  mediaFiles: string[];
}

const ID_PATTERN = /^\d{8}-\d{6}-\d{3}-(daily|manual|pre-migration|pre-restore)$/;
const DB_FILE = "media-manager.db";

export class BackupError extends Error {}

function backupId(now: Date, reason: BackupReason): string {
  const iso = now.toISOString(); // 2026-10-30T16:17:04.123Z
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${iso.slice(20, 23)}-${reason}`;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function backupDir(paths: DataPaths, id: string): string {
  if (!ID_PATTERN.test(id)) throw new BackupError(`"${id}" isn't a backup name.`);
  return containedPath(paths.backups, id);
}

function schemaVersion(db: Db): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row.v ?? 0;
}

/** Media files the database refers to, relative to the media directory. */
function referencedMedia(db: Db): string[] {
  const rows = db.prepare("SELECT original_path, thumb_path FROM media_assets").all() as { original_path: string; thumb_path: string }[];
  return [...new Set(rows.flatMap((r) => [r.original_path, r.thumb_path]))].sort();
}

/** Hard link, or copy when linking isn't possible (e.g. another volume). */
async function linkOrCopy(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") throw err;
    await copyFile(from, to);
  }
}

export async function createBackup(
  db: Db,
  paths: DataPaths,
  opts: { reason: BackupReason; appVersion: string; now?: Date },
): Promise<BackupManifest> {
  const now = opts.now ?? new Date();
  const id = backupId(now, opts.reason);
  const dir = backupDir(paths, id);
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true, mode: 0o700 });
  try {
    // A consistent snapshot even while the server is writing.
    await db.backup(join(partial, DB_FILE));
    await chmod(join(partial, DB_FILE), 0o400);
    const snapshot = new Database(join(partial, DB_FILE), { readonly: true });
    let media: string[];
    let version: number;
    try {
      media = referencedMedia(snapshot);
      version = schemaVersion(snapshot);
    } finally {
      snapshot.close();
    }
    const present: string[] = [];
    for (const rel of media) {
      const from = containedPath(paths.media, rel);
      if (!existsSync(from)) continue; // reported by verify; never invent files
      const to = containedPath(join(partial, "media"), rel);
      await mkdir(join(to, ".."), { recursive: true, mode: 0o700 });
      await linkOrCopy(from, to);
      present.push(rel);
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      id,
      reason: opts.reason,
      createdAt: now.toISOString(),
      appVersion: opts.appVersion,
      schemaVersion: version,
      databaseSha256: await sha256File(join(partial, DB_FILE)),
      mediaFiles: present,
    };
    await writeFile(join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    await rename(partial, dir);
    await pruneBackups(paths, opts.reason);
    return manifest;
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw err;
  }
}

export async function listBackups(paths: DataPaths): Promise<BackupManifest[]> {
  if (!existsSync(paths.backups)) return [];
  const out: BackupManifest[] = [];
  for (const name of await readdir(paths.backups)) {
    if (!ID_PATTERN.test(name)) continue;
    try {
      out.push(JSON.parse(await readFile(join(paths.backups, name, "manifest.json"), "utf8")) as BackupManifest);
    } catch {
      // No manifest: incomplete, ignored (and cleaned up by pruning).
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keeps the newest RETENTION[reason] complete backups of that kind; removes incomplete leftovers. */
export async function pruneBackups(paths: DataPaths, reason: BackupReason): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await readdir(paths.backups)) {
    if (name.endsWith(".partial")) {
      await rm(join(paths.backups, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  const old = (await listBackups(paths)).filter((b) => b.reason === reason).slice(RETENTION[reason]);
  for (const b of old) {
    await rm(backupDir(paths, b.id), { recursive: true, force: true });
    removed.push(b.id);
  }
  return removed;
}

export async function latestBackup(paths: DataPaths, reason: BackupReason): Promise<BackupManifest | null> {
  return (await listBackups(paths)).find((b) => b.reason === reason) ?? null;
}

/** Checks a backup is complete, unmodified and readable by this version of the app. Throws BackupError. */
export async function verifyBackup(dir: string): Promise<BackupManifest> {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as BackupManifest;
  } catch {
    throw new BackupError("This backup has no readable manifest; it may be incomplete.");
  }
  if (manifest.format !== BACKUP_FORMAT) throw new BackupError(`Unsupported backup format ${String(manifest.format)}.`);
  const dbFile = join(dir, DB_FILE);
  if (!existsSync(dbFile) || (await sha256File(dbFile)) !== manifest.databaseSha256) {
    throw new BackupError("The backup's database is missing or was changed after the backup was made.");
  }
  const known = loadMigrations().length;
  if (manifest.schemaVersion > known) {
    throw new BackupError(`This backup was made by a newer version of the app (schema ${manifest.schemaVersion}; this version knows ${known}).`);
  }
  const check = new Database(dbFile, { readonly: true });
  try {
    const result = check.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new BackupError(`The backup's database failed its integrity check: ${String(result)}`);
  } finally {
    check.close();
  }
  for (const rel of manifest.mediaFiles) {
    const file = containedPath(join(dir, "media"), rel);
    if (!existsSync(file)) throw new BackupError(`The backup is missing a photo file (${rel}).`);
  }
  return manifest;
}

export async function verifyBackupById(paths: DataPaths, id: string): Promise<BackupManifest> {
  return verifyBackup(backupDir(paths, id));
}

/**
 * Replaces the current database with a backup. The server must not be
 * running (the caller holds the instance lock). The current state is backed
 * up first. Every account's schedules are paused for review afterwards, so a
 * post the old database still thinks is pending is never published twice.
 */
export async function restoreBackup(paths: DataPaths, id: string, opts: { appVersion: string; now?: Date }): Promise<{ restored: BackupManifest; safety: BackupManifest | null }> {
  const dir = backupDir(paths, id);
  const manifest = await verifyBackup(dir);

  let safety: BackupManifest | null = null;
  if (existsSync(paths.database)) {
    const current = new Database(paths.database);
    try {
      safety = await createBackup(current, paths, { reason: "pre-restore", appVersion: opts.appVersion, ...(opts.now ? { now: opts.now } : {}) });
    } finally {
      current.close(); // checkpoints and removes the WAL
    }
  }

  // Bring back any photo files the restored database needs.
  for (const rel of manifest.mediaFiles) {
    const to = containedPath(paths.media, rel);
    if (existsSync(to)) continue;
    await mkdir(join(to, ".."), { recursive: true, mode: 0o700 });
    await linkOrCopy(containedPath(join(dir, "media"), rel), to);
  }

  const incoming = `${paths.database}.restoring`;
  await copyFile(join(dir, DB_FILE), incoming);
  await chmod(incoming, 0o600);
  const db = new Database(incoming);
  try {
    db.prepare("UPDATE accounts SET schedules_need_review = 1").run();
  } finally {
    db.close();
  }
  for (const f of [`${paths.database}-wal`, `${paths.database}-shm`]) await rm(f, { force: true });
  await rename(incoming, paths.database);
  return { restored: manifest, safety };
}

/** Copies a backup elsewhere (e.g. an external drive) as real files, not links. */
export async function exportBackup(paths: DataPaths, id: string, destination: string): Promise<string> {
  const dir = backupDir(paths, id);
  await verifyBackup(dir);
  const target = join(destination, `AtelierHalleMediaManager-backup-${id}`);
  if (existsSync(target)) throw new BackupError(`${target} already exists.`);
  await cp(dir, target, { recursive: true, errorOnExist: true, force: false });
  await verifyBackup(target);
  return target;
}

/** Bytes a backup adds beyond the live library (files whose only other link is in the library are free). */
export async function backupOwnBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const s = await stat(join(entry.parentPath, entry.name));
    if (s.nlink === 1) total += s.size;
  }
  return total;
}
