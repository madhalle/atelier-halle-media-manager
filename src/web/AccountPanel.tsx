// Main panel for the selected account: identity, publishing readiness,
// posts (gallery or composer), and account settings.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, CONNECTION_LABEL, disconnectAccount, getPlatformSetup, PLATFORM_LABEL, renameAccount, startConnect, type Account } from "./api.ts";
import { useDirty, useGuard } from "./dialogs.tsx";
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
        <ConnectionControls account={a} onUpdated={onUpdated} />
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

function ConnectionControls({ account: a, onUpdated }: { account: Account; onUpdated: (a: Account) => void }) {
  const { confirm, confirmDiscard } = useGuard();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const label = PLATFORM_LABEL[a.platform];
  const identity = a.connection.identity;
  const connected = a.connection.state === "connected";

  useEffect(() => {
    getPlatformSetup()
      .then((s) => setConfigured(a.platform === "instagram" ? s.config.instagram.secretSaved && !!s.config.instagram.clientId : s.config.pinterest.secretSaved && !!s.config.pinterest.clientId))
      .catch(() => setConfigured(false));
  }, [a.platform]);

  const connect = async () => {
    if (!(await confirmDiscard())) return;
    setBusy(true);
    setMessage(null);
    try {
      // Same tab: the platform redirects back to this app to finish.
      window.location.assign(await startConnect(a.id));
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Couldn't start connecting." });
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: `Disconnect ${a.displayName}?`,
      body: (
        <>
          <p>Publishing stops and the saved sign-in is deleted from the Keychain. Posts, schedules and history are kept; schedules pause until you reconnect and review them.</p>
          <p>A post already being sent may still go out; the app checks the result rather than assuming it stopped.</p>
        </>
      ),
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await disconnectAccount(a.id);
      onUpdated(r.account);
      setMessage({
        tone: r.credentialRemoved ? "info" : "error",
        text: `${r.credentialRemoved ? "Disconnected." : "Disconnected, but the saved sign-in couldn't be deleted from the Keychain."} ${r.followUp}`,
      });
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Couldn't disconnect." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        {a.connection.state === "unconnected"
          ? `Not connected. Connecting signs in to ${label}, verifies the real account and checks it can publish.`
          : `${CONNECTION_LABEL[a.connection.state]}${identity?.username ? ` as @${identity.username}` : ""}${identity?.accountType ? ` (${identity.accountType.toLowerCase()})` : ""}.`}
      </p>
      <div className="setup-actions">
        {!connected && (
          <button type="button" className="primary" disabled={busy || configured !== true} onClick={() => void connect()}>
            {a.connection.state === "unconnected" ? `Connect ${label} account` : `Reconnect ${label}`}
          </button>
        )}
        {a.connection.state !== "unconnected" && (
          <button type="button" className="danger" disabled={busy} onClick={() => void disconnect()}>
            Disconnect…
          </button>
        )}
      </div>
      {configured === false && !connected && (
        <p className="hint">Set up the {label} developer app first: Settings › Platform setup.</p>
      )}
      {message && (
        <p className={message.tone === "error" ? "error" : "hint"} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      )}
    </>
  );
}
