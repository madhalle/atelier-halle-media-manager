// Builds the platform-facing services once, so the HTTP server and the
// scheduler share one token manager (and its per-account renewal locks).
import type { Platform } from "../domain/accounts.ts";
import { createR2Stager } from "../delivery/r2.ts";
import type { AccountsRepo } from "../storage/accounts-repo.ts";
import type { CredentialStore } from "../storage/credentials.ts";
import type { Db } from "../storage/db.ts";
import { createPlatformConfig } from "../storage/platform-config.ts";
import { createConnectionService } from "./connect.ts";
import { createHttpClient, endpointOrigins, PRODUCTION_ENDPOINTS, type Endpoints } from "./http.ts";
import { createInstagramAdapter } from "./instagram.ts";
import { instagramOAuth, pinterestOAuth } from "./oauth.ts";
import { createPinterestAdapter } from "./pinterest.ts";
import { createTokenManager } from "./tokens.ts";
import type { AdapterRegistry, PlatformAdapter } from "./types.ts";

export interface PlatformServiceOptions {
  db: Db;
  accounts: AccountsRepo;
  credentials: CredentialStore;
  port: number;
  now: () => Date;
  /** Loopback fakes in tests; production endpoints otherwise. */
  endpoints?: Endpoints;
  fetchImpl?: typeof fetch;
  /** Only tests may talk plain HTTP, and only to loopback. */
  allowInsecureLoopback?: boolean;
}

export function createPlatformServices(o: PlatformServiceOptions) {
  const endpoints = o.endpoints ?? PRODUCTION_ENDPOINTS;
  const config = createPlatformConfig(o.db, o.credentials, o.now);
  const http = createHttpClient({
    allowedOrigins: (origin) => endpointOrigins(endpoints, config.view().r2.accountId).has(origin),
    allowInsecureLoopback: o.allowInsecureLoopback ?? false,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  const providers = { instagram: instagramOAuth(http, endpoints), pinterest: pinterestOAuth(http, endpoints) };
  const tokens = createTokenManager({ credentials: o.credentials, config, providers, now: o.now });
  const connections = createConnectionService({ accounts: o.accounts, config, providers, tokens, credentials: o.credentials, port: o.port, now: o.now });
  const pinterest = createPinterestAdapter({ http, endpoints, tokens, config, now: o.now });
  const stager = createR2Stager({ http, endpoints, config, now: o.now });
  const instagram = createInstagramAdapter({ http, endpoints, tokens, stager, now: o.now });
  const live: Record<Platform, PlatformAdapter> = { instagram, pinterest };

  /** Real adapters, only when live publishing is enabled and the developer app is set up. */
  const registry = (livePublishing: boolean): AdapterRegistry => (p) => (livePublishing && config.isConfigured(p) ? live[p] : null);

  return { endpoints, config, http, providers, tokens, connections, pinterest, instagram, stager, registry };
}

export type PlatformServices = ReturnType<typeof createPlatformServices>;
