import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeCrop, countHashtags, countMentions, isValidLink } from "../src/domain/posts.ts";
import { dataPaths } from "../src/storage/data-dir.ts";
import { createTestApp, sameOrigin, signIn, type TestApp } from "./helpers.ts";
import { avif, jpeg, multipart, png, webp } from "./images.ts";

let t: TestApp;
let auth: { cookie: string; csrf: string };
beforeEach(async () => {
  t = await createTestApp();
  auth = await signIn(t);
});
afterEach(async () => {
  await t.cleanup();
});

const headers = (extra: Record<string, string> = {}) => sameOrigin(t.config.port, { cookie: auth.cookie, "x-csrf-token": auth.csrf, ...extra });

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return t.app.inject({ method, url, headers: headers(), ...(payload !== undefined ? { payload: payload as object } : {}) });
}

async function upload(files: { name: string; data: Buffer; type?: string }[]) {
  const { payload, contentType } = await multipart(files);
  return t.app.inject({ method: "POST", url: "/api/media", headers: headers({ "content-type": contentType }), payload });
}

async function uploadOne(data: Buffer, name = "photo.jpg") {
  const res = await upload([{ name, data }]);
  const r = res.json().results[0];
  if (!r.ok) throw new Error(r.error);
  return r.media as { id: string; width: number; height: number; hasLocation: boolean };
}

async function account(platform: "instagram" | "pinterest", displayName: string) {
  return (await call("POST", "/api/accounts", { platform, displayName })).json().account as { id: string; revision: number };
}

const mediaDir = () => dataPaths(t.config.dataDir).media;

describe("domain helpers", () => {
  it("computes deterministic, in-bounds crops around a focus point", () => {
    expect(computeCrop(1000, 2000, "4:5", 0.5, 0.5)).toEqual({ left: 0, top: 375, width: 1000, height: 1250 });
    expect(computeCrop(1000, 2000, "4:5", 0.5, 0)).toEqual({ left: 0, top: 0, width: 1000, height: 1250 });
    expect(computeCrop(1000, 2000, "4:5", 0.5, 1)).toEqual({ left: 0, top: 750, width: 1000, height: 1250 });
    expect(computeCrop(3000, 1000, "1:1", 0, 0.5)).toEqual({ left: 0, top: 0, width: 1000, height: 1000 });
    expect(computeCrop(800, 600, "original", 0.2, 0.9)).toEqual({ left: 0, top: 0, width: 800, height: 600 });
  });

  it("counts hashtags and mentions as Instagram does, ignoring emails and URL fragments", () => {
    expect(countHashtags("#one #two_2 not#three #café")).toBe(3);
    expect(countMentions("@atelier hi@example.com @halle.studio")).toBe(2);
  });

  it("accepts only http(s) links with a real host", () => {
    for (const ok of ["", "https://atelierhalle.com/p/1", "http://example.org"]) expect(isValidLink(ok)).toBe(true);
    for (const bad of ["javascript:alert(1)", "atelierhalle.com", "https://localhost/x", "data:text/html,x", "https://u:p@example.com"]) {
      expect(isValidLink(bad)).toBe(false);
    }
  });
});

describe("photo library uploads", () => {
  it("stores several photos, keeps originals byte-identical and read-only, and strips location from thumbnails", async () => {
    const gpsJpeg = await jpeg(1200, 900, { gps: true });
    const res = await upload([
      { name: "a.jpg", data: gpsJpeg },
      { name: "b.png", data: await png() },
      { name: "c.webp", data: await webp() },
    ]);
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, true]);
    expect(results[0].media).toMatchObject({ width: 1200, height: 900, hasLocation: true, format: "jpeg", originalFilename: "a.jpg" });

    const originalsDir = join(mediaDir(), "originals");
    const stored = readdirSync(originalsDir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile());
    expect(stored).toHaveLength(3);
    const jpegFile = stored.find((d) => d.name.endsWith(".jpg"))!;
    const jpegPath = join(jpegFile.parentPath, jpegFile.name);
    expect(readFileSync(jpegPath).equals(gpsJpeg)).toBe(true);
    expect(statSync(jpegPath).mode & 0o777).toBe(0o400);

    const thumb = await t.app.inject({ method: "GET", url: results[0].media.thumbUrl, headers: headers() });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/webp");
    const tmeta = await sharp(thumb.rawPayload).metadata();
    expect(tmeta.exif).toBeUndefined();
    expect(Math.max(tmeta.width!, tmeta.height!)).toBeLessThanOrEqual(480);

    expect(readdirSync(join(mediaDir(), "tmp"))).toEqual([]);
  });

  it("reports EXIF-oriented dimensions", async () => {
    const m = await uploadOne(await jpeg(1200, 800, { orientation: 6 }));
    expect([m.width, m.height]).toEqual([800, 1200]);
  });

  it("deduplicates identical bytes", async () => {
    const data = await jpeg(500, 500, { color: "#123456" });
    const a = (await upload([{ name: "one.jpg", data }])).json().results[0];
    const b = (await upload([{ name: "copy.jpg", data }])).json().results[0];
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.media.id).toBe(a.media.id);
  });

  it("judges files by their bytes, rejects HEIF-family and fake images, and keeps processing the rest", async () => {
    const res = await upload([
      { name: "fake.jpg", data: Buffer.from("definitely not an image"), type: "image/jpeg" },
      { name: "photo.heic", data: await avif() },
      { name: "png-named.jpg", data: await png(300, 300) },
    ]);
    const [fake, heif, good] = res.json().results;
    expect(fake).toMatchObject({ ok: false, error: expect.stringContaining("isn't a JPEG, PNG or WebP") });
    expect(heif).toMatchObject({ ok: false, error: expect.stringContaining("HEIC/HEIF") });
    expect(good).toMatchObject({ ok: true, media: { format: "png" } });
    expect(readdirSync(join(mediaDir(), "tmp"))).toEqual([]);
  });

  it("never hands SVG, TIFF or GIF bytes to the image decoders", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    const tiff = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).tiff().toBuffer();
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).gif().toBuffer();
    const results = (await upload([
      { name: "x.jpg", data: svg },
      { name: "y.jpg", data: tiff },
      { name: "z.png", data: gif },
    ])).json().results;
    expect(results.map((r: { ok: boolean }) => r.ok)).toEqual([false, false, false]);
    // Defence in depth: the decoders themselves are blocked in this process.
    await expect(sharp(svg).metadata()).rejects.toThrow(/unsupported image format/i);
    await expect(sharp(tiff).metadata()).rejects.toThrow(/unsupported image format/i);
  });

  it("rejects images over the pixel limit before decoding them", async () => {
    const huge = await sharp({ create: { width: 12_000, height: 9_000, channels: 3, background: "#fff" } }).png({ compressionLevel: 9 }).toBuffer();
    const r = (await upload([{ name: "huge.png", data: huge }])).json().results[0];
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("too large") });
  });

  it("rejects files over the size limit without storing them", async () => {
    const big = Buffer.alloc(50 * 1024 * 1024 + 10, 0xff);
    const r = (await upload([{ name: "big.jpg", data: big }])).json().results[0];
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("larger than 50 MB") });
    expect(readdirSync(join(mediaDir(), "tmp"))).toEqual([]);
  });

  it("requires a session and CSRF token to upload", async () => {
    const { payload, contentType } = await multipart([{ name: "a.jpg", data: await jpeg(100, 100) }]);
    const noCsrf = await t.app.inject({
      method: "POST",
      url: "/api/media",
      headers: sameOrigin(t.config.port, { cookie: auth.cookie, "content-type": contentType }),
      payload,
    });
    expect(noCsrf.statusCode).toBe(403);
    const noSession = await t.app.inject({
      method: "GET",
      url: "/api/media",
      headers: sameOrigin(t.config.port),
    });
    expect(noSession.statusCode).toBe(401);
  });

  it("refuses to delete photos used by posts, and deletes unused ones with their files", async () => {
    const ig = await account("instagram", "IG");
    const used = await uploadOne(await jpeg(1080, 1080, { color: "#111" }));
    const unused = await uploadOne(await jpeg(1080, 1080, { color: "#222" }));
    await call("POST", `/api/accounts/${ig.id}/posts`, { mediaAssetId: used.id });

    expect((await call("DELETE", `/api/media/${used.id}`)).statusCode).toBe(409);
    expect((await call("DELETE", `/api/media/${unused.id}`)).statusCode).toBe(200);
    const list = (await call("GET", "/api/media")).json().media.map((m: { id: string }) => m.id);
    expect(list).toEqual([used.id]);
    const files = readdirSync(join(mediaDir(), "originals"), { recursive: true, withFileTypes: true }).filter((d) => d.isFile());
    expect(files).toHaveLength(1);
  });

  it("rejects malformed media ids", async () => {
    expect((await call("GET", "/api/media/..%2f..%2fetc/thumb")).statusCode).toBe(400);
  });
});

describe("posts", () => {
  it("creates drafts on unconnected accounts and never crops silently", async () => {
    const ig = await account("instagram", "Personal Instagram");
    const tall = await uploadOne(await jpeg(1000, 2000));
    const res = await call("POST", `/api/accounts/${ig.id}/posts`, { mediaAssetId: tall.id });
    expect(res.statusCode).toBe(201);
    const post = res.json().post;
    expect(post).toMatchObject({ status: "draft", accountId: ig.id });
    expect(post.media[0]).toMatchObject({ cropAspect: "original", mediaAssetId: tall.id });
    expect(post.issues).toContainEqual(expect.objectContaining({ field: "media", severity: "blocking", message: expect.stringContaining("Choose a crop") }));

    const cropped = await call("PATCH", `/api/posts/${post.id}`, {
      revision: post.revision,
      media: [{ position: 0, cropAspect: "4:5", focusX: 0.5, focusY: 0.2 }],
    });
    expect(cropped.json().post.issues.filter((i: { severity: string }) => i.severity === "blocking")).toEqual([]);
  });

  it("previews the exact derivative: cropped, resized, sRGB JPEG with no metadata", async () => {
    const ig = await account("instagram", "IG");
    const photo = await uploadOne(await jpeg(3000, 4000, { gps: true }));
    const post = (await call("POST", `/api/accounts/${ig.id}/posts`, { mediaAssetId: photo.id })).json().post;
    const updated = (
      await call("PATCH", `/api/posts/${post.id}`, { revision: post.revision, media: [{ position: 0, cropAspect: "1:1", focusX: 0.5, focusY: 0.5 }] })
    ).json().post;
    const res = await t.app.inject({ method: "GET", url: updated.media[0].previewUrl, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 1440, height: 1440, space: "srgb" });
    expect(meta.exif).toBeUndefined();
    expect(res.rawPayload.length).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("validates platform-specific fields", async () => {
    const ig = await account("instagram", "IG");
    const pin = await account("pinterest", "Pins");
    const photo = await uploadOne(await jpeg(1000, 1000));

    const igPost = (await call("POST", `/api/accounts/${ig.id}/posts`, { mediaAssetId: photo.id })).json().post;
    const caption = `${"x".repeat(2100)} ${Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ")}`;
    const igIssues = (await call("PATCH", `/api/posts/${igPost.id}`, { revision: igPost.revision, fields: { caption } })).json().post.issues;
    expect(igIssues.map((i: { message: string }) => i.message)).toEqual(
      expect.arrayContaining(["Captions can be at most 2200 characters.", "Instagram allows at most 30 hashtags."]),
    );

    const pinPost = (await call("POST", `/api/accounts/${pin.id}/posts`, { mediaAssetId: photo.id })).json().post;
    const pinIssues = (
      await call("PATCH", `/api/posts/${pinPost.id}`, {
        revision: pinPost.revision,
        fields: { pinTitle: "t".repeat(101), pinLink: "javascript:alert(1)", pinDescription: "ok" },
      })
    ).json().post.issues;
    expect(pinIssues.filter((i: { severity: string }) => i.severity === "blocking").map((i: { field: string }) => i.field).sort()).toEqual(
      ["pinBoard", "pinLink", "pinTitle"],
    );

    // Instagram-only crop presets are rejected for Pinterest and vice versa.
    const badCrop = await call("PATCH", `/api/posts/${pinPost.id}`, {
      revision: pinPost.revision + 1,
      media: [{ position: 0, cropAspect: "1.91:1", focusX: 0.5, focusY: 0.5 }],
    });
    expect(badCrop.statusCode).toBe(400);
    // Unknown fields (e.g. a status change) are refused.
    const sneaky = await call("PATCH", `/api/posts/${pinPost.id}`, { revision: pinPost.revision + 1, fields: { status: "published" } });
    expect(sneaky.statusCode).toBe(400);
  });

  it("copies to other accounts as independent drafts that reuse the same photo", async () => {
    const source = await account("instagram", "Business Instagram");
    const otherIg = await account("instagram", "Personal Instagram");
    const pin = await account("pinterest", "Atelier Halle Pinterest");
    const archived = await account("pinterest", "Old Pins");
    await call("POST", `/api/accounts/${archived.id}/archive`, { revision: archived.revision });
    const photo = await uploadOne(await jpeg(1080, 1350));

    let post = (await call("POST", `/api/accounts/${source.id}/posts`, { mediaAssetId: photo.id })).json().post;
    post = (
      await call("PATCH", `/api/posts/${post.id}`, {
        revision: post.revision,
        fields: { caption: "Linen dress #atelier", altText: "A linen dress on a hanger" },
        media: [{ position: 0, cropAspect: "4:5", focusX: 0.5, focusY: 0.5 }],
      })
    ).json().post;

    expect((await call("POST", `/api/posts/${post.id}/copies`, { accountIds: [archived.id] })).statusCode).toBe(409);
    expect((await call("POST", `/api/posts/${post.id}/copies`, { accountIds: [source.id] })).statusCode).toBe(400);

    const res = await call("POST", `/api/posts/${post.id}/copies`, { accountIds: [otherIg.id, pin.id] });
    expect(res.statusCode).toBe(201);
    const [igCopy, pinCopy] = res.json().posts;
    for (const c of [igCopy, pinCopy]) {
      expect(c).toMatchObject({ status: "draft", copiedFromPostId: post.id, altText: "A linen dress on a hanger" });
      expect(c.media[0].mediaAssetId).toBe(photo.id);
      expect(c.id).not.toBe(post.id);
    }
    expect(igCopy).toMatchObject({ accountId: otherIg.id, caption: "Linen dress #atelier" });
    expect(igCopy.media[0].cropAspect).toBe("4:5");
    expect(pinCopy).toMatchObject({ accountId: pin.id, pinDescription: "Linen dress #atelier", caption: "", pinBoardId: null });
    expect(pinCopy.media[0].cropAspect).toBe("original"); // 4:5 is not a Pinterest preset

    // Editing a copy never changes the source or other copies.
    await call("PATCH", `/api/posts/${igCopy.id}`, { revision: igCopy.revision, fields: { caption: "Personal take" } });
    expect((await call("GET", `/api/posts/${post.id}`)).json().post.caption).toBe("Linen dress #atelier");
    expect((await call("GET", `/api/posts/${pinCopy.id}`)).json().post.pinDescription).toBe("Linen dress #atelier");

    // Each account sees only its own posts.
    const lists = await Promise.all([source, otherIg, pin].map(async (a) => (await call("GET", `/api/accounts/${a.id}/posts`)).json()));
    expect(lists.map((l) => l.posts.length)).toEqual([1, 1, 1]);
    expect(lists[1].counts.draft).toBe(1);
  });

  it("deletes unpublished drafts but keeps their photos, and checks revisions", async () => {
    const ig = await account("instagram", "IG");
    const photo = await uploadOne(await jpeg(1080, 1080));
    const post = (await call("POST", `/api/accounts/${ig.id}/posts`, { mediaAssetId: photo.id })).json().post;
    expect((await call("DELETE", `/api/posts/${post.id}`, { revision: post.revision + 5 })).statusCode).toBe(409);
    expect((await call("DELETE", `/api/posts/${post.id}`, { revision: post.revision })).statusCode).toBe(200);
    expect((await call("GET", `/api/posts/${post.id}`)).statusCode).toBe(404);
    expect((await call("GET", "/api/media")).json().media.map((m: { id: string; usedByPosts: number }) => [m.id, m.usedByPosts])).toEqual([
      [photo.id, 0],
    ]);
  });

  it("refuses edits and deletion once a post is no longer a draft", async () => {
    const ig = await account("instagram", "IG");
    const photo = await uploadOne(await jpeg(1080, 1080));
    const post = (await call("POST", `/api/accounts/${ig.id}/posts`, { mediaAssetId: photo.id })).json().post;
    t.db.prepare("UPDATE posts SET status = 'published' WHERE id = ?").run(post.id);
    expect((await call("PATCH", `/api/posts/${post.id}`, { revision: post.revision, fields: { caption: "x" } })).statusCode).toBe(409);
    expect((await call("DELETE", `/api/posts/${post.id}`, { revision: post.revision })).statusCode).toBe(409);
    expect((await call("DELETE", `/api/media/${photo.id}`)).statusCode).toBe(409);
  });

  it("does not add posts to archived accounts", async () => {
    const ig = await account("instagram", "IG");
    await call("POST", `/api/accounts/${ig.id}/archive`, { revision: ig.revision });
    const photo = await uploadOne(await jpeg(1080, 1080));
    expect((await call("POST", `/api/accounts/${ig.id}/posts`, { mediaAssetId: photo.id })).statusCode).toBe(409);
  });

  it("prunes cached derivatives for crops no post uses any more", async () => {
    const ig = await account("instagram", "IG");
    const photo = await uploadOne(await jpeg(2000, 2000));
    let post = (await call("POST", `/api/accounts/${ig.id}/posts`, { mediaAssetId: photo.id })).json().post;
    const dir = join(mediaDir(), "derivatives", photo.id);
    for (const focusX of [0.2, 0.8]) {
      post = (await call("PATCH", `/api/posts/${post.id}`, { revision: post.revision, media: [{ position: 0, cropAspect: "4:5", focusX, focusY: 0.5 }] })).json().post;
      await t.app.inject({ method: "GET", url: post.media[0].previewUrl, headers: headers() });
    }
    expect(readdirSync(dir)).toHaveLength(1); // the earlier crop's file was pruned
    await call("DELETE", `/api/posts/${post.id}`, { revision: post.revision });
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("previews unsaved crops as real derivatives and validates the parameters", async () => {
    const photo = await uploadOne(await jpeg(2000, 1000));
    const ok = await t.app.inject({ method: "GET", url: `/api/media/${photo.id}/derivative?platform=instagram&aspect=1:1&fx=0.123&fy=0.5`, headers: headers() });
    expect(ok.statusCode).toBe(200);
    expect(await sharp(ok.rawPayload).metadata()).toMatchObject({ width: 1000, height: 1000 });
    const bad = await t.app.inject({ method: "GET", url: `/api/media/${photo.id}/derivative?platform=pinterest&aspect=4:5&fx=0.5&fy=0.5`, headers: headers() });
    expect(bad.statusCode).toBe(400);
    const outOfRange = await t.app.inject({ method: "GET", url: `/api/media/${photo.id}/derivative?platform=instagram&aspect=1:1&fx=2&fy=0.5`, headers: headers() });
    expect(outOfRange.statusCode).toBe(400);
  });

  it("removes files left unreferenced by a crash when the store starts", async () => {
    const { createMediaStore } = await import("../src/storage/media-store.ts");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const kept = await uploadOne(await jpeg(800, 800));
    mkdirSync(join(mediaDir(), "originals", "zz"), { recursive: true });
    writeFileSync(join(mediaDir(), "originals", "zz", "orphan.jpg"), "x");
    mkdirSync(join(mediaDir(), "derivatives", "not-an-asset"), { recursive: true });
    const store = createMediaStore(t.db, mediaDir());
    const { removedFiles } = await store.init();
    expect(removedFiles).toBe(2);
    expect(existsSync(join(mediaDir(), "originals", "zz", "orphan.jpg"))).toBe(false);
    const thumb = await t.app.inject({ method: "GET", url: `/api/media/${kept.id}/thumb`, headers: headers() });
    expect(thumb.statusCode).toBe(200);
  });

  it("keeps derivatives inside the media directory", async () => {
    const pin = await account("pinterest", "P");
    const photo = await uploadOne(await png(1000, 1500));
    const post = (await call("POST", `/api/accounts/${pin.id}/posts`, { mediaAssetId: photo.id })).json().post;
    await t.app.inject({ method: "GET", url: post.media[0].previewUrl, headers: headers() });
    expect(existsSync(join(mediaDir(), "derivatives", photo.id))).toBe(true);
  });
});
