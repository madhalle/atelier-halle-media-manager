// Real platform adapters and token handling, exercised against loopback fakes.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlatformError } from "../src/domain/publishing.ts";
import type { TokenSet } from "../src/platforms/oauth.ts";
import { createPlatformServices, type PlatformServices } from "../src/platforms/services.ts";
import type { PublishJob } from "../src/platforms/types.ts";
import { createMemoryStore } from "../src/storage/credentials.ts";
import { IG_SECRET, PIN_SECRET, R2, startFakeProviders, type FakeProviders } from "./fake-providers.ts";
import { jpeg } from "./images.ts";
import { connectedAccount, createEnv, scheduledPost, type Env } from "./scheduling-helpers.ts";
import { processNext } from "../src/scheduler/worker.ts";

let env: Env;
let fakes: FakeProviders;
let store: ReturnType<typeof createMemoryStore>;
let svc: PlatformServices;
let photoFile: string;

const DAY = 24 * 3600_000;

beforeEach(async () => {
  env = await createEnv();
  fakes = await startFakeProviders();
  store = createMemoryStore();
  svc = createPlatformServices({
    db: env.db,
    accounts: env.accounts,
    credentials: store,
    port: 4872,
    now: env.clock.now,
    endpoints: fakes.endpoints,
    allowInsecureLoopback: true,
  });
  await svc.config.update({
    instagram: { clientId: "9876543210123", clientSecret: IG_SECRET },
    pinterest: { clientId: "1234567890123", clientSecret: PIN_SECRET, tier: "trial" },
    r2: { accountId: R2.accountId, bucket: R2.bucket, accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey },
  });
  photoFile = join(env.dir.path, "derivative.jpg");
  writeFileSync(photoFile, await jpeg(1080, 1080));
});
afterEach(async () => {
  await fakes.close();
  await env.close();
});

const tokenSet = (over: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: "IG-LONG-0",
  accessExpiresAt: new Date(env.clock.t + 50 * DAY).toISOString(),
  refreshToken: null,
  refreshExpiresAt: null,
  scopes: [],
  obtainedAt: new Date(env.clock.t - 10 * DAY).toISOString(),
  ...over,
});

function job(over: Partial<PublishJob> = {}): PublishJob {
  return {
    postId: "post-1",
    attemptNo: 1,
    platform: "instagram",
    providerAccountId: fakes.state.ig.userId,
    credentialRef: "cred:test-1",
    caption: "Linen #atelier",
    altText: "A linen dress",
    pinTitle: "Linen",
    pinDescription: "Summer linen",
    pinLink: "https://atelierhalle.com/linen",
    pinBoardId: "1099652335",
    derivative: { file: photoFile, sha256: "x" },
    containerId: null,
    ...over,
  };
}

describe("token renewal", () => {
  it("renews Instagram tokens close to expiry, once, even under concurrent use", async () => {
    await svc.tokens.save("cred:test-1", tokenSet({ accessExpiresAt: new Date(env.clock.t + 5 * DAY).toISOString() }));
    const tokens = await Promise.all([1, 2, 3].map(() => svc.tokens.accessToken({ platform: "instagram", credentialRef: "cred:test-1" })));
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^IG-LONG-/);
    expect(tokens[0]).not.toBe("IG-LONG-0");
    expect(fakes.calls("ig-graph", "/refresh_access_token")).toHaveLength(1);
  });

  it("doesn't renew Instagram tokens younger than 24 hours (platform rule)", async () => {
    await svc.tokens.save("cred:test-1", tokenSet({ accessExpiresAt: new Date(env.clock.t + 5 * DAY).toISOString(), obtainedAt: new Date(env.clock.t - 3600_000).toISOString() }));
    expect(await svc.tokens.accessToken({ platform: "instagram", credentialRef: "cred:test-1" })).toBe("IG-LONG-0");
    expect(fakes.calls("ig-graph", "/refresh_access_token")).toHaveLength(0);
  });

  it("asks for reconnection when the saved sign-in is missing", async () => {
    await expect(svc.tokens.accessToken({ platform: "pinterest", credentialRef: "cred:missing" })).rejects.toMatchObject({ kind: "auth_expired", code: "missing_token" });
  });

  it("rotates Pinterest refresh tokens and flags an invalid refresh token for reconnection", async () => {
    await svc.tokens.save("cred:pin-1", tokenSet({ accessToken: "pina_OLD", accessExpiresAt: new Date(env.clock.t + 3600_000).toISOString(), refreshToken: "pinr_OLD" }));
    expect(await svc.tokens.accessToken({ platform: "pinterest", credentialRef: "cred:pin-1" })).toMatch(/^pina_TESTACCESS/);
    const saved = JSON.parse(store.dump().get("cred:pin-1")!);
    expect(saved.refreshToken).toMatch(/^pinr_TESTREFRESH/);

    fakes.state.pin.refreshValid = false;
    await svc.tokens.save("cred:pin-1", { ...saved, accessExpiresAt: new Date(env.clock.t - 1).toISOString() });
    await expect(svc.tokens.accessToken({ platform: "pinterest", credentialRef: "cred:pin-1" })).rejects.toMatchObject({ kind: "auth_expired" });
  });

  it("pauses (transient) rather than failing when the Keychain is unavailable", async () => {
    await svc.tokens.save("cred:test-1", tokenSet());
    store.failing = true;
    await expect(svc.tokens.accessToken({ platform: "instagram", credentialRef: "cred:test-1" })).rejects.toMatchObject({ kind: "transient", code: "keychain_unavailable" });
  });
});

describe("Pinterest adapter", () => {
  beforeEach(async () => {
    await svc.tokens.save("cred:test-1", tokenSet({ accessToken: "pina_GOOD", refreshToken: "pinr_X" }));
  });

  it("creates a sandbox Pin with direct image upload in trial mode", async () => {
    const r = await svc.pinterest.commit(job({ platform: "pinterest" }));
    expect(r).toEqual({ remotePostId: "813650000000", permalink: null }); // sandbox Pins aren't public
    const req = fakes.calls("pin-sandbox", "/v5/pins")[0]!;
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ board_id: "1099652335", title: "Linen", description: "Summer linen", link: "https://atelierhalle.com/linen", alt_text: "A linen dress" });
    expect(body.media_source).toMatchObject({ source_type: "image_base64", content_type: "image/jpeg" });
    expect(Buffer.from(body.media_source.data, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(fakes.calls("pin-api", "/v5/pins")).toHaveLength(0);
  });

  it("classifies failures: 401 as expired, 429 as rate limited, 5xx as transient (reconciled by the worker)", async () => {
    fakes.state.pin.createFails = { status: 401, json: { code: 2, message: "Authentication failed." } };
    await expect(svc.pinterest.commit(job())).rejects.toMatchObject({ kind: "auth_expired" });
    fakes.state.pin.createFails = { status: 429, json: { code: 8, message: "Too many requests" } };
    await expect(svc.pinterest.commit(job())).rejects.toMatchObject({ kind: "rate_limited" });
    fakes.state.pin.createFails = { status: 503, json: { code: 0, message: "Unavailable" } };
    await expect(svc.pinterest.commit(job())).rejects.toMatchObject({ kind: "transient" });
  });

  it("reconciles by finding the exact Pin on the board, and waits before concluding it wasn't created", async () => {
    const started = env.clock.now();
    await svc.pinterest.commit(job());
    expect(await svc.pinterest.reconcile(job(), started)).toMatchObject({ state: "published", remotePostId: "813650000000" });

    await expect(svc.pinterest.reconcile(job({ pinTitle: "Other" }), started)).rejects.toMatchObject({ kind: "transient" });
    env.clock.advance(6 * 60_000);
    expect(await svc.pinterest.reconcile(job({ pinTitle: "Other" }), started)).toEqual({ state: "not_published" });
  });
});

describe("Instagram adapter with R2 delivery", () => {
  beforeEach(async () => {
    await svc.tokens.save("cred:test-1", tokenSet());
  });

  it("stages through R2 with a short-lived presigned URL, deletes it once fetched, then publishes", async () => {
    const { containerId } = await svc.instagram.stage(job());
    expect(containerId).toBe("17889455560051444");
    expect(fakes.state.r2.badSignatures).toBe(0);
    expect(fakes.state.r2.objects.size).toBe(1);
    const [objectPath] = [...fakes.state.r2.objects.keys()];
    expect(objectPath).toMatch(new RegExp(`^/${R2.bucket}/staging/[0-9a-f-]{36}\\.jpg$`));

    const create = fakes.calls("ig-graph", `/v26.0/${fakes.state.ig.userId}/media`).find((c) => c.method === "POST")!;
    const form = new URLSearchParams(create.body);
    const imageUrl = new URL(form.get("image_url")!);
    expect(imageUrl.pathname).toBe(objectPath);
    expect(imageUrl.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(imageUrl.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(form.get("caption")).toBe("Linen #atelier");
    expect(form.get("alt_text")).toBe("A linen dress");

    expect(await svc.instagram.checkStaged(job({ containerId }))).toBe("ready");
    expect(fakes.state.r2.objects.size).toBe(0); // removed after Instagram fetched it

    const published = await svc.instagram.commit(job({ containerId }));
    expect(published).toEqual({ remotePostId: "17920238422030506", permalink: "https://www.instagram.com/p/ABC123/" });
    expect(fakes.calls("ig-graph", `/v26.0/${fakes.state.ig.userId}/content_publishing_limit`)).toHaveLength(1);
  });

  it("waits while Instagram is still processing", async () => {
    fakes.state.ig.containerStatus = "IN_PROGRESS";
    const { containerId } = await svc.instagram.stage(job());
    expect(await svc.instagram.checkStaged(job({ containerId }))).toBe("pending");
    expect(fakes.state.r2.objects.size).toBe(1);
  });

  it("checks the publishing quota before the irreversible call", async () => {
    fakes.state.ig.quotaUsage = 50;
    await expect(svc.instagram.commit(job({ containerId: "17889455560051444" }))).rejects.toMatchObject({ kind: "rate_limited", code: "publishing_quota" });
    expect(fakes.calls("ig-graph", `/v26.0/${fakes.state.ig.userId}/media_publish`)).toHaveLength(0);
  });

  it("reconciles a lost publish response using the container status", async () => {
    const started = env.clock.now();
    fakes.state.ig.containerStatus = "PUBLISHED";
    fakes.state.ig.publishedCaption = "Linen #atelier";
    expect(await svc.instagram.reconcile(job({ containerId: "17889455560051444" }), started)).toMatchObject({ state: "published", remotePostId: "17920238422030506" });
    fakes.state.ig.containerStatus = "FINISHED";
    await expect(svc.instagram.reconcile(job({ containerId: "17889455560051444" }), started)).rejects.toMatchObject({ kind: "transient" });
  });

  it("explains missing media delivery setup instead of failing silently", async () => {
    await svc.config.clear("r2");
    await expect(svc.instagram.stage(job())).rejects.toSatisfy((e: unknown) => e instanceof PlatformError && e.kind === "permanent" && /Cloudflare R2/.test(e.safeMessage));
  });
});

describe("end to end through the scheduler", () => {
  it("publishes a scheduled Pin via the real adapter, and a lost response doesn't duplicate it", async () => {
    await env.close();
    env = await createEnv({ adapters: "none" });
    const services = createPlatformServices({
      db: env.db,
      accounts: env.accounts,
      credentials: store,
      port: 4872,
      now: env.clock.now,
      endpoints: fakes.endpoints,
      allowInsecureLoopback: true,
    });
    await services.config.update({ pinterest: { clientId: "1234567890123", clientSecret: PIN_SECRET, tier: "trial" } });
    env.deps.adapters = services.registry(true);
    const a = connectedAccount(env, "pinterest", "Atelier Halle Pinterest");
    await services.tokens.save(a.credentialRef!, tokenSet({ accessToken: "pina_GOOD", refreshToken: "pinr_X" }));

    const post = await scheduledPost(env, a.id, 1, "Summer linen");
    env.db.prepare("UPDATE posts SET pin_board_id = '1099652335' WHERE id = ?").run(post.id);
    // The Pin is created but the response is lost (502).
    fakes.state.pin.loseNextResponse = true;
    env.clock.advance(60_000);
    await processNext(env.deps);
    const p = env.posts.get(post.id);
    expect(p).toMatchObject({ status: "published", publishedSimulated: false, remotePostId: "813650000000" });
    expect(fakes.calls("pin-sandbox", "/v5/pins").filter((c) => c.method === "POST")).toHaveLength(1);
    expect(JSON.stringify(env.db.prepare("SELECT * FROM publish_attempts").all())).not.toContain("pina_GOOD");
  });
});
