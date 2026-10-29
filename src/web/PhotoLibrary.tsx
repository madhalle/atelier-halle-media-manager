// Shared photo library: multi-file upload, browsing, deleting unused photos,
// and (in pick mode) choosing a photo for a new post.
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, deleteMedia, listMedia, uploadPhotos, type MediaItem, type UploadResult } from "./api.ts";
import { Modal, useGuard } from "./dialogs.tsx";

const ACCEPT = "image/jpeg,image/png,image/webp";

interface Props {
  open: boolean;
  /** When set, clicking a photo picks it instead of just browsing. */
  pickLabel?: string | undefined;
  onPick?: ((m: MediaItem) => void) | undefined;
  onClose: () => void;
}

export function PhotoLibraryDialog({ open, pickLabel, onPick, onClose }: Props) {
  return (
    <Modal open={open} title={onPick ? "Choose a photo" : "Photo library"} onCancel={onClose}>
      <Library pickLabel={pickLabel} onPick={onPick} onClose={onClose} />
    </Modal>
  );
}

function Library({ pickLabel, onPick, onClose }: Omit<Props, "open">) {
  const { confirm } = useGuard();
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const refresh = () =>
    listMedia()
      .then(setItems)
      .catch(() => setError("Could not load the photo library."));
  useEffect(() => void refresh(), []);

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await uploadPhotos(Array.from(files)));
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (m: MediaItem) => {
    const ok = await confirm({
      title: "Delete this photo?",
      body: "It is removed from this app's library. The file you uploaded from is not affected.",
      confirmLabel: "Delete photo",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteMedia(m.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the photo.");
    }
  };

  const failures = results.filter((r): r is Extract<UploadResult, { ok: false }> => !r.ok);
  const added = results.filter((r) => r.ok && r.created).length;
  const duplicates = results.filter((r) => r.ok && !r.created).length;

  return (
    <div className="library">
      <div className="library-upload">
        <label htmlFor={inputId} className="button-like primary">
          {busy ? "Uploading…" : "Upload photos"}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept={ACCEPT}
          multiple
          disabled={busy}
          onChange={(e) => void onFiles(e.target.files)}
        />
        <p className="hint">JPEG, PNG or WebP, up to 50 MB each. Photos are copied into the app, so moving the original file later is safe.</p>
      </div>

      <div aria-live="polite">
        {results.length > 0 && (
          <p className="upload-summary">
            {added > 0 && `${added} photo${added === 1 ? "" : "s"} added. `}
            {duplicates > 0 && `${duplicates} already in the library. `}
            {failures.length > 0 && `${failures.length} not added.`}
          </p>
        )}
        {failures.length > 0 && (
          <ul className="upload-errors">
            {failures.map((f, i) => (
              <li key={i}>
                <strong>{f.filename ?? "File"}</strong>: {f.error}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {items === null ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p className="hint">The library is empty. Upload photos to get started.</p>
      ) : (
        <ul className="library-grid">
          {items.map((m) => (
            <li key={m.id}>
              <figure>
                <img src={m.thumbUrl} alt={m.originalFilename ?? "Photo"} loading="lazy" width={160} height={160} />
                <figcaption>
                  <span className="filename">{m.originalFilename ?? "Untitled"}</span>
                  <span className="hint">
                    {m.width}×{m.height}
                    {m.hasLocation ? " · has location data (removed when posting)" : ""}
                  </span>
                </figcaption>
              </figure>
              <div className="library-actions">
                {onPick && (
                  <button type="button" className="primary" onClick={() => onPick(m)} aria-label={`${pickLabel ?? "Use"}: ${m.originalFilename ?? "photo"}`}>
                    {pickLabel ?? "Use"}
                  </button>
                )}
                {m.usedByPosts === 0 ? (
                  <button type="button" className="danger" onClick={() => void remove(m)} aria-label={`Delete ${m.originalFilename ?? "photo"}`}>
                    Delete
                  </button>
                ) : (
                  <span className="hint">In {m.usedByPosts} post{m.usedByPosts === 1 ? "" : "s"}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
