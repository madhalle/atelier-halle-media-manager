// "Copy to accounts": creates independent drafts on other active accounts.
import { useId, useState } from "react";
import { ApiError, CONNECTION_LABEL, copyPost, PLATFORM_LABEL, type Account, type Post } from "./api.ts";
import { Modal } from "./dialogs.tsx";
import { PlatformIcon } from "./icons.tsx";

interface Props {
  post: Post | null;
  source: Account;
  accounts: Account[];
  onClose: () => void;
  onCopied: (copies: Post[]) => void;
}

export function CopyDialog({ post, source, accounts, onClose, onCopied }: Props) {
  return (
    <Modal open={post !== null} title="Copy to accounts" onCancel={onClose}>
      {post && <CopyForm post={post} source={source} accounts={accounts} onClose={onClose} onCopied={onCopied} />}
    </Modal>
  );
}

function CopyForm({ post, source, accounts, onClose, onCopied }: Props & { post: Post }) {
  const targets = accounts.filter((a) => !a.archived && a.id !== source.id);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();

  const toggle = (id: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onCopied(await copyPost(post, [...chosen]));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not copy the post.");
    } finally {
      setBusy(false);
    }
  };

  if (targets.length === 0) {
    return (
      <>
        <p>There are no other active accounts to copy to. Add another account first.</p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p id={hintId} className="hint">
        Each copy is a separate draft with its own text, crop, board and schedule. It reuses the same stored photo and is never
        scheduled or published automatically. Pinterest boards are not copied, and text moves between caption and description when
        copying across platforms.
      </p>
      <fieldset aria-describedby={hintId}>
        <legend>Copy to</legend>
        <ul className="copy-targets">
          {targets.map((a) => (
            <li key={a.id}>
              <label className="radio">
                <input type="checkbox" checked={chosen.has(a.id)} onChange={() => toggle(a.id)} />
                <PlatformIcon platform={a.platform} />
                <span>
                  {a.displayName}{" "}
                  <span className="hint">
                    ({PLATFORM_LABEL[a.platform]} · {CONNECTION_LABEL[a.connection.state]})
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={chosen.size === 0 || busy} onClick={() => void submit()}>
          Create {chosen.size || ""} draft{chosen.size === 1 ? "" : "s"}
        </button>
      </div>
    </>
  );
}
