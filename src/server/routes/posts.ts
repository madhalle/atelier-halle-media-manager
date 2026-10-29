// Posts API: drafts, editing, previews of the exact publishing derivative,
// deletion of unpublished drafts, and independent copies across accounts.
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { computeCrop, CROP_ASPECTS, validatePost, type Issue, type MediaInfo, type Post } from "../../domain/posts.ts";
import type { AccountsRepo } from "../../storage/accounts-repo.ts";
import type { MediaStore } from "../../storage/media-store.ts";
import type { PostsRepo } from "../../storage/posts-repo.ts";
import { toMediaView, type MediaView } from "./media.ts";

export interface PostView extends Omit<Post, "media"> {
  media: (Post["media"][number] & { asset: MediaView; previewUrl: string })[];
  issues: Issue[];
}

const IdParams = z.object({ id: z.uuid() });
const PreviewParams = z.object({ id: z.uuid(), position: z.coerce.number().int().min(0).max(19) });
const CreateBody = z.object({ mediaAssetId: z.uuid() }).strict();
// Generous transport limits; platform limits are reported as issues so drafts can be saved mid-edit.
const text = (max: number) => z.string().max(max);
const PatchBody = z
  .object({
    revision: z.number().int().positive(),
    fields: z
      .object({
        caption: text(10_000),
        altText: text(5_000),
        pinTitle: text(1_000),
        pinDescription: text(5_000),
        pinLink: text(4_096),
      })
      .partial()
      .strict()
      .optional(),
    media: z
      .array(
        z
          .object({
            position: z.number().int().min(0).max(19),
            cropAspect: z.enum(CROP_ASPECTS),
            focusX: z.number().min(0).max(1),
            focusY: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
const RevisionBody = z.object({ revision: z.number().int().positive() }).strict();
const CopyBody = z.object({ accountIds: z.array(z.uuid()).min(1).max(100) }).strict();

export function registerPostRoutes(
  api: FastifyInstance,
  deps: { accounts: AccountsRepo; posts: PostsRepo; media: MediaStore },
): { view: (p: Post) => PostView } {
  const { accounts, posts, media } = deps;

  function view(p: Post): PostView {
    const platform = accounts.get(p.accountId).platform;
    const infos = new Map<string, MediaInfo>();
    const items = p.media.map((m) => {
      const asset = media.get(m.mediaAssetId);
      infos.set(asset.id, asset);
      return {
        ...m,
        asset: toMediaView(asset, media.usageCount(asset.id)),
        previewUrl: `/api/posts/${p.id}/media/${m.position}/preview?v=${p.revision}`,
      };
    });
    return { ...p, media: items, issues: validatePost(platform, p, infos) };
  }

  api.get("/accounts/:id/posts", async (req) => {
    const { id } = IdParams.parse(req.params);
    accounts.get(id);
    return { posts: posts.listForAccount(id).map(view), counts: posts.countsByStatus(id) };
  });

  api.post("/accounts/:id/posts", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { mediaAssetId } = CreateBody.parse(req.body);
    return reply.code(201).send({ post: view(posts.createDraft(id, mediaAssetId)) });
  });

  api.get("/posts/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    return { post: view(posts.get(id)) };
  });

  api.patch("/posts/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = PatchBody.parse(req.body);
    const patch = {
      ...(body.fields ? { fields: Object.fromEntries(Object.entries(body.fields).filter(([, v]) => v !== undefined)) } : {}),
      ...(body.media ? { media: body.media } : {}),
    };
    const updated = posts.update(id, body.revision, patch);
    if (body.media) for (const m of updated.media) await media.pruneDerivatives(m.mediaAssetId);
    return { post: view(updated) };
  });

  api.delete("/posts/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    const { revision } = RevisionBody.parse(req.body);
    const assetIds = posts.get(id).media.map((m) => m.mediaAssetId);
    posts.delete(id, revision);
    for (const assetId of assetIds) await media.pruneDerivatives(assetId);
    return { ok: true };
  });

  api.post("/posts/:id/copies", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { accountIds } = CopyBody.parse(req.body);
    return reply.code(201).send({ posts: posts.copy(id, accountIds).map(view) });
  });

  // The exact derivative that would be published: same crop, size, colour and metadata stripping.
  api.get("/posts/:id/media/:position/preview", async (req, reply) => {
    const { id, position } = PreviewParams.parse(req.params);
    const post = posts.get(id);
    const item = post.media.find((m) => m.position === position);
    if (!item) return reply.code(404).send({ error: "not_found", message: "No photo at that position." });
    const platform = accounts.get(post.accountId).platform;
    const asset = media.get(item.mediaAssetId);
    const crop = computeCrop(asset.width, asset.height, item.cropAspect, item.focusX, item.focusY);
    const { file } = await media.derivative(asset, platform, crop);
    return reply.type("image/jpeg").header("cache-control", "private, max-age=3600").send(createReadStream(file));
  });

  return { view };
}
