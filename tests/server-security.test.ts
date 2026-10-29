import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations } from "../src/storage/migrate.ts";
import { LAUNCH_TOKEN_TTL_MS, SESSION_IDLE_TTL_MS } from "../src/server/sessions.ts";
import { createTestApp, sameOrigin, signIn, type TestApp } from "./helpers.ts";

let t: TestApp;
let port: number;
beforeEach(async () => {
  t = await createTestApp();
  port = t.config.port;
});
afterEach(async () => {
  await t.cleanup();
});

describe("Host allowlist", () => {
  it.each(["evil.example", "127.0.0.1", "127.0.0.1:1", "localhost.evil.example:4872", ""])(
    "rejects Host %j (DNS rebinding protection)",
    async (host) => {
      const res = await t.app.inject({ method: "GET", url: "/healthz", headers: { host } });
      expect(res.statusCode).toBe(421);
    },
  );

  it("accepts the exact loopback hosts", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const res = await t.app.inject({ method: "GET", url: "/healthz", headers: { host } });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("launch token exchange", () => {
  it("sets an HttpOnly SameSite=Strict cookie and redirects without the token", async () => {
    const token = t.sessions.mintLaunchToken();
    const res = await t.app.inject({ method: "GET", url: `/launch?token=${token}`, headers: { host: `127.0.0.1:${port}` } });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/");
    expect(res.headers["cache-control"]).toBe("no-store");
    const cookie = res.cookies.find((c) => c.name === "mm_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
    expect(cookie?.value).not.toContain(token);
  });

  it("is single-use", async () => {
    const token = t.sessions.mintLaunchToken();
    const headers = { host: `127.0.0.1:${port}` };
    expect((await t.app.inject({ method: "GET", url: `/launch?token=${token}`, headers })).statusCode).toBe(303);
    expect((await t.app.inject({ method: "GET", url: `/launch?token=${token}`, headers })).statusCode).toBe(401);
  });

  it("expires", async () => {
    const token = t.sessions.mintLaunchToken();
    t.clock.advance(LAUNCH_TOKEN_TTL_MS + 1);
    const res = await t.app.inject({ method: "GET", url: `/launch?token=${token}`, headers: { host: `127.0.0.1:${port}` } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects missing and forged tokens", async () => {
    const headers = { host: `127.0.0.1:${port}` };
    expect((await t.app.inject({ method: "GET", url: "/launch", headers })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "GET", url: "/launch?token=guess", headers })).statusCode).toBe(401);
  });

  it("never writes the launch token to logs", async () => {
    const token = t.sessions.mintLaunchToken();
    // Force info-level request logging for this check.
    t.app.log.level = "info";
    await t.app.inject({ method: "GET", url: `/launch?token=${token}`, headers: { host: `127.0.0.1:${port}` } });
    expect(t.logs.length).toBeGreaterThan(0);
    expect(t.logs.join("\n")).not.toContain(token);
  });
});

describe("API authentication and CSRF", () => {
  it("requires a session", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/status", headers: sameOrigin(port) });
    expect(res.statusCode).toBe(401);
  });

  it("serves authenticated reads", async () => {
    const { cookie } = await signIn(t);
    const res = await t.app.inject({ method: "GET", url: "/api/status", headers: sameOrigin(port, { cookie }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ environment: "test", livePublishing: "disabled", schemaVersion: loadMigrations().length });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("rejects unsafe requests without a valid CSRF token", async () => {
    const { cookie } = await signIn(t);
    const missing = await t.app.inject({ method: "POST", url: "/api/session/logout", headers: sameOrigin(port, { cookie }) });
    expect(missing.statusCode).toBe(403);
    const wrong = await t.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: sameOrigin(port, { cookie, "x-csrf-token": "nope" }),
    });
    expect(wrong.statusCode).toBe(403);
  });

  it("accepts unsafe requests with the session's CSRF token, and logout ends the session", async () => {
    const { cookie, csrf } = await signIn(t);
    const out = await t.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: sameOrigin(port, { cookie, "x-csrf-token": csrf }),
    });
    expect(out.statusCode).toBe(200);
    const after = await t.app.inject({ method: "GET", url: "/api/status", headers: sameOrigin(port, { cookie }) });
    expect(after.statusCode).toBe(401);
  });

  it("rejects cross-origin requests even with a valid session", async () => {
    const { cookie, csrf } = await signIn(t);
    const evil = await t.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { host: `127.0.0.1:${port}`, origin: "https://evil.example", cookie, "x-csrf-token": csrf },
    });
    expect(evil.statusCode).toBe(403);
    const crossSiteRead = await t.app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site", cookie },
    });
    expect(crossSiteRead.statusCode).toBe(403);
    const otherPort = await t.app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: `127.0.0.1:${port}`, origin: "http://127.0.0.1:9999", cookie },
    });
    expect(otherPort.statusCode).toBe(403);
  });

  it("rejects unsafe requests that carry no Origin", async () => {
    const { cookie, csrf } = await signIn(t);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: { host: `127.0.0.1:${port}`, cookie, "x-csrf-token": csrf },
    });
    expect(res.statusCode).toBe(403);
  });

  it("expires idle sessions", async () => {
    const { cookie } = await signIn(t);
    t.clock.advance(SESSION_IDLE_TTL_MS + 1);
    const res = await t.app.inject({ method: "GET", url: "/api/status", headers: sameOrigin(port, { cookie }) });
    expect(res.statusCode).toBe(401);
  });

  it("does not expose the CSRF token or session id in logs", async () => {
    t.app.log.level = "info";
    const { cookie, csrf } = await signIn(t);
    const joined = t.logs.join("\n");
    expect(joined).not.toContain(cookie.split("=")[1]);
    expect(joined).not.toContain(csrf);
  });
});

describe("security headers and limits", () => {
  it("sends a strict CSP and related headers on every response", async () => {
    const res = await t.app.inject({ method: "GET", url: "/healthz", headers: { host: `127.0.0.1:${port}` } });
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects oversized JSON bodies", async () => {
    const { cookie, csrf } = await signIn(t);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: sameOrigin(port, { cookie, "x-csrf-token": csrf, "content-type": "application/json" }),
      payload: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 1) }),
    });
    expect(res.statusCode).toBe(413);
  });
});
