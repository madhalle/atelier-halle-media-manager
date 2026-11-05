// Account previews: profile and recent posts from the platform, with images
// proxied by key. Loopback fakes only.
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPlatformImageOrigin } from "../src/platforms/preview.ts";
import { createAccountsRepo } from "../src/storage/accounts-repo.ts";
import { createMemoryStore } from "../src/storage/credentials.ts";
import { BUSINESS_TOKEN, PIN_SECRET, startFakeProviders, type FakeProviders } from "./fake-providers.ts";
import { createTestApp, sameOrigin, signIn, type TestApp } from "./helpers.ts";

let t: TestApp;
let fakes: FakeProviders;
let auth: { cookie: string; csrf: string };

beforeEach(async () => {
  fakes = await startFakeProviders();
  t = await createTestApp({}, { credentials: createMemoryStore(), endpoints: fakes.endpoints });
  auth = await signIn(t);
});
afterEach(async () => {
  await t.cleanup();
  await fakes.close();
});

const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: sameOrigin(t.config.port, { cookie: auth.cookie, "x-csrf-token": auth.csrf }),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

async function connectedInstagram(): Promise<string> {
  await call("PATCH", "/api/platforms", { instagram: { businessToken: BUSINESS_TOKEN } });
  const a = (await call("POST", "/api/accounts", { platform: "instagram", displayName: "Studio" })).json().account as { id: string };
  expect((await call("POST", `/api/accounts/${a.id}/connect-business`, { instagramUserId: fakes.state.ig.userId })).statusCode).toBe(200);
  return a.id;
}

async function connectedPinterest(): Promise<string> {
  await call("PATCH", "/api/platforms", { pinterest: { clientId: "1234567890123", clientSecret: PIN_SECRET } });
  const a = (await call("POST", "/api/accounts", { platform: "pinterest", displayName: "Pins" })).json().account as { id: string };
  const start = await call("POST", `/api/accounts/${a.id}/connect`, {});
  const state = new URL(start.json().authorizeUrl).searchParams.get("state")!;
  expect((await call("POST", "/api/oauth/pinterest/complete", { state, code: "good-code" })).statusCode).toBe(200);
  return a.id;
}

describe("Instagram preview", () => {
  it("shows the profile and recent posts with links back to Instagram, without exposing tokens or image addresses", async () => {
    const id = await connectedInstagram();
    const res = await call("GET", `/api/accounts/${id}/preview`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile).toMatchObject({
      username: "atelierhalle",
      name: "Atelier Hallé",
      bio: "Jewellery, made by hand.",
      website: "https://atelierhalle.com/",
      postCount: 13,
      url: "https://www.instagram.com/atelierhalle/",
    });
    expect(body.profile.avatar).toMatch(new RegExp(`^/api/accounts/${id}/preview/images/avatar\\?v=\\d+$`));
    expect(body.posts.map((p: { kind: string; url: string }) => [p.kind, p.url])).toEqual([
      ["carousel", "https://www.instagram.com/p/AAA111/"],
      ["photo", "https://www.instagram.com/p/BBB222/"],
      ["video", "https://www.instagram.com/reel/CCC333/"],
    ]);
    expect(body.sandbox).toBe(false);
    expect(res.body).not.toContain(BUSINESS_TOKEN);
    expect(res.body).not.toContain(fakes.state.cdn.origin); // remote image URLs stay server-side
  });

  it("serves small re-encoded JPEGs by key, and the video's thumbnail rather than the video", async () => {
    const id = await connectedInstagram();
    const posts = (await call("GET", `/api/accounts/${id}/preview`)).json().posts as { image: string }[];
    const img = await call("GET", posts[0]!.image);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/jpeg");
    expect(img.headers["cache-control"]).toBe("private, max-age=600");
    const meta = await sharp(img.rawPayload).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 360, 360]);
    await call("GET", posts[2]!.image);
    expect(fakes.calls("cdn", "/img/c.jpg")).toHaveLength(1);
    expect(fakes.calls("cdn").some((c) => c.path.includes("v.mp4"))).toBe(false);
  });

  it("only accepts preview keys, never URLs, and 404s keys that aren't in the preview", async () => {
    const id = await connectedInstagram();
    await call("GET", `/api/accounts/${id}/preview`);
    expect((await call("GET", `/api/accounts/${id}/preview/images/${encodeURIComponent("https://evil.example/x.jpg")}`)).statusCode).toBe(400);
    expect((await call("GET", `/api/accounts/${id}/preview/images/p7`)).statusCode).toBe(404);
  });

  it("refuses non-image responses and image hosts that aren't the platform's", async () => {
    fakes.state.recent.instagram = [
      { id: "1", media_type: "IMAGE", media_url: `${fakes.state.cdn.origin}/img/not-an-image`, permalink: "https://www.instagram.com/p/X/", timestamp: "2026-10-01T12:00:00+0000" },
      { id: "2", media_type: "IMAGE", media_url: "https://evil.example/x.jpg", permalink: "https://evil.example/p", timestamp: "2026-10-01T12:00:00+0000" },
    ];
    const id = await connectedInstagram();
    const posts = (await call("GET", `/api/accounts/${id}/preview`)).json().posts as { image: string; url: string | null }[];
    expect(posts[1]!.url).toBeNull(); // permalinks must be instagram.com
    expect((await call("GET", posts[0]!.image)).statusCode).toBe(404);
    expect((await call("GET", posts[1]!.image)).statusCode).toBe(404);
  });

  it("keeps the preview briefly; Refresh asks Instagram again", async () => {
    const id = await connectedInstagram();
    await call("GET", `/api/accounts/${id}/preview`);
    await call("GET", `/api/accounts/${id}/preview`);
    const profileCalls = () => fakes.calls("fb-graph", `/v26.0/${fakes.state.ig.userId}`).length;
    expect(profileCalls()).toBe(1); // the second view used the kept preview
    await call("GET", `/api/accounts/${id}/preview?refresh=1`);
    expect(profileCalls()).toBe(2);
  });

  it("never calls a platform for simulated accounts", async () => {
    const a = (await call("POST", "/api/accounts", { platform: "instagram", displayName: "Sim" })).json().account as { id: string };
    // As scripts/dev-fake-connect.ts does.
    createAccountsRepo(t.db).markConnected(
      a.id,
      { providerAccountId: "fake-1", username: "simulated_instagram", displayName: "Simulated account", avatarUrl: null, accountType: "SIMULATED", verifiedAt: new Date().toISOString() },
      `fake:${a.id}`,
    );
    const res = await call("GET", `/api/accounts/${a.id}/preview`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/Simulated accounts/);
    expect(fakes.state.log).toHaveLength(0);
  });

  it("needs a connected account", async () => {
    const a = (await call("POST", "/api/accounts", { platform: "instagram", displayName: "New" })).json().account as { id: string };
    const res = await call("GET", `/api/accounts/${a.id}/preview`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/Connect this account/);
  });
});

describe("Pinterest preview (developer guidelines: no stored data, link back, don't crop)", () => {
  it("asks Pinterest on every view, links Pins back, and serves uncropped, uncached images", async () => {
    const id = await connectedPinterest();
    fakes.state.pin.pins.push({ id: "813650000001", title: "Ring", description: "", created_at: "2026-10-01T12:00:00" });
    const first = (await call("GET", `/api/accounts/${id}/preview`)).json();
    await call("GET", `/api/accounts/${id}/preview`);
    expect(fakes.calls("pin-sandbox", "/v5/pins").filter((c) => c.method === "GET")).toHaveLength(2);
    expect(first.profile).toMatchObject({ username: "atelierhalle", name: "Atelier Halle", url: "https://www.pinterest.com/atelierhalle/" });
    expect(first.posts).toMatchObject([{ kind: "pin", url: "https://www.pinterest.com/pin/813650000001/" }]);
    expect(first.sandbox).toBe(true); // Trial: the UI explains public Pins aren't listed

    const img = await call("GET", first.posts[0].image);
    expect(img.headers["cache-control"]).toBe("no-store");
    const meta = await sharp(img.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([288, 360]); // 640×800 scaled, not cropped
    await call("GET", first.posts[0].image);
    expect(fakes.calls("cdn", "/img/pin-813650000001.jpg")).toHaveLength(2); // not cached
  });
});

describe("image host allowlist", () => {
  it("accepts only the platforms' HTTPS image hosts", () => {
    for (const ok of ["https://scontent-lga3-3.cdninstagram.com", "https://scontent-lga3-3.xx.fbcdn.net", "https://i.pinimg.com"]) {
      expect(isPlatformImageOrigin(ok)).toBe(true);
    }
    for (const bad of [
      "http://scontent.cdninstagram.com",
      "https://cdninstagram.com.evil.example",
      "https://evilcdninstagram.com",
      "https://i.pinimg.com:8443",
      "https://127.0.0.1",
      "https://pinimg.com",
    ]) {
      expect(isPlatformImageOrigin(bad)).toBe(false);
    }
  });
});
