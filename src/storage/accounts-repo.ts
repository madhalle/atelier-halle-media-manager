// SQLite persistence for accounts. Every write is a short transaction guarded
// by the row revision where the caller supplies one.
import { randomUUID } from "node:crypto";
import {
  assertCanArchive,
  assertCanConnect,
  assertCanRestore,
  normalizeDisplayName,
  type Account,
  type ConnectionState,
  type Platform,
  type VerifiedIdentity,
} from "../domain/accounts.ts";
import { DomainError } from "../domain/errors.ts";
import type { Db } from "./db.ts";

interface AccountRow {
  id: string;
  platform: Platform;
  display_name: string;
  sort_order: number;
  archived_at: string | null;
  connection_state: ConnectionState;
  provider_account_id: string | null;
  provider_username: string | null;
  provider_display_name: string | null;
  provider_avatar_url: string | null;
  provider_account_type: string | null;
  identity_verified_at: string | null;
  credential_ref: string | null;
  schedules_need_review: 0 | 1;
  revision: number;
  created_at: string;
  updated_at: string;
}

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    platform: r.platform,
    displayName: r.display_name,
    sortOrder: r.sort_order,
    archivedAt: r.archived_at,
    connectionState: r.connection_state,
    identity:
      r.provider_account_id === null
        ? null
        : {
            providerAccountId: r.provider_account_id,
            username: r.provider_username,
            displayName: r.provider_display_name,
            avatarUrl: r.provider_avatar_url,
            accountType: r.provider_account_type,
            verifiedAt: r.identity_verified_at ?? r.updated_at,
          },
    credentialRef: r.credential_ref,
    schedulesNeedReview: r.schedules_need_review === 1,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

export function createAccountsRepo(db: Db, now: () => Date = () => new Date()) {
  const iso = () => now().toISOString();

  const selectAll = db.prepare<[], AccountRow>(
    "SELECT * FROM accounts ORDER BY archived_at IS NOT NULL, sort_order, created_at",
  );
  const selectActive = db.prepare<[], AccountRow>(
    "SELECT * FROM accounts WHERE archived_at IS NULL ORDER BY sort_order, created_at",
  );
  const selectOne = db.prepare<[string], AccountRow>("SELECT * FROM accounts WHERE id = ?");
  const selectIdentityOwner = db.prepare<[Platform, string], AccountRow>(
    `SELECT * FROM accounts
     WHERE platform = ? AND provider_account_id = ? AND archived_at IS NULL
       AND connection_state IN ('connected', 'needs_reconnect')`,
  );
  const nextSortOrder = db.prepare<[], { n: number }>(
    "SELECT coalesce(max(sort_order), -1) + 1 AS n FROM accounts WHERE archived_at IS NULL",
  );

  function require(id: string): Account {
    const row = selectOne.get(id);
    if (!row) throw new DomainError("not_found", "Account not found.");
    return toAccount(row);
  }

  function checkRevision(a: Account, expected: number | undefined): void {
    if (expected !== undefined && a.revision !== expected) {
      throw new DomainError("stale_revision", "This account changed in another window. Reload and try again.");
    }
  }

  /** Runs `fn` in a transaction and returns the account re-read afterwards. */
  function mutate(id: string, fn: (a: Account) => void): Account {
    return db.transaction(() => {
      fn(require(id));
      return require(id);
    })();
  }

  const bump = "revision = revision + 1, updated_at = @now";

  return {
    list(opts: { includeArchived?: boolean } = {}): Account[] {
      return (opts.includeArchived ? selectAll : selectActive).all().map(toAccount);
    },

    get(id: string): Account {
      return require(id);
    },

    create(input: { platform: Platform; displayName: string }): Account {
      const displayName = normalizeDisplayName(input.displayName);
      const id = randomUUID();
      const t = iso();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO accounts (id, platform, display_name, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, input.platform, displayName, nextSortOrder.get()!.n, t, t);
      })();
      return require(id);
    },

    rename(id: string, displayName: string, expectedRevision?: number): Account {
      const name = normalizeDisplayName(displayName);
      return mutate(id, (a) => {
        checkRevision(a, expectedRevision);
        db.prepare(`UPDATE accounts SET display_name = @name, ${bump} WHERE id = @id`).run({ id, name, now: iso() });
      });
    },

    /** `orderedIds` must be exactly the current active accounts, in the new order. */
    reorder(orderedIds: string[]): Account[] {
      return db.transaction(() => {
        const active = selectActive.all().map((r) => r.id);
        const unique = new Set(orderedIds);
        if (unique.size !== orderedIds.length || unique.size !== active.length || !active.every((id) => unique.has(id))) {
          throw new DomainError("stale_revision", "The account list changed. Reload and try again.");
        }
        const update = db.prepare(`UPDATE accounts SET sort_order = @order, ${bump} WHERE id = @id`);
        const t = iso();
        orderedIds.forEach((id, order) => update.run({ id, order, now: t }));
        return selectActive.all().map(toAccount);
      })();
    },

    /** Archiving keeps all content and history but pauses publication. */
    archive(id: string, expectedRevision?: number): Account {
      return mutate(id, (a) => {
        checkRevision(a, expectedRevision);
        assertCanArchive(a);
        db.prepare(`UPDATE accounts SET archived_at = @now, schedules_need_review = 1, ${bump} WHERE id = @id`).run({
          id,
          now: iso(),
        });
      });
    },

    /**
     * Restores to the end of the list. Schedules stay paused for review. If the
     * same platform identity was connected to another tab meanwhile, this tab
     * comes back disconnected rather than violating identity uniqueness.
     */
    restore(id: string, expectedRevision?: number): Account {
      return mutate(id, (a) => {
        checkRevision(a, expectedRevision);
        assertCanRestore(a);
        const taken =
          a.identity !== null &&
          (a.connectionState === "connected" || a.connectionState === "needs_reconnect") &&
          selectIdentityOwner.get(a.platform, a.identity.providerAccountId) !== undefined;
        db.prepare(
          `UPDATE accounts SET archived_at = NULL, sort_order = @order, schedules_need_review = 1,
             connection_state = CASE WHEN @taken THEN 'disconnected' ELSE connection_state END,
             credential_ref = CASE WHEN @taken THEN NULL ELSE credential_ref END,
             ${bump}
           WHERE id = @id`,
        ).run({ id, order: nextSortOrder.get()!.n, taken: taken ? 1 : 0, now: iso() });
      });
    },

    /** Records a verified platform identity. Any connection change requires schedule review. */
    markConnected(id: string, identity: VerifiedIdentity, credentialRef: string): Account {
      try {
        return mutate(id, (a) => {
          const owner = selectIdentityOwner.get(a.platform, identity.providerAccountId);
          assertCanConnect(a, identity, owner ? toAccount(owner) : null);
          db.prepare(
            `UPDATE accounts SET connection_state = 'connected', provider_account_id = @pid,
               provider_username = @username, provider_display_name = @pname, provider_avatar_url = @avatar,
               provider_account_type = @type, identity_verified_at = @verifiedAt, credential_ref = @cred,
               schedules_need_review = 1, ${bump}
             WHERE id = @id`,
          ).run({
            id,
            pid: identity.providerAccountId,
            username: identity.username,
            pname: identity.displayName,
            avatar: identity.avatarUrl,
            type: identity.accountType,
            verifiedAt: identity.verifiedAt,
            cred: credentialRef,
            now: iso(),
          });
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new DomainError("duplicate_identity", "That platform account is already connected to another tab.");
        }
        throw err;
      }
    },

    /** Removes the credential reference; keeps the identity so reconnection can be verified. */
    markDisconnected(id: string): Account {
      return mutate(id, (a) => {
        if (a.connectionState === "unconnected") throw new DomainError("invalid_state", "This account is not connected.");
        db.prepare(
          `UPDATE accounts SET connection_state = 'disconnected', credential_ref = NULL,
             schedules_need_review = 1, ${bump}
           WHERE id = @id`,
        ).run({ id, now: iso() });
      });
    },

    acknowledgeScheduleReview(id: string, expectedRevision?: number): Account {
      return mutate(id, (a) => {
        checkRevision(a, expectedRevision);
        if (a.archivedAt !== null) throw new DomainError("invalid_state", "Restore this account first.");
        db.prepare(`UPDATE accounts SET schedules_need_review = 0, ${bump} WHERE id = @id`).run({ id, now: iso() });
      });
    },
  };
}

export type AccountsRepo = ReturnType<typeof createAccountsRepo>;
