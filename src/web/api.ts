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

// ---- Photo library and posts ----

export interface MediaItem {
  id: string;
  width: number;
  height: number;
  format: "jpeg" | "png" | "webp";
  byteSize: number;
  originalFilename: string | null;
  hasLocation: boolean;
  usedByPosts: number;
  thumbUrl: string;
  createdAt: string;
}

export type UploadResult =
  | { filename: string | null; ok: true; created: boolean; media: MediaItem }
  | { filename: string | null; ok: false; error: string };

export type PostStatus =
  | "draft"
  | "scheduled"
  | "preparing"
  | "publishing"
  | "published"
  | "retry_waiting"
  | "needs_attention"
  | "canceled";

export type CropAspect = "original" | "1:1" | "4:5" | "1.91:1" | "2:3";

export const PLATFORM_ASPECTS: Record<Platform, CropAspect[]> = {
  instagram: ["original", "1:1", "4:5", "1.91:1"],
  pinterest: ["original", "2:3", "1:1"],
};

export interface Issue {
  field: "caption" | "altText" | "pinTitle" | "pinDescription" | "pinLink" | "pinBoard" | "media";
  message: string;
  severity: "blocking" | "warning";
}

export interface PostFields {
  caption: string;
  altText: string;
  pinTitle: string;
  pinDescription: string;
  pinLink: string;
}

export interface PostMediaItem {
  position: number;
  mediaAssetId: string;
  cropAspect: CropAspect;
  focusX: number;
  focusY: number;
  asset: MediaItem;
  previewUrl: string;
}

export type AttentionKind =
  | "not_connected"
  | "not_configured"
  | "missed"
  | "validation"
  | "permanent"
  | "auth"
  | "retries_exhausted"
  | "ambiguous";

export interface Post extends PostFields {
  id: string;
  accountId: string;
  status: PostStatus;
  scheduledAt: string | null;
  timezone: string | null;
  localTime: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  cancelRequested: boolean;
  commitStartedAt: string | null;
  remotePostId: string | null;
  remotePermalink: string | null;
  publishedAt: string | null;
  publishedSimulated: boolean;
  attentionKind: AttentionKind | null;
  attentionMessage: string | null;
  pinBoardId: string | null;
  pinBoardName: string | null;
  copiedFromPostId: string | null;
  media: PostMediaItem[];
  issues: Issue[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type StatusCounts = Record<PostStatus, number>;

export async function uploadPhotos(files: File[]): Promise<UploadResult[]> {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch("/api/media", {
    method: "POST",
    body: form,
    credentials: "same-origin",
    headers: csrfToken ? { "x-csrf-token": csrfToken } : {},
  });
  const data = (await res.json().catch(() => ({}))) as { results?: UploadResult[]; error?: string; message?: string };
  if (!res.ok || !data.results) throw new ApiError(res.status, data.error ?? "upload_failed", data.message ?? "Upload failed.");
  return data.results;
}

export const listMedia = () => request<{ media: MediaItem[] }>("GET", "/api/media").then((r) => r.media);
export const deleteMedia = (id: string) => request<{ ok: true }>("DELETE", `/api/media/${id}`);
export const derivativeUrl = (mediaId: string, platform: Platform, aspect: CropAspect, fx: number, fy: number) =>
  `/api/media/${mediaId}/derivative?platform=${platform}&aspect=${encodeURIComponent(aspect)}&fx=${fx.toFixed(2)}&fy=${fy.toFixed(2)}`;

export const listPosts = (accountId: string) =>
  request<{ posts: Post[]; counts: StatusCounts }>("GET", `/api/accounts/${accountId}/posts`);
export const createPost = (accountId: string, mediaAssetId: string) =>
  request<{ post: Post }>("POST", `/api/accounts/${accountId}/posts`, { mediaAssetId }).then((r) => r.post);
export const getPost = (id: string) => request<{ post: Post }>("GET", `/api/posts/${id}`).then((r) => r.post);
export const updatePost = (
  post: Post,
  fields: Partial<PostFields>,
  media?: { position: number; cropAspect: CropAspect; focusX: number; focusY: number }[],
) =>
  request<{ post: Post }>("PATCH", `/api/posts/${post.id}`, { revision: post.revision, fields, ...(media ? { media } : {}) }).then(
    (r) => r.post,
  );
export const deletePost = (post: Post) => request<{ ok: true }>("DELETE", `/api/posts/${post.id}`, { revision: post.revision });
export const copyPost = (post: Post, accountIds: string[]) =>
  request<{ posts: Post[] }>("POST", `/api/posts/${post.id}/copies`, { accountIds }).then((r) => r.posts);

export const STATUS_LABEL: Record<PostStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  preparing: "Preparing",
  publishing: "Publishing",
  published: "Published",
  retry_waiting: "Retrying",
  needs_attention: "Needs attention",
  canceled: "Canceled",
};

// ---- Scheduling ----

export class ScheduleConflict extends ApiError {
  readonly detail: {
    suggestion?: { localTime: string; instant: string; offset: string };
    earlier?: { instant: string; offset: string };
    later?: { instant: string; offset: string };
  };
  constructor(code: string, message: string, detail: ScheduleConflict["detail"]) {
    super(409, code, message);
    this.detail = detail;
  }
}

export async function schedulePost(
  post: Post,
  localTime: string,
  timeZone: string,
  choice?: "earlier" | "later",
): Promise<{ post: Post; warnings: string[] }> {
  const res = await fetch(`/api/posts/${post.id}/schedule`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
    body: JSON.stringify({ revision: post.revision, localTime, timeZone, ...(choice ? { choice } : {}) }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 409 && (data.error === "nonexistent_time" || data.error === "ambiguous_time")) {
    throw new ScheduleConflict(data.error, String(data.message), data as ScheduleConflict["detail"]);
  }
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? "request_failed"), String(data.message ?? "Could not schedule."));
  return data as { post: Post; warnings: string[] };
}

export const cancelSchedule = (post: Post) =>
  request<{ post: Post; immediate: boolean; message: string }>("POST", `/api/posts/${post.id}/cancel`, { revision: post.revision });
export const dismissAttention = (post: Post) =>
  request<{ post: Post }>("POST", `/api/posts/${post.id}/dismiss`, { revision: post.revision }).then((r) => r.post);
export const resolveOutcome = (post: Post, outcome: "published" | "not_published") =>
  request<{ post: Post }>("POST", `/api/posts/${post.id}/resolve`, { revision: post.revision, outcome }).then((r) => r.post);

export interface Attempt {
  id: string;
  attemptNo: number;
  startedAt: string;
  finishedAt: string | null;
  stage: string;
  outcome: string;
  errorCode: string | null;
  errorMessage: string | null;
  remotePostId: string | null;
  simulated: boolean;
}
export const listAttempts = (postId: string) => request<{ attempts: Attempt[] }>("GET", `/api/posts/${postId}/attempts`).then((r) => r.attempts);

export interface Settings {
  defaultTimezone: string;
  missedGraceMinutes: number;
}
export const getSettings = () => request<{ settings: Settings }>("GET", "/api/settings").then((r) => r.settings);
export const updateSettings = (s: Partial<Settings>) => request<{ settings: Settings }>("PATCH", "/api/settings", s).then((r) => r.settings);

export interface Health {
  scheduler: { running: boolean; lastCheckAt: string | null; intervalSeconds: number; stale: boolean; lastError: string | null };
  counts: { scheduled: number; overdue: number; needsAttention: number; inFlight: number };
  settings: Settings;
  publishing: "simulated" | "live" | "not_configured";
}
export const getHealth = () => request<Health>("GET", "/api/health");

/** "Tue, Oct 29, 9:00 AM EDT" in the post's own zone. */
export function formatInZone(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(instant));
}

// ---- Platform setup and connections ----

export interface PlatformSetup {
  config: {
    instagram: { clientId: string | null; secretSaved: boolean; redirectHost: "localhost" | "127.0.0.1" };
    pinterest: { clientId: string | null; secretSaved: boolean; redirectHost: "localhost" | "127.0.0.1"; tier: "trial" | "standard" };
    r2: { accountId: string | null; bucket: string | null; accessKeyId: string | null; secretSaved: boolean };
  };
  redirectUris: { instagram: string; pinterest: string };
  keychain: { ok: boolean; reason: string | null; kind: "keychain" | "memory" };
  livePublishing: boolean;
}

export const getPlatformSetup = () => request<PlatformSetup>("GET", "/api/platforms");
/** Secrets are sent once and stored in the Keychain; they are never returned. */
export const updatePlatformSetup = (patch: Record<string, Record<string, string | null>>) =>
  request<{ config: PlatformSetup["config"] }>("PATCH", "/api/platforms", patch).then((r) => r.config);
export const clearPlatformSetup = (kind: "instagram" | "pinterest" | "r2") =>
  request<{ config: PlatformSetup["config"] }>("DELETE", `/api/platforms/${kind}`).then((r) => r.config);

/** Uploads, reads back and deletes a tiny test object in the R2 bucket. */
export const testR2 = () => request<{ ok: true }>("POST", "/api/platforms/r2/test", {});

export const startConnect = (accountId: string) =>
  request<{ authorizeUrl: string }>("POST", `/api/accounts/${accountId}/connect`, {}).then((r) => r.authorizeUrl);
export const disconnectAccount = (accountId: string) =>
  request<{ account: Account; credentialRemoved: boolean; followUp: string }>("POST", `/api/accounts/${accountId}/disconnect`, {});

export interface Board {
  id: string;
  name: string;
  privacy: string | null;
}
export const listBoards = (accountId: string) => request<{ boards: Board[] }>("GET", `/api/accounts/${accountId}/boards`).then((r) => r.boards);
export const setPostBoard = (post: Post, boardId: string) =>
  request<{ post: Post }>("POST", `/api/posts/${post.id}/board`, { revision: post.revision, boardId }).then((r) => r.post);
