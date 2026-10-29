// Same-origin API client. The session cookie is HttpOnly; the CSRF token is
// kept only in memory (never localStorage) and sent on unsafe requests.
let csrfToken: string | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
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
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? "request_failed", data.message ?? `Request failed (${res.status}).`);
  return data as T;
}

export type Platform = "instagram" | "pinterest";
export type ConnectionState = "unconnected" | "connected" | "needs_reconnect" | "disconnected";

export interface Account {
  id: string;
  platform: Platform;
  displayName: string;
  sortOrder: number;
  archived: boolean;
  archivedAt: string | null;
  connection: {
    state: ConnectionState;
    identity: { username: string | null; displayName: string | null; accountType: string | null; verifiedAt: string } | null;
  };
  schedulesNeedReview: boolean;
  publishing: { ready: boolean; blockers: string[] };
  revision: number;
  createdAt: string;
  updatedAt: string;
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

export const listAccounts = () =>
  request<{ accounts: Account[] }>("GET", "/api/accounts?includeArchived=true").then((r) => r.accounts);
export const createAccount = (platform: Platform, displayName: string) =>
  request<{ account: Account }>("POST", "/api/accounts", { platform, displayName }).then((r) => r.account);
export const renameAccount = (a: Account, displayName: string) =>
  request<{ account: Account }>("PATCH", `/api/accounts/${a.id}`, { displayName, revision: a.revision }).then((r) => r.account);
export const reorderAccounts = (ids: string[]) =>
  request<{ accounts: Account[] }>("POST", "/api/accounts/reorder", { ids }).then((r) => r.accounts);
export const archiveAccount = (a: Account) =>
  request<{ account: Account }>("POST", `/api/accounts/${a.id}/archive`, { revision: a.revision }).then((r) => r.account);
export const restoreAccount = (a: Account) =>
  request<{ account: Account }>("POST", `/api/accounts/${a.id}/restore`, { revision: a.revision }).then((r) => r.account);
export const acknowledgeReview = (a: Account) =>
  request<{ account: Account }>("POST", `/api/accounts/${a.id}/acknowledge-review`, { revision: a.revision }).then(
    (r) => r.account,
  );

export const PLATFORM_LABEL: Record<Platform, string> = { instagram: "Instagram", pinterest: "Pinterest" };

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  unconnected: "Not connected",
  connected: "Connected",
  needs_reconnect: "Reconnect needed",
  disconnected: "Disconnected",
};
