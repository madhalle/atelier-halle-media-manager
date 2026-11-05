// A read-only preview of a connected account: its profile and most recent
// posts, so each tab is recognisable. Nothing is stored on disk.
//
// Pinterest's developer guidelines: don't store data accessed through the API
// ("call the API each time"), link Pins back to Pinterest, make clear the
// content is from Pinterest, and don't cover or filter Pins. So Pinterest
// previews are fetched on every view, kept only long enough to serve the
// images just listed, never cached as images, and shown uncropped.
//
// Images are fetched by the server and re-encoded, so the page's strict CSP
// stays 'self'-only. Image URLs come only from the platform's API response and
// are referenced by opaque keys; the browser never supplies a URL (no SSRF).
//
//   Instagram → GET /{ig-user-id}?fields=username,name,biography,website,profile_picture_url,media_count
//               GET /{ig-user-id}/media?fields=id,media_type,media_url,thumbnail_url,permalink,timestamp
//               (graph.instagram.com or graph.facebook.com, as the account connected)
//   Pinterest → GET /v5/user_account, GET /v5/pins?page_size=…
import sharp from "sharp";
import { z } from "zod";
import type { Account } from "../domain/accounts.ts";
import { PlatformError } from "../domain/publishing.ts";
import type { PlatformConfig } from "../storage/platform-config.ts";
import { GRAPH_VERSION, pinterestBase, type Endpoints, type HttpClient } from "./http.ts";
import { classifyResponse, send } from "./oauth.ts";
import type { TokenManager } from "./tokens.ts";

export const PREVIEW_POSTS = 9;
const TTL_MS = { instagram: 10 * 60_000, pinterest: 60_000 } as const;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CACHED_IMAGES = 200;

export interface PreviewProfile {
  username: string | null;
  name: string | null;
  bio: string | null;
  website: string | null;
  postCount: number | null;
  /** The account's public page on the platform. */
  url: string | null;
  hasAvatar: boolean;
}

export interface PreviewPost {
  /** Opaque key for the image route. */
  key: string;
  url: string | null;
  postedAt: string | null;
  kind: "photo" | "carousel" | "video" | "pin";
}

export interface AccountPreview {
  profile: PreviewProfile;
  posts: PreviewPost[];
  fetchedAt: string;
}

interface Cached {
  credentialRef: string;
  expiresAt: number;
  preview: AccountPreview;
  /** key → remote image URL from the API (avatar under "avatar"). */
  images: Map<string, string>;
}

/** Image hosts the platforms return. Exact suffix match on HTTPS only. */
export function isPlatformImageOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "") return false;
  const h = u.hostname;
  return h.endsWith(".cdninstagram.com") || h.endsWith(".fbcdn.net") || h === "i.pinimg.com";
}

const safeLink = (v: unknown, hosts: string[]): string | null => {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && hosts.includes(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
};
const webLink = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
};
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

const IgProfile = z.object({
  username: z.string().optional(),
  name: z.string().optional(),
  biography: z.string().optional(),
  website: z.string().optional(),
  profile_picture_url: z.string().optional(),
  media_count: z.number().optional(),
});
const IgMedia = z.object({
  data: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      media_type: z.string().optional(),
      media_url: z.string().optional(),
      thumbnail_url: z.string().optional(),
      permalink: z.string().optional(),
      timestamp: z.string().optional(),
    }),
  ),
});
const PinUser = z.object({
  username: z.string().optional(),
  business_name: z.string().nullable().optional(),
  about: z.string().nullable().optional(),
  website_url: z.string().nullable().optional(),
  profile_image: z.string().nullable().optional(),
  pin_count: z.number().optional(),
});
const PinImages = z.record(z.string(), z.object({ url: z.string() }).loose());
const PinItems = z.object({
  items: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      created_at: z.string().optional(),
      media: z.object({ media_type: z.string().optional(), images: PinImages.optional() }).loose().nullable().optional(),
    }),
  ),
});

export function createPreviewService(deps: {
  http: HttpClient;
  /** Client that may only reach platform image hosts. */
  images: HttpClient;
  endpoints: Endpoints;
  tokens: TokenManager;
  config: PlatformConfig;
  now: () => Date;
}) {
  const cache = new Map<string, Cached>(); // account id →
  const imageCache = new Map<string, { type: string; bytes: Buffer }>(); // `${accountId}:${key}:${fetchedAt}` →

  async function instagram(account: Account): Promise<Omit<Cached, "credentialRef" | "expiresAt">> {
    const g = await deps.tokens.grant(account);
    const id = encodeURIComponent(account.identity!.providerAccountId);
    const url = (path: string, params: Record<string, string>) => {
      const u = new URL(`/${GRAPH_VERSION}/${path}`, g.graph === "facebook" ? deps.endpoints.facebookGraph : deps.endpoints.instagramGraph);
      u.search = new URLSearchParams({ ...params, access_token: g.accessToken }).toString();
      return u;
    };
    const [p, m] = await Promise.all([
      send(deps.http, { method: "GET", url: url(id, { fields: "username,name,biography,website,profile_picture_url,media_count" }), headers: { accept: "application/json" } }),
      send(deps.http, {
        method: "GET",
        url: url(`${id}/media`, { fields: "id,media_type,media_url,thumbnail_url,permalink,timestamp", limit: String(PREVIEW_POSTS) }),
        headers: { accept: "application/json" },
      }),
    ]);
    if (p.status !== 200) throw classifyResponse("instagram", p, "load the profile");
    if (m.status !== 200) throw classifyResponse("instagram", m, "load recent posts");
    const prof = IgProfile.safeParse(p.json);
    const media = IgMedia.safeParse(m.json);
    if (!prof.success || !media.success) throw new PlatformError("transient", "bad_preview_response", "Instagram answered, but not in the expected format.");
    const images = new Map<string, string>();
    if (prof.data.profile_picture_url) images.set("avatar", prof.data.profile_picture_url);
    const posts: PreviewPost[] = [];
    media.data.data.slice(0, PREVIEW_POSTS).forEach((item, i) => {
      const type = item.media_type ?? "IMAGE";
      const src = type === "VIDEO" ? item.thumbnail_url : item.media_url;
      if (!src) return;
      const key = `p${i}`;
      images.set(key, src);
      posts.push({
        key,
        url: safeLink(item.permalink, ["www.instagram.com", "instagram.com"]),
        postedAt: item.timestamp ?? null,
        kind: type === "CAROUSEL_ALBUM" ? "carousel" : type === "VIDEO" ? "video" : "photo",
      });
    });
    const username = prof.data.username ?? account.identity?.username ?? null;
    return {
      images,
      preview: {
        profile: {
          username,
          name: text(prof.data.name, 100),
          bio: text(prof.data.biography, 300),
          website: webLink(prof.data.website),
          postCount: prof.data.media_count ?? null,
          url: username && /^[A-Za-z0-9._]{1,30}$/.test(username) ? `https://www.instagram.com/${username}/` : null,
          hasAvatar: images.has("avatar"),
        },
        posts,
        fetchedAt: deps.now().toISOString(),
      },
    };
  }

  async function pinterest(account: Account): Promise<Omit<Cached, "credentialRef" | "expiresAt">> {
    const base = pinterestBase(deps.endpoints, deps.config.view().pinterest.tier);
    const headers = { authorization: `Bearer ${await deps.tokens.accessToken(account)}`, accept: "application/json" };
    const pinsUrl = new URL("/v5/pins", base);
    pinsUrl.search = new URLSearchParams({ page_size: String(PREVIEW_POSTS) }).toString();
    const [u, pins] = await Promise.all([
      send(deps.http, { method: "GET", url: new URL("/v5/user_account", base), headers }),
      send(deps.http, { method: "GET", url: pinsUrl, headers }),
    ]);
    if (u.status !== 200) throw classifyResponse("pinterest", u, "load the profile");
    if (pins.status !== 200) throw classifyResponse("pinterest", pins, "load recent Pins");
    const user = PinUser.safeParse(u.json);
    const list = PinItems.safeParse(pins.json);
    if (!user.success || !list.success) throw new PlatformError("transient", "bad_preview_response", "Pinterest answered, but not in the expected format.");
    const images = new Map<string, string>();
    if (user.data.profile_image) images.set("avatar", user.data.profile_image);
    const posts: PreviewPost[] = [];
    list.data.items.slice(0, PREVIEW_POSTS).forEach((pin, i) => {
      const imgs = pin.media?.images ?? {};
      const src = (imgs["600x"] ?? imgs["400x300"] ?? imgs["1200x"] ?? Object.values(imgs)[0])?.url;
      if (!src) return;
      const key = `p${i}`;
      images.set(key, src);
      const id = String(pin.id);
      posts.push({ key, url: /^\d{1,30}$/.test(id) ? `https://www.pinterest.com/pin/${id}/` : null, postedAt: pin.created_at ?? null, kind: "pin" });
    });
    const username = user.data.username ?? account.identity?.username ?? null;
    return {
      images,
      preview: {
        profile: {
          username,
          name: text(user.data.business_name, 100),
          bio: text(user.data.about, 300),
          website: webLink(user.data.website_url),
          postCount: user.data.pin_count ?? null,
          url: username && /^[A-Za-z0-9_]{1,30}$/.test(username) ? `https://www.pinterest.com/${username}/` : null,
          hasAvatar: images.has("avatar"),
        },
        posts,
        fetchedAt: deps.now().toISOString(),
      },
    };
  }

  async function load(account: Account, refresh: boolean): Promise<Cached> {
    if (account.connectionState !== "connected" || !account.credentialRef || !account.identity) {
      throw new PlatformError("permanent", "not_connected", "Connect this account to see its profile.");
    }
    if (account.identity.accountType === "SIMULATED" || account.credentialRef.startsWith("fake:")) {
      throw new PlatformError("permanent", "simulated", "Simulated accounts have no profile to preview.");
    }
    const hit = cache.get(account.id);
    const t = deps.now().getTime();
    if (!refresh && hit && hit.expiresAt > t && hit.credentialRef === account.credentialRef) return hit;
    const fresh = account.platform === "instagram" ? await instagram(account) : await pinterest(account);
    const entry: Cached = { ...fresh, credentialRef: account.credentialRef, expiresAt: t + TTL_MS[account.platform] };
    cache.set(account.id, entry);
    return entry;
  }

  return {
    async preview(account: Account, opts: { refresh?: boolean } = {}): Promise<AccountPreview> {
      // Pinterest: always ask the API afresh (no stored Pinterest data).
      return (await load(account, opts.refresh === true || account.platform === "pinterest")).preview;
    },

    /** A small re-encoded JPEG for a key from the current preview. */
    async image(account: Account, key: string): Promise<{ type: string; bytes: Buffer }> {
      const entry = await load(account, false);
      const src = entry.images.get(key);
      if (!src) throw new PlatformError("permanent", "no_image", "That image isn't in this account's preview.");
      const ck = `${account.id}:${key}:${entry.preview.fetchedAt}`;
      const hit = imageCache.get(ck);
      if (hit) return hit;
      let url: URL;
      try {
        url = new URL(src);
      } catch {
        throw new PlatformError("permanent", "bad_image_url", "The platform returned an unusable image address.");
      }
      const res = await send(deps.images, { method: "GET", url, headers: { accept: "image/*" }, maxBytes: MAX_IMAGE_BYTES });
      const type = res.headers.get("content-type") ?? "";
      if (res.status !== 200 || !type.startsWith("image/")) throw new PlatformError("transient", "image_unavailable", "The image couldn't be loaded.");
      const size = key === "avatar" ? 160 : 360;
      // Instagram thumbnails are cropped square like Instagram's grid; Pins are never cropped.
      const fit = account.platform === "pinterest" ? "inside" : "cover";
      let bytes: Buffer;
      try {
        bytes = await sharp(res.body, { limitInputPixels: 50_000_000 }).rotate().resize(size, size, { fit, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      } catch {
        throw new PlatformError("permanent", "bad_image", "The image couldn't be read.");
      }
      const out = { type: "image/jpeg", bytes };
      if (account.platform === "pinterest") return out; // not cached
      if (imageCache.size >= MAX_CACHED_IMAGES) imageCache.delete(imageCache.keys().next().value!);
      imageCache.set(ck, out);
      return out;
    },

    /** Drops cached data for an account (e.g. on disconnect). */
    forget(accountId: string): void {
      cache.delete(accountId);
      for (const k of imageCache.keys()) if (k.startsWith(`${accountId}:`)) imageCache.delete(k);
    },
  };
}

export type PreviewService = ReturnType<typeof createPreviewService>;
