// Instagram through a Meta business portfolio: a system-user token (generated
// in the Meta App Dashboard, stored in the Keychain) instead of Instagram
// Login. These tokens don't expire and use graph.facebook.com. Meta's newer
// apps ("API setup with Unified login") only offer this route, and their
// OAuth redirect must be HTTPS, which a loopback app can't serve.
//
//   accounts  → GET /me/assigned_instagram_accounts (the portfolio's Instagram
//               accounts assigned to the system user). Observed live
//               (2026-11-04): empty for a system user that does have assigned
//               accounts, so an account can also be looked up by its ID.
//   lookup    → GET /{ig-user-id}?fields=id,username,name (succeeds only if the
//               token can reach the account)
//   scopes    → GET /me/permissions
import { z } from "zod";
import { PlatformError } from "../domain/publishing.ts";
import type { PlatformConfig } from "../storage/platform-config.ts";
import { GRAPH_VERSION, type Endpoints, type HttpClient } from "./http.ts";
import { classifyResponse, send } from "./oauth.ts";

export const INSTAGRAM_BUSINESS_SCOPES = ["instagram_basic", "instagram_content_publish"] as const;

/** System-user tokens don't expire; stored with a far-future date so renewal never triggers. */
export const NEVER_EXPIRES = "9999-12-31T00:00:00.000Z";
/**
 * Stored per account instead of the token itself: the one token lives only in
 * Platform setup, so removing or replacing it there applies to every account.
 */
export const BUSINESS_TOKEN_REFERENCE = "business-portfolio-token";

const Assigned = z.object({
  data: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      username: z.string().optional(),
      name: z.string().optional(),
      profile_picture_url: z.string().optional(),
    }),
  ),
});
const IgUser = z.object({ id: z.union([z.string(), z.number()]), username: z.string().optional(), name: z.string().optional() });
const Permissions = z.object({ data: z.array(z.object({ permission: z.string(), status: z.string() })) });

export interface BusinessInstagramAccount {
  id: string;
  username: string | null;
  name: string | null;
}

export interface BusinessAccess {
  accounts: BusinessInstagramAccount[];
  /** Granted scopes, or null if Meta wouldn't say. */
  scopes: string[] | null;
  /** Required scopes that are definitely missing. */
  missing: string[];
}

export function createMetaBusiness(deps: { http: HttpClient; endpoints: Endpoints; config: PlatformConfig }) {
  const url = (path: string, params: Record<string, string>) => {
    const u = new URL(`/${GRAPH_VERSION}/${path}`, deps.endpoints.facebookGraph);
    u.search = new URLSearchParams(params).toString();
    return u;
  };

  async function token(): Promise<string> {
    const t = await deps.config.instagramBusinessToken();
    if (!t) throw new PlatformError("permanent", "no_business_token", "Add the business portfolio token in Settings › Platform setup first.");
    return t;
  }

  return {
    /** One Instagram account by ID, or null if the token can't reach it. */
    async lookup(id: string): Promise<BusinessInstagramAccount | null> {
      const tok = await token();
      const res = await send(deps.http, { method: "GET", url: url(encodeURIComponent(id), { fields: "id,username,name", access_token: tok }), headers: { accept: "application/json" } });
      if (res.status === 401 || (res.json as { error?: { code?: number } } | null)?.error?.code === 190) {
        throw new PlatformError("auth_expired", "business_token_invalid", "Meta rejected the business portfolio token. Generate a new one and save it in Platform setup.");
      }
      if (res.status !== 200) return null;
      const u = IgUser.safeParse(res.json);
      if (!u.success || String(u.data.id) !== id || !u.data.username) return null;
      return { id, username: u.data.username, name: u.data.name ?? null };
    },

    /** What the saved token can reach. Never returns the token. */
    async access(): Promise<{ token: string; access: BusinessAccess }> {
      const tok = await token();
      const perms = await send(deps.http, { method: "GET", url: url("me/permissions", { access_token: tok }), headers: { accept: "application/json" } });
      if (perms.status === 401 || (perms.json as { error?: { code?: number } } | null)?.error?.code === 190) {
        throw new PlatformError("auth_expired", "business_token_invalid", "Meta rejected the business portfolio token. Generate a new one and save it in Platform setup.");
      }
      // If Meta won't list permissions, don't guess: publishing reports a missing permission clearly.
      const parsed = perms.status === 200 ? Permissions.safeParse(perms.json) : null;
      const scopes = parsed?.success ? parsed.data.data.filter((p) => p.status === "granted").map((p) => p.permission) : null;
      const missing = scopes ? INSTAGRAM_BUSINESS_SCOPES.filter((s) => !scopes.includes(s)) : [];

      const res = await send(deps.http, {
        method: "GET",
        url: url("me/assigned_instagram_accounts", { fields: "id,username,name", limit: "50", access_token: tok }),
        headers: { accept: "application/json" },
      });
      if (res.status !== 200) throw classifyResponse("instagram", res, "list the business portfolio's Instagram accounts");
      const list = Assigned.safeParse(res.json);
      if (!list.success) throw new PlatformError("transient", "bad_accounts_response", "Meta answered, but not in the expected format.");
      return {
        token: tok,
        access: {
          accounts: list.data.data.map((a) => ({ id: String(a.id), username: a.username ?? null, name: a.name ?? null })),
          scopes,
          missing,
        },
      };
    },
  };
}

export type MetaBusiness = ReturnType<typeof createMetaBusiness>;
