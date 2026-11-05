// Post editor for one destination post. Shows only fields the account's
// platform supports, previews the real publishing derivative, and validates.
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiError,
  listBoards,
  setPostBoard,
  type Board,
  deletePost,
  derivativeUrl,
  MAX_PHOTOS,
  PLATFORM_ASPECTS,
  PLATFORM_LABEL,
  STATUS_LABEL,
  setPostMedia,
  updatePost,
  type Account,
  type CropAspect,
  type Issue,
  type Post,
  type PostFields,
} from "./api.ts";
import { useDirty, useGuard } from "./dialogs.tsx";
import { PhotoLibraryDialog } from "./PhotoLibrary.tsx";
import { SchedulePanel } from "./SchedulePanel.tsx";

const LIMITS = {
  caption: 2200,
  hashtags: 30,
  mentions: 20,
  igAlt: 1000,
  pinTitle: 100,
  pinDescription: 800,
  pinLink: 2048,
  pinAlt: 500,
};

const ASPECT_LABEL: Record<CropAspect, string> = {
  original: "Original",
  "1:1": "Square 1:1",
  "4:5": "Portrait 4:5",
  "1.91:1": "Landscape 1.91:1",
  "2:3": "Tall 2:3",
};

const chars = (s: string) => [...s].length;
const hashtags = (s: string) => (s.match(/(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu) ?? []).length;
const mentions = (s: string) => (s.match(/(^|[^\p{L}\p{N}_.])@[\p{L}\p{N}_.]+/gu) ?? []).length;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface Props {
  post: Post;
  account: Account;
  defaultTimezone: string;
  onNotice: (text: string) => void;
  onSaved: (p: Post) => void;
  onClose: () => void;
  onDeleted: () => void;
  onCopy: (p: Post) => void;
}

export function Composer({ post, account, defaultTimezone, onNotice, onSaved, onClose, onDeleted, onCopy }: Props) {
  const { confirm, confirmDiscard } = useGuard();
  const platform = account.platform;
  // Mirrors the server's rules; the server enforces them regardless.
  const editable =
    (post.status === "draft" ||
      post.status === "canceled" ||
      post.status === "scheduled" ||
      post.status === "retry_waiting" ||
      post.status === "needs_attention") &&
    post.commitStartedAt === null &&
    post.attentionKind !== "ambiguous";
  const deletable = post.status === "draft" || post.status === "canceled";
  const count = post.media.length;
  const carousel = count > 1;
  const [selected, setSelected] = useState(0);
  const item = post.media[Math.min(selected, count - 1)];
  const [picking, setPicking] = useState(false);

  const pick = (p: Post): PostFields => ({
    caption: p.caption,
    altText: p.altText,
    pinTitle: p.pinTitle,
    pinDescription: p.pinDescription,
    pinLink: p.pinLink,
  });
  const [fields, setFields] = useState<PostFields>(() => pick(post));
  const [crop, setCrop] = useState(() => ({ aspect: item?.cropAspect ?? "original", fx: item?.focusX ?? 0.5, fy: item?.focusY ?? 0.5 }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cropDirty = !!item && (crop.aspect !== item.cropAspect || Math.abs(crop.fx - item.focusX) > 0.004 || Math.abs(crop.fy - item.focusY) > 0.004);
  const fieldsDirty = (Object.keys(fields) as (keyof PostFields)[]).some((k) => fields[k] !== post[k]);
  const dirty = editable && (fieldsDirty || cropDirty);
  useDirty(`post:${post.id}`, dirty);

  const debouncedCrop = useDebounced(crop, 250);
  const previewSrc = item ? derivativeUrl(item.asset.id, platform, debouncedCrop.aspect, debouncedCrop.fx, debouncedCrop.fy) : null;

  const set = (k: keyof PostFields) => (v: string) => setFields((f) => ({ ...f, [k]: v }));
  // Server issues describe the saved version; hide them for fields with unsaved edits.
  const fieldDirty: Partial<Record<Issue["field"], boolean>> = {
    caption: fields.caption !== post.caption,
    altText: fields.altText !== post.altText,
    pinTitle: fields.pinTitle !== post.pinTitle,
    pinDescription: fields.pinDescription !== post.pinDescription,
    pinLink: fields.pinLink !== post.pinLink,
    media: cropDirty,
  };
  const issuesFor = (field: Issue["field"]) => (fieldDirty[field] ? [] : post.issues.filter((i) => i.field === field));

  const round = (v: number) => Math.round(v * 100) / 100;
  // A carousel shares one crop shape, so changing it applies to every photo; the position is per photo.
  const cropPatch = () => {
    if (!item || !cropDirty) return undefined;
    const shapeChanged = crop.aspect !== item.cropAspect;
    return post.media
      .filter((m) => m.position === item.position || (carousel && shapeChanged))
      .map((m) =>
        m.position === item.position
          ? { position: m.position, cropAspect: crop.aspect, focusX: round(crop.fx), focusY: round(crop.fy) }
          : { position: m.position, cropAspect: crop.aspect, focusX: m.focusX, focusY: m.focusY },
      );
  };

  const select = (i: number) => {
    const m = post.media[i];
    if (!m) return;
    setSelected(i);
    setCrop({ aspect: m.cropAspect, fx: m.focusX, fy: m.focusY });
  };

  type PhotoItem = { mediaAssetId: string; cropAspect: CropAspect; focusX: number; focusY: number };
  const items = (): PhotoItem[] => post.media.map((m) => ({ mediaAssetId: m.asset.id, cropAspect: m.cropAspect, focusX: m.focusX, focusY: m.focusY }));

  /** Add, remove or reorder photos; saved immediately. */
  const changePhotos = async (next: PhotoItem[], nextSelected: number) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await setPostMedia(post, next);
      onSaved(saved);
      const m = saved.media[Math.min(nextSelected, saved.media.length - 1)]!;
      setSelected(Math.min(nextSelected, saved.media.length - 1));
      setCrop({ aspect: m.cropAspect, fx: m.focusX, fy: m.focusY });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the photos.");
    } finally {
      setSaving(false);
    }
  };
  const move = (i: number, by: -1 | 1) => {
    const next = items();
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    void changePhotos(next, i + by);
  };
  const removeAt = (i: number) => void changePhotos(items().filter((_, n) => n !== i), Math.max(0, i - 1));
  const addPhoto = (assetId: string) => {
    setPicking(false);
    if (post.media.some((m) => m.asset.id === assetId)) {
      setError("That photo is already in this post.");
      return;
    }
    // New photos join with the carousel's shape, centred.
    const shape = post.media[0]?.cropAspect ?? PLATFORM_ASPECTS[platform][0]!;
    void changePhotos([...items(), { mediaAssetId: assetId, cropAspect: shape, focusX: 0.5, focusY: 0.5 }], count);
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!dirty) return post;
    setSaving(true);
    setError(null);
    try {
      const saved = await updatePost(post, fields, cropPatch());
      onSaved(saved);
      return saved;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the draft.");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (await confirmDiscard()) onClose();
  };

  const remove = async () => {
    const ok = await confirm({
      title: "Delete this draft?",
      body: "The draft is deleted. Its photo stays in the photo library, and copies on other accounts are not affected.",
      confirmLabel: "Delete draft",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deletePost(post);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the draft.");
    }
  };

  const copy = async () => {
    if (dirty) {
      const saved = await save();
      if (!saved) return;
      onCopy(saved);
    } else onCopy(post);
  };

  const blocking = post.issues.filter((i) => i.severity === "blocking");
  const warnings = post.issues.filter((i) => i.severity === "warning");

  return (
    <article className="composer" aria-labelledby="composer-title">
      <header className="composer-header">
        <button type="button" className="link-button" onClick={() => void close()}>
          ← Back to posts
        </button>
        <h2 id="composer-title" tabIndex={-1}>
          {STATUS_LABEL[post.status]} for {account.displayName}
        </h2>
        {post.copiedFromPostId && <p className="hint">Independent copy: edits here never change the original or other copies.</p>}
      </header>

      <form className="composer-grid" onSubmit={(e) => void save(e)} noValidate>
        <section className="composer-media" aria-labelledby="photo-heading">
          <h3 id="photo-heading">{carousel ? `Carousel: ${count} photos` : "Photo and crop"}</h3>
          <PhotoStrip
            post={post}
            selected={Math.min(selected, count - 1)}
            editable={editable}
            locked={cropDirty || saving}
            max={MAX_PHOTOS[platform]}
            onSelect={select}
            onMove={move}
            onRemove={removeAt}
            onAdd={() => setPicking(true)}
          />
          {cropDirty && carousel && <p className="hint">Save the crop before switching or rearranging photos.</p>}
          {item && previewSrc ? (
            <>
              <figure className="preview">
                <img src={previewSrc} alt={fields.altText || "Preview of the photo as it will be posted"} />
                <figcaption className="hint">
                  {carousel && `Photo ${Math.min(selected, count - 1) + 1} of ${count}. `}
                  Exact {PLATFORM_LABEL[platform]} upload: {ASPECT_LABEL[debouncedCrop.aspect]}, colour-corrected, location data removed.
                </figcaption>
              </figure>
              <fieldset disabled={!editable}>
                <legend>Crop</legend>
                {carousel && <p className="hint">Every photo in a carousel uses the same shape. The position is set per photo.</p>}
                <div className="crop-options">
                  {PLATFORM_ASPECTS[platform].map((a) => (
                    <label key={a} className="radio">
                      <input type="radio" name="aspect" value={a} checked={crop.aspect === a} onChange={() => setCrop((c) => ({ ...c, aspect: a }))} />
                      {ASPECT_LABEL[a]}
                    </label>
                  ))}
                </div>
                {crop.aspect !== "original" && (
                  <>
                    <Slider label="Horizontal position" value={crop.fx} onChange={(fx) => setCrop((c) => ({ ...c, fx }))} />
                    <Slider label="Vertical position" value={crop.fy} onChange={(fy) => setCrop((c) => ({ ...c, fy }))} />
                  </>
                )}
              </fieldset>
              <FieldIssues issues={issuesFor("media")} />
            </>
          ) : (
            <p className="error">This post has no photo.</p>
          )}
        </section>

        <section className="composer-fields" aria-labelledby="text-heading">
          <h3 id="text-heading">{platform === "instagram" ? "Instagram post" : "Pin details"}</h3>
          {platform === "instagram" ? (
            <>
              <TextField
                label="Caption"
                multiline
                value={fields.caption}
                onChange={set("caption")}
                disabled={!editable}
                counters={[
                  `${chars(fields.caption)}/${LIMITS.caption} characters`,
                  `${hashtags(fields.caption)}/${LIMITS.hashtags} hashtags`,
                  `${mentions(fields.caption)}/${LIMITS.mentions} mentions`,
                ]}
                over={chars(fields.caption) > LIMITS.caption || hashtags(fields.caption) > LIMITS.hashtags || mentions(fields.caption) > LIMITS.mentions}
                hint="Hashtags and @mentions are part of the caption text."
                issues={issuesFor("caption")}
              />
              <TextField
                label="Alt text"
                multiline
                rows={2}
                value={fields.altText}
                onChange={set("altText")}
                disabled={!editable}
                counters={[`${chars(fields.altText)}/${LIMITS.igAlt}`]}
                over={chars(fields.altText) > LIMITS.igAlt}
                hint={
                  carousel
                    ? "Instagram's API doesn't document alt text for carousel photos, so it isn't sent with carousels."
                    : "Describes the photo for people using screen readers."
                }
                issues={issuesFor("altText")}
              />
            </>
          ) : (
            <>
              <TextField
                label="Title"
                value={fields.pinTitle}
                onChange={set("pinTitle")}
                disabled={!editable}
                counters={[`${chars(fields.pinTitle)}/${LIMITS.pinTitle}`]}
                over={chars(fields.pinTitle) > LIMITS.pinTitle}
                issues={issuesFor("pinTitle")}
              />
              <TextField
                label="Description"
                multiline
                value={fields.pinDescription}
                onChange={set("pinDescription")}
                disabled={!editable}
                counters={[`${chars(fields.pinDescription)}/${LIMITS.pinDescription}`]}
                over={chars(fields.pinDescription) > LIMITS.pinDescription}
                hint="Hashtags, if you use them, are part of the description."
                issues={issuesFor("pinDescription")}
              />
              <TextField
                label="Destination link"
                type="url"
                value={fields.pinLink}
                onChange={set("pinLink")}
                disabled={!editable}
                counters={[]}
                over={chars(fields.pinLink) > LIMITS.pinLink}
                hint="Optional. Where the Pin leads, e.g. https://atelierhalle.com/…"
                issues={issuesFor("pinLink")}
              />
              <TextField
                label="Alt text"
                multiline
                rows={2}
                value={fields.altText}
                onChange={set("altText")}
                disabled={!editable}
                counters={[`${chars(fields.altText)}/${LIMITS.pinAlt}`]}
                over={chars(fields.altText) > LIMITS.pinAlt}
                issues={issuesFor("altText")}
              />
              <BoardPicker post={post} account={account} editable={editable} dirty={dirty} onSaved={onSaved} />
              <FieldIssues issues={issuesFor("pinBoard")} />
            </>
          )}
          <details className="unsupported">
            <summary>What can’t be set here?</summary>
            {platform === "instagram" ? (
              <p>
                Location tags, people tags, product tags, music and collaborators aren’t included in this version. Reels, Stories and video
                aren’t supported.
              </p>
            ) : (
              <p>Board sections, video Pins, and per-photo titles or links in carousel Pins aren’t included in this version. Tagged topics can’t be set: Pinterest’s API has no field for them, so Pinterest picks topics from the title and description.</p>
            )}
          </details>
        </section>

        {editable && (
        <section className="composer-checks" aria-labelledby="checks-heading">
          <h3 id="checks-heading">Ready to schedule?</h3>
          {dirty && <p className="hint">Save to re-check.</p>}
          {blocking.length === 0 ? (
            <p className="ok">Nothing blocks this post.</p>
          ) : (
            <ul className="issues blocking">
              {blocking.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          )}
          {warnings.length > 0 && (
            <ul className="issues warnings">
              {warnings.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          )}
          {!account.publishing.ready && (
            <p className="hint">Even when ready, this account won’t publish until: {account.publishing.blockers.join(" ")}</p>
          )}
        </section>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!editable && (
          <p className="hint composer-locked">
            {post.status === "published" ? "Published posts can't be edited here." : "Editing is locked while this post is being published or its outcome is checked."}
          </p>
        )}
        <div className="composer-actions">
          {editable && (
            <button type="submit" className="primary" disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save draft"}
            </button>
          )}
          <button type="button" onClick={() => void copy()} disabled={saving}>
            Copy to accounts…
          </button>
          {deletable && (
            <button type="button" className="danger" onClick={() => void remove()}>
              Delete draft…
            </button>
          )}
        </div>
      </form>
      <PhotoLibraryDialog open={picking} pickLabel="Add to post" onPick={(m) => addPhoto(m.id)} onClose={() => setPicking(false)} />
      <SchedulePanel post={post} account={account} defaultTimezone={defaultTimezone} dirty={dirty} onChanged={onSaved} onNotice={onNotice} />
    </article>
  );
}

function PhotoStrip({
  post,
  selected,
  editable,
  locked,
  max,
  onSelect,
  onMove,
  onRemove,
  onAdd,
}: {
  post: Post;
  selected: number;
  editable: boolean;
  locked: boolean;
  max: number;
  onSelect: (i: number) => void;
  onMove: (i: number, by: -1 | 1) => void;
  onRemove: (i: number) => void;
  onAdd: () => void;
}) {
  const count = post.media.length;
  if (count <= 1 && !editable) return null;
  return (
    <div className="photo-strip">
      <ol aria-label="Photos in this post">
        {post.media.map((m, i) => (
          <li key={`${m.asset.id}-${i}`} className={i === selected ? "selected" : undefined}>
            <button type="button" className="strip-thumb" aria-pressed={i === selected} disabled={locked && i !== selected} onClick={() => onSelect(i)}>
              <img src={m.asset.thumbUrl} alt="" />
              <span className="visually-hidden">
                Photo {i + 1} of {count}
                {m.asset.originalFilename ? `: ${m.asset.originalFilename}` : ""}
              </span>
            </button>
            {editable && count > 1 && (
              <span className="strip-actions">
                <button type="button" aria-label={`Move photo ${i + 1} earlier`} disabled={locked || i === 0} onClick={() => onMove(i, -1)}>
                  ←
                </button>
                <button type="button" aria-label={`Move photo ${i + 1} later`} disabled={locked || i === count - 1} onClick={() => onMove(i, 1)}>
                  →
                </button>
                <button type="button" aria-label={`Remove photo ${i + 1} from the post`} disabled={locked} onClick={() => onRemove(i)}>
                  ×
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {editable && (
        <button type="button" onClick={onAdd} disabled={locked || count >= max}>
          {count >= max ? `Maximum ${max} photos` : count === 1 ? "Add photo (carousel)…" : "Add photo…"}
        </button>
      )}
    </div>
  );
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const id = useId();
  return (
    <div className="slider">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={0} max={100} step={1} value={Math.round(value * 100)} onChange={(e) => onChange(Number(e.target.value) / 100)} />
    </div>
  );
}

function FieldIssues({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="field-issues">
      {issues.map((i, n) => (
        <li key={n} className={i.severity}>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  counters: string[];
  over: boolean;
  disabled: boolean;
  issues: Issue[];
  hint?: ReactNode;
  multiline?: boolean;
  rows?: number;
  type?: "text" | "url";
}

function TextField({ label, value, onChange, counters, over, disabled, issues, hint, multiline, rows = 5, type = "text" }: TextFieldProps) {
  const id = useId();
  const counterId = useId();
  const hintId = useId();
  const describedBy = [counters.length ? counterId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    value,
    disabled,
    "aria-describedby": describedBy,
    "aria-invalid": over || issues.some((i) => i.severity === "blocking"),
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {multiline ? <textarea rows={rows} {...common} /> : <input type={type} autoComplete="off" {...common} />}
      {counters.length > 0 && (
        <p id={counterId} className={`counter${over ? " over" : ""}`}>
          {counters.join(" · ")}
        </p>
      )}
      {hint && (
        <p id={hintId} className="hint">
          {hint}
        </p>
      )}
      <FieldIssues issues={issues} />
    </div>
  );
}

function BoardPicker({ post, account, editable, dirty, onSaved }: { post: Post; account: Account; editable: boolean; dirty: boolean; onSaved: (p: Post) => void }) {
  const id = useId();
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = account.connection.state === "connected";

  useEffect(() => {
    if (!connected) return;
    listBoards(account.id)
      .then(setBoards)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Couldn't load boards."));
  }, [account.id, connected]);

  if (!connected) {
    return (
      <div className="field">
        <span className="field-label">Board</span>
        <p>{post.pinBoardName ?? <span className="hint">No board chosen.</span>}</p>
        <p className="hint">Boards load from Pinterest after this account is connected.</p>
      </div>
    );
  }
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        Board
      </label>
      <select
        id={id}
        value={post.pinBoardId ?? ""}
        disabled={!editable || dirty || boards === null}
        onChange={(e) => {
          setError(null);
          setPostBoard(post, e.target.value)
            .then(onSaved)
            .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Couldn't set the board."));
        }}
      >
        <option value="" disabled>
          {boards === null ? "Loading boards…" : "Choose a board"}
        </option>
        {(boards ?? []).map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
            {b.privacy === "SECRET" ? " (secret)" : ""}
          </option>
        ))}
      </select>
      {dirty && <p className="hint">Save your changes before changing the board.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
