// SQLite persistence for destination posts and their ordered photos.
import { randomUUID } from "node:crypto";
import type { Account } from "../domain/accounts.ts";
import { DomainError } from "../domain/errors.ts";
import {
  assertEditable,
  fieldsForCopy,
  PLATFORM_ASPECTS,
  type CropAspect,
  type Post,
  type PostFields,
  type PostMedia,
  type PostStatus,
} from "../domain/posts.ts";
import type { AccountsRepo } from "./accounts-repo.ts";
import type { Db } from "./db.ts";

interface PostRow {
  id: string;
  account_id: string;
  status: PostStatus;
  caption: string;
  alt_text: string;
  pin_title: string;
  pin_description: string;
  pin_link: string;
  pin_board_id: string | null;
  pin_board_name: string | null;
  copied_from_post_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface MediaRow {
  post_id: string;
  position: number;
  media_asset_id: string;
  crop_aspect: CropAspect;
  crop_focus_x: number;
  crop_focus_y: number;
}

export interface PostPatch {
  fields?: Partial<Omit<PostFields, "pinBoardId" | "pinBoardName">>;
  media?: { position: number; cropAspect: CropAspect; focusX: number; focusY: number }[];
}

export function createPostsRepo(db: Db, accounts: AccountsRepo, now: () => Date = () => new Date()) {
  const iso = () => now().toISOString();
  const selectPost = db.prepare<[string], PostRow>("SELECT * FROM posts WHERE id = ?");
  const selectMedia = db.prepare<[string], MediaRow>("SELECT * FROM post_media WHERE post_id = ? ORDER BY position");
  const assetExists = db.prepare<[string], { id: string }>("SELECT id FROM media_assets WHERE id = ?");

  function hydrate(r: PostRow, media: MediaRow[]): Post {
    return {
      id: r.id,
      accountId: r.account_id,
      status: r.status,
      caption: r.caption,
      altText: r.alt_text,
      pinTitle: r.pin_title,
      pinDescription: r.pin_description,
      pinLink: r.pin_link,
      pinBoardId: r.pin_board_id,
      pinBoardName: r.pin_board_name,
      copiedFromPostId: r.copied_from_post_id,
      revision: r.revision,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      media: media.map(
        (m): PostMedia => ({
          position: m.position,
          mediaAssetId: m.media_asset_id,
          cropAspect: m.crop_aspect,
          focusX: m.crop_focus_x,
          focusY: m.crop_focus_y,
        }),
      ),
    };
  }

  function get(id: string): Post {
    const row = selectPost.get(id);
    if (!row) throw new DomainError("not_found", "Post not found.");
    return hydrate(row, selectMedia.all(id));
  }

  function requireActiveAccount(id: string): Account {
    const account = accounts.get(id);
    if (account.archivedAt !== null) throw new DomainError("invalid_state", "Restore this account before adding posts to it.");
    return account;
  }

  const insertPost = db.prepare(
    `INSERT INTO posts (id, account_id, caption, alt_text, pin_title, pin_description, pin_link, pin_board_id,
       pin_board_name, copied_from_post_id, created_at, updated_at)
     VALUES (@id, @accountId, @caption, @altText, @pinTitle, @pinDescription, @pinLink, @pinBoardId,
       @pinBoardName, @copiedFrom, @now, @now)`,
  );
  const insertMedia = db.prepare(
    `INSERT INTO post_media (post_id, position, media_asset_id, crop_aspect, crop_focus_x, crop_focus_y)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  function insert(accountId: string, fields: PostFields, media: PostMedia[], copiedFrom: string | null): string {
    const id = randomUUID();
    insertPost.run({ id, accountId, ...fields, copiedFrom, now: iso() });
    for (const m of media) insertMedia.run(id, m.position, m.mediaAssetId, m.cropAspect, m.focusX, m.focusY);
    return id;
  }

  const EMPTY: PostFields = {
    caption: "",
    altText: "",
    pinTitle: "",
    pinDescription: "",
    pinLink: "",
    pinBoardId: null,
    pinBoardName: null,
  };

  return {
    get,

    listForAccount(accountId: string): Post[] {
      const rows = db.prepare<[string], PostRow>("SELECT * FROM posts WHERE account_id = ? ORDER BY updated_at DESC, id").all(accountId);
      const media = db
        .prepare<[string], MediaRow>(
          "SELECT pm.* FROM post_media pm JOIN posts p ON p.id = pm.post_id WHERE p.account_id = ? ORDER BY pm.position",
        )
        .all(accountId);
      const byPost = Map.groupBy(media, (m) => m.post_id);
      return rows.map((r) => hydrate(r, byPost.get(r.id) ?? []));
    },

    /** New single-photo draft. Unconnected accounts may hold drafts. Never auto-crops. */
    createDraft(accountId: string, mediaAssetId: string): Post {
      return db.transaction(() => {
        const account = requireActiveAccount(accountId);
        if (!assetExists.get(mediaAssetId)) throw new DomainError("not_found", "Photo not found.");
        const media: PostMedia = { position: 0, mediaAssetId, cropAspect: PLATFORM_ASPECTS[account.platform].default, focusX: 0.5, focusY: 0.5 };
        return get(insert(accountId, EMPTY, [media], null));
      })();
    },

    update(id: string, expectedRevision: number, patch: PostPatch): Post {
      return db.transaction(() => {
        const post = get(id);
        if (post.revision !== expectedRevision) {
          throw new DomainError("stale_revision", "This post changed in another window. Reload and try again.");
        }
        assertEditable(post);
        const platform = accounts.get(post.accountId).platform;
        const f = { ...post, ...patch.fields };
        db.prepare(
          `UPDATE posts SET caption = ?, alt_text = ?, pin_title = ?, pin_description = ?, pin_link = ?,
             revision = revision + 1, updated_at = ? WHERE id = ?`,
        ).run(f.caption, f.altText, f.pinTitle, f.pinDescription, f.pinLink, iso(), id);
        for (const m of patch.media ?? []) {
          if (!PLATFORM_ASPECTS[platform].allowed.includes(m.cropAspect)) {
            throw new DomainError("validation", `The ${m.cropAspect} crop isn't available for this platform.`);
          }
          const r = db
            .prepare("UPDATE post_media SET crop_aspect = ?, crop_focus_x = ?, crop_focus_y = ? WHERE post_id = ? AND position = ?")
            .run(m.cropAspect, m.focusX, m.focusY, id, m.position);
          if (r.changes !== 1) throw new DomainError("validation", "That photo position doesn't exist in this post.");
        }
        return get(id);
      })();
    },

    /** Deletes an unpublished draft. Photos stay in the library. */
    delete(id: string, expectedRevision: number): void {
      db.transaction(() => {
        const post = get(id);
        if (post.revision !== expectedRevision) {
          throw new DomainError("stale_revision", "This post changed in another window. Reload and try again.");
        }
        if (post.status !== "draft" && post.status !== "canceled") {
          throw new DomainError("invalid_state", "Only unpublished drafts can be deleted.");
        }
        db.prepare("UPDATE posts SET copied_from_post_id = NULL WHERE copied_from_post_id = ?").run(id);
        db.prepare("DELETE FROM posts WHERE id = ?").run(id);
      })();
    },

    /**
     * Creates one independent draft per target account, reusing the same
     * immutable photos. Copies are never scheduled or published automatically.
     */
    copy(sourceId: string, targetAccountIds: string[]): Post[] {
      return db.transaction(() => {
        const source = get(sourceId);
        const sourcePlatform = accounts.get(source.accountId).platform;
        const unique = [...new Set(targetAccountIds)];
        if (unique.length === 0) throw new DomainError("validation", "Choose at least one account.");
        if (unique.includes(source.accountId)) throw new DomainError("validation", "A post can't be copied to its own account.");
        return unique.map((targetId) => {
          const target = requireActiveAccount(targetId);
          const { fields, media } = fieldsForCopy(source, sourcePlatform, target.platform);
          return get(insert(target.id, fields, media, source.id));
        });
      })();
    },

    countsByStatus(accountId: string): Record<PostStatus, number> {
      const counts = Object.fromEntries(
        ["draft", "scheduled", "preparing", "publishing", "published", "retry_waiting", "needs_attention", "canceled"].map((s) => [s, 0]),
      ) as Record<PostStatus, number>;
      for (const r of db
        .prepare<[string], { status: PostStatus; n: number }>("SELECT status, count(*) AS n FROM posts WHERE account_id = ? GROUP BY status")
        .all(accountId)) {
        counts[r.status] = r.n;
      }
      return counts;
    },
  };
}

export type PostsRepo = ReturnType<typeof createPostsRepo>;
