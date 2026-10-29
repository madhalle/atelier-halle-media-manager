// The selected account's posts: status filters, gallery, and the composer.
import { useCallback, useEffect, useState } from "react";
import { Composer } from "./Composer.tsx";
import { CopyDialog } from "./CopyDialog.tsx";
import { PhotoLibraryDialog } from "./PhotoLibrary.tsx";
import { ApiError, createPost, formatInZone, getPost, getSettings, listPosts, STATUS_LABEL, type Account, type Post, type PostStatus, type StatusCounts } from "./api.ts";
import { useGuard } from "./dialogs.tsx";

const FILTERS: { key: string; label: string; statuses: PostStatus[] | null }[] = [
  { key: "all", label: "All", statuses: null },
  { key: "draft", label: "Drafts", statuses: ["draft", "canceled"] },
  { key: "scheduled", label: "Scheduled", statuses: ["scheduled", "preparing", "publishing", "retry_waiting"] },
  { key: "published", label: "Published", statuses: ["published"] },
  { key: "attention", label: "Needs attention", statuses: ["needs_attention"] },
];

interface Props {
  account: Account;
  accounts: Account[];
  openPostId: string | null;
  onOpenPost: (id: string | null) => void;
  onNotice: (text: string) => void;
}

export function PostsSection({ account, accounts, openPostId, onOpenPost, onNotice }: Props) {
  const { confirmDiscard } = useGuard();
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [counts, setCounts] = useState<StatusCounts | null>(null);
  const [filter, setFilter] = useState("all");
  const [library, setLibrary] = useState<"closed" | "browse" | "pick">("closed");
  const [copying, setCopying] = useState<Post | null>(null);
  const [openPost, setOpenPost] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaultTimezone, setDefaultTimezone] = useState("America/New_York");

  const refresh = useCallback(async () => {
    try {
      const r = await listPosts(account.id);
      setPosts(r.posts);
      setCounts(r.counts);
    } catch {
      setError("Could not load posts.");
    }
  }, [account.id]);

  useEffect(() => void refresh(), [refresh]);
  useEffect(() => void getSettings().then((s) => setDefaultTimezone(s.defaultTimezone)), []);

  // The backend publishes on its own; poll so results show up without a reload.
  const pending = (p: Post) => p.status === "scheduled" || p.status === "retry_waiting" || p.status === "preparing" || p.status === "publishing";
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      if (openPost && pending(openPost)) void getPost(openPost.id).then((p) => setOpenPost((cur) => (cur?.id === p.id ? p : cur)));
      else if (!openPost) void refresh();
    }, 15_000);
    return () => clearInterval(t);
  }, [openPost, refresh]);

  useEffect(() => {
    if (!openPostId) return setOpenPost(null);
    if (openPost?.id === openPostId) return;
    getPost(openPostId)
      .then((p) => (p.accountId === account.id ? setOpenPost(p) : onOpenPost(null)))
      .catch(() => onOpenPost(null));
  }, [openPostId, openPost?.id, account.id, onOpenPost]);

  useEffect(() => {
    if (openPost) document.getElementById("composer-title")?.focus();
  }, [openPost?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const newPost = async (mediaId: string) => {
    setLibrary("closed");
    try {
      const p = await createPost(account.id, mediaId);
      setOpenPost(p);
      onOpenPost(p.id);
      void refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the post.");
    }
  };

  const closeComposer = () => {
    setOpenPost(null);
    onOpenPost(null);
    void refresh();
  };

  if (openPost) {
    return (
      <>
        <Composer
          key={openPost.id}
          post={openPost}
          account={account}
          defaultTimezone={defaultTimezone}
          onNotice={onNotice}
          onSaved={(p) => {
            setOpenPost(p);
            void refresh();
          }}
          onClose={closeComposer}
          onDeleted={() => {
            onNotice("Draft deleted. Its photo is still in the library.");
            closeComposer();
          }}
          onCopy={(p) => setCopying(p)}
        />
        <CopyDialog
          post={copying}
          source={account}
          accounts={accounts}
          onClose={() => setCopying(null)}
          onCopied={(copies) => {
            setCopying(null);
            const names = copies.map((c) => accounts.find((a) => a.id === c.accountId)?.displayName ?? "account");
            onNotice(`Created ${copies.length} independent draft${copies.length === 1 ? "" : "s"} on: ${names.join(", ")}. Nothing was scheduled.`);
          }}
        />
      </>
    );
  }

  const active = FILTERS.find((f) => f.key === filter)!;
  const shown = (posts ?? []).filter((p) => !active.statuses || active.statuses.includes(p.status));
  const countFor = (f: (typeof FILTERS)[number]) =>
    counts ? (f.statuses ? f.statuses.reduce((n, s) => n + counts[s], 0) : Object.values(counts).reduce((n, c) => n + c, 0)) : 0;

  return (
    <section aria-labelledby="posts-heading" className="posts">
      <div className="posts-toolbar">
        <h2 id="posts-heading">Posts</h2>
        {!account.archived && (
          <div className="post-actions">
            <button type="button" className="primary" onClick={() => setLibrary("pick")}>
              New post
            </button>
            <button type="button" onClick={() => setLibrary("browse")}>
              Photo library
            </button>
          </div>
        )}
      </div>
      <div className="filters" role="group" aria-label="Filter posts by status">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label} <span className="count">{countFor(f)}</span>
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {counts && counts.needs_attention > 0 && filter !== "attention" && (
        <div className="notice-bar error" role="alert">
          <span>
            {counts.needs_attention} post{counts.needs_attention === 1 ? " needs" : "s need"} your attention.
          </span>
          <button type="button" className="link-button" onClick={() => setFilter("attention")}>
            Show
          </button>
        </div>
      )}

      {posts === null ? (
        <p>Loading…</p>
      ) : shown.length === 0 ? (
        <div className="gallery-empty">
          <p>{posts.length === 0 ? "No posts for this account yet." : `No ${active.label.toLowerCase()} posts.`}</p>
          {posts.length === 0 && !account.archived && <p className="hint">Choose “New post” to pick or upload a photo.</p>}
        </div>
      ) : (
        <ul className="post-grid">
          {shown.map((p) => (
            <li key={p.id}>
              <PostCard
                post={p}
                account={account}
                onOpen={async () => {
                  if (await confirmDiscard()) {
                    setOpenPost(p);
                    onOpenPost(p.id);
                  }
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <PhotoLibraryDialog
        open={library !== "closed"}
        {...(library === "pick" ? { pickLabel: "Use for new post", onPick: (m) => void newPost(m.id) } : {})}
        onClose={() => {
          setLibrary("closed");
          void refresh();
        }}
      />
    </section>
  );
}

function PostCard({ post, account, onOpen }: { post: Post; account: Account; onOpen: () => void }) {
  const text = account.platform === "instagram" ? post.caption : post.pinTitle || post.pinDescription;
  const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  const thumb = post.media[0]?.asset.thumbUrl;
  const blocking = post.issues.filter((i) => i.severity === "blocking").length;
  return (
    <button type="button" className="post-card" onClick={onOpen}>
      {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="no-thumb">No photo</span>}
      <span className="post-card-body">
        <span className={`status status-${post.status}`}>{STATUS_LABEL[post.status]}</span>
        <span className="caption-preview">{preview || <em className="hint">No text yet</em>}</span>
        {post.scheduledAt && (post.status === "scheduled" || post.status === "retry_waiting" || post.status === "preparing" || post.status === "publishing") && (
          <span className="when">{formatInZone(post.scheduledAt, post.timezone ?? "UTC")}</span>
        )}
        {post.status === "published" && post.publishedAt && (
          <span className="when">
            {formatInZone(post.publishedAt, post.timezone ?? "UTC")}
            {post.publishedSimulated && " · simulated"}
          </span>
        )}
        {post.status === "needs_attention" && post.attentionMessage && <span className="attention-text">{post.attentionMessage}</span>}
        {post.status === "draft" && blocking > 0 && (
          <span className="hint">
            {blocking} issue{blocking === 1 ? "" : "s"} before scheduling
          </span>
        )}
        <span className="hint">Edited {new Date(post.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
      </span>
    </button>
  );
}
