// Main panel for the selected account: identity, publishing readiness,
// posts (gallery or composer), and account settings.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, CONNECTION_LABEL, PLATFORM_LABEL, renameAccount, type Account } from "./api.ts";
import { useDirty } from "./dialogs.tsx";
import { PlatformIcon } from "./icons.tsx";
import { PostsSection } from "./Posts.tsx";

interface Props {
  account: Account;
  accounts: Account[];
  openPostId: string | null;
  onOpenPost: (id: string | null) => void;
  onNotice: (text: string) => void;
  focusRename: boolean;
  onRenameFocused: () => void;
  onUpdated: (a: Account) => void;
  onArchive: (a: Account) => void;
  onRestore: (a: Account) => void;
  onAcknowledgeReview: (a: Account) => void;
}

export function AccountPanel({ account: a, accounts, openPostId, onOpenPost, onNotice, focusRename, onRenameFocused, onUpdated, onArchive, onRestore, onAcknowledgeReview }: Props) {
  const identity = a.connection.identity;
  const formatDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <article className="account-panel" aria-labelledby="account-title">
      <header className="panel-header">
        <PlatformIcon platform={a.platform} />
        <div>
          <h1 id="account-title" tabIndex={-1}>{a.displayName}</h1>
          <p className="panel-meta">
            {PLATFORM_LABEL[a.platform]} ·{" "}
            <span className={`conn conn-${a.connection.state}`}>{CONNECTION_LABEL[a.connection.state]}</span>
            {identity?.username ? ` as @${identity.username}` : ""}
            {identity?.accountType ? ` (${identity.accountType.toLowerCase()})` : ""}
          </p>
        </div>
      </header>

      {a.archived && (
        <div className="banner" role="status">
          <p>
            Archived {a.archivedAt ? formatDate(a.archivedAt) : ""}. Its posts and history are kept, and nothing publishes from an
            archived account.
          </p>
          <button type="button" onClick={() => onRestore(a)}>
            Restore account
          </button>
        </div>
      )}

      {!a.archived && !a.publishing.ready && (
        <section className="banner attention" aria-labelledby="publishing-heading">
          <h2 id="publishing-heading">Won’t publish automatically</h2>
          <ul>
            {a.publishing.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          {a.schedulesNeedReview && (
            <p>
              Pending schedules stay paused after archiving, restoring, connecting or disconnecting, so nothing resumes without your
              review.{" "}
              <button type="button" className="link-button" onClick={() => onAcknowledgeReview(a)}>
                Mark schedules reviewed
              </button>
            </p>
          )}
        </section>
      )}

      <PostsSection account={a} accounts={accounts} openPostId={openPostId} onOpenPost={onOpenPost} onNotice={onNotice} />

      {!a.archived && !openPostId && (
        <AccountSettings account={a} focusRename={focusRename} onRenameFocused={onRenameFocused} onUpdated={onUpdated} onArchive={onArchive} />
      )}
    </article>
  );
}

function AccountSettings({
  account: a,
  focusRename,
  onRenameFocused,
  onUpdated,
  onArchive,
}: {
  account: Account;
  focusRename: boolean;
  onRenameFocused: () => void;
  onUpdated: (a: Account) => void;
  onArchive: (a: Account) => void;
}) {
  const [name, setName] = useState(a.displayName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const errorId = useId();
  const dirty = name !== a.displayName;
  useDirty(`rename:${a.id}`, dirty);

  useEffect(() => setName(a.displayName), [a.id, a.displayName]);
  useEffect(() => {
    if (!focusRename) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    inputRef.current?.scrollIntoView({ block: "center" });
    onRenameFocused();
  }, [focusRename, onRenameFocused]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onUpdated(await renameAccount(a, name));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not rename the account.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings" aria-labelledby="settings-heading">
      <h2 id="settings-heading">Account settings</h2>
      <form className="rename" onSubmit={(e) => void save(e)} noValidate>
        <label htmlFor={nameId}>Display name</label>
        <div className="inline-field">
          <input
            id={nameId}
            ref={inputRef}
            type="text"
            value={name}
            maxLength={60}
            autoComplete="off"
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="primary" disabled={!dirty || saving}>
            Save name
          </button>
          {dirty && (
            <button type="button" onClick={() => setName(a.displayName)}>
              Revert
            </button>
          )}
        </div>
        {error && (
          <p id={errorId} className="error" role="alert">
            {error}
          </p>
        )}
      </form>

      <div className="setting-row">
        <h3>Connection</h3>
        <p>
          {a.connection.state === "unconnected"
            ? `Not connected. Connecting verifies the real ${PLATFORM_LABEL[a.platform]} account and its eligibility.`
            : CONNECTION_LABEL[a.connection.state]}
        </p>
        <button type="button" disabled aria-describedby={`${nameId}-conn`}>
          Connect {PLATFORM_LABEL[a.platform]} account
        </button>
        <p id={`${nameId}-conn`} className="hint">
          Platform sign-in is not set up in this build yet. You can still use this tab for planning.
        </p>
      </div>

      <div className="setting-row">
        <h3>Archive</h3>
        <p>Hides this tab and pauses any pending publication. Posts and history are kept, and you can restore it later.</p>
        <button type="button" className="danger" onClick={() => onArchive(a)}>
          Archive account…
        </button>
      </div>
    </section>
  );
}
