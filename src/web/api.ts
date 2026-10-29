// Same-origin API client. The session cookie is HttpOnly; the CSRF token is
// kept only in memory (never localStorage) and sent on unsafe requests.
let csrfToken: string | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? "request_failed");
  return data as T;
}

export interface Status {
  version: string;
  environment: string;
  livePublishing: "enabled" | "disabled";
  schemaVersion: number;
}

export async function startSession(): Promise<void> {
  const s = await request<{ csrfToken: string }>("GET", "/api/session");
  csrfToken = s.csrfToken;
}

export const getStatus = () => request<Status>("GET", "/api/status");
export const logout = () => request<{ ok: true }>("POST", "/api/session/logout", {});
