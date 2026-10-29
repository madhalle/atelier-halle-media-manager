import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canPublish, normalizeDisplayName, type VerifiedIdentity } from "../src/domain/accounts.ts";
import { createAccountsRepo, type AccountsRepo } from "../src/storage/accounts-repo.ts";
import { openDatabase, type Db } from "../src/storage/db.ts";
import { migrate } from "../src/storage/migrate.ts";
import { createTestApp, sameOrigin, signIn, tempDir, type TestApp } from "./helpers.ts";

const identity = (id: string, username = `user_${id}`): VerifiedIdentity => ({
  providerAccountId: id,
  username,
  displayName: null,
  avatarUrl: null,
  accountType: "BUSINESS",
  verifiedAt: "2026-10-29T12:00:00.000Z",
});

describe("display names", () => {
  it("normalizes whitespace and rejects empty, long, or control-character names", () => {
    expect(normalizeDisplayName("  Atelier   Halle\tPinterest ")).toBe("Atelier Halle Pinterest");
    expect(() => normalizeDisplayName("   ")).toThrow(/Enter a display name/);
    expect(() => normalizeDisplayName("x".repeat(61))).toThrow(/at most 60/);
    expect(() => normalizeDisplayName("Evil\u202Egnp.exe")).toThrow(/unsupported/);
    expect(normalizeDisplayName("é".repeat(60))).toHaveLength(60);
  });
});

describe("accounts repository", () => {
  let dir: ReturnType<typeof tempDir>;
  let db: Db;
  let repo: AccountsRepo;
  beforeEach(() => {
    dir = tempDir();
    db = openDatabase(join(dir.path, "a.db"));
    migrate(db);
    repo = createAccountsRepo(db);
  });
  afterEach(() => {
    db.close();
    dir.cleanup();
  });

  it("starts empty on a fresh install", () => {
    expect(repo.list({ includeArchived: true })).toEqual([]);
  });

  it("creates any number of unconnected accounts on either platform, in order", () => {
    const names = ["Personal Instagram", "Business Instagram", "Atelier Halle Pinterest", "Personal Pinterest", "Third IG"];
    const platforms = ["instagram", "instagram", "pinterest", "pinterest", "instagram"] as const;
    names.forEach((displayName, i) => repo.create({ platform: platforms[i]!, displayName }));
    const list = repo.list();
    expect(list.map((a) => a.displayName)).toEqual(names);
    expect(new Set(list.map((a) => a.id)).size).toBe(5);
    for (const a of list) {
      expect(a.connectionState).toBe("unconnected");
      expect(a.identity).toBeNull();
      expect(canPublish(a)).toBe(false);
    }
  });

  it("persists accounts and order across reopening the database", () => {
    const a = repo.create({ platform: "instagram", displayName: "A" });
    const b = repo.create({ platform: "pinterest", displayName: "B" });
    repo.reorder([b.id, a.id]);
    db.close();
    db = openDatabase(join(dir.path, "a.db"));
    repo = createAccountsRepo(db);
    expect(repo.list().map((x) => x.displayName)).toEqual(["B", "A"]);
  });

  it("rejects reorders that do not match the current active accounts", () => {
    const a = repo.create({ platform: "instagram", displayName: "A" });
    const b = repo.create({ platform: "instagram", displayName: "B" });
    expect(() => repo.reorder([a.id])).toThrow();
    expect(() => repo.reorder([a.id, a.id])).toThrow();
    expect(() => repo.reorder([a.id, b.id, crypto.randomUUID()])).toThrow();
  });

  it("renames with revision checks", () => {
    const a = repo.create({ platform: "instagram", displayName: "A" });
    const renamed = repo.rename(a.id, "Business Instagram", a.revision);
    expect(renamed.displayName).toBe("Business Instagram");
    expect(renamed.revision).toBe(a.revision + 1);
    expect(() => repo.rename(a.id, "Stale", a.revision)).toThrow(/changed in another window/);
  });

  it("archives and restores without deleting, and requires schedule review after restore", () => {
    const a = repo.create({ platform: "instagram", displayName: "A" });
    const b = repo.create({ platform: "instagram", displayName: "B" });
    const archived = repo.archive(a.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(repo.list().map((x) => x.id)).toEqual([b.id]);
    expect(repo.list({ includeArchived: true }).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(() => repo.archive(a.id)).toThrow(/already archived/);

    const restored = repo.restore(a.id);
    expect(restored.archivedAt).toBeNull();
    expect(restored.schedulesNeedReview).toBe(true);
    expect(repo.list().map((x) => x.id)).toEqual([b.id, a.id]); // restored to the end
    expect(repo.acknowledgeScheduleReview(a.id).schedulesNeedReview).toBe(false);
  });

  it("enforces one active tab per platform identity, keyed by provider ID not display name", () => {
    const a = repo.create({ platform: "instagram", displayName: "Same Name" });
    const b = repo.create({ platform: "instagram", displayName: "Same Name" });
    const p = repo.create({ platform: "pinterest", displayName: "Pins" });
    repo.markConnected(a.id, identity("111"), "kc:a");
    expect(() => repo.markConnected(b.id, identity("111", "renamed_handle"), "kc:b")).toThrow(/already connected to “Same Name”/);
    // Different provider ID with the same handle is a different identity.
    expect(repo.markConnected(b.id, identity("222", "user_111"), "kc:b").connectionState).toBe("connected");
    // Same numeric ID on another platform is a different identity.
    expect(repo.markConnected(p.id, identity("111"), "kc:p").connectionState).toBe("connected");
  });

  it("enforces identity uniqueness in the database even if the domain check is bypassed", () => {
    const a = repo.create({ platform: "instagram", displayName: "A" });
    const b = repo.create({ platform: "instagram", displayName: "B" });
    repo.markConnected(a.id, identity("111"), "kc:a");
    expect(() =>
      db
        .prepare("UPDATE accounts SET connection_state = 'connected', provider_account_id = '111', credential_ref = 'x' WHERE id = ?")
        .run(b.id),
    ).toThrow(/UNIQUE/);
  });

  it("disconnecting removes the credential reference, keeps the identity, and pauses schedules", () => {
    const a = repo.create({ platform: "pinterest", displayName: "A" });
    repo.acknowledgeScheduleReview(repo.markConnected(a.id, identity("9"), "kc:a").id);
    const d = repo.markDisconnected(a.id);
    expect(d).toMatchObject({ connectionState: "disconnected", credentialRef: null, schedulesNeedReview: true });
    expect(d.identity?.providerAccountId).toBe("9");
    expect(canPublish(d)).toBe(false);
  });

  it("reconnecting requires review and refuses to swap to a different real account", () => {
    const a = repo.create({ platform: "instagram", displayName: "A" });
    repo.markConnected(a.id, identity("1"), "kc:a");
    repo.acknowledgeScheduleReview(a.id);
    repo.markDisconnected(a.id);
    expect(() => repo.markConnected(a.id, identity("2"), "kc:a2")).toThrow(/different account/);
    const again = repo.markConnected(a.id, identity("1"), "kc:a3");
    expect(again.schedulesNeedReview).toBe(true);
    expect(canPublish(again)).toBe(false);
    expect(canPublish(repo.acknowledgeScheduleReview(a.id))).toBe(true);
  });

  it("restores as disconnected if its identity was connected elsewhere meanwhile", () => {
    const a = repo.create({ platform: "instagram", displayName: "A" });
    const b = repo.create({ platform: "instagram", displayName: "B" });
    repo.markConnected(a.id, identity("1"), "kc:a");
    repo.archive(a.id);
    repo.markConnected(b.id, identity("1"), "kc:b");
    const restored = repo.restore(a.id);
    expect(restored).toMatchObject({ connectionState: "disconnected", credentialRef: null, schedulesNeedReview: true });
  });

  it("archived accounts cannot connect or be marked reviewed", () => {
    const a = repo.create({ platform: "instagram", displayName: "A" });
    repo.archive(a.id);
    expect(() => repo.markConnected(a.id, identity("1"), "kc")).toThrow(/Restore/);
    expect(() => repo.acknowledgeScheduleReview(a.id)).toThrow(/Restore/);
  });
});

describe("accounts API", () => {
  let t: TestApp;
  let auth: { cookie: string; csrf: string };
  beforeEach(async () => {
    t = await createTestApp();
    auth = await signIn(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: sameOrigin(t.config.port, { cookie: auth.cookie, "x-csrf-token": auth.csrf }),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  it("creates, lists, renames, reorders, archives and restores", async () => {
    expect((await call("GET", "/api/accounts")).json()).toEqual({ accounts: [] });

    const ig = (await call("POST", "/api/accounts", { platform: "instagram", displayName: "Business Instagram" })).json().account;
    const pin = (await call("POST", "/api/accounts", { platform: "pinterest", displayName: "Atelier Halle Pinterest" })).json().account;
    expect(ig).toMatchObject({ platform: "instagram", archived: false, connection: { state: "unconnected", identity: null } });
    expect(ig.publishing).toEqual({ ready: false, blockers: ["Not connected to a platform account yet."] });
    expect(ig).not.toHaveProperty("credentialRef");

    const renamed = await call("PATCH", `/api/accounts/${ig.id}`, { displayName: "Personal Instagram", revision: ig.revision });
    expect(renamed.json().account.displayName).toBe("Personal Instagram");
    const stale = await call("PATCH", `/api/accounts/${ig.id}`, { displayName: "Nope", revision: ig.revision });
    expect(stale.statusCode).toBe(409);

    const reordered = await call("POST", "/api/accounts/reorder", { ids: [pin.id, ig.id] });
    expect(reordered.json().accounts.map((a: { id: string }) => a.id)).toEqual([pin.id, ig.id]);

    const archived = await call("POST", `/api/accounts/${pin.id}/archive`, { revision: reordered.json().accounts[0].revision });
    expect(archived.json().account.archived).toBe(true);
    expect((await call("GET", "/api/accounts")).json().accounts).toHaveLength(1);
    expect((await call("GET", "/api/accounts?includeArchived=true")).json().accounts).toHaveLength(2);

    const restored = await call("POST", `/api/accounts/${pin.id}/restore`, { revision: archived.json().account.revision });
    expect(restored.json().account).toMatchObject({ archived: false, schedulesNeedReview: true });
  });

  it("validates input", async () => {
    expect((await call("POST", "/api/accounts", { platform: "tiktok", displayName: "x" })).statusCode).toBe(400);
    expect((await call("POST", "/api/accounts", { platform: "instagram", displayName: "  " })).json()).toMatchObject({
      error: "validation",
      message: "Enter a display name.",
    });
    expect((await call("POST", "/api/accounts", { platform: "instagram", displayName: "x", extra: 1 })).statusCode).toBe(400);
    expect((await call("GET", "/api/accounts/not-a-uuid")).statusCode).toBe(400);
    expect((await call("GET", `/api/accounts/${crypto.randomUUID()}`)).statusCode).toBe(404);
  });

  it("has no route that can mark an account connected without a platform check", async () => {
    const ig = (await call("POST", "/api/accounts", { platform: "instagram", displayName: "IG" })).json().account;
    for (const url of [`/api/accounts/${ig.id}/connect`, `/api/accounts/${ig.id}/connected`]) {
      expect((await call("POST", url, { providerAccountId: "1" })).statusCode).toBe(404);
    }
    const patched = await call("PATCH", `/api/accounts/${ig.id}`, {
      displayName: "IG",
      revision: ig.revision,
      connectionState: "connected",
    });
    expect(patched.statusCode).toBe(400);
  });

  it("returns caption-safe JSON for names containing markup", async () => {
    const res = await call("POST", "/api/accounts", { platform: "pinterest", displayName: "<img src=x onerror=alert(1)>" });
    expect(res.statusCode).toBe(201);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});
