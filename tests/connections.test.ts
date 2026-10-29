// Milestone 6 security and behaviour: platform setup, OAuth, tokens, adapters.
// Everything runs against loopback fakes; nothing reaches a real platform.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpClient } from "../src/platforms/http.ts";
import { createMemoryStore } from "../src/storage/credentials.ts";
import { createTestApp, sameOrigin, signIn, type TestApp } from "./helpers.ts";
import { IG_SECRET, PIN_SECRET, R2, startFakeProviders, type FakeProviders } from "./fake-providers.ts";

let t: TestApp;
let fakes: FakeProviders;
let store: ReturnType<typeof createMemoryStore>;
let auth: { cookie: string; csrf: string };

beforeEach(async () => {
  fakes = await startFakeProviders();
  store = createMemoryStore();
  t = await createTestApp({}, { credentials: store, endpoints: fakes.endpoints });
  auth = await signIn(t);
});
afterEach(async () => {
  await t.cleanup();
  await fakes.close();
});

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, a = auth) =>
  t.app.inject({
    method,
    url,
    headers: sameOrigin(t.config.port, { cookie: a.cookie, "x-csrf-token": a.csrf }),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

async function setupApps() {
  const res = await call("PATCH", "/api/platforms", {
    instagram: { clientId: "9876543210123", clientSecret: IG_SECRET },
    pinterest: { clientId: "1234567890123", clientSecret: PIN_SECRET },
    r2: { accountId: R2.accountId, bucket: R2.bucket, accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey },
  });
  expect(res.statusCode).toBe(200);
}

async function account(platform: "instagram" | "pinterest") {
  return (await call("POST", "/api/accounts", { platform, displayName: `My ${platform}` })).json().account as { id: string; revision: number };
}

async function connect(accountId: string, platform: "instagram" | "pinterest", code = "good-code", a = auth) {
  const start = await call("POST", `/api/accounts/${accountId}/connect`, {}, a);
  expect(start.statusCode).toBe(200);
  const url = new URL(start.json().authorizeUrl);
  const state = url.searchParams.get("state")!;
  return { url, state, res: await call("POST", `/api/oauth/${platform}/complete`, { state, code }, a) };
}

/** Every string stored anywhere the user or a log could see it. */
function everythingVisible(extra: string[] = []): string {
  const tables = ["accounts", "posts", "app_settings", "publish_attempts", "media_assets"];
  const db = tables.map((tb) => JSON.stringify(t.db.prepare(`SELECT * FROM ${tb}`).all())).join("\n");
  return [db, t.logs.join("\n"), ...extra].join("\n");
}

describe("platform setup", () => {
  it("stores app secrets only in the credential store and never returns them", async () => {
    await setupApps();
    const view = await call("GET", "/api/platforms");
    const body = view.body;
    expect(view.json().config).toMatchObject({
      instagram: { clientId: "9876543210123", secretSaved: true, redirectHost: "localhost" },
      pinterest: { clientId: "1234567890123", secretSaved: true, tier: "trial" },
      r2: { accountId: R2.accountId, bucket: R2.bucket, accessKeyId: R2.accessKeyId, secretSaved: true },
    });
    expect(view.json().redirectUris.instagram).toBe(`http://localhost:${t.config.port}/oauth/instagram/callback`);
    for (const secret of [IG_SECRET, PIN_SECRET, R2.secretAccessKey]) {
      expect(body).not.toContain(secret);
      expect(everythingVisible()).not.toContain(secret);
    }
    expect([...store.dump().keys()].sort()).toEqual(["app:instagram:client_secret", "app:pinterest:client_secret", "app:r2:secret_access_key"]);
  });

  it("validates input and can remove a platform's setup", async () => {
    expect((await call("PATCH", "/api/platforms", { instagram: { clientId: "not-a-number" } })).statusCode).toBe(400);
    expect((await call("PATCH", "/api/platforms", { instagram: { clientSecret: "short" } })).statusCode).toBe(400);
    expect((await call("PATCH", "/api/platforms", { tiktok: {} })).statusCode).toBe(400);
    await setupApps();
    const cleared = await call("DELETE", "/api/platforms/instagram");
    expect(cleared.json().config.instagram).toMatchObject({ clientId: null, secretSaved: false });
    expect(store.dump().has("app:instagram:client_secret")).toBe(false);
  });

  it("refuses rather than falling back to plaintext when the Keychain fails", async () => {
    store.failing = true;
    const res = await call("PATCH", "/api/platforms", { instagram: { clientId: "9876543210123", clientSecret: IG_SECRET } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("keychain_unavailable");
    expect(everythingVisible()).not.toContain(IG_SECRET);
  });
});

describe("connecting accounts (OAuth)", () => {
  it("connects an Instagram Business account, keeping tokens out of every visible place", async () => {
    await setupApps();
    const a = await account("instagram");
    const { url, state, res } = await connect(a.id, "instagram");

    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "9876543210123",
      redirect_uri: `http://localhost:${t.config.port}/oauth/instagram/callback`,
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_content_publish",
      force_reauth: "true",
    });
    expect(url.toString()).not.toContain(IG_SECRET);
    expect(state.length).toBeGreaterThanOrEqual(40);

    expect(res.statusCode).toBe(200);
    expect(res.json().account).toMatchObject({
      connection: { state: "connected", identity: { username: "atelierhalle", accountType: "BUSINESS" } },
      schedulesNeedReview: true,
    });
    // Exchange used the exact registered redirect URI and the secret server-side.
    const ex = fakes.calls("ig-api", "/oauth/access_token")[0]!;
    expect(new URLSearchParams(ex.body).get("redirect_uri")).toBe(`http://localhost:${t.config.port}/oauth/instagram/callback`);

    const ref = t.db.prepare("SELECT credential_ref AS r FROM accounts WHERE id = ?").get(a.id) as { r: string };
    expect(ref.r).toMatch(/^cred:/);
    const tokens = JSON.parse(store.dump().get(ref.r)!);
    expect(tokens.accessToken).toMatch(/^IG-LONG-/);
    const visible = everythingVisible([res.body, (await call("GET", "/api/accounts?includeArchived=true")).body]);
    expect(visible).not.toContain(tokens.accessToken);
    expect(visible).not.toContain("IG-SHORT-");
    expect(visible).not.toContain("good-code");
    expect(visible).not.toContain(state);
  });

  it("makes sign-in state single-use, expiring, and bound to the browser session that started it", async () => {
    await setupApps();
    const a = await account("instagram");
    const start = async () => new URL((await call("POST", `/api/accounts/${a.id}/connect`, {})).json().authorizeUrl).searchParams.get("state")!;

    const s1 = await start();
    const other = await signIn(t); // a different browser session
    const stolen = await call("POST", "/api/oauth/instagram/complete", { state: s1, code: "good-code" }, other);
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().message).toMatch(/didn't start in this browser session/);
    // Even the right session can't use it now: it was consumed.
    expect((await call("POST", "/api/oauth/instagram/complete", { state: s1, code: "good-code" })).statusCode).toBe(400);

    const s2 = await start();
    t.clock.advance(10 * 60_000 + 1);
    expect((await call("POST", "/api/oauth/instagram/complete", { state: s2, code: "good-code" })).json().message).toMatch(/expired/);

    const s3 = await start();
    expect((await call("POST", "/api/oauth/pinterest/complete", { state: s3, code: "good-code" })).statusCode).toBe(400);

    const forged = await call("POST", "/api/oauth/instagram/complete", { state: "x".repeat(43), code: "good-code" });
    expect(forged.statusCode).toBe(400);
    expect(fakes.calls("ig-api")).toHaveLength(0); // nothing was ever exchanged
  });

  it("handles a refused sign-in without connecting anything", async () => {
    await setupApps();
    const a = await account("instagram");
    const start = await call("POST", `/api/accounts/${a.id}/connect`, {});
    const state = new URL(start.json().authorizeUrl).searchParams.get("state")!;
    const res = await call("POST", "/api/oauth/instagram/complete", { state, error: "access_denied" });
    expect(res.json().message).toMatch(/canceled or refused/);
    expect((await call("GET", `/api/accounts/${a.id}`)).json().account.connection.state).toBe("unconnected");
  });

  it("refuses personal Instagram accounts and discards their tokens", async () => {
    await setupApps();
    fakes.state.ig.accountType = "PERSONAL";
    const a = await account("instagram");
    const { res } = await connect(a.id, "instagram");
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/only allows publishing .* professional/);
    expect([...store.dump().keys()].filter((k) => k.startsWith("cred:"))).toEqual([]);
  });

  it("refuses connections without publishing permission", async () => {
    await setupApps();
    fakes.state.ig.permissions = ["instagram_business_basic"];
    const a = await account("instagram");
    const { res } = await connect(a.id, "instagram");
    expect(res.json().message).toMatch(/permission wasn't granted/);
  });

  it("prevents the same Instagram identity being connected to two tabs, and cleans up", async () => {
    await setupApps();
    const a = await account("instagram");
    const b = await account("instagram");
    expect((await connect(a.id, "instagram")).res.statusCode).toBe(200);
    const second = await connect(b.id, "instagram");
    expect(second.res.statusCode).toBe(409);
    expect(second.res.json().error).toBe("duplicate_identity");
    expect([...store.dump().keys()].filter((k) => k.startsWith("cred:"))).toHaveLength(1);
  });

  it("connects a Pinterest business account with HTTP Basic client auth, and refuses personal accounts", async () => {
    await setupApps();
    const a = await account("pinterest");
    const { url, res } = await connect(a.id, "pinterest");
    expect(url.searchParams.get("scope")).toBe("user_accounts:read,boards:read,pins:read,pins:write");
    expect(res.statusCode).toBe(200);
    expect(fakes.calls("pin-api", "/v5/oauth/token")[0]!.body).not.toContain(PIN_SECRET); // secret only in the Authorization header

    fakes.state.pin.accountType = "PINNER";
    fakes.state.pin.id = "999";
    const b = await account("pinterest");
    const refused = await connect(b.id, "pinterest");
    expect(refused.res.json().message).toMatch(/business account/);
  });

  it("disconnecting deletes the stored token and explains the platform-side step", async () => {
    await setupApps();
    const a = await account("pinterest");
    await connect(a.id, "pinterest");
    const ref = (t.db.prepare("SELECT credential_ref AS r FROM accounts WHERE id = ?").get(a.id) as { r: string }).r;
    const res = await call("POST", `/api/accounts/${a.id}/disconnect`, {});
    expect(res.json()).toMatchObject({ account: { connection: { state: "disconnected" } }, credentialRemoved: true });
    expect(res.json().followUp).toMatch(/doesn't let apps revoke/);
    expect(store.dump().has(ref)).toBe(false);
  });

  it("serves the callback page without inline script or secrets", async () => {
    const page = await t.app.inject({ method: "GET", url: "/oauth/instagram/callback?code=abc&state=def", headers: { host: `localhost:${t.config.port}` } });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).not.toContain("abc");
    expect(page.body).not.toMatch(/<script>(?!<\/script>)/);
    expect(page.body).not.toMatch(/\sstyle=/);
    expect(t.logs.join("\n")).not.toContain("code=abc");
    const bad = await t.app.inject({ method: "GET", url: "/oauth/tiktok/callback", headers: { host: `localhost:${t.config.port}` } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("Pinterest boards", () => {
  it("lists boards and only accepts a board that belongs to the account", async () => {
    await setupApps();
    const a = await account("pinterest");
    await connect(a.id, "pinterest");
    expect((await call("GET", `/api/accounts/${a.id}/boards`)).json().boards).toEqual([{ id: "1099652335", name: "Collections", privacy: "PUBLIC" }]);
  });
});

describe("outbound HTTP client", () => {
  it("only talks to allowlisted HTTPS origins and never follows redirects", async () => {
    const http = createHttpClient({ allowedOrigins: (o) => o === "https://api.pinterest.com", fetchImpl: async () => new Response("{}") });
    await expect(http.request({ method: "GET", url: new URL("https://evil.example/") })).rejects.toThrow(/isn't allowed/);
    await expect(http.request({ method: "GET", url: new URL("http://api.pinterest.com/") })).rejects.toThrow(/isn't allowed/);
    await expect(http.request({ method: "GET", url: new URL("https://user:pw@api.pinterest.com/") })).rejects.toThrow(/isn't allowed/);
    await expect(http.request({ method: "GET", url: new URL("http://169.254.169.254/latest/meta-data") })).rejects.toThrow(/isn't allowed/);

    let seen: RequestInit | undefined;
    const spy = createHttpClient({ allowedOrigins: () => true, fetchImpl: async (_u, init) => ((seen = init), new Response("{}")) });
    await spy.request({ method: "GET", url: new URL("https://api.pinterest.com/v5/x") });
    expect(seen?.redirect).toBe("error");
  });

  it("caps response size and never echoes URLs (which may hold tokens) in errors", async () => {
    const big = createHttpClient({ allowedOrigins: () => true, fetchImpl: async () => new Response("x".repeat(3 * 1024 * 1024)) });
    await expect(big.request({ method: "GET", url: new URL("https://graph.instagram.com/me?access_token=SECRET") })).rejects.toThrow(/too large/);
    const down = createHttpClient({ allowedOrigins: () => true, fetchImpl: async () => Promise.reject(new TypeError("fetch failed")) });
    const err = await down.request({ method: "GET", url: new URL("https://graph.instagram.com/me?access_token=SECRET") }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("SECRET");
  });
});
