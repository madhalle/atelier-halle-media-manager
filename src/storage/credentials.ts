// Secret storage. Production uses the macOS Keychain; SQLite only ever holds
// opaque references. There is deliberately no plaintext fallback: if the
// Keychain can't be used, operations fail with CredentialUnavailable and the
// affected work pauses with an actionable message.
import { randomUUID } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";

export interface CredentialStore {
  readonly kind: "keychain" | "memory";
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  /** Round-trips a throwaway item to confirm the store works in this context. */
  probe(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export class CredentialUnavailable extends Error {
  constructor(message = "The macOS Keychain couldn't be used. Unlock it or allow access for this app, then try again.") {
    super(message);
    this.name = "CredentialUnavailable";
  }
}

const REF_PATTERN = /^(cred|app):[a-z0-9:_-]{1,120}$/;

export function newCredentialRef(): string {
  return `cred:${randomUUID()}`;
}

function assertRef(ref: string): void {
  if (!REF_PATTERN.test(ref)) throw new Error("Invalid credential reference");
}

const KEYCHAIN_TIMEOUT_MS = 15_000;

/** Keychain items live under one service name per environment, e.g. "com.atelierhalle.media-manager". */
export function createKeychainStore(service: string): CredentialStore {
  const entry = (ref: string) => {
    assertRef(ref);
    return new AsyncEntry(service, ref);
  };
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch {
      // The underlying error text can include item names; keep it out of logs and the UI.
      throw new CredentialUnavailable();
    }
  };
  const signal = () => AbortSignal.timeout(KEYCHAIN_TIMEOUT_MS);

  const store: CredentialStore = {
    kind: "keychain",
    get: (ref) => guard(() => entry(ref).getPassword(signal())),
    set: (ref, value) => guard(() => entry(ref).setPassword(value, signal())),
    delete: (ref) => guard(async () => void (await entry(ref).deletePassword(signal()))),
    async probe() {
      const ref = `app:probe-${randomUUID()}`;
      try {
        await store.set(ref, "probe");
        const ok = (await store.get(ref)) === "probe";
        await store.delete(ref);
        return ok ? { ok: true } : { ok: false, reason: "The Keychain returned an unexpected value." };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : "Keychain unavailable." };
      }
    },
  };
  return store;
}

/** For tests and development only. Never used in production. */
export function createMemoryStore(opts: { failing?: boolean } = {}): CredentialStore & { dump(): Map<string, string>; failing: boolean } {
  const data = new Map<string, string>();
  const store = {
    kind: "memory" as const,
    failing: opts.failing ?? false,
    dump: () => new Map(data),
    async get(ref: string) {
      assertRef(ref);
      if (store.failing) throw new CredentialUnavailable();
      return data.get(ref) ?? null;
    },
    async set(ref: string, value: string) {
      assertRef(ref);
      if (store.failing) throw new CredentialUnavailable();
      data.set(ref, value);
    },
    async delete(ref: string) {
      assertRef(ref);
      if (store.failing) throw new CredentialUnavailable();
      data.delete(ref);
    },
    async probe() {
      return store.failing ? ({ ok: false, reason: "Simulated Keychain failure." } as const) : ({ ok: true } as const);
    },
  };
  return store;
}
