// Platform-independent account rules. No I/O here.
import { DomainError } from "./errors.ts";

export const PLATFORMS = ["instagram", "pinterest"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "Instagram",
  pinterest: "Pinterest",
};

export type ConnectionState = "unconnected" | "connected" | "needs_reconnect" | "disconnected";

export const DISPLAY_NAME_MAX = 60;

export interface VerifiedIdentity {
  providerAccountId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  accountType: string | null;
  verifiedAt: string;
}

export interface Account {
  id: string;
  platform: Platform;
  displayName: string;
  sortOrder: number;
  archivedAt: string | null;
  connectionState: ConnectionState;
  identity: VerifiedIdentity | null;
  credentialRef: string | null;
  schedulesNeedReview: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

// C0/C1 controls plus bidi overrides, which can disguise names.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const DISALLOWED = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export function normalizeDisplayName(raw: string): string {
  const name = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (DISALLOWED.test(name)) throw new DomainError("validation", "Display name contains unsupported characters.");
  if (name.length === 0) throw new DomainError("validation", "Enter a display name.");
  if ([...name].length > DISPLAY_NAME_MAX) {
    throw new DomainError("validation", `Display names can be at most ${DISPLAY_NAME_MAX} characters.`);
  }
  return name;
}

export function isActive(a: Account): boolean {
  return a.archivedAt === null;
}

/**
 * Whether the scheduler may publish for this account at all. Unconnected,
 * disconnected, archived, or under-review accounts never publish.
 */
export function canPublish(a: Account): boolean {
  return isActive(a) && a.connectionState === "connected" && !a.schedulesNeedReview;
}

export function assertCanArchive(a: Account): void {
  if (!isActive(a)) throw new DomainError("invalid_state", "This account is already archived.");
}

export function assertCanRestore(a: Account): void {
  if (isActive(a)) throw new DomainError("invalid_state", "This account is not archived.");
}

/**
 * Validates a newly verified identity before it is attached to `account`.
 * `ownerOfIdentity` is the active account already holding that identity, if any.
 */
export function assertCanConnect(account: Account, identity: VerifiedIdentity, ownerOfIdentity: Account | null): void {
  if (!isActive(account)) throw new DomainError("invalid_state", "Restore this account before connecting it.");
  if (identity.providerAccountId.trim() === "") throw new DomainError("validation", "The platform returned no account ID.");
  if (
    account.identity !== null &&
    account.connectionState !== "unconnected" &&
    account.identity.providerAccountId !== identity.providerAccountId
  ) {
    // Reconnecting must not silently swap which real account a tab posts to.
    throw new DomainError(
      "invalid_state",
      "This tab was connected to a different account before. Create a new tab for the other account.",
    );
  }
  if (ownerOfIdentity && ownerOfIdentity.id !== account.id) {
    throw new DomainError(
      "duplicate_identity",
      `That ${PLATFORM_LABELS[account.platform]} account is already connected to “${ownerOfIdentity.displayName}”.`,
    );
  }
}
