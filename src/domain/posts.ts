// Platform-specific post rules: fields, limits, crops, validation and copying.
// Limits come from docs/platform-capabilities.md (verified 2026-10-29).
import type { Platform } from "./accounts.ts";
import { DomainError } from "./errors.ts";

export const POST_STATUSES = [
  "draft",
  "scheduled",
  "preparing",
  "publishing",
  "published",
  "retry_waiting",
  "needs_attention",
  "canceled",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Statuses whose content may be edited or deleted by the user. */
export const EDITABLE_STATUSES: ReadonlySet<PostStatus> = new Set(["draft", "canceled"]);

export const CROP_ASPECTS = ["original", "1:1", "4:5", "1.91:1", "2:3"] as const;
export type CropAspect = (typeof CROP_ASPECTS)[number];

export interface PostFields {
  caption: string;
  altText: string;
  pinTitle: string;
  pinDescription: string;
  pinLink: string;
  pinBoardId: string | null;
  pinBoardName: string | null;
}

export interface PostMedia {
  position: number;
  mediaAssetId: string;
  cropAspect: CropAspect;
  focusX: number;
  focusY: number;
}

export interface Post extends PostFields {
  id: string;
  accountId: string;
  status: PostStatus;
  media: PostMedia[];
  copiedFromPostId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export const LIMITS = {
  instagram: { caption: 2200, hashtags: 30, mentions: 20, altText: 1000 },
  pinterest: { title: 100, description: 800, link: 2048, altText: 500 },
} as const;

/** Which crop presets each platform accepts, and its default. */
export const PLATFORM_ASPECTS: Record<Platform, { allowed: readonly CropAspect[]; default: CropAspect }> = {
  // Instagram feed images must be between 4:5 and 1.91:1.
  instagram: { allowed: ["original", "1:1", "4:5", "1.91:1"], default: "original" },
  pinterest: { allowed: ["original", "2:3", "1:1"], default: "original" },
};

export const INSTAGRAM_RATIO = { min: 4 / 5, max: 1.91 } as const;

const ASPECT_RATIO: Record<Exclude<CropAspect, "original">, number> = {
  "1:1": 1,
  "4:5": 4 / 5,
  "1.91:1": 1.91,
  "2:3": 2 / 3,
};

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The largest rectangle of the requested aspect that fits the image, centred
 * on the focus point as far as the edges allow. Pure and deterministic, so the
 * preview and the published derivative always match.
 */
export function computeCrop(width: number, height: number, aspect: CropAspect, focusX: number, focusY: number): CropRect {
  if (aspect === "original") return { left: 0, top: 0, width, height };
  const ratio = ASPECT_RATIO[aspect];
  let w = width;
  let h = Math.round(width / ratio);
  if (h > height) {
    h = height;
    w = Math.round(height * ratio);
  }
  const clamp = (v: number, max: number) => Math.min(Math.max(0, v), max);
  const left = clamp(Math.round(focusX * width - w / 2), width - w);
  const top = clamp(Math.round(focusY * height - h / 2), height - h);
  return { left, top, width: w, height: h };
}

export function countHashtags(text: string): number {
  return (text.match(/(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu) ?? []).length;
}

export function countMentions(text: string): number {
  return (text.match(/(^|[^\p{L}\p{N}_.])@[\p{L}\p{N}_.]+/gu) ?? []).length;
}

const chars = (s: string) => [...s].length;

export function isValidLink(link: string): boolean {
  if (link === "") return true;
  try {
    const u = new URL(link);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

export interface Issue {
  field: "caption" | "altText" | "pinTitle" | "pinDescription" | "pinLink" | "pinBoard" | "media";
  message: string;
  /** Blocking issues prevent scheduling; warnings are advisory. */
  severity: "blocking" | "warning";
}

export interface MediaInfo {
  width: number;
  height: number;
}

/** Validation for a post as it would be published. Drafts may be saved with issues. */
export function validatePost(platform: Platform, post: PostFields & { media: PostMedia[] }, media: Map<string, MediaInfo>): Issue[] {
  const issues: Issue[] = [];
  const block = (field: Issue["field"], message: string) => issues.push({ field, message, severity: "blocking" });
  const warn = (field: Issue["field"], message: string) => issues.push({ field, message, severity: "warning" });

  if (post.media.length === 0) block("media", "Add a photo.");
  if (post.media.length > 1) block("media", "Only single-photo posts are supported so far.");

  for (const m of post.media) {
    const info = media.get(m.mediaAssetId);
    if (!info) {
      block("media", "A photo in this post is missing from the library.");
      continue;
    }
    if (!PLATFORM_ASPECTS[platform].allowed.includes(m.cropAspect)) {
      block("media", `The ${m.cropAspect} crop isn't available for ${platform === "instagram" ? "Instagram" : "Pinterest"}.`);
      continue;
    }
    const crop = computeCrop(info.width, info.height, m.cropAspect, m.focusX, m.focusY);
    if (platform === "instagram") {
      const ratio = crop.width / crop.height;
      if (ratio < INSTAGRAM_RATIO.min - 0.005 || ratio > INSTAGRAM_RATIO.max + 0.005) {
        block("media", "Instagram needs an aspect ratio between 4:5 (portrait) and 1.91:1 (landscape). Choose a crop.");
      }
      if (crop.width < 320) warn("media", "This photo is narrower than 320 pixels; Instagram will upscale it.");
    }
    if (platform === "pinterest" && (crop.width < 200 || crop.height < 300)) {
      warn("media", "This photo is small; Pinterest may show it at low quality.");
    }
  }

  if (platform === "instagram") {
    const l = LIMITS.instagram;
    if (chars(post.caption) > l.caption) block("caption", `Captions can be at most ${l.caption} characters.`);
    if (countHashtags(post.caption) > l.hashtags) block("caption", `Instagram allows at most ${l.hashtags} hashtags.`);
    if (countMentions(post.caption) > l.mentions) block("caption", `Instagram allows at most ${l.mentions} @mentions.`);
    if (chars(post.altText) > l.altText) block("altText", `Alt text can be at most ${l.altText} characters.`);
    if (post.caption.trim() === "") warn("caption", "The caption is empty.");
  } else {
    const l = LIMITS.pinterest;
    if (chars(post.pinTitle) > l.title) block("pinTitle", `Titles can be at most ${l.title} characters.`);
    if (chars(post.pinDescription) > l.description) block("pinDescription", `Descriptions can be at most ${l.description} characters.`);
    if (chars(post.pinLink) > l.link) block("pinLink", `Links can be at most ${l.link} characters.`);
    else if (!isValidLink(post.pinLink)) block("pinLink", "Enter a full web address starting with https:// (or leave it empty).");
    if (chars(post.altText) > l.altText) block("altText", `Alt text can be at most ${l.altText} characters.`);
    if (!post.pinBoardId) block("pinBoard", "Choose a board. Boards load after the account is connected.");
    if (post.pinTitle.trim() === "") warn("pinTitle", "The title is empty.");
  }
  if (post.altText.trim() === "") warn("altText", "Alt text helps people using screen readers.");
  return issues;
}

/**
 * Text and crop settings for an independent copy on another account. Boards
 * are account-specific and never copied; crops are reset where the target
 * platform does not support them.
 */
export function fieldsForCopy(source: Post, sourcePlatform: Platform, targetPlatform: Platform): { fields: PostFields; media: PostMedia[] } {
  const same = sourcePlatform === targetPlatform;
  const fields: PostFields = {
    caption: same ? source.caption : targetPlatform === "instagram" ? source.pinDescription : "",
    altText: source.altText,
    pinTitle: same ? source.pinTitle : "",
    pinDescription: same ? source.pinDescription : targetPlatform === "pinterest" ? source.caption : "",
    pinLink: same ? source.pinLink : "",
    pinBoardId: null,
    pinBoardName: null,
  };
  const allowed = PLATFORM_ASPECTS[targetPlatform];
  const media = source.media.map((m) =>
    allowed.allowed.includes(m.cropAspect) ? { ...m } : { ...m, cropAspect: allowed.default, focusX: 0.5, focusY: 0.5 },
  );
  return { fields, media };
}

export function assertEditable(post: Post): void {
  if (!EDITABLE_STATUSES.has(post.status)) {
    throw new DomainError("invalid_state", "Only drafts can be edited. Cancel the schedule first.");
  }
}
