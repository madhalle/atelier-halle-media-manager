// SQL for scheduling: user actions (schedule, cancel, resolve) and the worker's
// lease-guarded state changes. Every worker write is conditioned on the claim
// token, so a worker whose lease expired can never overwrite newer state.
import { randomUUID } from "node:crypto";
import type { Account } from "../domain/accounts.ts";
import { DomainError } from "../domain/errors.ts";
import { assertEditable, type AttentionKind, type Post, type PostStatus } from "../domain/posts.ts";
import { DEFAULT_MISSED_GRACE_MINUTES } from "../domain/publishing.ts";
import { DEFAULT_TIMEZONE, isValidTimeZone } from "../domain/time.ts";
import type { Db } from "./db.ts";
import type { PostsRepo } from "./posts-repo.ts";

export interface Settings {
  defaultTimezone: string;
  missedGraceMinutes: number;
}

export interface Attempt {
  id: string;
  postId: string;
  attemptNo: number;
  startedAt: string;
  finishedAt: string | null;
  stage: "preflight" | "stage" | "check" | "commit" | "reconcile";
  outcome: string;
  errorCode: string | null;
  errorMessage: string | null;
  remoteContainerId: string | null;
  remotePostId: string | null;
  simulated: boolean;
}

export interface ClaimedPost {
  id: string;
  accountId: string;
  claimToken: string;
  revision: number;
  attemptCount: number;
  scheduledAt: string;
  remoteContainerId: string | null;
  commitStartedAt: string | null;
  reconcileRequired: boolean;
}

/** Thrown when a lease-guarded update finds the claim no longer held. */
export class StaleClaim extends Error {
  constructor() {
    super("claim lost");
    this.name = "StaleClaim";
  }
}

export const CLAIM_TTL_MS = 5 * 60_000;

export function createScheduleRepo(db: Db, posts: PostsRepo) {
  const getSetting = db.prepare<[string], { value: string }>("SELECT value FROM app_settings WHERE key = ?");
  const putSetting = db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );

  function guarded(sql: string, params: Record<string, unknown>): void {
    const r = db.prepare(`${sql} WHERE id = @id AND claim_token = @token`).run(params);
    if (r.changes !== 1) throw new StaleClaim();
  }

  function requireRevision(post: Post, revision: number): void {
    if (post.revision !== revision) throw new DomainError("stale_revision", "This post changed in another window. Reload and try again.");
  }

  return {
    // ---- Settings ----
    settings(): Settings {
      const tz = getSetting.get("default_timezone")?.value;
      const grace = getSetting.get("missed_grace_minutes")?.value;
      return {
        defaultTimezone: tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE,
        missedGraceMinutes: grace !== undefined ? Number(grace) : DEFAULT_MISSED_GRACE_MINUTES,
      };
    },

    updateSettings(patch: Partial<Settings>, now: Date): Settings {
      if (patch.defaultTimezone !== undefined) {
        if (!isValidTimeZone(patch.defaultTimezone)) throw new DomainError("validation", "Unknown time zone.");
        putSetting.run("default_timezone", patch.defaultTimezone, now.toISOString());
      }
      if (patch.missedGraceMinutes !== undefined) {
        if (!Number.isInteger(patch.missedGraceMinutes) || patch.missedGraceMinutes < 0 || patch.missedGraceMinutes > 1440) {
          throw new DomainError("validation", "The grace period must be between 0 and 1440 minutes.");
        }
        putSetting.run("missed_grace_minutes", String(patch.missedGraceMinutes), now.toISOString());
      }
      return this.settings();
    },

    // ---- User actions ----
    /** Schedules or reschedules. `instant` is already resolved from local time + zone. */
    schedule(id: string, revision: number, at: { instant: string; timezone: string; localTime: string }, now: Date): Post {
      return db.transaction(() => {
        const post = posts.get(id);
        requireRevision(post, revision);
        assertEditable(post);
        db.prepare(
          `UPDATE posts SET status = 'scheduled', scheduled_at = ?, timezone = ?, local_time = ?, next_attempt_at = ?,
             attempt_count = 0, cancel_requested = 0, attention_kind = NULL, attention_message = NULL,
             revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        ).run(at.instant, at.timezone, at.localTime, at.instant, now.toISOString(), id);
        return posts.get(id);
      })();
    },

    /**
     * Cancels a pending schedule. If the worker already holds the post, the
     * cancellation is recorded and honoured before the irreversible step if it
     * hasn't started; once it has, the result is reconciled, not assumed.
     */
    cancel(id: string, revision: number, now: Date): { post: Post; immediate: boolean } {
      return db.transaction(() => {
        const post = posts.get(id);
        requireRevision(post, revision);
        const t = now.toISOString();
        if (post.status === "scheduled" || (post.status === "retry_waiting" && post.commitStartedAt === null)) {
          db.prepare(
            `UPDATE posts SET status = 'canceled', next_attempt_at = NULL, claim_token = NULL, claim_expires_at = NULL,
               revision = revision + 1, updated_at = ? WHERE id = ?`,
          ).run(t, id);
          return { post: posts.get(id), immediate: true };
        }
        if (post.status === "preparing" || post.status === "publishing" || post.status === "retry_waiting") {
          db.prepare("UPDATE posts SET cancel_requested = 1, revision = revision + 1, updated_at = ? WHERE id = ?").run(t, id);
          return { post: posts.get(id), immediate: false };
        }
        throw new DomainError("invalid_state", "Only scheduled posts can be canceled.");
      })();
    },

    /** Clears a needs-attention post back to an editable, unscheduled state. */
    dismissAttention(id: string, revision: number, now: Date): Post {
      return db.transaction(() => {
        const post = posts.get(id);
        requireRevision(post, revision);
        if (post.status !== "needs_attention") throw new DomainError("invalid_state", "This post doesn't need attention.");
        if (post.attentionKind === "ambiguous") throw new DomainError("invalid_state", "First confirm whether this post was published.");
        db.prepare(
          `UPDATE posts SET status = 'canceled', next_attempt_at = NULL, attention_kind = NULL, attention_message = NULL,
             revision = revision + 1, updated_at = ? WHERE id = ?`,
        ).run(now.toISOString(), id);
        return posts.get(id);
      })();
    },

    /** The user checked the platform after an uncertain outcome. */
    resolveAmbiguous(id: string, revision: number, outcome: "published" | "not_published", now: Date): Post {
      return db.transaction(() => {
        const post = posts.get(id);
        requireRevision(post, revision);
        if (post.attentionKind !== "ambiguous") throw new DomainError("invalid_state", "This post's outcome isn't in question.");
        const t = now.toISOString();
        if (outcome === "published") {
          db.prepare(
            `UPDATE posts SET status = 'published', published_at = coalesce(published_at, ?), attention_kind = NULL,
               attention_message = 'You confirmed this was published.', next_attempt_at = NULL, reconcile_required = 0,
               revision = revision + 1, updated_at = ? WHERE id = ?`,
          ).run(t, t, id);
        } else {
          // A fresh container is used next time; the old one may be in an unknown state.
          db.prepare(
            `UPDATE posts SET status = 'canceled', commit_started_at = NULL, reconcile_required = 0, remote_container_id = NULL,
               attention_kind = NULL, attention_message = NULL, next_attempt_at = NULL,
               revision = revision + 1, updated_at = ? WHERE id = ?`,
          ).run(t, id);
        }
        return posts.get(id);
      })();
    },

    attempts(postId: string): Attempt[] {
      return db
        .prepare<[string], Record<string, unknown>>("SELECT * FROM publish_attempts WHERE post_id = ? ORDER BY attempt_no DESC, started_at DESC")
        .all(postId)
        .map((r) => ({
          id: r.id as string,
          postId: r.post_id as string,
          attemptNo: r.attempt_no as number,
          startedAt: r.started_at as string,
          finishedAt: r.finished_at as string | null,
          stage: r.stage as Attempt["stage"],
          outcome: r.outcome as string,
          errorCode: r.error_code as string | null,
          errorMessage: r.error_message as string | null,
          remoteContainerId: r.remote_container_id as string | null,
          remotePostId: r.remote_post_id as string | null,
          simulated: r.simulated === 1,
        }));
    },

    // ---- Worker operations ----
    heartbeat(now: Date, intervalMs: number, error: string | null): void {
      db.prepare(
        `INSERT INTO scheduler_status (id, started_at, last_tick_at, last_tick_error, interval_ms) VALUES (1, @now, @now, @error, @interval)
         ON CONFLICT(id) DO UPDATE SET last_tick_at = @now, last_tick_error = @error, interval_ms = @interval`,
      ).run({ now: now.toISOString(), error, interval: intervalMs });
    },

    markStarted(now: Date, intervalMs: number): void {
      db.prepare(
        `INSERT INTO scheduler_status (id, started_at, interval_ms) VALUES (1, @now, @interval)
         ON CONFLICT(id) DO UPDATE SET started_at = @now, interval_ms = @interval`,
      ).run({ now: now.toISOString(), interval: intervalMs });
    },

    status(): { startedAt: string; lastTickAt: string | null; lastTickError: string | null; intervalMs: number } | null {
      const r = db.prepare<[], { started_at: string; last_tick_at: string | null; last_tick_error: string | null; interval_ms: number }>(
        "SELECT * FROM scheduler_status WHERE id = 1",
      ).get();
      return r ? { startedAt: r.started_at, lastTickAt: r.last_tick_at, lastTickError: r.last_tick_error, intervalMs: r.interval_ms } : null;
    },

    counts(now: Date, overdueAfterMs: number): { scheduled: number; overdue: number; needsAttention: number; inFlight: number } {
      const r = db
        .prepare<[string], { scheduled: number; overdue: number; attention: number; inflight: number }>(
          `SELECT
             sum(status IN ('scheduled', 'retry_waiting')) AS scheduled,
             sum(status IN ('scheduled', 'retry_waiting') AND next_attempt_at < ?) AS overdue,
             sum(status = 'needs_attention') AS attention,
             sum(status IN ('preparing', 'publishing')) AS inflight
           FROM posts`,
        )
        .get(new Date(now.getTime() - overdueAfterMs).toISOString())!;
      return { scheduled: r.scheduled ?? 0, overdue: r.overdue ?? 0, needsAttention: r.attention ?? 0, inFlight: r.inflight ?? 0 };
    },

    /**
     * Expired leases: work that never reached the irreversible step goes back
     * to the queue; work that did is marked for reconciliation, never re-sent.
     */
    recoverExpiredClaims(now: Date): number {
      const t = now.toISOString();
      return db.transaction(() => {
        const expired = db
          .prepare<[string], { id: string; commit_started_at: string | null }>(
            "SELECT id, commit_started_at FROM posts WHERE status IN ('preparing', 'publishing') AND claim_expires_at < ?",
          )
          .all(t);
        for (const p of expired) {
          db.prepare(
            `UPDATE posts SET status = 'retry_waiting', claim_token = NULL, claim_expires_at = NULL, next_attempt_at = ?,
               reconcile_required = CASE WHEN commit_started_at IS NOT NULL THEN 1 ELSE reconcile_required END
             WHERE id = ?`,
          ).run(t, p.id);
          db.prepare(
            "UPDATE publish_attempts SET outcome = 'interrupted', finished_at = ? WHERE post_id = ? AND outcome = 'in_progress'",
          ).run(t, p.id);
        }
        return expired.length;
      })();
    },

    /** Due posts on accounts that were never connected: kept, clearly not published. */
    markDueOnUnconnected(now: Date): number {
      const t = now.toISOString();
      return db.transaction(() => {
        const due = db
          .prepare<[string], { id: string; revision: number }>(
            `SELECT p.id, p.revision FROM posts p JOIN accounts a ON a.id = p.account_id
             WHERE p.status IN ('scheduled', 'retry_waiting') AND p.next_attempt_at <= ?
               AND a.archived_at IS NULL AND a.schedules_need_review = 0 AND a.connection_state = 'unconnected'`,
          )
          .all(t);
        for (const p of due) {
          db.prepare(
            `UPDATE posts SET status = 'needs_attention', attention_kind = 'not_connected', next_attempt_at = NULL,
               attention_message = 'Not published: this account isn''t connected to the platform yet. Connect it, then reschedule.',
               revision = revision + 1, updated_at = ?
             WHERE id = ? AND status IN ('scheduled', 'retry_waiting')`,
          ).run(t, p.id);
          db.prepare(
            `INSERT INTO publish_attempts (id, post_id, attempt_no, started_at, finished_at, stage, outcome, error_code, error_message, post_revision)
             VALUES (?, ?, (SELECT coalesce(max(attempt_no), 0) + 1 FROM publish_attempts WHERE post_id = ?), ?, ?, 'preflight', 'skipped',
               'not_connected', 'Account not connected; nothing was sent.', ?)`,
          ).run(randomUUID(), p.id, p.id, t, t, p.revision);
        }
        return due.length;
      })();
    },

    /** Atomically leases the next due post on a publishable account. */
    claimNext(now: Date): ClaimedPost | null {
      const t = now.toISOString();
      const token = randomUUID();
      const row = db
        .prepare<
          [string, string, string],
          {
            id: string;
            account_id: string;
            revision: number;
            attempt_count: number;
            scheduled_at: string;
            remote_container_id: string | null;
            commit_started_at: string | null;
            reconcile_required: 0 | 1;
          }
        >(
          `UPDATE posts SET status = 'preparing', claim_token = ?, claim_expires_at = ?, claimed_revision = revision
           WHERE id = (
             SELECT p.id FROM posts p JOIN accounts a ON a.id = p.account_id
             WHERE p.status IN ('scheduled', 'retry_waiting') AND p.next_attempt_at <= ?
               AND a.archived_at IS NULL AND a.schedules_need_review = 0 AND a.connection_state = 'connected'
             ORDER BY p.next_attempt_at, p.id LIMIT 1
           )
           RETURNING id, account_id, revision, attempt_count, scheduled_at, remote_container_id, commit_started_at, reconcile_required`,
        )
        .get(token, new Date(now.getTime() + CLAIM_TTL_MS).toISOString(), t);
      if (!row) return null;
      return {
        id: row.id,
        accountId: row.account_id,
        claimToken: token,
        revision: row.revision,
        attemptCount: row.attempt_count,
        scheduledAt: row.scheduled_at,
        remoteContainerId: row.remote_container_id,
        commitStartedAt: row.commit_started_at,
        reconcileRequired: row.reconcile_required === 1,
      };
    },

    startAttempt(c: ClaimedPost, stage: Attempt["stage"], now: Date, simulated: boolean): string {
      const id = randomUUID();
      db.transaction(() => {
        guarded("UPDATE posts SET attempt_count = attempt_count + 1", { id: c.id, token: c.claimToken });
        db.prepare(
          `INSERT INTO publish_attempts (id, post_id, attempt_no, started_at, stage, outcome, post_revision, simulated)
           VALUES (?, ?, (SELECT attempt_count FROM posts WHERE id = ?), ?, ?, 'in_progress', ?, ?)`,
        ).run(id, c.id, c.id, now.toISOString(), stage, c.revision, simulated ? 1 : 0);
      })();
      return id;
    },

    updateAttempt(
      attemptId: string,
      patch: {
        stage?: Attempt["stage"];
        outcome?: string;
        errorCode?: string | null;
        errorMessage?: string | null;
        remoteContainerId?: string | null;
        remotePostId?: string | null;
        mediaAssetId?: string;
        derivativeSha256?: string;
        finishedAt?: Date;
      },
    ): void {
      const cols: Record<string, unknown> = {
        stage: patch.stage,
        outcome: patch.outcome,
        error_code: patch.errorCode,
        error_message: patch.errorMessage,
        remote_container_id: patch.remoteContainerId,
        remote_post_id: patch.remotePostId,
        media_asset_id: patch.mediaAssetId,
        derivative_sha256: patch.derivativeSha256,
        finished_at: patch.finishedAt?.toISOString(),
      };
      const set = Object.entries(cols).filter(([, v]) => v !== undefined);
      if (set.length === 0) return;
      db.prepare(`UPDATE publish_attempts SET ${set.map(([k]) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({
        id: attemptId,
        ...Object.fromEntries(set),
      });
    },

    /** Re-reads the claimed post with its account for the pre-commit recheck. */
    recheck(c: ClaimedPost): { status: PostStatus; revision: number; cancelRequested: boolean; claimHeld: boolean } {
      const r = db
        .prepare<[string], { status: PostStatus; revision: number; cancel_requested: 0 | 1; claim_token: string | null }>(
          "SELECT status, revision, cancel_requested, claim_token FROM posts WHERE id = ?",
        )
        .get(c.id)!;
      return { status: r.status, revision: r.revision, cancelRequested: r.cancel_requested === 1, claimHeld: r.claim_token === c.claimToken };
    },

    saveContainer(c: ClaimedPost, containerId: string | null): void {
      guarded("UPDATE posts SET remote_container_id = @containerId", { id: c.id, token: c.claimToken, containerId });
    },

    /** Persisted before the irreversible call. */
    markCommitStarted(c: ClaimedPost, now: Date): void {
      guarded("UPDATE posts SET status = 'publishing', commit_started_at = @now", { id: c.id, token: c.claimToken, now: now.toISOString() });
    },

    markPublished(c: ClaimedPost, result: { remotePostId: string; permalink: string | null }, now: Date, simulated: boolean): void {
      guarded(
        `UPDATE posts SET status = 'published', remote_post_id = @remotePostId, remote_permalink = @permalink, published_at = @now,
           published_simulated = @simulated, claim_token = NULL, claim_expires_at = NULL, next_attempt_at = NULL,
           reconcile_required = 0, attention_kind = NULL, attention_message = NULL, updated_at = @now, revision = revision + 1`,
        { id: c.id, token: c.claimToken, ...result, now: now.toISOString(), simulated: simulated ? 1 : 0 },
      );
    },

    /** Back to the queue at `at`. Clears commit markers only when reconciliation proved nothing was published. */
    release(c: ClaimedPost, status: "retry_waiting" | "scheduled", at: Date, opts: { clearCommit?: boolean; reconcile?: boolean } = {}): void {
      guarded(
        `UPDATE posts SET status = @status, next_attempt_at = @at, claim_token = NULL, claim_expires_at = NULL
           ${opts.clearCommit ? ", commit_started_at = NULL, reconcile_required = 0, remote_container_id = NULL" : ""}
           ${opts.reconcile ? ", reconcile_required = 1" : ""}`,
        { id: c.id, token: c.claimToken, status, at: at.toISOString() },
      );
    },

    markCanceled(c: ClaimedPost, now: Date): void {
      guarded(
        `UPDATE posts SET status = 'canceled', cancel_requested = 0, claim_token = NULL, claim_expires_at = NULL, next_attempt_at = NULL,
           updated_at = @now, revision = revision + 1`,
        { id: c.id, token: c.claimToken, now: now.toISOString() },
      );
    },

    /** `clearCommit` only when the platform definitively refused the publish call. */
    markNeedsAttention(c: ClaimedPost, kind: AttentionKind, message: string, now: Date, opts: { clearCommit?: boolean } = {}): void {
      guarded(
        `UPDATE posts SET status = 'needs_attention', attention_kind = @kind, attention_message = @message, claim_token = NULL,
           claim_expires_at = NULL, next_attempt_at = NULL, updated_at = @now, revision = revision + 1
           ${opts.clearCommit ? ", commit_started_at = NULL, reconcile_required = 0" : ""}`,
        { id: c.id, token: c.claimToken, kind, message, now: now.toISOString() },
      );
    },

    markAccountNeedsReconnect(account: Account, now: Date): void {
      db.prepare(
        `UPDATE accounts SET connection_state = 'needs_reconnect', revision = revision + 1, updated_at = ?
         WHERE id = ? AND connection_state = 'connected'`,
      ).run(now.toISOString(), account.id);
    },
  };
}

export type ScheduleRepo = ReturnType<typeof createScheduleRepo>;
