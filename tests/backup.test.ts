// Backups and restore: consistent snapshots, no wasted space, tamper
// detection, retention, and a restore that can never publish a post twice.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupError, createBackup, exportBackup, listBackups, restoreBackup, verifyBackup, verifyBackupById } from "../src/storage/backup.ts";
import { dataPaths, type DataPaths } from "../src/storage/data-dir.ts";
import { tempDir } from "./helpers.ts";
import { connectedAccount, createEnv, scheduledPost, type Env } from "./scheduling-helpers.ts";

let env: Env;
let paths: DataPaths;
const v = { appVersion: "0.1.0" };
const at = (minute: number) => new Date(Date.UTC(2026, 9, 30, 12, minute));

beforeEach(async () => {
  env = await createEnv();
  paths = dataPaths(env.dir.path);
});
afterEach(async () => {
  await env.close();
});

describe("creating backups", () => {
  it("takes a consistent snapshot with hard-linked photos, so photos cost no extra space", async () => {
    const account = connectedAccount(env);
    const post = await scheduledPost(env, account.id);
    const m = await createBackup(env.db, paths, { reason: "manual", ...v, now: at(0) });

    expect(m.id).toBe("20261030-120000-000-manual");
    expect(m.schemaVersion).toBe(4);
    expect(m.mediaFiles).toHaveLength(2); // original + thumbnail
    const dir = join(paths.backups, m.id);
    for (const rel of m.mediaFiles) {
      const backed = statSync(join(dir, "media", rel));
      const live = statSync(join(paths.media, rel));
      expect(backed.ino).toBe(live.ino);
    }
    expect(statSync(join(dir, "media-manager.db")).mode & 0o777).toBe(0o400);
    expect(statSync(dir).mode & 0o077).toBe(0);
    await expect(verifyBackup(dir)).resolves.toMatchObject({ id: m.id });
    expect(post.status).toBe("scheduled");
  });

  it("keeps only the newest backups of each kind and cleans up interrupted ones", async () => {
    mkdirSync(join(paths.backups, "20261030-115900-000-daily.partial"));
    for (let i = 0; i < 9; i++) await createBackup(env.db, paths, { reason: "daily", ...v, now: at(i) });
    await createBackup(env.db, paths, { reason: "manual", ...v, now: at(30) });
    const all = await listBackups(paths);
    expect(all.filter((b) => b.reason === "daily").map((b) => b.id.slice(9, 13))).toEqual(["1208", "1207", "1206", "1205", "1204", "1203", "1202"]);
    expect(all.filter((b) => b.reason === "manual")).toHaveLength(1);
    expect(readdirSync(paths.backups).some((n) => n.endsWith(".partial"))).toBe(false);
  });
});

describe("verifying backups", () => {
  it("detects a modified database, a missing photo, a missing manifest and a newer schema", async () => {
    connectedAccount(env);
    await scheduledPost(env, connectedAccount(env, "pinterest", "Pins").id);
    const m = await createBackup(env.db, paths, { reason: "manual", ...v, now: at(0) });
    const dir = join(paths.backups, m.id);

    const tampered = tempDir("mm-bk-");
    const t1 = await exportBackup(paths, m.id, tampered.path);
    chmodSync(join(t1, "media-manager.db"), 0o600);
    writeFileSync(join(t1, "media-manager.db"), "not a database");
    await expect(verifyBackup(t1)).rejects.toThrow(/changed after the backup/);

    const missing = tempDir("mm-bk-");
    const t2 = await exportBackup(paths, m.id, missing.path);
    rmSync(join(t2, "media", m.mediaFiles[0]!), { force: true });
    await expect(verifyBackup(t2)).rejects.toThrow(/missing a photo file/);

    const noManifest = tempDir("mm-bk-");
    const t3 = await exportBackup(paths, m.id, noManifest.path);
    rmSync(join(t3, "manifest.json"), { force: true });
    await expect(verifyBackup(t3)).rejects.toThrow(/no readable manifest/);

    const newer = tempDir("mm-bk-");
    const t4 = await exportBackup(paths, m.id, newer.path);
    const manifest = JSON.parse(readFileSync(join(t4, "manifest.json"), "utf8")) as { schemaVersion: number };
    chmodSync(join(t4, "manifest.json"), 0o600);
    writeFileSync(join(t4, "manifest.json"), JSON.stringify({ ...manifest, schemaVersion: 99 }));
    await expect(verifyBackup(t4)).rejects.toThrow(/newer version of the app/);

    await expect(verifyBackup(dir)).resolves.toBeTruthy();
    for (const d of [tampered, missing, noManifest, newer]) d.cleanup();
  });

  it("rejects backup names that aren't backups (no path tricks)", async () => {
    await expect(verifyBackupById(paths, "../media-manager.db")).rejects.toBeInstanceOf(BackupError);
    await expect(restoreBackup(paths, "../../etc", v)).rejects.toBeInstanceOf(BackupError);
  });

  it("exports as independent copies that verify on their own", async () => {
    await scheduledPost(env, connectedAccount(env).id);
    const m = await createBackup(env.db, paths, { reason: "manual", ...v, now: at(0) });
    const dest = tempDir("mm-export-");
    const target = await exportBackup(paths, m.id, dest.path);
    for (const rel of m.mediaFiles) expect(statSync(join(target, "media", rel)).nlink).toBe(1);
    await expect(verifyBackup(target)).resolves.toMatchObject({ id: m.id });
    await expect(exportBackup(paths, m.id, dest.path)).rejects.toThrow(/already exists/);
    dest.cleanup();
  });
});

describe("restoring", () => {
  it("brings back data and photos, keeps the current state, and pauses every schedule for review", async () => {
    const account = connectedAccount(env);
    const post = await scheduledPost(env, account.id, 10, "Before");
    const m = await createBackup(env.db, paths, { reason: "manual", ...v, now: at(0) });

    // After the backup: the post is cancelled and its photo deleted.
    env.schedule.cancel(post.id, post.revision, env.clock.now());
    const assetId = env.posts.get(post.id).media[0]!.mediaAssetId;
    env.db.prepare("DELETE FROM post_media WHERE media_asset_id = ?").run(assetId);
    await env.media.remove(assetId);
    expect(existsSync(join(paths.media, m.mediaFiles[0]!))).toBe(false);

    await env.scheduler.stop();
    env.db.close();
    const { restored, safety } = await restoreBackup(paths, m.id, { ...v, now: at(5) });
    expect(restored.id).toBe(m.id);
    expect(safety?.reason).toBe("pre-restore");
    expect(existsSync(join(paths.backups, safety!.id))).toBe(true);
    for (const rel of m.mediaFiles) expect(existsSync(join(paths.media, rel))).toBe(true);
    expect(existsSync(`${paths.database}-wal`) && statSync(`${paths.database}-wal`).size > 0).toBe(false);

    await env.restart();
    const back = env.posts.get(post.id);
    expect(back.status).toBe("scheduled");
    expect(back.caption).toBe("Before");
    expect(env.accounts.get(account.id).schedulesNeedReview).toBe(true);

    // Even when due, nothing publishes until the schedules are reviewed.
    env.clock.advance(15 * 60_000);
    await env.scheduler.tick();
    expect(env.fakes.instagram.calls.filter((c) => c.step === "commit")).toHaveLength(0);
  });
});

describe("command line", () => {
  const run = promisify(execFile);
  const node = process.execPath;
  const script = join(import.meta.dirname, "..", "scripts", "backup.ts");
  const cli = (args: string[]) =>
    run(node, [script, "--env", "test", ...args], { env: { ...process.env, MEDIA_MANAGER_DATA_DIR: env.dir.path, MEDIA_MANAGER_PORT: "4872" } });

  it("backs up, lists, verifies, and refuses to restore while the app is running", async () => {
    await scheduledPost(env, connectedAccount(env).id);
    const created = await cli([]);
    expect(created.stdout).toMatch(/Backed up to .*-manual \(2 photo files\)/);
    const id = /(\d{8}-\d{6}-\d{3}-manual)/.exec(created.stdout)![1]!;
    expect((await cli(["list"])).stdout).toContain(id);
    expect((await cli(["verify", id])).stdout).toMatch(/^OK/);

    writeFileSync(join(env.dir.path, "server.lock"), String(process.pid)); // as if the server were running
    await expect(cli(["restore", id])).rejects.toMatchObject({ stderr: expect.stringMatching(/Media Manager is running/) });
  });
});
