// The only way server code talks to the internet. Every request must target an
// exact allowlisted origin over HTTPS; redirects are refused (no following
// into internal addresses); bodies are size-capped; requests time out. Error
// messages never contain URLs, query strings or bodies, which may hold tokens.

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON, or null when the body wasn't JSON. */
  json: unknown;
}

export class HttpFailure extends Error {
  readonly kind: "timeout" | "network" | "blocked" | "too_large";
  constructor(kind: HttpFailure["kind"], message: string) {
    super(message);
    this.name = "HttpFailure";
    this.kind = kind;
  }
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: URL;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function createHttpClient(opts: {
  /** Exact origins, e.g. "https://graph.instagram.com". */
  allowedOrigins: (origin: string) => boolean;
  /** Plain HTTP is allowed only for loopback test servers. */
  allowInsecureLoopback?: boolean;
  fetchImpl?: typeof fetch;
}): HttpClient {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async request(req) {
      const { url } = req;
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      const schemeOk = url.protocol === "https:" || (opts.allowInsecureLoopback === true && loopback && url.protocol === "http:");
      if (!schemeOk || !opts.allowedOrigins(url.origin) || url.username || url.password) {
        throw new HttpFailure("blocked", `Refused a request to a host that isn't allowed (${url.host}).`);
      }
      let res: Response;
      try {
        res = await doFetch(url, {
          method: req.method,
          headers: { "user-agent": "AtelierHalleMediaManager/0.1", ...req.headers },
          ...(req.body !== undefined ? { body: req.body } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
        });
      } catch (err) {
        const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw new HttpFailure(timeout ? "timeout" : "network", timeout ? `No response from ${url.host} in time.` : `Couldn't reach ${url.host}.`);
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_RESPONSE_BYTES) throw new HttpFailure("too_large", `Response from ${url.host} was too large.`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_RESPONSE_BYTES) throw new HttpFailure("too_large", `Response from ${url.host} was too large.`);
      let json: unknown = null;
      if (buf.byteLength > 0) {
        try {
          json = JSON.parse(new TextDecoder().decode(buf));
        } catch {
          json = null;
        }
      }
      return { status: res.status, headers: res.headers, json };
    },
  };
}

/** Production endpoints. Tests substitute loopback fakes. */
export interface Endpoints {
  instagramAuthorize: string;
  instagramApi: string;
  instagramGraph: string;
  pinterestAuthorize: string;
  pinterestApi: string;
  pinterestSandboxApi: string;
  r2: (accountId: string) => string;
}

export const GRAPH_VERSION = "v26.0";

export const PRODUCTION_ENDPOINTS: Endpoints = {
  instagramAuthorize: "https://www.instagram.com/oauth/authorize",
  instagramApi: "https://api.instagram.com",
  instagramGraph: "https://graph.instagram.com",
  pinterestAuthorize: "https://www.pinterest.com/oauth/",
  pinterestApi: "https://api.pinterest.com",
  pinterestSandboxApi: "https://api-sandbox.pinterest.com",
  r2: (accountId) => `https://${accountId}.r2.cloudflarestorage.com`,
};

export function endpointOrigins(e: Endpoints, r2AccountId: string | null): Set<string> {
  const origins = [e.instagramApi, e.instagramGraph, e.pinterestApi, e.pinterestSandboxApi];
  if (r2AccountId) origins.push(e.r2(r2AccountId));
  return new Set(origins.map((o) => new URL(o).origin));
}

/** Safe error text from a provider JSON error: known fields only, bounded, no tokens. */
export function providerErrorText(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const j = json as Record<string, unknown>;
  const nested = (j.error && typeof j.error === "object" ? j.error : j) as Record<string, unknown>;
  const parts = [nested.error_user_msg, nested.message, nested.error_description, typeof j.error === "string" ? j.error : undefined]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 300));
  return parts[0] ?? "";
}
