import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, sameOrigin, signIn, type TestApp } from "./helpers.ts";
import { jpeg, multipart } from "./images.ts";

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

async function draft(platform: "instagram" | "pinterest", fields: Record<string, string> = { caption: "Hello" }) {
  const account = (await call("POST", "/api/accounts", { platform, displayName: platform })).json().account;
  const { payload, contentType } = await multipart([{ name: "p.jpg", data: await jpeg(1080, 1080, { color: `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}` }) }]);
  const media = (
    await t.app.inject({
      method: "POST",
      url: "/api/media",
      headers: sameOrigin(t.config.port, { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": contentType }),
      payload,
    })
  ).json().results[0].media;
  let post = (await call("POST", `/api/accounts/${account.id}/posts`, { mediaAssetId: media.id })).json().post;
  post = (await call("PATCH", `/api/posts/${post.id}`, { revision: post.revision, fields })).json().post;
  return { account, post };
}

describe("scheduling API", () => {
  it("schedules in an explicit zone and stores the UTC instant", async () => {
    const { post } = await draft("instagram");
    const res = await call("POST", `/api/posts/${post.id}/schedule`, { revision: post.revision, localTime: "2030-07-01T09:00", timeZone: "America/New_York" });
    expect(res.statusCode).toBe(200);
    expect(res.json().post).toMatchObject({ status: "scheduled", scheduledAt: "2030-07-01T13:00:00Z", timezone: "America/New_York", localTime: "2030-07-01T09:00" });
    expect(res.json().warnings[0]).toMatch(/isn't connected/);
  });

  it("explains nonexistent and ambiguous daylight-saving times instead of guessing", async () => {
    const { post } = await draft("instagram");
    const gap = await call("POST", `/api/posts/${post.id}/schedule`, { revision: post.revision, localTime: "2030-03-10T02:30", timeZone: "America/New_York" });
    expect(gap.statusCode).toBe(409);
    expect(gap.json()).toMatchObject({ error: "nonexistent_time", suggestion: { localTime: "2030-03-10T03:30" } });

    const overlap = await call("POST", `/api/posts/${post.id}/schedule`, { revision: post.revision, localTime: "2030-11-03T01:30", timeZone: "America/New_York" });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json()).toMatchObject({ error: "ambiguous_time", earlier: { offset: "-04:00" }, later: { offset: "-05:00" } });

    const chosen = await call("POST", `/api/posts/${post.id}/schedule`, {
      revision: post.revision,
      localTime: "2030-11-03T01:30",
      timeZone: "America/New_York",
      choice: "later",
    });
    expect(chosen.json().post.scheduledAt).toBe("2030-11-03T06:30:00Z");
  });

  it("refuses past times, invalid zones and posts with blocking issues", async () => {
    const { post } = await draft("instagram", { caption: "#a ".repeat(31) });
    expect((await call("POST", `/api/posts/${post.id}/schedule`, { revision: post.revision, localTime: "2020-01-01T09:00", timeZone: "UTC" })).statusCode).toBe(400);
    expect((await call("POST", `/api/posts/${post.id}/schedule`, { revision: post.revision, localTime: "2030-01-01T09:00", timeZone: "Nowhere/Land" })).statusCode).toBe(400);
    const blocked = await call("POST", `/api/posts/${post.id}/schedule`, { revision: post.revision, localTime: "2030-01-01T09:00", timeZone: "UTC" });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toMatch(/30 hashtags/);
  });

  it("lets unconnected Pinterest accounts plan without a board, with a clear warning", async () => {
    const { post } = await draft("pinterest", { pinTitle: "Linen", pinDescription: "Summer" });
    const res = await call("POST", `/api/posts/${post.id}/schedule`, { revision: post.revision, localTime: "2030-01-01T09:00", timeZone: "UTC" });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.join(" ")).toMatch(/marked as not published/);
  });

  it("cancels, reschedules, and exposes history", async () => {
    const { post } = await draft("instagram");
    const s = (await call("POST", `/api/posts/${post.id}/schedule`, { revision: post.revision, localTime: "2030-01-01T09:00", timeZone: "UTC" })).json().post;
    const c = await call("POST", `/api/posts/${post.id}/cancel`, { revision: s.revision });
    expect(c.json()).toMatchObject({ immediate: true, post: { status: "canceled" } });
    const again = await call("POST", `/api/posts/${post.id}/schedule`, { revision: c.json().post.revision, localTime: "2030-02-01T09:00", timeZone: "Europe/Paris" });
    expect(again.json().post).toMatchObject({ status: "scheduled", scheduledAt: "2030-02-01T08:00:00Z" });
    expect((await call("GET", `/api/posts/${post.id}/attempts`)).json()).toEqual({ attempts: [] });
  });

  it("reads and validates settings", async () => {
    expect((await call("GET", "/api/settings")).json().settings).toEqual({ defaultTimezone: "America/New_York", missedGraceMinutes: 30 });
    expect((await call("PATCH", "/api/settings", { defaultTimezone: "Mars/Base" })).statusCode).toBe(400);
    expect((await call("PATCH", "/api/settings", { missedGraceMinutes: -1 })).statusCode).toBe(400);
    const ok = await call("PATCH", "/api/settings", { defaultTimezone: "Europe/London", missedGraceMinutes: 45 });
    expect(ok.json().settings).toEqual({ defaultTimezone: "Europe/London", missedGraceMinutes: 45 });
  });

  it("reports scheduler health honestly when the scheduler isn't running", async () => {
    const h = (await call("GET", "/api/health")).json();
    expect(h).toMatchObject({ scheduler: { running: false, stale: true }, publishing: "not_configured" });
  });
});
