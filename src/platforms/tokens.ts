// Access tokens for connected accounts: stored in the credential store under
// the account's opaque credential reference, renewed before they expire, and
// renewed one-at-a-time per account so concurrent work can't race a refresh.
import type { Account, Platform } from "../domain/accounts.ts";
import { PlatformError } from "../domain/publishing.ts";
import { CredentialUnavailable, type CredentialStore } from "../storage/credentials.ts";
import type { PlatformConfig } from "../storage/platform-config.ts";
import { TokenSetSchema, type OAuthProvider, type TokenSet } from "./oauth.ts";

/** Renew this far ahead of expiry. Instagram tokens die after 60 days without a refresh. */
const RENEW_BEFORE_MS: Record<Platform, number> = { instagram: 10 * 24 * 3600_000, pinterest: 24 * 3600_000 };
/** Instagram only allows refreshing tokens at least 24 hours old. */
const IG_MIN_AGE_MS = 24 * 3600_000;

export function createTokenManager(deps: {
  credentials: CredentialStore;
  config: PlatformConfig;
  providers: Record<Platform, OAuthProvider>;
  now: () => Date;
}) {
  const locks = new Map<string, Promise<unknown>>();

  /** Serializes `fn` per credential reference. */
  function exclusive<T>(ref: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(ref) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    locks.set(ref, tail);
    void tail.then(() => {
      if (locks.get(ref) === tail) locks.delete(ref);
    });
    return run;
  }

  async function load(ref: string): Promise<TokenSet> {
    let raw: string | null;
    try {
      raw = await deps.credentials.get(ref);
    } catch (err) {
      if (err instanceof CredentialUnavailable) throw new PlatformError("transient", "keychain_unavailable", err.message);
      throw err;
    }
    if (!raw) throw new PlatformError("auth_expired", "missing_token", "This account's saved sign-in is missing. Reconnect it.");
    const parsed = TokenSetSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new PlatformError("auth_expired", "corrupt_token", "This account's saved sign-in is unreadable. Reconnect it.");
    return parsed.data;
  }

  async function save(ref: string, tokens: TokenSet): Promise<void> {
    try {
      await deps.credentials.set(ref, JSON.stringify(tokens));
    } catch (err) {
      if (err instanceof CredentialUnavailable) throw new PlatformError("transient", "keychain_unavailable", err.message);
      throw err;
    }
  }

  function needsRenewal(platform: Platform, t: TokenSet, now: Date): boolean {
    const left = Date.parse(t.accessExpiresAt) - now.getTime();
    if (left > RENEW_BEFORE_MS[platform]) return false;
    if (platform === "instagram" && now.getTime() - Date.parse(t.obtainedAt) < IG_MIN_AGE_MS) return false;
    return true;
  }

  async function renew(platform: Platform, ref: string, t: TokenSet, now: Date): Promise<TokenSet> {
    const app = await deps.config.appCredentials(platform);
    if (!app) throw new PlatformError("auth_expired", "app_not_configured", "The app's platform setup is incomplete.");
    const fresh = await deps.providers[platform].refresh(app, t, now);
    await save(ref, fresh);
    return fresh;
  }

  return {
    save: (ref: string, tokens: TokenSet) => exclusive(ref, () => save(ref, tokens)),

    /** A usable access token, renewing first if it's close to expiry. */
    accessToken(account: Pick<Account, "platform" | "credentialRef">): Promise<string> {
      const ref = account.credentialRef;
      if (!ref) return Promise.reject(new PlatformError("auth_expired", "not_connected", "This account isn't connected."));
      return exclusive(ref, async () => {
        const now = deps.now();
        let t = await load(ref);
        if (needsRenewal(account.platform, t, now)) {
          try {
            t = await renew(account.platform, ref, t, now);
          } catch (err) {
            // Still valid? Use it and try renewing next time.
            if (Date.parse(t.accessExpiresAt) > now.getTime() + 60_000 && !(err instanceof PlatformError && err.kind === "auth_expired")) return t.accessToken;
            throw err;
          }
        }
        if (Date.parse(t.accessExpiresAt) <= now.getTime()) {
          throw new PlatformError("auth_expired", "token_expired", "The connection expired. Reconnect this account.");
        }
        return t.accessToken;
      });
    },

    /** Proactive renewal for accounts nearing expiry. Returns accounts that need reconnecting. */
    async renewDue(accounts: Account[]): Promise<string[]> {
      const failed: string[] = [];
      for (const a of accounts) {
        if (a.connectionState !== "connected" || !a.credentialRef || a.archivedAt) continue;
        try {
          await this.accessToken(a);
        } catch (err) {
          if (err instanceof PlatformError && err.kind === "auth_expired") failed.push(a.id);
        }
      }
      return failed;
    },

    async remove(ref: string): Promise<void> {
      await exclusive(ref, () => deps.credentials.delete(ref));
    },

    /** Test hook. */
    _load: load,
  };
}

export type TokenManager = ReturnType<typeof createTokenManager>;
