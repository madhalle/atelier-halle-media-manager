import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, productionDataDir } from "../src/server/config.ts";
import { containedPath, prepareDataDir } from "../src/storage/data-dir.ts";
import { openDatabase } from "../src/storage/db.ts";
import { acquireInstanceLock } from "../src/storage/instance-lock.ts";
import { loadMigrations, migrate } from "../src/storage/migrate.ts";
import { tempDir } from "./helpers.ts";

let dir: ReturnType<typeof tempDir>;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  dir.cleanup();
});

describe("data directory", () => {
  it("creates an owner-only layout", () => {
    const paths = prepareDataDir(join(dir.path, "data"));
    for (const d of [paths.root, paths.media, paths.backups, paths.logs]) {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
  });

  it("makes the database files owner-only", () => {
    const paths = prepareDataDir(join(dir.path, "data"));
    const db = openDatabase(paths.database);
    expect(statSync(paths.database).mode & 0o777).toBe(0o600);
    db.close();
  });

  it("contains untrusted paths", () => {
    const base = join(dir.path, "media");
    expect(containedPath(base, "ab/cd.jpg")).toBe(join(base, "ab", "cd.jpg"));
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "", ".", "a\0b"]) {
      expect(() => containedPath(base, bad)).toThrow();
    }
    expect(containedPath(base, "..hidden")).toBe(join(base, "..hidden"));
  });
});

describe("migrations", () => {
  it("applies once and is idempotent across restarts", () => {
    const file = join(dir.path, "a.db");
    const db1 = openDatabase(file);
    expect(migrate(db1)).toEqual(loadMigrations().map((m) => m.version));
    db1.close();
    const db2 = openDatabase(file);
    expect(migrate(db2)).toEqual([]);
    expect(db2.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db2.pragma("journal_mode", { simple: true })).toBe("wal");
    db2.close();
  });

  it("refuses edited, unknown, or non-contiguous migrations", () => {
    const mdir = join(dir.path, "migrations");
    mkdirSync(mdir);
    writeFileSync(join(mdir, "0001_one.sql"), "CREATE TABLE one (x INTEGER) STRICT;");
    const db = openDatabase(join(dir.path, "b.db"));
    migrate(db, loadMigrations(mdir));

    writeFileSync(join(mdir, "0001_one.sql"), "CREATE TABLE one (y INTEGER) STRICT;");
    expect(() => migrate(db, loadMigrations(mdir))).toThrow(/modified/);

    expect(() => migrate(db, [])).toThrow(/does not know/);

    writeFileSync(join(mdir, "0003_three.sql"), "SELECT 1;");
    expect(() => loadMigrations(mdir)).toThrow(/contiguous/);
    db.close();
  });

  it("rolls back a failing migration completely", () => {
    const mdir = join(dir.path, "migrations");
    mkdirSync(mdir);
    writeFileSync(join(mdir, "0001_bad.sql"), "CREATE TABLE ok (x INTEGER) STRICT; SELECT * FROM missing_table;");
    const db = openDatabase(join(dir.path, "c.db"));
    expect(() => migrate(db, loadMigrations(mdir))).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeUndefined();
    expect(db.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("instance lock", () => {
  it("prevents a second instance and recovers stale locks", () => {
    const file = join(dir.path, "server.lock");
    const release = acquireInstanceLock(file);
    expect(() => acquireInstanceLock(file)).toThrow(/already using/);
    release();
    writeFileSync(file, "999999"); // pid that is not running
    acquireInstanceLock(file)();
  });
});

describe("configuration", () => {
  it("defaults production to Application Support, outside the checkout", () => {
    const c = loadConfig({}, "/repo");
    expect(c).toMatchObject({ env: "production", host: "127.0.0.1", port: 4870, livePublishing: false });
    expect(c.dataDir).toBe(productionDataDir());
  });

  it("isolates development data inside the ignored .data directory", () => {
    const c = loadConfig({ MEDIA_MANAGER_ENV: "development" }, "/repo");
    expect(c.dataDir).toBe("/repo/.data/development");
    expect(c.port).toBe(4871);
  });

  it("requires tests to choose an explicit data directory", () => {
    expect(() => loadConfig({ MEDIA_MANAGER_ENV: "test" })).toThrow(/MEDIA_MANAGER_DATA_DIR/);
  });

  it("never lets development or test use real data", () => {
    expect(() =>
      loadConfig({ MEDIA_MANAGER_ENV: "development", MEDIA_MANAGER_DATA_DIR: productionDataDir() }),
    ).toThrow(/Refusing/);
  });

  it("refuses live publishing outside production", () => {
    expect(() =>
      loadConfig({ MEDIA_MANAGER_ENV: "development", MEDIA_MANAGER_LIVE_PUBLISHING: "enabled" }, "/repo"),
    ).toThrow(/production/);
  });

  it("never allows simulated platforms or short schedule lead times in production", () => {
    expect(() => loadConfig({ MEDIA_MANAGER_FAKE_PLATFORMS: "enabled" }, "/repo")).toThrow(/never be enabled in production/);
    expect(() => loadConfig({ MEDIA_MANAGER_MIN_LEAD_SECONDS: "0" }, "/repo")).toThrow(/at least 60 seconds/);
    expect(loadConfig({}, "/repo")).toMatchObject({ fakePlatforms: false, schedulerIntervalMs: 60_000, minScheduleLeadMs: 60_000 });
    expect(
      loadConfig({ MEDIA_MANAGER_ENV: "development", MEDIA_MANAGER_FAKE_PLATFORMS: "enabled", MEDIA_MANAGER_MIN_LEAD_SECONDS: "-60" }, "/repo"),
    ).toMatchObject({ fakePlatforms: true, minScheduleLeadMs: -60_000 });
    expect(() => loadConfig({ MEDIA_MANAGER_SCHEDULER_INTERVAL_MS: "10" }, "/repo")).toThrow();
  });

  it("rejects relative data directories and invalid ports", () => {
    expect(() => loadConfig({ MEDIA_MANAGER_DATA_DIR: "data" })).toThrow();
    expect(() => loadConfig({ MEDIA_MANAGER_PORT: "80" })).toThrow();
  });
});
