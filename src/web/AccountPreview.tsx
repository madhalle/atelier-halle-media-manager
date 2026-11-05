// The connected account as it appears on the platform: profile and most
// recent posts, so each tab is recognisable. Read-only; links open the
// platform in a new tab. Images come from this app's server, never directly.
import { useEffect, useState } from "react";
import { ApiError, getAccountPreview, PLATFORM_LABEL, type Account, type AccountPreview as Preview } from "./api.ts";

const KIND_LABEL = { photo: "Photo", carousel: "Carousel", video: "Video", pin: "Pin" } as const;

export function AccountPreview({ account: a }: { account: Account }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = PLATFORM_LABEL[a.platform];

  const load = async (refresh: boolean) => {
    setBusy(true);
    try {
      setPreview(await getAccountPreview(a.id, refresh));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Couldn't load the ${label} profile.`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setPreview(null);
    setError(null);
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id, a.connection.identity?.username]);

  const p = preview?.profile;
  return (
    <section className="account-preview" aria-labelledby={`preview-${a.id}`} aria-busy={busy}>
      <div className="preview-head">
        {p?.avatar ? <img className="preview-avatar" src={p.avatar} alt="" width={56} height={56} /> : <div className="preview-avatar" aria-hidden="true" />}
        <div className="preview-identity">
          <h2 id={`preview-${a.id}`}>
            {p?.name ?? (p?.username ? `@${p.username}` : `On ${label}`)}
          </h2>
          <p className="hint">
            {p?.username ? `@${p.username}` : ""}
            {p?.postCount !== null && p?.postCount !== undefined ? ` · ${p.postCount} ${a.platform === "pinterest" ? "Pins" : "posts"}` : ""}
            {` · from ${label}`}
          </p>
          {p?.bio && <p className="preview-bio">{p.bio}</p>}
          <p className="preview-links">
            {p?.url && (
              <a href={p.url} target="_blank" rel="noopener noreferrer">
                View on {label} ↗
              </a>
            )}
            {p?.website && (
              <a href={p.website} target="_blank" rel="noopener noreferrer nofollow">
                {new URL(p.website).host} ↗
              </a>
            )}
          </p>
        </div>
        <button type="button" onClick={() => void load(true)} disabled={busy}>
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {preview && (
        <>
          <h3 className="preview-subhead">
            {preview.sandbox ? "Recent sandbox Pins" : a.platform === "pinterest" ? "Recent Pins on Pinterest" : `Recently on ${label}`}
          </h3>
          {preview.sandbox && (
            <p className="hint">On Trial access Pinterest only lists Pins made through this app, not your public Pins. They'll show here with Standard access.</p>
          )}
          {preview.posts.length === 0 ? (
            <p className="hint">{preview.sandbox ? "No sandbox Pins yet." : "Nothing posted yet."}</p>
          ) : (
            <ul className={`preview-grid preview-${a.platform}`}>
              {preview.posts.map((post) => {
                const alt = `${KIND_LABEL[post.kind]}${post.postedAt ? ` from ${new Date(post.postedAt).toLocaleDateString()}` : ""}`;
                const img = <img src={post.image} alt={alt} loading="lazy" />;
                return (
                  <li key={post.key}>
                    {post.url ? (
                      <a href={post.url} target="_blank" rel="noopener noreferrer" title={`Open on ${label}`}>
                        {img}
                      </a>
                    ) : (
                      img
                    )}
                    {post.kind === "carousel" && <span className="preview-badge" aria-hidden="true">⧉</span>}
                    {post.kind === "video" && <span className="preview-badge" aria-hidden="true">▶</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
