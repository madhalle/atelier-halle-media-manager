// Deterministic fake platform for tests and local development ONLY.
// Nothing is sent anywhere. Every result it produces is marked simulated, and
// the server refuses to enable it in production.
import type { Platform } from "../domain/accounts.ts";
import { PlatformError, type FailureKind } from "../domain/publishing.ts";
import type { CommitResult, PlatformAdapter, PublishJob, ReconcileResult } from "./types.ts";

type Step = "stage" | "checkStaged" | "commit" | "reconcile";

export type FakeBehavior =
  | { type: "ok" }
  | { type: "pending" }
  | { type: "fail"; kind: FailureKind; code?: string; retryAfterMs?: number }
  /** commit only: the post IS published remotely, but the response is lost. */
  | { type: "lost_response" }
  /** reconcile only */
  | { type: "reconcile"; result: "published" | "not_published" | "unknown" };

export interface FakeCall {
  step: Step;
  postId: string;
  attemptNo: number;
  containerId: string | null;
}

export interface FakePlatform extends PlatformAdapter {
  calls: FakeCall[];
  /** Remote posts that "exist" on the fake platform, by post id. */
  published: Map<string, CommitResult & { count: number }>;
  /** Queue behaviours for the next calls to a step (FIFO). Unqueued calls succeed. */
  script(step: Step, ...behaviors: FakeBehavior[]): void;
  /** Side effects run at the start of a step, e.g. the user cancelling mid-publish (tests). */
  hooks: Partial<Record<Step, (job: PublishJob) => void | Promise<void>>>;
}

/**
 * Text-driven scripting for browser tests and manual development, where the
 * test cannot reach into the server process: a caption or description
 * containing "[fake:permanent]", "[fake:transient]", "[fake:lost]" or
 * "[fake:ambiguous]" selects that behaviour for the commit step; "[fake:unknown]"
 * also makes reconciliation inconclusive.
 */
function markerBehavior(job: PublishJob): FakeBehavior | null {
  const text = `${job.caption} ${job.pinDescription}`;
  if (text.includes("[fake:permanent]")) return { type: "fail", kind: "permanent", code: "fake_permanent" };
  if (text.includes("[fake:transient]")) return { type: "fail", kind: "transient", code: "fake_transient" };
  if (text.includes("[fake:auth]")) return { type: "fail", kind: "auth_expired", code: "fake_auth" };
  if (text.includes("[fake:lost]")) return { type: "lost_response" };
  if (text.includes("[fake:ambiguous]") || text.includes("[fake:unknown]")) return { type: "fail", kind: "ambiguous", code: "fake_timeout" };
  return null;
}

export function createFakePlatform(platform: Platform): FakePlatform {
  const queues = new Map<Step, FakeBehavior[]>();
  const calls: FakeCall[] = [];
  const published = new Map<string, CommitResult & { count: number }>();
  let seq = 0;

  const hooks: FakePlatform["hooks"] = {};
  const next = async (step: Step, job: PublishJob): Promise<FakeBehavior> => {
    await hooks[step]?.(job);
    calls.push({ step, postId: job.postId, attemptNo: job.attemptNo, containerId: job.containerId });
    const queued = queues.get(step)?.shift();
    if (queued) return queued;
    if (step === "commit") return markerBehavior(job) ?? { type: "ok" };
    if (step === "reconcile" && `${job.caption} ${job.pinDescription}`.includes("[fake:unknown]")) {
      return { type: "reconcile", result: "unknown" };
    }
    if (step === "reconcile") {
      // Default reconciliation reflects the fake platform's actual state.
      return { type: "reconcile", result: published.has(job.postId) ? "published" : "not_published" };
    }
    return { type: "ok" };
  };

  const fail = (b: FakeBehavior) => {
    if (b.type === "fail") throw new PlatformError(b.kind, b.code ?? `fake_${b.kind}`, `Simulated ${b.kind.replace("_", " ")} failure.`, b.retryAfterMs);
  };

  const publishRemote = (job: PublishJob): CommitResult => {
    const existing = published.get(job.postId);
    const result = { remotePostId: existing?.remotePostId ?? `fake-${platform}-${++seq}`, permalink: null };
    published.set(job.postId, { ...result, count: (existing?.count ?? 0) + 1 });
    return result;
  };

  return {
    platform,
    simulated: true,
    calls,
    published,
    hooks,
    script(step, ...behaviors) {
      queues.set(step, [...(queues.get(step) ?? []), ...behaviors]);
    },
    async stage(job) {
      const b = await next("stage", job);
      fail(b);
      return { containerId: platform === "instagram" ? (job.containerId ?? `fake-container-${++seq}`) : null };
    },
    async checkStaged(job) {
      const b = await next("checkStaged", job);
      fail(b);
      return b.type === "pending" ? "pending" : "ready";
    },
    async commit(job) {
      const b = await next("commit", job);
      if (b.type === "lost_response") {
        publishRemote(job);
        throw new PlatformError("ambiguous", "fake_lost_response", "The connection dropped before the platform answered.");
      }
      fail(b);
      return publishRemote(job);
    },
    async reconcile(job): Promise<ReconcileResult> {
      const b = await next("reconcile", job);
      fail(b);
      if (b.type !== "reconcile") return { state: "unknown" };
      if (b.result === "published") {
        const p = published.get(job.postId);
        return { state: "published", remotePostId: p?.remotePostId ?? `fake-${platform}-reconciled`, permalink: p?.permalink ?? null };
      }
      return { state: b.result };
    },
  };
}
