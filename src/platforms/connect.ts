// Connecting and disconnecting real platform accounts.
//
// Flow: an authenticated browser session asks to connect → we mint a random,
// single-use, 10-minute `state` bound to that session → the user signs in on
// the platform → the platform redirects back with `code` + `state` → our
// callback page posts them (with the session cookie and CSRF token) → we
// verify the state belongs to this session, exchange the code server-side,
// verify the real identity and eligibility, and only then store tokens.
import { createHash, randomBytes } from "node:crypto";
import type { Account, Platform } from "../domain/accounts.ts";
import { PLATFORM_LABELS } from "../domain/accounts.ts";
import { DomainError } from "../domain/errors.ts";
import { PlatformError } from "../domain/publishing.ts";
import type { AccountsRepo } from "../storage/accounts-repo.ts";
import { newCredentialRef, type CredentialStore } from "../storage/credentials.ts";
import type { PlatformConfig } from "../storage/platform-config.ts";
import type { OAuthProvider } from "./oauth.ts";
import type { TokenManager } from "./tokens.ts";

export const FLOW_TTL_MS = 10 * 60_000;
const MAX_PENDING_FLOWS = 20;

interface PendingFlow {
  accountId: string;
  platform: Platform;
  sessionKey: string;
  redirectUri: string;
  expiresAt: number;
}

const digest = (v: string) => createHash("sha256").update(v).digest("hex");

export function redirectUriFor(platform: Platform, host: string, port: number): string {
  return `http://${host}:${port}/oauth/${platform}/callback`;
}

export function createConnectionService(deps: {
  accounts: AccountsRepo;
  config: PlatformConfig;
  providers: Record<Platform, OAuthProvider>;
  tokens: TokenManager;
  credentials: CredentialStore;
  port: number;
  now: () => Date;
}) {
  const flows = new Map<string, PendingFlow>();

  const sweep = () => {
    const t = deps.now().getTime();
    for (const [k, f] of flows) if (f.expiresAt <= t) flows.delete(k);
  };

  return {
    redirectUri(platform: Platform): string {
      const v = deps.config.view();
      return redirectUriFor(platform, platform === "instagram" ? v.instagram.redirectHost : v.pinterest.redirectHost, deps.port);
    },

    async start(accountId: string, sessionId: string): Promise<{ authorizeUrl: string }> {
      const account = deps.accounts.get(accountId);
      if (account.archivedAt !== null) throw new DomainError("invalid_state", "Restore this account before connecting it.");
      const app = await deps.config.appCredentials(account.platform);
      if (!app) {
        throw new DomainError("invalid_state", `Set up the ${PLATFORM_LABELS[account.platform]} developer app in Settings › Platform setup first.`);
      }
      sweep();
      if (flows.size >= MAX_PENDING_FLOWS) throw new DomainError("invalid_state", "Too many sign-ins in progress. Wait a few minutes and try again.");
      const state = randomBytes(32).toString("base64url");
      const redirectUri = this.redirectUri(account.platform);
      flows.set(digest(state), {
        accountId,
        platform: account.platform,
        sessionKey: digest(sessionId),
        redirectUri,
        expiresAt: deps.now().getTime() + FLOW_TTL_MS,
      });
      return { authorizeUrl: deps.providers[account.platform].authorizeUrl(app, redirectUri, state) };
    },

    async complete(platform: Platform, input: { state: string; code?: string | undefined; error?: string | undefined }, sessionId: string): Promise<Account> {
      const key = digest(input.state);
      const flow = flows.get(key);
      flows.delete(key); // single use, whatever happens next
      if (!flow || flow.expiresAt <= deps.now().getTime()) {
        throw new DomainError("validation", "This sign-in link has expired or was already used. Start connecting again.");
      }
      if (flow.platform !== platform || flow.sessionKey !== digest(sessionId)) {
        throw new DomainError("validation", "This sign-in didn't start in this browser session. Start connecting again.");
      }
      if (input.error || !input.code) {
        throw new DomainError("validation", `Signing in to ${PLATFORM_LABELS[platform]} was canceled or refused. Nothing was connected.`);
      }

      const app = await deps.config.appCredentials(platform);
      if (!app) throw new DomainError("invalid_state", "The platform setup changed during sign-in. Try again.");
      const provider = deps.providers[platform];
      const now = deps.now();
      let check;
      let tokens;
      try {
        tokens = await provider.exchange(app, input.code, flow.redirectUri, now);
        check = await provider.identify(tokens, now);
      } catch (err) {
        if (err instanceof PlatformError) throw new DomainError("invalid_state", err.safeMessage);
        throw err;
      }
      // Ineligible accounts: the tokens are discarded, never stored.
      if (!check.eligible) throw new DomainError("invalid_state", check.reason ?? "This account can't be used for publishing.");

      const before = deps.accounts.get(flow.accountId);
      const ref = newCredentialRef();
      await deps.tokens.save(ref, tokens);
      let connected: Account;
      try {
        connected = deps.accounts.markConnected(flow.accountId, check.identity, ref);
      } catch (err) {
        await deps.credentials.delete(ref).catch(() => undefined);
        throw err;
      }
      if (before.credentialRef && before.credentialRef !== ref) await deps.tokens.remove(before.credentialRef).catch(() => undefined);
      return connected;
    },

    /**
     * Stops publishing immediately, then deletes the local credential. Neither
     * platform offers user-token revocation through the API, so the app's
     * access must also be removed in the platform's own settings.
     */
    async disconnect(accountId: string): Promise<{ account: Account; credentialRemoved: boolean; followUp: string }> {
      const before = deps.accounts.get(accountId);
      const account = deps.accounts.markDisconnected(accountId);
      let credentialRemoved = true;
      if (before.credentialRef) {
        try {
          await deps.tokens.remove(before.credentialRef);
        } catch {
          credentialRemoved = false;
        }
      }
      // Menu paths aren't stated: they change and haven't been verified here.
      const followUp = `${PLATFORM_LABELS[before.platform]} doesn't let apps revoke their own access, so the platform still lists this app as connected. To fully revoke it, remove the app in your ${PLATFORM_LABELS[before.platform]} account's connected apps settings.`;
      return { account, credentialRemoved, followUp };
    },

    /** Test hook. */
    _pending: () => flows.size,
  };
}

export type ConnectionService = ReturnType<typeof createConnectionService>;
