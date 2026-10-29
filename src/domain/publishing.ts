// Publishing rules independent of any platform: allowed transitions, failure
// classification, retry backoff, and the missed-schedule policy.
import type { PostStatus } from "./posts.ts";

/** Allowed status transitions. Anything else is a bug. */
export const TRANSITIONS: Record<PostStatus, readonly PostStatus[]> = {
  draft: ["scheduled"],
  canceled: ["scheduled", "draft"],
  scheduled: ["preparing", "canceled", "needs_attention", "scheduled"],
  retry_waiting: ["preparing", "canceled", "needs_attention", "scheduled"],
  preparing: ["publishing", "retry_waiting", "needs_attention", "canceled", "scheduled"],
  publishing: ["published", "retry_waiting", "needs_attention"],
  needs_attention: ["scheduled", "canceled", "published"],
  published: [],
};

export function canTransition(from: PostStatus, to: PostStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses the scheduler may pick up when due. */
export const PENDING_STATUSES: readonly PostStatus[] = ["scheduled", "retry_waiting"];
/** Statuses where platform calls may be in progress. Content is locked. */
export const IN_FLIGHT_STATUSES: readonly PostStatus[] = ["preparing", "publishing"];

export type FailureKind = "transient" | "rate_limited" | "auth_expired" | "permanent" | "ambiguous";

/**
 * Thrown by platform adapters. `safeMessage` must never contain tokens, signed
 * URLs or raw provider payloads; it is stored and shown to the user.
 *
 * Adapters must only use `rate_limited`, `auth_expired` or `permanent` for the
 * irreversible publish call when the platform definitively refused it. Anything
 * that might have succeeded (timeouts, dropped connections, 5xx) is `ambiguous`.
 */
export class PlatformError extends Error {
  readonly kind: FailureKind;
  readonly code: string;
  readonly retryAfterMs: number | undefined;
  readonly safeMessage: string;
  constructor(kind: FailureKind, code: string, safeMessage: string, retryAfterMs?: number) {
    super(`${kind}: ${code}`);
    this.name = "PlatformError";
    this.kind = kind;
    this.code = code;
    this.safeMessage = safeMessage;
    this.retryAfterMs = retryAfterMs;
  }
}

export const RETRY_POLICY = {
  maxAttempts: 6,
  baseDelayMs: 60_000,
  maxDelayMs: 60 * 60_000,
  /** Provider-requested waits are honoured up to this bound. */
  maxRetryAfterMs: 24 * 60 * 60_000,
} as const;

/**
 * Exponential backoff with jitter (50–100% of the exponential step), bounded.
 * A provider Retry-After is honoured when longer.
 */
export function backoffMs(attempt: number, random: () => number = Math.random, retryAfterMs?: number): number {
  const exp = Math.min(RETRY_POLICY.maxDelayMs, RETRY_POLICY.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exp * (0.5 + random() * 0.5));
  if (retryAfterMs !== undefined) return Math.max(jittered, Math.min(retryAfterMs, RETRY_POLICY.maxRetryAfterMs));
  return jittered;
}

export const DEFAULT_MISSED_GRACE_MINUTES = 30;

/**
 * Work not yet started may still publish if it is at most `graceMinutes` late;
 * older work needs the user's review. Retries and reconciliation of work that
 * already started are not "missed" and are handled separately.
 */
export function isMissed(scheduledAt: string, now: Date, graceMinutes: number): boolean {
  return now.getTime() - Date.parse(scheduledAt) > graceMinutes * 60_000;
}
