// Instagram through a Meta business portfolio (system-user token): setup,
// connecting, and publishing via graph.facebook.com. Loopback fakes only.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlatformServices } from "../src/platforms/services.ts";
import { createAccountsRepo } from "../src/storage/accounts-repo.ts";
import { createMemoryStore } from "../src/storage/credentials.ts";
import { BUSINESS_TOKEN, R2, startFakeProviders, type FakeProviders } from "./fake-providers.ts";
import { createTestApp, sameOrigin, signIn, type TestApp } from "./helpers.ts";
import { jpeg } from "./images.ts";

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

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: sameOrigin(t.config.port, { cookie: auth.cookie, "x-csrf-token": auth.csrf }),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const saveToken = (businessToken = BUSINESS_TOKEN) => call("PATCH", "/api/platforms", { instagram: { businessToken } });
const newAccount = async () => (await call("POST", "/api/accounts", { platform: "instagram", displayName: "Studio" })).json().account as { id: string };

function everythingVisible(extra: string[] = []): string {
  const tables = ["accounts", "posts", "app_settings", "publish_attempts", "media_assets"];
  const db = tables.map((tb) => JSON.stringify(t.db.prepare(`SELECT * FROM ${tb}`).all())).join("\n");
  return [db, t.logs.join("\n"), ...extra].join("\n");
}

describe("business portfolio token setup", () => {
  it("stores the token only in the credential store and reports Instagram as set up", async () => {
    const res = await saveToken();
    expect(res.statusCode).toBe(200);
    expect(res.json().config.instagram).toMatchObject({ businessTokenSaved: true, clientId: null, secretSaved: false });
    expect([...store.dump().values()]).toContain(BUSINESS_TOKEN);
    const view = await call("GET", "/api/platforms");
    expect(everythingVisible([res.body, view.body])).not.toContain(BUSINESS_TOKEN);
  });

  it("rejects things that aren't Meta tokens, without echoing them", async () => {
    const res = await saveToken("not-a-token-but-a-password-1234567890");
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/starts with EA/);
    expect(res.body).not.toContain("password-1234567890");
  });

  it("removing the Instagram setup deletes the token", async () => {
    await saveToken();
    const res = await call("DELETE", "/api/platforms/instagram");
    expect(res.json().config.instagram.businessTokenSaved).toBe(false);
    expect([...store.dump().values()]).not.toContain(BUSINESS_TOKEN);
  });
});

describe("connecting with a business portfolio token", () => {
  it("lists reachable Instagram accounts, then connects the chosen one without exposing the token", async () => {
    await saveToken();
    const a = await newAccount();
    const list = await call("GET", `/api/accounts/${a.id}/business-instagram-accounts`);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      accounts: [
        { id: "17841400000000001", username: "atelierhalle", name: "Atelier Halle" },
        { id: "17841400000000002", username: "studio_second", name: null },
      ],
      missing: [],
    });

    const res = await call("POST", `/api/accounts/${a.id}/connect-business`, { instagramUserId: "17841400000000002" });
    expect(res.statusCode).toBe(200);
    expect(res.json().account).toMatchObject({ connection: { state: "connected", identity: { username: "studio_second" } }, schedulesNeedReview: true });

    const ref = (t.db.prepare("SELECT credential_ref AS r FROM accounts WHERE id = ?").get(a.id) as { r: string }).r;
    const stored = JSON.parse(store.dump().get(ref)!);
    // The account stores a reference; the one token stays in Platform setup.
    expect(stored).toMatchObject({ accessToken: "business-portfolio-token", graph: "facebook", accessExpiresAt: "9999-12-31T00:00:00.000Z", refreshToken: null });
    expect([...store.dump().values()].filter((v) => v.includes(BUSINESS_TOKEN))).toHaveLength(1);
    expect(everythingVisible([list.body, res.body])).not.toContain(BUSINESS_TOKEN);
    // Only graph.facebook.com was used; the Instagram Login hosts were never contacted.
    expect(fakes.calls("ig-api")).toHaveLength(0);
    expect(fakes.calls("ig-graph")).toHaveLength(0);
  });

  it("refuses an Instagram account the token can't reach", async () => {
    await saveToken();
    const a = await newAccount();
    const res = await call("POST", `/api/accounts/${a.id}/connect-business`, { instagramUserId: "99999" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/can't reach that Instagram account/);
  });

  it("refuses a token without publishing permission, naming what's missing", async () => {
    fakes.state.fb.permissions = ["instagram_basic", "business_management"];
    await saveToken();
    const a = await newAccount();
    expect((await call("GET", `/api/accounts/${a.id}/business-instagram-accounts`)).json().missing).toEqual(["instagram_content_publish"]);
    const res = await call("POST", `/api/accounts/${a.id}/connect-business`, { instagramUserId: "17841400000000001" });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/missing instagram_content_publish/);
    expect(t.db.prepare("SELECT credential_ref AS r FROM accounts WHERE id = ?").get(a.id)).toEqual({ r: null });
  });

  it("still connects when Meta won't list permissions (publishing reports problems later)", async () => {
    fakes.state.fb.permissionsStatus = 400;
    await saveToken();
    const a = await newAccount();
    const res = await call("POST", `/api/accounts/${a.id}/connect-business`, { instagramUserId: "17841400000000001" });
    expect(res.statusCode).toBe(200);
  });

  it("explains a rejected token, and an empty portfolio", async () => {
    await saveToken("EAAEXAMPLEunknownToken0123456789abcdefghijkl");
    const a = await newAccount();
    const bad = await call("GET", `/api/accounts/${a.id}/business-instagram-accounts`);
    expect(bad.statusCode).toBe(409);
    expect(bad.json().message).toMatch(/Meta rejected the business portfolio token/);

    await saveToken();
    fakes.state.fb.assigned = [];
    expect((await call("GET", `/api/accounts/${a.id}/business-instagram-accounts`)).json().accounts).toEqual([]);
  });

  it("needs the token set up first, and only applies to Instagram accounts", async () => {
    const a = await newAccount();
    expect((await call("GET", `/api/accounts/${a.id}/business-instagram-accounts`)).json().message).toMatch(/Platform setup/);
    const pin = (await call("POST", "/api/accounts", { platform: "pinterest", displayName: "Pins" })).json().account as { id: string };
    await saveToken();
    expect((await call("GET", `/api/accounts/${pin.id}/business-instagram-accounts`)).statusCode).toBe(400);
  });
});

describe("publishing with a business portfolio token", () => {
  it("uses graph.facebook.com for every step and never tries to renew the token", async () => {
    const svc = createPlatformServices({
      db: t.db,
      accounts: createAccountsRepo(t.db),
      credentials: store,
      port: 4872,
      now: () => new Date(),
      endpoints: fakes.endpoints,
      allowInsecureLoopback: true,
    });
    await svc.config.update({
      instagram: { businessToken: BUSINESS_TOKEN },
      r2: { accountId: R2.accountId, bucket: R2.bucket, accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey },
    });
    expect(svc.config.isConfigured("instagram")).toBe(true);
    const a = await newAccount();
    const connected = await svc.connections.connectBusiness(a.id, fakes.state.ig.userId);

    const file = join(t.config.dataDir, "derivative.jpg");
    writeFileSync(file, await jpeg(1080, 1080));
    const job = {
      postId: "post-1",
      attemptNo: 1,
      platform: "instagram" as const,
      providerAccountId: fakes.state.ig.userId,
      credentialRef: connected.credentialRef!,
      caption: "Gold ring",
      altText: "A gold ring",
      pinTitle: "",
      pinDescription: "",
      pinLink: "",
      pinBoardId: null,
      media: [{ file, sha256: "x" }],
      containerId: null,
    };
    const { containerId } = await svc.instagram.stage(job);
    expect(await svc.instagram.checkStaged({ ...job, containerId })).toBe("ready");
    expect(await svc.instagram.commit({ ...job, containerId })).toMatchObject({ remotePostId: "17920238422030506" });

    const create = fakes.calls("fb-graph", `/v26.0/${fakes.state.ig.userId}/media`).find((c) => c.method === "POST")!;
    expect(new URLSearchParams(create.body).get("access_token")).toBe(BUSINESS_TOKEN);
    expect(fakes.calls("fb-graph", `/v26.0/${fakes.state.ig.userId}/media_publish`)).toHaveLength(1);
    expect(fakes.calls("ig-graph")).toHaveLength(0);
    expect(await svc.tokens.renewDue([connected])).toEqual([]);
    expect(fakes.calls("ig-graph", "/refresh_access_token")).toHaveLength(0);

    // Removing the token in Platform setup stops publishing for every account at once.
    await svc.config.clear("instagram");
    await expect(svc.instagram.commit({ ...job, containerId })).rejects.toMatchObject({ kind: "auth_expired", code: "business_token_removed" });
    expect(await svc.tokens.renewDue([connected])).toEqual([connected.id]);
  });
});
