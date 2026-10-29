// Local browser authentication.
//
// The server mints short-lived, single-use launch tokens. Exchanging one at
// /launch creates a random session, stored only in this process's memory and
// delivered as an HttpOnly SameSite=Strict cookie. Restarting the server ends
// all sessions; open a fresh launch link afterwards.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const LAUNCH_TOKEN_TTL_MS = 10 * 60_000;
export const SESSION_IDLE_TTL_MS = 12 * 60 * 60_000;
export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60_000;

export interface Session {
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
}

const token = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createSessionStore(now: () => number = Date.now) {
  // Keys are SHA-256 digests so raw secrets are not kept as map keys.
  const launchTokens = new Map<string, number>();
  const sessions = new Map<string, Session>();

  function sweep(): void {
    const t = now();
    for (const [k, expires] of launchTokens) if (expires <= t) launchTokens.delete(k);
    for (const [k, s] of sessions) if (isExpired(s, t)) sessions.delete(k);
  }

  function isExpired(s: Session, t: number): boolean {
    return t - s.lastSeenAt > SESSION_IDLE_TTL_MS || t - s.createdAt > SESSION_ABSOLUTE_TTL_MS;
  }

  return {
    mintLaunchToken(): string {
      sweep();
      const value = token();
      launchTokens.set(digest(value), now() + LAUNCH_TOKEN_TTL_MS);
      return value;
    },

    /** Consumes a launch token. Returns a new session id, or null. */
    exchangeLaunchToken(value: string): string | null {
      const key = digest(value);
      const expires = launchTokens.get(key);
      launchTokens.delete(key);
      if (expires === undefined || expires <= now()) return null;
      const id = token();
      sessions.set(digest(id), { csrfToken: token(), createdAt: now(), lastSeenAt: now() });
      return id;
    },

    get(id: string | undefined): Session | null {
      if (!id) return null;
      const key = digest(id);
      const session = sessions.get(key);
      if (!session) return null;
      const t = now();
      if (isExpired(session, t)) {
        sessions.delete(key);
        return null;
      }
      session.lastSeenAt = t;
      return session;
    },

    destroy(id: string | undefined): void {
      if (id) sessions.delete(digest(id));
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
