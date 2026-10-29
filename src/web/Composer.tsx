// Post editor for one destination post. Shows only fields the account's
// platform supports, previews the real publishing derivative, and validates.
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiError,
  deletePost,
  derivativeUrl,
  PLATFORM_ASPECTS,
  PLATFORM_LABEL,
  STATUS_LABEL,
  updatePost,
  type Account,
  type CropAspect,
  type Issue,
  type Post,
  type PostFields,
} from "./api.ts";
import { useDirty, useGuard } from "./dialogs.tsx";

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
  onSaved: (p: Post) => void;
  onClose: () => void;
  onDeleted: () => void;
  onCopy: (p: Post) => void;
}

export function Composer({ post, account, onSaved, onClose, onDeleted, onCopy }: Props) {
  const { confirm, confirmDiscard } = useGuard();
  const platform = account.platform;
  const editable = post.status === "draft" || post.status === "canceled";
  const item = post.media[0];

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

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!dirty) return post;
    setSaving(true);
    setError(null);
    try {
      const saved = await updatePost(
        post,
        fields,
        item && cropDirty ? [{ position: item.position, cropAspect: crop.aspect, focusX: Math.round(crop.fx * 100) / 100, focusY: Math.round(crop.fy * 100) / 100 }] : undefined,
      );
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
          <h3 id="photo-heading">Photo and crop</h3>
          {item && previewSrc ? (
            <>
              <figure className="preview">
                <img src={previewSrc} alt={fields.altText || "Preview of the photo as it will be posted"} />
                <figcaption className="hint">
                  Exact {PLATFORM_LABEL[platform]} upload: {ASPECT_LABEL[debouncedCrop.aspect]}, colour-corrected, location data removed.
                </figcaption>
              </figure>
              <fieldset disabled={!editable}>
                <legend>Crop</legend>
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
                hint="Describes the photo for people using screen readers."
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
              <div className="field">
                <span className="field-label">Board</span>
                <p>{post.pinBoardName ?? <span className="hint">No board chosen.</span>}</p>
                <p className="hint">
                  {account.connection.state === "connected"
                    ? "Board selection arrives with Pinterest sign-in."
                    : "Boards load from Pinterest after this account is connected."}
                </p>
                <FieldIssues issues={issuesFor("pinBoard")} />
              </div>
            </>
          )}
          <details className="unsupported">
            <summary>What can’t be set here?</summary>
            {platform === "instagram" ? (
              <p>
                Location tags, people tags, product tags, music and collaborators aren’t included in this version. Reels, Stories and video
                aren’t supported. Carousels come later.
              </p>
            ) : (
              <p>Board sections, video Pins and multi-image Pins aren’t included in this version.</p>
            )}
          </details>
        </section>

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

        {error && (
          <p className="error" role="alert">
            {error}
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
          {editable && (
            <button type="button" className="danger" onClick={() => void remove()}>
              Delete draft…
            </button>
          )}
        </div>
      </form>
    </article>
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
