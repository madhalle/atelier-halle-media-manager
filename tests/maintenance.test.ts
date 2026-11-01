// Recovery controls over HTTP: service status, backing up and checking backups.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentLabel, runningAsAgent } from "../src/server/launch-agent.ts";
import { dataPaths } from "../src/storage/data-dir.ts";
import { createTestApp, sameOrigin, signIn, type TestApp } from "./helpers.ts";

let t: TestApp;
let auth: { cookie: string; csrf: string };
beforeEach(async () => {
  t = await createTestApp();
  auth = await signIn(t);
});
afterEach(async () => {
  await t.cleanup();
});

const call = (method: "GET" | "POST", url: string, withCsrf = true) =>
  t.app.inject({
    method,
    url,
    headers: sameOrigin(t.config.port, { cookie: auth.cookie, ...(withCsrf ? { "x-csrf-token": auth.csrf } : {}) }),
    ...(method === "POST" ? { payload: {} } : {}),
  });

describe("backups and service", () => {
  it("reports how the server runs, without exposing file paths", async () => {
    const res = await call("GET", "/api/maintenance");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: { mode: "terminal", env: "test" }, livePublishing: false, keychain: { ok: true }, backups: [] });
    expect(res.body).not.toContain(t.config.dataDir);
  });

  it("backs up on request, lists it, and checks it", async () => {
    const created = await call("POST", "/api/backups");
    expect(created.statusCode).toBe(201);
    const id = created.json().backup.id as string;
    expect(id).toMatch(/^\d{8}-\d{6}-\d{3}-manual$/);
    const list = (await call("GET", "/api/maintenance")).json().backups;
    expect(list).toEqual([expect.objectContaining({ id, reason: "manual", photoFiles: 0 })]);
    expect((await call("POST", `/api/backups/${id}/verify`)).json()).toEqual({ ok: true, photoFiles: 0 });
  });

  it("reports a damaged backup, and rejects names that aren't backups", async () => {
    const id = (await call("POST", "/api/backups")).json().backup.id as string;
    const db = join(dataPaths(t.config.dataDir).backups, id, "media-manager.db");
    chmodSync(db, 0o600);
    writeFileSync(db, "damaged");
    const res = await call("POST", `/api/backups/${id}/verify`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/changed after the backup/);
    for (const bad of ["..%2F..%2Fetc", "not-a-backup"]) expect((await call("POST", `/api/backups/${bad}/verify`)).statusCode).toBe(409);
  });

  it("needs a session and CSRF token to back up", async () => {
    expect((await call("POST", "/api/backups", false)).statusCode).toBe(403);
    const anon = await t.app.inject({ method: "GET", url: "/api/maintenance", headers: sameOrigin(t.config.port) });
    expect(anon.statusCode).toBe(401);
  });
});

describe("background detection", () => {
  it("recognises the LaunchAgent by launchd's service name", () => {
    expect(runningAsAgent("production", { XPC_SERVICE_NAME: agentLabel("production") })).toBe(true);
    expect(runningAsAgent("production", { XPC_SERVICE_NAME: "application.com.apple.Terminal.123" })).toBe(false);
    expect(runningAsAgent("production", { XPC_SERVICE_NAME: agentLabel("development") })).toBe(false);
    expect(runningAsAgent("production", {})).toBe(false);
  });
});
