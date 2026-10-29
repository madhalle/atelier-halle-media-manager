// Processes one leased post. The order of operations is the safety argument:
//
//   preflight → stage (persist container id) → check → recheck cancellation,
//   revision and account → persist "commit started" → irreversible commit →
//   persist result.
//
// After "commit started" is persisted, the post is never sent again unless
// reconciliation with the platform proves it was not published.
import { canPublish, PLATFORM_LABELS, type Account } from "../domain/accounts.ts";
import type { AttentionKind } from "../domain/posts.ts";
import { computeCrop, validatePost } from "../domain/posts.ts";
import { backoffMs, isMissed, PlatformError, RETRY_POLICY } from "../domain/publishing.ts";
import type { PlatformAdapter, PublishJob } from "../platforms/types.ts";
import type { AdapterRegistry } from "../platforms/types.ts";
import type { AccountsRepo } from "../storage/accounts-repo.ts";
import { sha256File, type MediaStore } from "../storage/media-store.ts";
import type { PostsRepo } from "../storage/posts-repo.ts";
import { StaleClaim, type ClaimedPost, type ScheduleRepo } from "../storage/schedule-repo.ts";

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface WorkerDeps {
  accounts: AccountsRepo;
  posts: PostsRepo;
  media: MediaStore;
  schedule: ScheduleRepo;
  adapters: AdapterRegistry;
  now: () => Date;
  random?: () => number;
  log: Logger;
}

const PENDING_RECHECK_MS = 60_000;

/** Claims and processes the next due post. Returns false when nothing was due. */
export async function processNext(deps: WorkerDeps): Promise<boolean> {
  const claim = deps.schedule.claimNext(deps.now());
  if (!claim) return false;
  try {
    await processClaim(deps, claim);
  } catch (err) {
    if (err instanceof StaleClaim) {
      deps.log.warn({ postId: claim.id }, "lease lost; another run owns this post now");
    } else {
      throw err;
    }
  }
  return true;
}

async function processClaim(deps: WorkerDeps, c: ClaimedPost): Promise<void> {
  const { accounts, posts, schedule, now } = deps;
  const account = accounts.get(c.accountId);
  const adapter = deps.adapters(account.platform);
  const attemptId = schedule.startAttempt(c, c.commitStartedAt ? "reconcile" : "preflight", now(), adapter?.simulated ?? false);
  const attemptNo = c.attemptCount + 1;
  const finish = (outcome: string, extra: { errorCode?: string; errorMessage?: string; remotePostId?: string } = {}) =>
    schedule.updateAttempt(attemptId, { outcome, finishedAt: now(), ...extra });

  const attention = (kind: AttentionKind, message: string, code: string, opts: { clearCommit?: boolean } = {}) => {
    schedule.markNeedsAttention(c, kind, message, now(), opts);
    finish(kind === "ambiguous" ? "ambiguous" : kind === "auth" ? "auth_expired" : "permanent", { errorCode: code, errorMessage: message });
  };

  const retryLater = (err: PlatformError | null, opts: { reconcile?: boolean; clearCommit?: boolean } = {}) => {
    if (attemptNo >= RETRY_POLICY.maxAttempts) {
      if (opts.reconcile) {
        return attention("ambiguous", uncertainMessage(account), err?.code ?? "reconcile_exhausted");
      }
      return attention(
        "retries_exhausted",
        `Not published after ${attemptNo} attempts. Last problem: ${err?.safeMessage ?? "unknown error"}`,
        err?.code ?? "retries_exhausted",
        { clearCommit: opts.clearCommit ?? false },
      );
    }
    const delay = backoffMs(attemptNo, deps.random, err?.retryAfterMs);
    schedule.release(c, "retry_waiting", new Date(now().getTime() + delay), opts);
    finish(err?.kind === "rate_limited" ? "rate_limited" : "retry", err ? { errorCode: err.code, errorMessage: err.safeMessage } : {});
  };

  // ---- Preflight ----
  if (!adapter) {
    return attention(
      "not_configured",
      `Not published: publishing to ${PLATFORM_LABELS[account.platform]} isn't set up in this app yet. Nothing was sent.`,
      "not_configured",
    );
  }
  const post = posts.get(c.id);
  const item = post.media[0];
  if (!item) return attention("validation", "Not published: the post has no photo.", "no_media");
  const asset = deps.media.get(item.mediaAssetId);
  if (!account.identity || !account.credentialRef) {
    return attention("auth", "Not published: reconnect this account.", "missing_credentials");
  }

  const derivative = await deps.media.derivative(asset, account.platform, computeCrop(asset.width, asset.height, item.cropAspect, item.focusX, item.focusY));
  const sha256 = await sha256File(derivative.file);
  schedule.updateAttempt(attemptId, { mediaAssetId: asset.id, derivativeSha256: sha256 });
  const job: PublishJob = {
    postId: post.id,
    attemptNo,
    platform: account.platform,
    providerAccountId: account.identity.providerAccountId,
    credentialRef: account.credentialRef,
    caption: post.caption,
    altText: post.altText,
    pinTitle: post.pinTitle,
    pinDescription: post.pinDescription,
    pinLink: post.pinLink,
    pinBoardId: post.pinBoardId,
    derivative: { file: derivative.file, sha256 },
    containerId: c.remoteContainerId,
  };

  if (c.commitStartedAt) {
    return reconcile(deps, adapter, c, job, account, new Date(c.commitStartedAt), attemptId, { attention, retryLater, finish });
  }

  if (c.attemptCount === 0 && isMissed(c.scheduledAt, now(), schedule.settings().missedGraceMinutes)) {
    const late = Math.round((now().getTime() - Date.parse(c.scheduledAt)) / 60_000);
    return attention(
      "missed",
      `Not published: it was due ${late} minutes ago, probably while the Mac was asleep or the app wasn't running. Review it and reschedule.`,
      "missed",
    );
  }

  const blocking = validatePost(account.platform, post, new Map([[asset.id, asset]])).filter((i) => i.severity === "blocking");
  if (blocking.length > 0) return attention("validation", `Not published: ${blocking[0]!.message}`, "validation");

  // ---- Stage and check (repeatable, nothing public yet) ----
  try {
    schedule.updateAttempt(attemptId, { stage: "stage" });
    const { containerId } = await adapter.stage(job);
    if (containerId !== c.remoteContainerId) {
      schedule.saveContainer(c, containerId);
      job.containerId = containerId;
      schedule.updateAttempt(attemptId, { remoteContainerId: containerId });
    }
    schedule.updateAttempt(attemptId, { stage: "check" });
    if ((await adapter.checkStaged(job)) === "pending") {
      if (attemptNo >= RETRY_POLICY.maxAttempts) {
        return attention("retries_exhausted", "Not published: the platform was still processing the photo after several checks.", "stage_timeout");
      }
      schedule.release(c, "retry_waiting", new Date(now().getTime() + PENDING_RECHECK_MS));
      return finish("pending");
    }
  } catch (err) {
    return handlePreCommitError(err, { attention, retryLater, account, deps });
  }

  // ---- Final recheck immediately before the irreversible step ----
  const fresh = schedule.recheck(c);
  if (!fresh.claimHeld) throw new StaleClaim();
  if (fresh.cancelRequested) {
    schedule.markCanceled(c, now());
    return finish("canceled");
  }
  if (fresh.revision !== c.revision) {
    // Edited after we claimed it: start over with the new content.
    schedule.release(c, "scheduled", now());
    return finish("retry", { errorCode: "edited", errorMessage: "The post changed while being prepared; it will be re-checked." });
  }
  const latestAccount = accounts.get(c.accountId);
  if (!canPublish(latestAccount)) {
    schedule.release(c, "scheduled", now());
    return finish("paused", { errorCode: "account_paused", errorMessage: "The account was paused, archived or disconnected before publishing." });
  }

  schedule.markCommitStarted(c, now());
  schedule.updateAttempt(attemptId, { stage: "commit" });
  const commitStartedAt = now();
  try {
    const result = await adapter.commit(job);
    schedule.markPublished(c, result, now(), adapter.simulated);
    return finish("published", { remotePostId: result.remotePostId });
  } catch (err) {
    if (err instanceof StaleClaim) throw err;
    if (err instanceof PlatformError && (err.kind === "rate_limited" || err.kind === "auth_expired" || err.kind === "permanent")) {
      // The platform definitively refused: nothing was published.
      return handlePreCommitError(err, { attention, retryLater, account, deps, clearCommit: true });
    }
    // Timeouts, dropped connections, 5xx: it may have gone out. Ask the platform.
    return reconcile(deps, adapter, c, job, account, commitStartedAt, attemptId, { attention, retryLater, finish });
  }
}

interface Handlers {
  attention: (kind: AttentionKind, message: string, code: string, opts?: { clearCommit?: boolean }) => void;
  retryLater: (err: PlatformError | null, opts?: { reconcile?: boolean; clearCommit?: boolean }) => void;
  finish: (outcome: string, extra?: { errorCode?: string; errorMessage?: string; remotePostId?: string }) => void;
}

function handlePreCommitError(
  err: unknown,
  ctx: Omit<Handlers, "finish"> & { account: Account; deps: WorkerDeps; clearCommit?: boolean },
): void {
  if (err instanceof StaleClaim) throw err;
  const clear = { clearCommit: ctx.clearCommit ?? false };
  if (!(err instanceof PlatformError)) {
    // Unexpected local error: log details server-side, store only a generic message.
    ctx.deps.log.error({ err }, "unexpected error while preparing a post");
    return ctx.retryLater(new PlatformError("transient", "internal_error", "An unexpected error occurred in the app."), clear);
  }
  switch (err.kind) {
    case "transient":
    case "ambiguous":
    case "rate_limited":
      return ctx.retryLater(err, clear);
    case "auth_expired":
      ctx.deps.schedule.markAccountNeedsReconnect(ctx.account, ctx.deps.now());
      return ctx.attention("auth", `Not published: the ${PLATFORM_LABELS[ctx.account.platform]} connection expired. Reconnect the account, then reschedule.`, err.code, clear);
    case "permanent":
      return ctx.attention("permanent", `Not published: ${err.safeMessage}`, err.code, clear);
  }
}

function uncertainMessage(account: Account): string {
  return `It's not certain whether this was published. Check the ${PLATFORM_LABELS[account.platform]} account, then tell the app what happened. It won't be retried automatically, to avoid a duplicate post.`;
}

async function reconcile(
  deps: WorkerDeps,
  adapter: PlatformAdapter,
  c: ClaimedPost,
  job: PublishJob,
  account: Account,
  commitStartedAt: Date,
  attemptId: string,
  h: Handlers,
): Promise<void> {
  deps.schedule.updateAttempt(attemptId, { stage: "reconcile" });
  let result;
  try {
    result = await adapter.reconcile(job, commitStartedAt);
  } catch (err) {
    if (err instanceof StaleClaim) throw err;
    if (err instanceof PlatformError && err.kind === "auth_expired") {
      deps.schedule.markAccountNeedsReconnect(account, deps.now());
      return h.attention("ambiguous", uncertainMessage(account), err.code);
    }
    // Couldn't ask the platform right now; keep the commit marker and try reconciling later.
    return h.retryLater(err instanceof PlatformError ? err : null, { reconcile: true });
  }
  if (result.state === "published") {
    deps.schedule.markPublished(c, result, deps.now(), adapter.simulated);
    return h.finish("published", { remotePostId: result.remotePostId, errorCode: "reconciled", errorMessage: "Confirmed published after an uncertain response." });
  }
  if (result.state === "not_published") {
    // Proven not published: safe to try again with a fresh container.
    return h.retryLater(new PlatformError("transient", "not_published", "The platform confirmed the post did not go out."), { clearCommit: true });
  }
  return h.attention("ambiguous", uncertainMessage(account), "unknown_outcome");
}
