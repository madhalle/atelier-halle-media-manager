// The boundary between the scheduler and a social platform. Publishing is split
// into repeatable pre-commit steps and one irreversible commit, so the
// scheduler can persist progress and never blindly repeat the commit.
import type { Platform } from "../domain/accounts.ts";

export interface PublishJob {
  postId: string;
  attemptNo: number;
  platform: Platform;
  providerAccountId: string;
  credentialRef: string;
  /** Text fields relevant to the platform. */
  caption: string;
  altText: string;
  pinTitle: string;
  pinDescription: string;
  pinLink: string;
  pinBoardId: string | null;
  /** Prepared derivative file on disk (JPEG, metadata stripped). */
  derivative: { file: string; sha256: string };
  /** Remote identifier from an earlier stage call, if any. */
  containerId: string | null;
}

export interface CommitResult {
  remotePostId: string;
  permalink: string | null;
}

export type ReconcileResult = ({ state: "published" } & CommitResult) | { state: "not_published" } | { state: "unknown" };

export interface PlatformAdapter {
  readonly platform: Platform;
  /** True only for fakes. Simulated results are labelled everywhere. */
  readonly simulated: boolean;
  /** Repeatable, pre-commit. Returns a remote id to persist immediately (e.g. an Instagram container). */
  stage(job: PublishJob): Promise<{ containerId: string | null }>;
  /** Repeatable, pre-commit. "pending" means try again later. Throws PlatformError on failure. */
  checkStaged(job: PublishJob): Promise<"ready" | "pending">;
  /** The irreversible publish. */
  commit(job: PublishJob): Promise<CommitResult>;
  /** After an interrupted or uncertain commit: did the post go out? */
  reconcile(job: PublishJob, commitStartedAt: Date): Promise<ReconcileResult>;
}

/** Returns the adapter for a platform, or null when publishing isn't set up for it. */
export type AdapterRegistry = (platform: Platform) => PlatformAdapter | null;

export const NO_ADAPTERS: AdapterRegistry = () => null;
