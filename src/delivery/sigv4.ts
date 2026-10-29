// AWS Signature Version 4, as used by the S3 API (Cloudflare R2 speaks it).
// Implemented on node:crypto so media delivery adds no dependencies; verified
// against AWS's published test vectors in tests/sigv4.test.ts.
import { createHash, createHmac } from "node:crypto";

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigV4Scope {
  region: string;
  service: string;
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Uint8Array | string, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 requires (A-Z a-z 0-9 - _ . ~ unescaped). */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (ch === "/" && !encodeSlash)) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function amzDate(date: Date): { dateTime: string; day: string } {
  const dateTime = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { dateTime, day: dateTime.slice(0, 8) };
}

function signingKey(secret: string, day: string, scope: SigV4Scope): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), scope.region), scope.service), "aws4_request");
}

function canonicalQuery(params: [string, string][]): string {
  return params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export interface CanonicalInput {
  method: string;
  url: URL;
  /** Header names are lower-cased; values trimmed. Must include `host`. */
  headers: Record<string, string>;
  payloadHash: string;
}

export function canonicalRequest(input: CanonicalInput): { request: string; signedHeaders: string } {
  const names = Object.keys(input.headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const signedHeaders = names.join(";");
  const params = [...input.url.searchParams.entries()];
  const request = [
    input.method,
    uriEncode(decodeURIComponent(input.url.pathname), false) || "/",
    canonicalQuery(params),
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  return { request, signedHeaders };
}

export function stringToSign(dateTime: string, day: string, scope: SigV4Scope, canonical: string): string {
  return ["AWS4-HMAC-SHA256", dateTime, `${day}/${scope.region}/${scope.service}/aws4_request`, sha256Hex(canonical)].join("\n");
}

/** Signs a request with an Authorization header. Returns headers to send. */
export function signHeaders(
  creds: SigV4Credentials,
  scope: SigV4Scope,
  req: { method: string; url: URL; headers?: Record<string, string>; payloadHash: string },
  now: Date,
): Record<string, string> {
  const { dateTime, day } = amzDate(now);
  const headers: Record<string, string> = { ...req.headers, host: req.url.host, "x-amz-date": dateTime };
  if (scope.service === "s3") headers["x-amz-content-sha256"] = req.payloadHash;
  const { request, signedHeaders } = canonicalRequest({ method: req.method, url: req.url, headers, payloadHash: req.payloadHash });
  const signature = createHmac("sha256", signingKey(creds.secretAccessKey, day, scope))
    .update(stringToSign(dateTime, day, scope, request))
    .digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${day}/${scope.region}/${scope.service}/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** A presigned URL granting one method on one object until it expires. */
export function presignUrl(creds: SigV4Credentials, scope: SigV4Scope, method: string, url: URL, expiresSeconds: number, now: Date): URL {
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604_800) throw new Error("Invalid presign expiry");
  const { dateTime, day } = amzDate(now);
  const signed = new URL(url);
  signed.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  signed.searchParams.set("X-Amz-Credential", `${creds.accessKeyId}/${day}/${scope.region}/${scope.service}/aws4_request`);
  signed.searchParams.set("X-Amz-Date", dateTime);
  signed.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  signed.searchParams.set("X-Amz-SignedHeaders", "host");
  const { request } = canonicalRequest({ method, url: signed, headers: { host: signed.host }, payloadHash: "UNSIGNED-PAYLOAD" });
  const signature = createHmac("sha256", signingKey(creds.secretAccessKey, day, scope))
    .update(stringToSign(dateTime, day, scope, request))
    .digest("hex");
  signed.searchParams.set("X-Amz-Signature", signature);
  return signed;
}

export const EMPTY_SHA256 = sha256Hex("");
export { sha256Hex };
