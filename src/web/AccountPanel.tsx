// Main panel for the selected account: identity, publishing readiness,
// posts (gallery or composer), and account settings.
import { useState } from "react";
import { ApiError, CONNECTION_LABEL, disconnectAccount, PLATFORM_LABEL, type Account } from "./api.ts";
import { AccountPreview } from "./AccountPreview.tsx";
import { ConnectAccount } from "./ConnectAccount.tsx";
import { useGuard } from "./dialogs.tsx";
import { PlatformIcon } from "./icons.tsx";
import { PostsSection } from "./Posts.tsx";

interface Props {
  account: Account;
  accounts: Account[];
  openPostId: string | null;
  onOpenPost: (id: string | null) => void;
  onNotice: (text: string) => void;
  onUpdated: (a: Account) => void;
  onArchive: (a: Account) => void;
  onRestore: (a: Account) => void;
  onAcknowledgeReview: (a: Account) => void;
}

export function AccountPanel({ account: a, accounts, openPostId, onOpenPost, onNotice, onUpdated, onArchive, onRestore, onAcknowledgeReview }: Props) {
  const identity = a.connection.identity;
  const formatDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <article className="account-panel" aria-labelledby="account-title">
      <header className="panel-header">
        <PlatformIcon platform={a.platform} />
        <div>
          <h1 id="account-title" tabIndex={-1}>{a.label}</h1>
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

      {!a.archived && !openPostId && a.connection.state === "connected" && identity?.accountType !== "SIMULATED" && <AccountPreview account={a} />}

      <PostsSection account={a} accounts={accounts} openPostId={openPostId} onOpenPost={onOpenPost} onNotice={onNotice} />

      {!a.archived && !openPostId && (
        <AccountSettings account={a} onUpdated={onUpdated} onArchive={onArchive} />
      )}
    </article>
  );
}

function AccountSettings({ account: a, onUpdated, onArchive }: { account: Account; onUpdated: (a: Account) => void; onArchive: (a: Account) => void }) {
  return (
    <section className="settings" aria-labelledby="settings-heading">
      <h2 id="settings-heading">Account settings</h2>
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
  const { confirm } = useGuard();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const identity = a.connection.identity;

  const disconnect = async () => {
    const ok = await confirm({
      title: `Disconnect ${a.label}?`,
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
        {CONNECTION_LABEL[a.connection.state]}
        {identity?.username ? ` as @${identity.username}` : ""}
        {identity?.accountType ? ` (${identity.accountType.toLowerCase()})` : ""}.
      </p>
      {a.connection.state !== "connected" && <ConnectAccount account={a} onConnected={onUpdated} />}
      {a.connection.state !== "unconnected" && (
        <div className="setup-actions">
          <button type="button" className="danger" disabled={busy} onClick={() => void disconnect()}>
            Disconnect…
          </button>
        </div>
      )}
      {message && (
        <p className={message.tone === "error" ? "error" : "hint"} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      )}
    </>
  );
}
