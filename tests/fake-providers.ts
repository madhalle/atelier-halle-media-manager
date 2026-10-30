// Loopback HTTP fakes of the Instagram, Pinterest and R2 endpoints, with
// sanitized response shapes from the official docs. They record requests and
// assert what our code sends (secrets in the right place, signatures valid).
import { createServer, type IncomingMessage, type Server } from "node:http";
import { canonicalRequest, presignUrl, stringToSign } from "../src/delivery/sigv4.ts";

/** "20261030T161704Z" → Date. */
function parseAmzDate(s: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) : new Date(NaN);
}
import { createHmac } from "node:crypto";
import type { Endpoints } from "../src/platforms/http.ts";

export interface Recorded {
  service: string;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: string;
}

type Handler = (req: Recorded) => { status: number; json?: unknown; headers?: Record<string, string> } | Promise<{ status: number; json?: unknown; headers?: Record<string, string> }>;

async function serve(service: string, log: Recorded[], handler: Handler): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const rec: Recorded = { service, method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    log.push(rec);
    const out = await handler(rec);
    res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
    res.end(out.json === undefined ? "" : JSON.stringify(out.json));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { server, origin: `http://127.0.0.1:${addr.port}` };
}

export const IG_SECRET = "ig-app-secret-0123456789abcdef";
export const PIN_SECRET = "pin-app-secret-0123456789abcdef";
export const R2 = { accountId: "0123456789abcdef0123456789abcdef", bucket: "staging-bucket", accessKeyId: "R2ACCESSKEYID0001", secretAccessKey: "r2SecretAccessKey/abcdefghijklmnop0123" };

export interface FakeState {
  log: Recorded[];
  ig: {
    accountType: string;
    userId: string;
    permissions: string[];
    tokenSeq: number;
    containerStatus: string;
    quotaUsage: number;
    publishFails: null | { status: number; json?: unknown };
    publishedCaption: string | null;
  };
  pin: {
    accountType: string;
    id: string;
    tokenSeq: number;
    createFails: null | { status: number; json?: unknown };
    pins: { id: string; title: string; description: string; created_at: string }[];
    refreshValid: boolean;
    /** Create the Pin but answer 502, as if the response were lost. */
    loseNextResponse: boolean;
  };
  r2: { objects: Map<string, string>; badSignatures: number };
}

export interface FakeProviders {
  state: FakeState;
  endpoints: Endpoints;
  close(): Promise<void>;
  calls(service: string, path?: string): Recorded[];
}

export async function startFakeProviders(): Promise<FakeProviders> {
  const log: Recorded[] = [];
  const state: FakeState = {
    log,
    ig: { accountType: "BUSINESS", userId: "17841400000000001", permissions: ["instagram_business_basic", "instagram_business_content_publish"], tokenSeq: 0, containerStatus: "FINISHED", quotaUsage: 0, publishFails: null, publishedCaption: null },
    pin: { accountType: "BUSINESS", id: "549755885175", tokenSeq: 0, createFails: null, pins: [], refreshValid: true, loseNextResponse: false },
    r2: { objects: new Map(), badSignatures: 0 },
  };

  const igApi = await serve("ig-api", log, (r) => {
    if (r.method === "POST" && r.path === "/oauth/access_token") {
      const f = new URLSearchParams(r.body);
      if (f.get("client_secret") !== IG_SECRET || f.get("code") !== "good-code") return { status: 400, json: { error_type: "OAuthException", code: 400, error_message: "Invalid code" } };
      return { status: 200, json: { data: [{ access_token: `IG-SHORT-${++state.ig.tokenSeq}`, user_id: state.ig.userId, permissions: state.ig.permissions.join(",") }] } };
    }
    return { status: 404 };
  });

  const igGraph = await serve("ig-graph", log, (r) => {
    const tok = r.query.get("access_token") ?? new URLSearchParams(r.body).get("access_token");
    if (r.path === "/access_token") {
      if (r.query.get("client_secret") !== IG_SECRET) return { status: 400, json: { error: { message: "bad secret", code: 101 } } };
      return { status: 200, json: { access_token: `IG-LONG-${++state.ig.tokenSeq}`, token_type: "bearer", expires_in: 5183944 } };
    }
    if (r.path === "/refresh_access_token") return { status: 200, json: { access_token: `IG-LONG-${++state.ig.tokenSeq}`, token_type: "bearer", expires_in: 5183944 } };
    if (!tok?.startsWith("IG-LONG-")) return { status: 400, json: { error: { message: "Invalid OAuth access token.", code: 190 } } };
    if (r.path === "/v26.0/me") return { status: 200, json: { id: "app-scoped-1", user_id: state.ig.userId, username: "atelierhalle", account_type: state.ig.accountType } };
    if (r.method === "POST" && r.path === `/v26.0/${state.ig.userId}/media`) return { status: 200, json: { id: "17889455560051444" } };
    if (r.path === "/v26.0/17889455560051444") return { status: 200, json: { status_code: state.ig.containerStatus } };
    if (r.path === `/v26.0/${state.ig.userId}/content_publishing_limit`) return { status: 200, json: { data: [{ quota_usage: state.ig.quotaUsage, config: { quota_total: 50, quota_duration: 86400 } }] } };
    if (r.method === "POST" && r.path === `/v26.0/${state.ig.userId}/media_publish`) {
      if (state.ig.publishFails) return state.ig.publishFails;
      state.ig.containerStatus = "PUBLISHED";
      return { status: 200, json: { id: "17920238422030506" } };
    }
    if (r.path === "/v26.0/17920238422030506") return { status: 200, json: { permalink: "https://www.instagram.com/p/ABC123/" } };
    if (r.path === `/v26.0/${state.ig.userId}/media`) {
      return { status: 200, json: { data: state.ig.publishedCaption === null ? [] : [{ id: "17920238422030506", caption: state.ig.publishedCaption, timestamp: new Date().toISOString(), permalink: "https://www.instagram.com/p/ABC123/" }] } };
    }
    return { status: 404, json: { error: { message: "Unknown path", code: 100 } } };
  });

  const pinHandler = (sandbox: boolean): Handler => (r) => {
    if (r.path === "/v5/oauth/token") {
      const expected = `Basic ${Buffer.from(`1234567890123:${PIN_SECRET}`).toString("base64")}`;
      if (r.headers.authorization !== expected) return { status: 401, json: { code: 2, message: "Authentication failed." } };
      const f = new URLSearchParams(r.body);
      if (f.get("grant_type") === "authorization_code" && f.get("code") !== "good-code") return { status: 400, json: { code: 1, message: "Invalid code" } };
      if (f.get("grant_type") === "refresh_token" && !state.pin.refreshValid) return { status: 400, json: { code: 1, message: "Invalid refresh token" } };
      const n = ++state.pin.tokenSeq;
      return {
        status: 200,
        json: { access_token: `pina_TESTACCESS${n}`, refresh_token: `pinr_TESTREFRESH${n}`, token_type: "bearer", expires_in: 2592000, refresh_token_expires_in: 5184000, scope: "boards:read,pins:read,pins:write,user_accounts:read" },
      };
    }
    if (!r.headers.authorization?.startsWith("Bearer pina_")) return { status: 401, json: { code: 2, message: "Authentication failed." } };
    if (r.path === "/v5/user_account") return { status: 200, json: { id: state.pin.id, username: "atelierhalle", account_type: state.pin.accountType, business_name: "Atelier Halle" } };
    if (r.path === "/v5/boards") return { status: 200, json: { items: [{ id: "1099652335", name: "Collections", privacy: "PUBLIC" }], bookmark: null } };
    if (r.method === "POST" && r.path === "/v5/pins") {
      if (!sandbox) return { status: 403, json: { code: 3, message: "Trial apps must use the sandbox." } };
      if (state.pin.createFails) return state.pin.createFails;
      const b = JSON.parse(r.body) as { title?: string; description?: string; board_id: string; media_source: { data: string } };
      const pin = { id: `81365000000${state.pin.pins.length}`, title: b.title ?? "", description: b.description ?? "", created_at: new Date().toISOString().slice(0, 19) };
      state.pin.pins.push(pin);
      if (state.pin.loseNextResponse) {
        state.pin.loseNextResponse = false;
        return { status: 502, json: { message: "Bad gateway" } };
      }
      return { status: 201, json: { id: pin.id, board_id: b.board_id } };
    }
    if (r.path === "/v5/boards/1099652335/pins") return { status: 200, json: { items: state.pin.pins } };
    return { status: 404, json: { code: 404, message: "Not found" } };
  };
  const pinApi = await serve("pin-api", log, pinHandler(false));
  const pinSandbox = await serve("pin-sandbox", log, pinHandler(true));

  // Verifies SigV4 exactly as R2 would, using the known secret.
  const r2 = await serve("r2", log, (r) => {
    if (r.method === "GET" && r.query.has("X-Amz-Signature")) {
      // Presigned GET: re-sign the same request with the known secret and compare.
      const signed = presignUrl(
        { accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey },
        { region: "auto", service: "s3" },
        "GET",
        new URL(`http://${r.headers.host}${r.path}`),
        Number(r.query.get("X-Amz-Expires")),
        parseAmzDate(r.query.get("X-Amz-Date") ?? ""),
      );
      if (signed.searchParams.get("X-Amz-Signature") !== r.query.get("X-Amz-Signature")) {
        state.r2.badSignatures++;
        return { status: 403 };
      }
      const obj = state.r2.objects.get(r.path);
      return obj === undefined ? { status: 404 } : { status: 200, json: JSON.parse(obj) as unknown };
    }
    const auth = r.headers.authorization;
    if (!auth) return { status: 403 };
    const m = /Credential=([^/]+)\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/.exec(auth);
    if (!m || m[1] !== R2.accessKeyId) return { status: 403 };
    const headers: Record<string, string> = {};
    for (const h of m[3]!.split(";")) headers[h] = String(r.headers[h]);
    const url = new URL(`http://${r.headers.host}${r.path}`);
    const payloadHash = String(r.headers["x-amz-content-sha256"]);
    const { request } = canonicalRequest({ method: r.method, url, headers, payloadHash });
    const day = m[2]!;
    const key = [day, "auto", "s3", "aws4_request"].reduce<Buffer | string>((k, part) => createHmac("sha256", k).update(part).digest(), `AWS4${R2.secretAccessKey}`);
    const expected = createHmac("sha256", key).update(stringToSign(String(r.headers["x-amz-date"]), day, { region: "auto", service: "s3" }, request)).digest("hex");
    if (expected !== m[4]) {
      state.r2.badSignatures++;
      return { status: 403 };
    }
    if (r.method === "PUT") state.r2.objects.set(r.path, r.body);
    if (r.method === "DELETE") state.r2.objects.delete(r.path);
    return { status: r.method === "DELETE" ? 204 : 200 };
  });

  const servers = [igApi, igGraph, pinApi, pinSandbox, r2];
  return {
    state,
    endpoints: {
      instagramAuthorize: "https://www.instagram.com/oauth/authorize",
      instagramApi: igApi.origin,
      instagramGraph: igGraph.origin,
      pinterestAuthorize: "https://www.pinterest.com/oauth/",
      pinterestApi: pinApi.origin,
      pinterestSandboxApi: pinSandbox.origin,
      r2: () => r2.origin,
    },
    calls: (service, path) => log.filter((l) => l.service === service && (path === undefined || l.path === path)),
    async close() {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.server.close(() => r()))));
    },
  };
}
