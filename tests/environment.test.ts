// Milestone 1 compatibility checks: proves the chosen native dependencies
// load and behave as the architecture assumes on this machine's runtime.
// These tests never touch the macOS Keychain or the network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mm-env-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runtime", () => {
  it("runs on the pinned Node.js LTS major", () => {
    expect(process.versions.node.split(".")[0]).toBe("26");
  });
});

describe("better-sqlite3", () => {
  it("supports WAL, enforced foreign keys, and transactions", () => {
    const db = new Database(join(dir, "app.db"));
    expect(db.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE account (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE post (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id)) STRICT;
    `);
    expect(() => db.prepare("INSERT INTO post VALUES (?, ?)").run("p1", "missing")).toThrow(/FOREIGN KEY/);

    const insertBoth = db.transaction(() => {
      db.prepare("INSERT INTO account VALUES (?)").run("a1");
      db.prepare("INSERT INTO post VALUES (?, ?)").run("p1", "nope");
    });
    expect(() => insertBoth()).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM account").get()).toEqual({ n: 0 });
    db.close();
  });

  it("produces a consistent online backup that includes WAL-only writes", async () => {
    const live = new Database(join(dir, "live.db"));
    live.pragma("journal_mode = WAL");
    live.pragma("wal_autocheckpoint = 0");
    live.exec("CREATE TABLE t (v TEXT) STRICT");
    live.prepare("INSERT INTO t VALUES (?)").run("only-in-wal");

    const target = join(dir, "backup.db");
    await live.backup(target);
    live.close();

    const restored = new Database(target, { readonly: true });
    expect(restored.prepare("SELECT v FROM t").all()).toEqual([{ v: "only-in-wal" }]);
    restored.close();
  });
});

describe("sharp", () => {
  async function jpegWithGpsAndOrientation(): Promise<Buffer> {
    return sharp({ create: { width: 40, height: 20, channels: 3, background: "#c33" } })
      .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 44/1 0/1" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
  }

  it("decodes JPEG and PNG from bytes", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#fff" } }).png().toBuffer();
    expect((await sharp(png).metadata()).format).toBe("png");
    expect((await sharp(await jpegWithGpsAndOrientation()).metadata()).format).toBe("jpeg");
  });

  it("applies EXIF orientation and strips location metadata from derivatives", async () => {
    const original = await jpegWithGpsAndOrientation();
    const meta = await sharp(original).metadata();
    expect(meta.orientation).toBe(6);
    expect(meta.exif).toBeDefined();

    const derivative = await sharp(original).rotate().toColorspace("srgb").jpeg({ quality: 90 }).toBuffer();
    const out = await sharp(derivative).metadata();
    expect([out.width, out.height]).toEqual([20, 40]);
    expect(out.exif).toBeUndefined();
    expect(out.orientation).toBeUndefined();
  });

  it("rejects bytes that are not an image regardless of file name", async () => {
    await expect(sharp(Buffer.from("not really a .jpg")).metadata()).rejects.toThrow();
  });

  it("enforces a pixel limit before decoding", async () => {
    const big = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#000" } }).png().toBuffer();
    await expect(sharp(big, { limitInputPixels: 100 * 100 }).toBuffer()).rejects.toThrow(/pixel limit/i);
  });

  it("does not decode HEIC with the prebuilt libvips (HEVC is excluded)", () => {
    // Prebuilt sharp ships libheif with AVIF only. HEIC uploads must be
    // rejected with guidance, or converted by a separately verified path.
    expect(sharp.format.heif.input.fileSuffix).not.toContain(".heic");
  });
});

describe("@napi-rs/keyring", () => {
  it("loads its native binding (Keychain access is verified separately)", async () => {
    const keyring = await import("@napi-rs/keyring");
    expect(typeof keyring.Entry).toBe("function");
  });
});
