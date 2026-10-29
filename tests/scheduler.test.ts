import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backoffMs, RETRY_POLICY } from "../src/domain/publishing.ts";
import { localTimeOf, resolveLocalTime } from "../src/domain/time.ts";
import { processNext } from "../src/scheduler/worker.ts";
import { CLAIM_TTL_MS, StaleClaim } from "../src/storage/schedule-repo.ts";
import { commits, connectedAccount, createEnv, photo, scheduledPost, type Env } from "./scheduling-helpers.ts";

const MIN = 60_000;

describe("time zones and daylight saving", () => {
  it("resolves ordinary times using the chosen zone, not the machine's", () => {
    expect(resolveLocalTime("2026-07-01T09:00", "America/New_York")).toMatchObject({ kind: "ok", instant: "2026-07-01T13:00:00Z" });
    expect(resolveLocalTime("2026-07-01T09:00", "Asia/Tokyo")).toMatchObject({ kind: "ok", instant: "2026-07-01T00:00:00Z" });
    expect(localTimeOf("2026-07-01T13:00:00Z", "America/New_York")).toBe("2026-07-01T09:00");
  });

  it("flags times skipped by spring-forward and suggests the next valid time", () => {
    expect(resolveLocalTime("2026-03-08T02:30", "America/New_York")).toEqual({
      kind: "nonexistent",
      suggestion: { localTime: "2026-03-08T03:30", instant: "2026-03-08T07:30:00Z", offset: "-04:00" },
    });
  });

  it("asks which occurrence for repeated fall-back times, and resolves either on request", () => {
    expect(resolveLocalTime("2026-11-01T01:30", "America/New_York")).toEqual({
      kind: "ambiguous",
      earlier: { instant: "2026-11-01T05:30:00Z", offset: "-04:00" },
      later: { instant: "2026-11-01T06:30:00Z", offset: "-05:00" },
    });
    expect(resolveLocalTime("2026-11-01T01:30", "America/New_York", "later")).toMatchObject({ instant: "2026-11-01T06:30:00Z" });
  });

  it("rejects invalid dates and unknown zones", () => {
    expect(() => resolveLocalTime("2026-02-30T10:00", "America/New_York")).toThrow(/doesn't exist/);
    expect(() => resolveLocalTime("2026-10-29T10:00", "Mars/Olympus")).toThrow(/Unknown time zone/);
    expect(() => resolveLocalTime("10/29/2026 10am", "America/New_York")).toThrow(/Enter a date/);
  });
});

describe("backoff", () => {
  it("grows exponentially with bounded jitter and a cap", () => {
    expect(backoffMs(1, () => 0)).toBe(30_000);
    expect(backoffMs(1, () => 1)).toBe(60_000);
    expect(backoffMs(3, () => 1)).toBe(240_000);
    expect(backoffMs(50, () => 1)).toBe(RETRY_POLICY.maxDelayMs);
  });

  it("honours a provider's Retry-After when it is longer, up to a bound", () => {
    expect(backoffMs(1, () => 1, 10 * MIN)).toBe(10 * MIN);
    expect(backoffMs(1, () => 1, 1_000)).toBe(60_000);
    expect(backoffMs(1, () => 1, 999 * 60 * MIN)).toBe(RETRY_POLICY.maxRetryAfterMs);
  });
});

describe("scheduler", () => {
  let env: Env;
  beforeEach(async () => {
    env = await createEnv();
  });
  afterEach(async () => {
    await env.close();
  });

  const tick = () => env.scheduler.tick();
  const status = (id: string) => env.posts.get(id).status;

  it("publishes once when due, never early, and records history", async () => {
    const a = connectedAccount(env);
    const post = await scheduledPost(env, a.id, 10);
    await tick();
    expect(status(post.id)).toBe("scheduled");
    expect(commits(env)).toBe(0);

    env.clock.advance(10 * MIN);
    await tick();
    const p = env.posts.get(post.id);
    expect(p).toMatchObject({ status: "published", publishedSimulated: true });
    expect(p.remotePostId).toMatch(/^fake-instagram-/);
    await tick();
    expect(commits(env)).toBe(1);
    expect(env.schedule.attempts(post.id)).toMatchObject([{ outcome: "published", stage: "commit", simulated: true }]);
    expect(env.fakes.instagram.calls.map((c) => c.step)).toEqual(["stage", "checkStaged", "commit"]);
  });

  it("keeps schedules across a restart; SQLite is the source of truth", async () => {
    const a = connectedAccount(env);
    const post = await scheduledPost(env, a.id, 5);
    await env.restart();
    env.clock.advance(5 * MIN);
    await tick();
    expect(status(post.id)).toBe("published");
  });

  it("never reports success for an unconnected account; the post stays saved and says so", async () => {
    const a = env.accounts.create({ platform: "pinterest", displayName: "Planning only" });
    const draft = env.posts.createDraft(a.id, await photo(env));
    const post = env.schedule.schedule(draft.id, draft.revision, { instant: new Date(env.clock.t + MIN).toISOString(), timezone: "UTC", localTime: "x" }, env.clock.now());
    env.clock.advance(2 * MIN);
    await tick();
    const p = env.posts.get(post.id);
    expect(p).toMatchObject({ status: "needs_attention", attentionKind: "not_connected", remotePostId: null, publishedAt: null });
    expect(p.attentionMessage).toMatch(/Not published/);
    expect(env.fakes.pinterest.calls).toEqual([]);
  });

  it("marks posts not published when no real platform integration is configured", async () => {
    await env.close();
    env = await createEnv({ adapters: "none" });
    const a = connectedAccount(env);
    const post = await scheduledPost(env, a.id, 1);
    env.clock.advance(MIN);
    await tick();
    expect(env.posts.get(post.id)).toMatchObject({ status: "needs_attention", attentionKind: "not_configured", publishedAt: null });
  });

  it("pauses archived accounts and requires review after restore before anything publishes", async () => {
    const a = connectedAccount(env);
    const post = await scheduledPost(env, a.id, 5);
    env.accounts.archive(a.id);
    env.clock.advance(10 * MIN);
    await tick();
    expect(status(post.id)).toBe("scheduled");

    env.accounts.restore(a.id);
    await tick();
    expect(status(post.id)).toBe("scheduled"); // still paused: review required
    expect(commits(env)).toBe(0);

    env.accounts.acknowledgeScheduleReview(a.id);
    await tick();
    expect(status(post.id)).toBe("published"); // 5 minutes late: within the 30-minute policy
  });

  it("pauses disconnected accounts and never silently resumes on reconnect", async () => {
    const a = connectedAccount(env);
    const post = await scheduledPost(env, a.id, 5);
    env.accounts.markDisconnected(a.id);
    env.clock.advance(6 * MIN);
    await tick();
    expect(status(post.id)).toBe("scheduled");
    env.accounts.markConnected(a.id, { ...env.accounts.get(a.id).identity! }, "kc:new");
    await tick();
    expect(status(post.id)).toBe("scheduled");
    expect(commits(env)).toBe(0);
  });

  describe("missed schedules", () => {
    it("publishes work up to 30 minutes late", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 0.5);
      env.clock.advance(30 * MIN);
      await tick();
      expect(status(post.id)).toBe("published");
    });

    it("holds older work for review instead of publishing it", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.clock.advance(32 * MIN);
      await tick();
      expect(env.posts.get(post.id)).toMatchObject({ status: "needs_attention", attentionKind: "missed" });
      expect(env.posts.get(post.id).attentionMessage).toMatch(/due 31 minutes ago/);
      expect(commits(env)).toBe(0);
    });

    it("uses the configured grace period", async () => {
      env.schedule.updateSettings({ missedGraceMinutes: 120 }, env.clock.now());
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.clock.advance(90 * MIN);
      await tick();
      expect(status(post.id)).toBe("published");
    });
  });

  describe("failures", () => {
    it("retries transient failures with backoff, then succeeds (offline recovery)", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.script("stage", { type: "fail", kind: "transient" }, { type: "fail", kind: "transient" });
      env.clock.advance(MIN);
      await tick();
      let p = env.posts.get(post.id);
      expect(p.status).toBe("retry_waiting");
      expect(Date.parse(p.nextAttemptAt!) - env.clock.t).toBe(backoffMs(1, () => 0.5));
      env.clock.advance(5 * MIN);
      await tick();
      expect(status(post.id)).toBe("retry_waiting");
      env.clock.advance(10 * MIN);
      await tick();
      p = env.posts.get(post.id);
      expect(p.status).toBe("published");
      expect(commits(env)).toBe(1);
      expect(env.schedule.attempts(post.id).map((x) => x.outcome)).toEqual(["published", "retry", "retry"]);
    });

    it("honours provider rate-limit guidance", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.script("stage", { type: "fail", kind: "rate_limited", retryAfterMs: 45 * MIN });
      env.clock.advance(MIN);
      await tick();
      const p = env.posts.get(post.id);
      expect(Date.parse(p.nextAttemptAt!) - env.clock.t).toBe(45 * MIN);
      expect(env.schedule.attempts(post.id)[0]).toMatchObject({ outcome: "rate_limited" });
    });

    it("stops on permanent validation failures", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.script("stage", { type: "fail", kind: "permanent", code: "bad_image" });
      env.clock.advance(MIN);
      await tick();
      env.clock.advance(60 * MIN);
      await tick();
      expect(env.posts.get(post.id)).toMatchObject({ status: "needs_attention", attentionKind: "permanent" });
      expect(env.fakes.instagram.calls.filter((c) => c.step === "stage")).toHaveLength(1);
    });

    it("flags expired credentials and asks for reconnection", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.script("stage", { type: "fail", kind: "auth_expired" });
      env.clock.advance(MIN);
      await tick();
      expect(env.posts.get(post.id)).toMatchObject({ status: "needs_attention", attentionKind: "auth" });
      expect(env.accounts.get(a.id).connectionState).toBe("needs_reconnect");
    });

    it("gives up after the maximum number of attempts", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.script("stage", ...Array.from({ length: 10 }, () => ({ type: "fail", kind: "transient" }) as const));
      env.clock.advance(MIN);
      for (let i = 0; i < RETRY_POLICY.maxAttempts + 2; i++) {
        await tick();
        env.clock.advance(2 * 60 * MIN);
      }
      expect(env.posts.get(post.id)).toMatchObject({ status: "needs_attention", attentionKind: "retries_exhausted" });
      expect(env.schedule.attempts(post.id)).toHaveLength(RETRY_POLICY.maxAttempts);
    });

    it("treats a definitive refusal at publish time as not published", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.script("commit", { type: "fail", kind: "permanent", code: "caption_rejected" });
      env.clock.advance(MIN);
      await tick();
      const p = env.posts.get(post.id);
      expect(p).toMatchObject({ status: "needs_attention", attentionKind: "permanent", commitStartedAt: null });
      expect(env.fakes.instagram.calls.some((c) => c.step === "reconcile")).toBe(false);
    });

    it("stores only sanitized messages for unexpected errors", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.hooks.stage = () => {
        throw new Error("GET https://graph.instagram.com/me?access_token=SECRET-TOKEN failed");
      };
      env.clock.advance(MIN);
      await tick();
      const attempt = env.schedule.attempts(post.id)[0]!;
      expect(attempt.errorMessage).toBe("An unexpected error occurred in the app.");
      expect(JSON.stringify(env.db.prepare("SELECT * FROM publish_attempts").all())).not.toContain("SECRET-TOKEN");
      expect(JSON.stringify(env.db.prepare("SELECT * FROM posts").all())).not.toContain("SECRET-TOKEN");
    });
  });

  describe("uncertain outcomes", () => {
    it("does not republish when the platform published but the response was lost", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.script("commit", { type: "lost_response" });
      env.clock.advance(MIN);
      await tick();
      expect(env.posts.get(post.id)).toMatchObject({ status: "published" });
      expect(env.fakes.instagram.published.get(post.id)?.count).toBe(1);
      for (let i = 0; i < 3; i++) {
        env.clock.advance(60 * MIN);
        await tick();
      }
      expect(commits(env)).toBe(1);
      expect(env.schedule.attempts(post.id)[0]).toMatchObject({ outcome: "published", errorCode: "reconciled" });
    });

    it("requires the user's review when the outcome can't be determined, and never retries blindly", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.script("commit", { type: "fail", kind: "ambiguous" });
      env.fakes.instagram.script("reconcile", { type: "reconcile", result: "unknown" });
      env.clock.advance(MIN);
      await tick();
      let p = env.posts.get(post.id);
      expect(p).toMatchObject({ status: "needs_attention", attentionKind: "ambiguous" });
      expect(p.attentionMessage).toMatch(/won't be retried automatically/);
      env.clock.advance(24 * 60 * MIN);
      await tick();
      expect(commits(env)).toBe(1);

      expect(() => env.posts.update(post.id, p.revision, { fields: { caption: "x" } })).toThrow(/sent to the platform|confirm whether/);
      expect(() => env.schedule.dismissAttention(post.id, p.revision, env.clock.now())).toThrow(/confirm whether/);

      p = env.schedule.resolveAmbiguous(post.id, p.revision, "not_published", env.clock.now());
      expect(p).toMatchObject({ status: "canceled", commitStartedAt: null });
      expect(env.posts.update(post.id, p.revision, { fields: { caption: "Try again" } }).caption).toBe("Try again");
    });

    it("lets the user confirm an uncertain post was published", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.script("commit", { type: "fail", kind: "ambiguous" });
      env.fakes.instagram.script("reconcile", { type: "reconcile", result: "unknown" });
      env.clock.advance(MIN);
      await tick();
      const p = env.schedule.resolveAmbiguous(post.id, env.posts.get(post.id).revision, "published", env.clock.now());
      expect(p.status).toBe("published");
    });

    it("retries only after reconciliation proves nothing was published", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.script("commit", { type: "fail", kind: "ambiguous" });
      env.clock.advance(MIN);
      await tick(); // default reconcile reports not_published
      expect(env.posts.get(post.id)).toMatchObject({ status: "retry_waiting", commitStartedAt: null });
      env.clock.advance(5 * MIN);
      await tick();
      expect(status(post.id)).toBe("published");
      expect(env.fakes.instagram.published.get(post.id)?.count).toBe(1);
    });

    it("reconciles work interrupted after the publish call started (crash), instead of resending", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.clock.advance(MIN);
      // Simulate a crash: lease taken, publish call started and succeeded remotely, process died.
      const claim = env.schedule.claimNext(env.clock.now())!;
      env.schedule.startAttempt(claim, "preflight", env.clock.now(), true);
      env.schedule.markCommitStarted(claim, env.clock.now());
      env.fakes.instagram.published.set(post.id, { remotePostId: "remote-1", permalink: null, count: 1 });

      await env.restart();
      env.clock.advance(CLAIM_TTL_MS + 1);
      await tick();
      expect(env.posts.get(post.id)).toMatchObject({ status: "published", remotePostId: "remote-1" });
      expect(commits(env)).toBe(0);
      expect(env.schedule.attempts(post.id).map((x) => x.outcome)).toEqual(["published", "interrupted"]);
    });

    it("requeues work interrupted before the publish call, reusing the saved container", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.clock.advance(MIN);
      const claim = env.schedule.claimNext(env.clock.now())!;
      env.schedule.saveContainer(claim, "container-77");
      env.clock.advance(CLAIM_TTL_MS + 1);
      await tick();
      expect(status(post.id)).toBe("published");
      expect(env.fakes.instagram.calls.find((c) => c.step === "stage")?.containerId).toBe("container-77");
      expect(commits(env)).toBe(1);
    });
  });

  describe("concurrency and races", () => {
    it("lets only one worker hold a post; a stale lease can't overwrite newer state", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.clock.advance(MIN);
      const first = env.schedule.claimNext(env.clock.now())!;
      expect(env.schedule.claimNext(env.clock.now())).toBeNull();
      env.clock.advance(CLAIM_TTL_MS + 1);
      env.schedule.recoverExpiredClaims(env.clock.now());
      const second = env.schedule.claimNext(env.clock.now())!;
      expect(second.claimToken).not.toBe(first.claimToken);
      expect(() => env.schedule.markPublished(first, { remotePostId: "x", permalink: null }, env.clock.now(), true)).toThrow(StaleClaim);
      expect(status(post.id)).toBe("preparing");
    });

    it("overlapping ticks and parallel workers publish each post once", async () => {
      const a = connectedAccount(env);
      const posts = await Promise.all([1, 1, 1].map(() => scheduledPost(env, a.id, 1)));
      env.clock.advance(MIN);
      await Promise.all([tick(), tick(), processNext(env.deps), processNext(env.deps)]);
      await tick();
      for (const p of posts) expect(status(p.id)).toBe("published");
      expect(commits(env)).toBe(3);
    });

    it("cancels immediately when nothing has started", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      const { immediate } = env.schedule.cancel(post.id, post.revision, env.clock.now());
      expect(immediate).toBe(true);
      env.clock.advance(MIN);
      await tick();
      expect(status(post.id)).toBe("canceled");
      expect(commits(env)).toBe(0);
    });

    it("honours a cancel that arrives mid-preparation, before the irreversible step", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.hooks.stage = () => {
        const p = env.posts.get(post.id);
        expect(env.schedule.cancel(post.id, p.revision, env.clock.now()).immediate).toBe(false);
      };
      env.clock.advance(MIN);
      await tick();
      expect(status(post.id)).toBe("canceled");
      expect(commits(env)).toBe(0);
    });

    it("does not pretend a cancel stopped a publish already in flight", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.hooks.commit = () => {
        const p = env.posts.get(post.id);
        expect(p.status).toBe("publishing");
        expect(env.schedule.cancel(post.id, p.revision, env.clock.now()).immediate).toBe(false);
      };
      env.clock.advance(MIN);
      await tick();
      expect(status(post.id)).toBe("published");
    });

    it("rechecks the account right before publishing", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.hooks.checkStaged = () => void env.accounts.archive(a.id);
      env.clock.advance(MIN);
      await tick();
      expect(status(post.id)).toBe("scheduled");
      expect(commits(env)).toBe(0);
    });

    it("locks content while it is being published", async () => {
      const a = connectedAccount(env);
      const post = await scheduledPost(env, a.id, 1);
      env.fakes.instagram.hooks.stage = () => {
        expect(() => env.posts.update(post.id, env.posts.get(post.id).revision, { fields: { caption: "late edit" } })).toThrow(/being published/);
      };
      env.clock.advance(MIN);
      await tick();
      expect(env.posts.get(post.id).caption).toBe("New collection");
    });
  });

  it("publishes at the chosen side of a daylight-saving overlap", async () => {
    const a = connectedAccount(env);
    let post = env.posts.createDraft(a.id, await photo(env));
    post = env.posts.update(post.id, post.revision, { fields: { caption: "Fall back" } });
    const r = resolveLocalTime("2026-11-01T01:30", "America/New_York", "later");
    if (r.kind !== "ok") throw new Error("expected ok");
    env.clock.set("2026-11-01T05:00:00Z");
    env.schedule.schedule(post.id, post.revision, { instant: r.instant, timezone: "America/New_York", localTime: "2026-11-01T01:30" }, env.clock.now());
    env.clock.set("2026-11-01T05:31:00Z"); // the earlier 01:30 has passed
    await tick();
    expect(status(post.id)).toBe("scheduled");
    env.clock.set("2026-11-01T06:30:30Z");
    await tick();
    expect(status(post.id)).toBe("published");
  });

  it("records a heartbeat for health reporting", async () => {
    await tick();
    expect(env.schedule.status()).toMatchObject({ lastTickAt: env.clock.now().toISOString(), lastTickError: null });
  });
});
