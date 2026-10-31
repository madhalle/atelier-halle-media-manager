// Instagram API with Instagram Login: single-image and carousel feed posts.
//   stage  → upload derivative to R2, presign, POST /{ig-user}/media (container).
//            Carousels: one item container per photo (is_carousel_item), wait
//            until Instagram has fetched them all, then the CAROUSEL container.
//   check  → GET /{container}?fields=status_code until FINISHED; then delete staged object
//   commit → check content_publishing_limit, POST /{ig-user}/media_publish
//   reconcile → container status PUBLISHED means it went out
import { z } from "zod";
import { PlatformError } from "../domain/publishing.ts";
import type { R2Stager } from "../delivery/r2.ts";
import { classifyResponse, send } from "./oauth.ts";
import { GRAPH_VERSION, type Endpoints, type HttpClient } from "./http.ts";
import type { TokenManager } from "./tokens.ts";
import type { PlatformAdapter, PublishJob, ReconcileResult } from "./types.ts";

const Id = z.object({ id: z.union([z.string(), z.number()]) });
const Status = z.object({ status_code: z.string().optional(), status: z.string().optional() });
const Limit = z.object({ data: z.array(z.object({ quota_usage: z.number().optional(), config: z.object({ quota_total: z.number().optional() }).optional() })) });
const MediaList = z.object({
  data: z.array(z.object({ id: z.union([z.string(), z.number()]), timestamp: z.string().optional(), caption: z.string().optional(), permalink: z.string().optional() })),
});

const SETTLE_MS = 5 * 60_000;
/** How long to wait for carousel items to be fetched before trying again later. */
const ITEM_WAIT_MS = 90_000;
const ITEM_POLL_MS = 3_000;

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createInstagramAdapter(deps: {
  http: HttpClient;
  endpoints: Endpoints;
  tokens: TokenManager;
  stager: R2Stager;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
}): PlatformAdapter {
  const sleep = deps.sleep ?? sleepReal;
  const staged = new Map<string, string>(); // container id → staged object key
  const token = (job: PublishJob) => deps.tokens.accessToken({ platform: "instagram", credentialRef: job.credentialRef });
  const graph = (path: string, params: Record<string, string>) => {
    const u = new URL(`/${GRAPH_VERSION}/${path}`, deps.endpoints.instagramGraph);
    u.search = new URLSearchParams(params).toString();
    return u;
  };
  const postForm = async (path: string, params: Record<string, string>) =>
    send(deps.http, {
      method: "POST",
      url: new URL(`/${GRAPH_VERSION}/${path}`, deps.endpoints.instagramGraph),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      timeoutMs: 60_000,
    });

  async function containerStatus(job: PublishJob, containerId: string): Promise<string> {
    const res = await send(deps.http, { method: "GET", url: graph(encodeURIComponent(containerId), { fields: "status_code,status", access_token: await token(job) }) });
    if (res.status !== 200) throw classifyResponse("instagram", res, "check the upload status");
    const s = Status.safeParse(res.json);
    return (s.success && s.data.status_code) || "UNKNOWN";
  }

  async function cleanup(containerId: string): Promise<void> {
    const key = staged.get(containerId);
    if (key) {
      staged.delete(containerId);
      await deps.stager.remove(key);
    }
  }

  async function createContainer(job: PublishJob, params: Record<string, string>, what: string): Promise<string> {
    const res = await postForm(`${encodeURIComponent(job.providerAccountId)}/media`, { ...params, access_token: await token(job) });
    if (res.status !== 200) throw classifyResponse("instagram", res, what);
    const id = Id.safeParse(res.json);
    if (!id.success) throw new PlatformError("transient", "bad_container_response", "Instagram answered, but not in the expected format.");
    return String(id.data.id);
  }

  /**
   * One item container per photo, then the carousel container. The staged
   * photos are deleted once Instagram has fetched every item, or on failure.
   * Unused item containers expire on Instagram's side after 24 hours.
   */
  async function stageCarousel(job: PublishJob): Promise<string> {
    const keys: string[] = [];
    try {
      const items: string[] = [];
      for (const m of job.media) {
        const staged = await deps.stager.stage(m.file);
        keys.push(staged.key);
        items.push(await createContainer(job, { image_url: staged.url, is_carousel_item: "true" }, "prepare a carousel photo"));
      }
      const deadline = deps.now().getTime() + ITEM_WAIT_MS;
      for (const item of items) {
        for (;;) {
          const status = await containerStatus(job, item);
          if (status === "FINISHED") break;
          if (status !== "IN_PROGRESS") {
            throw new PlatformError("permanent", `carousel_item_${status.toLowerCase()}`, "Instagram couldn't process one of the carousel photos. Check that each is a valid JPEG within Instagram's limits.");
          }
          if (deps.now().getTime() >= deadline) {
            throw new PlatformError("transient", "carousel_items_pending", "Instagram is still processing the carousel photos; it will try again shortly.");
          }
          await sleep(ITEM_POLL_MS);
        }
      }
      const params: Record<string, string> = { media_type: "CAROUSEL", children: items.join(",") };
      if (job.caption) params.caption = job.caption;
      return await createContainer(job, params, "prepare the carousel");
    } finally {
      for (const key of keys) await deps.stager.remove(key);
    }
  }

  return {
    platform: "instagram",
    simulated: false,

    async stage(job) {
      if (job.containerId) {
        const status = await containerStatus(job, job.containerId);
        if (status === "IN_PROGRESS" || status === "FINISHED") return { containerId: job.containerId };
        await cleanup(job.containerId); // EXPIRED/ERROR: start over with a fresh container
      }
      if (job.media.length > 1) return { containerId: await stageCarousel(job) };
      const media = await deps.stager.stage(job.media[0]!.file);
      const params: Record<string, string> = { image_url: media.url, access_token: await token(job) };
      if (job.caption) params.caption = job.caption;
      if (job.altText) params.alt_text = job.altText;
      const res = await postForm(`${encodeURIComponent(job.providerAccountId)}/media`, params);
      if (res.status !== 200) {
        await deps.stager.remove(media.key);
        throw classifyResponse("instagram", res, "prepare the post");
      }
      const id = Id.safeParse(res.json);
      if (!id.success) {
        await deps.stager.remove(media.key);
        throw new PlatformError("transient", "bad_container_response", "Instagram answered, but not in the expected format.");
      }
      staged.set(String(id.data.id), media.key);
      return { containerId: String(id.data.id) };
    },

    async checkStaged(job) {
      if (!job.containerId) throw new PlatformError("transient", "no_container", "The upload wasn't prepared.");
      const status = await containerStatus(job, job.containerId);
      if (status === "IN_PROGRESS") return "pending";
      await cleanup(job.containerId); // Instagram has fetched the image (or given up)
      if (status === "FINISHED") return "ready";
      if (status === "EXPIRED") throw new PlatformError("transient", "container_expired", "The prepared upload expired; it will be prepared again.");
      throw new PlatformError("permanent", `container_${status.toLowerCase()}`, "Instagram couldn't process this photo. Check that it is a valid JPEG within Instagram's limits.");
    },

    async commit(job) {
      if (!job.containerId) throw new PlatformError("permanent", "no_container", "The upload wasn't prepared.");
      const tok = await token(job);
      // Check the 24-hour publishing quota first; Meta's docs disagree on the number, so ask.
      const limitRes = await send(deps.http, {
        method: "GET",
        url: graph(`${encodeURIComponent(job.providerAccountId)}/content_publishing_limit`, { fields: "quota_usage,config", access_token: tok }),
      });
      if (limitRes.status === 200) {
        const l = Limit.safeParse(limitRes.json);
        const row = l.success ? l.data.data[0] : undefined;
        if (row?.quota_usage !== undefined && row.config?.quota_total !== undefined && row.quota_usage >= row.config.quota_total) {
          throw new PlatformError("rate_limited", "publishing_quota", `Instagram's limit of ${row.config.quota_total} posts per 24 hours is reached. It will retry later.`, 60 * 60_000);
        }
      }
      const res = await postForm(`${encodeURIComponent(job.providerAccountId)}/media_publish`, { creation_id: job.containerId, access_token: tok });
      if (res.status !== 200) throw classifyResponse("instagram", res, "publish the post");
      const id = Id.safeParse(res.json);
      if (!id.success) throw new PlatformError("ambiguous", "bad_publish_response", "Instagram answered, but not in the expected format.");
      const mediaId = String(id.data.id);
      let permalink: string | null = null;
      const p = await send(deps.http, { method: "GET", url: graph(encodeURIComponent(mediaId), { fields: "permalink", access_token: tok }) }).catch(() => null);
      if (p?.status === 200) {
        const link = (p.json as { permalink?: unknown } | null)?.permalink;
        if (typeof link === "string" && link.startsWith("https://www.instagram.com/")) permalink = link;
      }
      return { remotePostId: mediaId, permalink };
    },

    async reconcile(job, commitStartedAt): Promise<ReconcileResult> {
      if (!job.containerId) return { state: "unknown" };
      const status = await containerStatus(job, job.containerId);
      if (status === "PUBLISHED") {
        const res = await send(deps.http, {
          method: "GET",
          url: graph(`${encodeURIComponent(job.providerAccountId)}/media`, { fields: "id,timestamp,caption,permalink", limit: "10", access_token: await token(job) }),
        });
        const list = res.status === 200 ? MediaList.safeParse(res.json) : null;
        const since = commitStartedAt.getTime() - 2 * 60_000;
        const match = list?.success
          ? list.data.data.find((m) => (m.caption ?? "") === job.caption && (!m.timestamp || Date.parse(m.timestamp) >= since))
          : undefined;
        if (match) return { state: "published", remotePostId: String(match.id), permalink: match.permalink ?? null };
        return { state: "published", remotePostId: `container:${job.containerId}`, permalink: null };
      }
      if (status === "FINISHED") {
        if (deps.now().getTime() - commitStartedAt.getTime() < SETTLE_MS) {
          throw new PlatformError("transient", "not_settled", "Still checking whether the post went out.");
        }
        return { state: "not_published" };
      }
      if (status === "ERROR" || status === "EXPIRED") return { state: "not_published" };
      return { state: "unknown" };
    },
  };
}
