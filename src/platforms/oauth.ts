// OAuth for Instagram (Instagram API with Instagram Login) and Pinterest (v5).
// All exchanges run server-side with the app secret; tokens never reach the
// browser. Provider responses are validated; errors are sanitized.
import { z } from "zod";
import type { Platform, VerifiedIdentity } from "../domain/accounts.ts";
import { PlatformError } from "../domain/publishing.ts";
import { GRAPH_VERSION, HttpFailure, providerErrorText, type Endpoints, type HttpClient, type HttpResponse } from "./http.ts";

export interface TokenSet {
  accessToken: string;
  /** ISO instant. */
  accessExpiresAt: string;
  refreshToken: string | null;
  refreshExpiresAt: string | null;
  scopes: string[];
  obtainedAt: string;
}

export const TokenSetSchema = z.object({
  accessToken: z.string().min(1),
  accessExpiresAt: z.string(),
  refreshToken: z.string().nullable(),
  refreshExpiresAt: z.string().nullable(),
  scopes: z.array(z.string()),
  obtainedAt: z.string(),
});

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
}

export interface IdentityCheck {
  identity: VerifiedIdentity;
  eligible: boolean;
  /** Why the account can't be used for publishing, in user terms. */
  reason: string | null;
}

export interface OAuthProvider {
  readonly platform: Platform;
  readonly scopes: readonly string[];
  /** PKCE isn't documented by either platform (docs/platform-capabilities.md); state + server-side exchange instead. */
  readonly pkce: false;
  authorizeUrl(app: AppCredentials, redirectUri: string, state: string): string;
  exchange(app: AppCredentials, code: string, redirectUri: string, now: Date): Promise<TokenSet>;
  refresh(app: AppCredentials, tokens: TokenSet, now: Date): Promise<TokenSet>;
  identify(tokens: TokenSet, now: Date): Promise<IdentityCheck>;
}

const addSeconds = (now: Date, s: number) => new Date(now.getTime() + s * 1000).toISOString();

/** Maps a provider HTTP failure to a classified, sanitized PlatformError. */
export function classifyResponse(platform: Platform, res: HttpResponse, action: string): PlatformError {
  const detail = providerErrorText(res.json);
  const msg = `${platform === "instagram" ? "Instagram" : "Pinterest"} couldn't ${action}${detail ? `: ${detail}` : "."}`;
  const code = errorCode(res.json) ?? `http_${res.status}`;
  if (res.status === 401 || isGraphAuthError(res.json)) return new PlatformError("auth_expired", code, msg);
  if (res.status === 429 || isGraphRateLimit(res.json)) return new PlatformError("rate_limited", code, msg, retryAfterMs(res));
  if (res.status >= 500) return new PlatformError("transient", code, msg);
  return new PlatformError("permanent", code, msg);
}

function errorCode(json: unknown): string | null {
  const e = (json as { error?: { code?: unknown; error_subcode?: unknown }; code?: unknown } | null) ?? null;
  const c = e?.error?.code ?? e?.code;
  return typeof c === "number" || typeof c === "string" ? `provider_${String(c).slice(0, 20)}` : null;
}

function isGraphAuthError(json: unknown): boolean {
  return (json as { error?: { code?: number } } | null)?.error?.code === 190;
}

function isGraphRateLimit(json: unknown): boolean {
  const c = (json as { error?: { code?: number } } | null)?.error?.code;
  return c === 4 || c === 17 || c === 32 || c === 613;
}

function retryAfterMs(res: HttpResponse): number | undefined {
  const ra = res.headers.get("retry-after") ?? res.headers.get("x-ratelimit-reset");
  const n = ra === null ? NaN : Number(ra);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 86_400) * 1000 : undefined;
}

/** Network-level failures are transient; they never prove anything about the remote side. */
export async function send(http: HttpClient, req: Parameters<HttpClient["request"]>[0]): Promise<HttpResponse> {
  try {
    return await http.request(req);
  } catch (err) {
    if (err instanceof HttpFailure) {
      throw new PlatformError(err.kind === "blocked" ? "permanent" : "transient", `http_${err.kind}`, err.message);
    }
    throw err;
  }
}

const form = (params: Record<string, string>) => new URLSearchParams(params).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };

// ---------------- Instagram ----------------

const IgShortToken = z.union([
  z.object({ data: z.array(z.object({ access_token: z.string(), user_id: z.union([z.string(), z.number()]), permissions: z.union([z.string(), z.array(z.string())]).optional() })).min(1) }),
  z.object({ access_token: z.string(), user_id: z.union([z.string(), z.number()]), permissions: z.union([z.string(), z.array(z.string())]).optional() }),
]);
const IgLongToken = z.object({ access_token: z.string(), expires_in: z.number() });
const IgMe = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  user_id: z.union([z.string(), z.number()]).optional(),
  username: z.string().optional(),
  account_type: z.string().optional(),
  profile_picture_url: z.string().optional(),
});

export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"] as const;

export function instagramOAuth(http: HttpClient, e: Endpoints): OAuthProvider {
  return {
    platform: "instagram",
    scopes: INSTAGRAM_SCOPES,
    pkce: false,
    authorizeUrl(app, redirectUri, state) {
      const u = new URL(e.instagramAuthorize);
      u.search = new URLSearchParams({
        client_id: app.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: INSTAGRAM_SCOPES.join(","),
        state,
        // Always show the account picker so the intended account is chosen.
        force_reauth: "true",
      }).toString();
      return u.toString();
    },
    async exchange(app, rawCode, redirectUri, now) {
      const code = rawCode.replace(/#_$/, "");
      const res = await send(http, {
        method: "POST",
        url: new URL("/oauth/access_token", e.instagramApi),
        headers: FORM,
        body: form({ client_id: app.clientId, client_secret: app.clientSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code }),
      });
      if (res.status !== 200) throw classifyResponse("instagram", res, "finish signing in");
      const parsed = IgShortToken.safeParse(res.json);
      if (!parsed.success) throw new PlatformError("permanent", "bad_token_response", "Instagram returned an unexpected sign-in response.");
      const short = "data" in parsed.data ? parsed.data.data[0]! : parsed.data;
      const perms = typeof short.permissions === "string" ? short.permissions.split(",") : (short.permissions ?? []);

      const longUrl = new URL("/access_token", e.instagramGraph);
      longUrl.search = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: app.clientSecret, access_token: short.access_token }).toString();
      const longRes = await send(http, { method: "GET", url: longUrl, headers: { accept: "application/json" } });
      if (longRes.status !== 200) throw classifyResponse("instagram", longRes, "issue a long-lived token");
      const long = IgLongToken.safeParse(longRes.json);
      if (!long.success) throw new PlatformError("permanent", "bad_token_response", "Instagram returned an unexpected token response.");
      return {
        accessToken: long.data.access_token,
        accessExpiresAt: addSeconds(now, long.data.expires_in),
        refreshToken: null,
        refreshExpiresAt: null,
        scopes: perms.map((p) => p.trim()).filter(Boolean),
        obtainedAt: now.toISOString(),
      };
    },
    async refresh(_app, tokens, now) {
      const u = new URL("/refresh_access_token", e.instagramGraph);
      u.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: tokens.accessToken }).toString();
      const res = await send(http, { method: "GET", url: u, headers: { accept: "application/json" } });
      if (res.status !== 200) throw classifyResponse("instagram", res, "renew the connection");
      const parsed = IgLongToken.safeParse(res.json);
      if (!parsed.success) throw new PlatformError("transient", "bad_token_response", "Instagram returned an unexpected renewal response.");
      return { ...tokens, accessToken: parsed.data.access_token, accessExpiresAt: addSeconds(now, parsed.data.expires_in), obtainedAt: now.toISOString() };
    },
    async identify(tokens, now) {
      const u = new URL(`/${GRAPH_VERSION}/me`, e.instagramGraph);
      u.search = new URLSearchParams({ fields: "id,user_id,username,account_type,profile_picture_url", access_token: tokens.accessToken }).toString();
      const res = await send(http, { method: "GET", url: u, headers: { accept: "application/json" } });
      if (res.status !== 200) throw classifyResponse("instagram", res, "confirm which account you signed in with");
      const me = IgMe.safeParse(res.json);
      const id = me.success ? (me.data.user_id ?? me.data.id) : undefined;
      if (!me.success || id === undefined) throw new PlatformError("permanent", "no_identity", "Instagram didn't return an account ID.");
      const type = me.data.account_type ?? null;
      const missing = INSTAGRAM_SCOPES.filter((s) => tokens.scopes.length > 0 && !tokens.scopes.includes(s));
      const eligible = (type === "BUSINESS" || type === "MEDIA_CREATOR") && missing.length === 0;
      return {
        identity: {
          providerAccountId: String(id),
          username: me.data.username ?? null,
          displayName: null,
          avatarUrl: null,
          accountType: type,
          verifiedAt: now.toISOString(),
        },
        eligible,
        reason: eligible
          ? null
          : missing.length > 0
            ? `Publishing permission wasn't granted (${missing.join(", ")}). Connect again and allow it.`
            : `@${me.data.username ?? "this account"} is a ${type?.toLowerCase() ?? "non-professional"} account. Instagram only allows publishing through the API from professional (Business or Creator) accounts.`,
      };
    },
  };
}

// ---------------- Pinterest ----------------

const PinToken = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
  refresh_token_expires_at: z.number().optional(),
  scope: z.string().optional(),
});
const PinAccount = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  username: z.string().optional(),
  account_type: z.string().optional(),
  business_name: z.string().nullable().optional(),
});

export const PINTEREST_SCOPES = ["user_accounts:read", "boards:read", "pins:read", "pins:write"] as const;

export function pinterestOAuth(http: HttpClient, e: Endpoints): OAuthProvider {
  const tokenSet = (data: z.infer<typeof PinToken>, now: Date, previous?: TokenSet): TokenSet => ({
    accessToken: data.access_token,
    accessExpiresAt: addSeconds(now, data.expires_in),
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? null,
    refreshExpiresAt:
      data.refresh_token_expires_at !== undefined
        ? new Date(data.refresh_token_expires_at * 1000).toISOString()
        : data.refresh_token_expires_in !== undefined
          ? addSeconds(now, data.refresh_token_expires_in)
          : (previous?.refreshExpiresAt ?? null),
    scopes: data.scope ? data.scope.split(/[ ,]+/).filter(Boolean) : (previous?.scopes ?? []),
    obtainedAt: now.toISOString(),
  });
  const basic = (app: AppCredentials) => `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;

  return {
    platform: "pinterest",
    scopes: PINTEREST_SCOPES,
    pkce: false,
    authorizeUrl(app, redirectUri, state) {
      const u = new URL(e.pinterestAuthorize);
      u.search = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, response_type: "code", scope: PINTEREST_SCOPES.join(","), state }).toString();
      return u.toString();
    },
    async exchange(app, code, redirectUri, now) {
      const res = await send(http, {
        method: "POST",
        url: new URL("/v5/oauth/token", e.pinterestApi),
        headers: { ...FORM, authorization: basic(app) },
        body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
      });
      if (res.status !== 200) throw classifyResponse("pinterest", res, "finish signing in");
      const parsed = PinToken.safeParse(res.json);
      if (!parsed.success) throw new PlatformError("permanent", "bad_token_response", "Pinterest returned an unexpected sign-in response.");
      return tokenSet(parsed.data, now);
    },
    async refresh(app, tokens, now) {
      if (!tokens.refreshToken) throw new PlatformError("auth_expired", "no_refresh_token", "The Pinterest connection can't be renewed. Reconnect it.");
      const res = await send(http, {
        method: "POST",
        url: new URL("/v5/oauth/token", e.pinterestApi),
        headers: { ...FORM, authorization: basic(app) },
        body: form({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }),
      });
      if (res.status !== 200) {
        const err = classifyResponse("pinterest", res, "renew the connection");
        // An invalid refresh token is a 400 from the token endpoint: reconnecting is the only fix.
        throw res.status === 400 ? new PlatformError("auth_expired", err.code, err.safeMessage) : err;
      }
      const parsed = PinToken.safeParse(res.json);
      if (!parsed.success) throw new PlatformError("transient", "bad_token_response", "Pinterest returned an unexpected renewal response.");
      return tokenSet(parsed.data, now, tokens);
    },
    async identify(tokens, now) {
      const res = await send(http, {
        method: "GET",
        url: new URL("/v5/user_account", e.pinterestApi),
        headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" },
      });
      if (res.status !== 200) throw classifyResponse("pinterest", res, "confirm which account you signed in with");
      const acct = PinAccount.safeParse(res.json);
      if (!acct.success || acct.data.id === undefined) throw new PlatformError("permanent", "no_identity", "Pinterest didn't return an account ID.");
      const type = acct.data.account_type ?? null;
      const missing = PINTEREST_SCOPES.filter((s) => tokens.scopes.length > 0 && !tokens.scopes.includes(s));
      const eligible = type === "BUSINESS" && missing.length === 0;
      return {
        identity: {
          providerAccountId: String(acct.data.id),
          username: acct.data.username ?? null,
          displayName: acct.data.business_name ?? null,
          avatarUrl: null,
          accountType: type,
          verifiedAt: now.toISOString(),
        },
        eligible,
        reason: eligible
          ? null
          : missing.length > 0
            ? `Some permissions weren't granted (${missing.join(", ")}). Connect again and allow them.`
            : `${acct.data.username ?? "This account"} is a ${type?.toLowerCase() ?? "personal"} account. Use a Pinterest business account for publishing.`,
      };
    },
  };
}
