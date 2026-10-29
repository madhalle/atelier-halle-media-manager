// Request guards for a loopback-only server. Loopback binding alone does not
// stop other websites in the browser from reaching it, so every request is
// checked for an exact Host, and API requests for a same-origin caller.
import type { FastifyReply, FastifyRequest } from "fastify";

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

export function allowedOrigins(port: number): Set<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method);
}

/**
 * Rejects requests that did not come from this app's own pages. Browsers send
 * Origin on cross-origin and on unsafe same-origin fetches, and Sec-Fetch-Site
 * on all modern requests.
 */
export function checkSameOrigin(req: FastifyRequest, reply: FastifyReply, origins: Set<string>): boolean {
  const origin = req.headers.origin;
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") {
    void reply.code(403).send({ error: "cross_origin_request" });
    return false;
  }
  if (origin !== undefined ? !origins.has(origin) : isUnsafeMethod(req.method)) {
    void reply.code(403).send({ error: "cross_origin_request" });
    return false;
  }
  return true;
}

/** Path without query string, for logs: launch tokens and OAuth codes travel in queries. */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : `${url.slice(0, q)}?[redacted]`;
}
