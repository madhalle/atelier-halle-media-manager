// Backups and background service: status at a glance, "back up now", and
// integrity checks. Restoring needs the app stopped, so it's a Terminal command.
import { useCallback, useEffect, useState } from "react";
import { ApiError, backUpNow, getMaintenance, verifyBackup, type BackupInfo, type Maintenance } from "./api.ts";
import { Modal } from "./dialogs.tsx";

const REASON: Record<BackupInfo["reason"], string> = {
  daily: "Daily",
  manual: "Manual",
  "pre-migration": "Before an upgrade",
  "pre-restore": "Before a restore",
};

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function MaintenanceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} title="Backups and service" onCancel={onClose}>
      <MaintenanceBody onClose={onClose} />
    </Modal>
  );
}

function MaintenanceBody({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Maintenance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [checks, setChecks] = useState<Record<string, { tone: "ok" | "error"; text: string }>>({});

  const reload = useCallback(
    () =>
      getMaintenance()
        .then(setData)
        .catch(() => setError("Couldn't load backup and service status.")),
    [],
  );
  useEffect(() => void reload(), [reload]);

  if (!data) return <p>{error ?? "Loading…"}</p>;
  const envFlag = data.service.env === "production" ? "" : ` --env ${data.service.env}`;
  const latest = data.backups[0];

  const backUp = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await backUpNow();
      setStatus({ tone: "ok", text: "Backed up." });
      await reload();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof ApiError ? err.message : "The backup failed." });
    } finally {
      setBusy(false);
    }
  };

  const check = async (id: string) => {
    setChecks((c) => ({ ...c, [id]: { tone: "ok", text: "Checking…" } }));
    try {
      const r = await verifyBackup(id);
      setChecks((c) => ({ ...c, [id]: { tone: "ok", text: `Intact: database verified, all ${r.photoFiles} photo files present.` } }));
    } catch (err) {
      setChecks((c) => ({ ...c, [id]: { tone: "error", text: err instanceof ApiError ? err.message : "The check couldn't run." } }));
    }
  };

  return (
    <div className="maintenance">
      <section aria-labelledby="svc-heading">
        <h3 id="svc-heading">Service</h3>
        <ul className="status-list">
          <li>
            {data.service.mode === "background" ? (
              <span className="health-ok">● Running in the background: starts at login, restarts after a crash.</span>
            ) : (
              <>
                <span className="health-bad">● Running from Terminal.</span> Scheduled posts only go out while that Terminal window stays open
                and the Mac is awake. To run it in the background instead, stop it (Ctrl+C) and run{" "}
                <code>npm run service -- install{envFlag}</code>.
              </>
            )}
          </li>
          <li>
            Live publishing:{" "}
            {data.livePublishing ? <span className="health-ok">on</span> : <span>off (connecting works; nothing is published)</span>}
          </li>
          <li>
            macOS Keychain:{" "}
            {data.keychain.ok ? <span className="health-ok">available</span> : <span className="health-bad">unavailable: {data.keychain.reason}</span>}
          </li>
        </ul>
      </section>

      <section aria-labelledby="bk-heading">
        <h3 id="bk-heading">Backups</h3>
        <p className="hint">
          The app backs up automatically every day and before upgrades. Photos in backups are linked, not copied, so they take almost no extra
          space. Secrets are never included; they stay in the Keychain.
        </p>
        <p>
          {latest ? (
            <>
              Latest: {when(latest.createdAt)} ({REASON[latest.reason].toLowerCase()}).
            </>
          ) : (
            "No backups yet."
          )}{" "}
          <button type="button" className="primary" onClick={() => void backUp()} disabled={busy}>
            {busy ? "Backing up…" : "Back up now"}
          </button>{" "}
          {status && <span className={status.tone === "error" ? "error" : "hint"} role={status.tone === "error" ? "alert" : "status"}>{status.text}</span>}
        </p>
        {data.backups.length > 0 && (
          <table className="backups">
            <thead>
              <tr>
                <th scope="col">Made</th>
                <th scope="col">Kind</th>
                <th scope="col">Photo files</th>
                <th scope="col">Extra space</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.backups.map((b) => (
                <tr key={b.id}>
                  <td>{when(b.createdAt)}</td>
                  <td>{REASON[b.reason]}</td>
                  <td>{b.photoFiles}</td>
                  <td>{size(b.extraBytes)}</td>
                  <td>
                    <button type="button" onClick={() => void check(b.id)} aria-label={`Check backup from ${when(b.createdAt)}`}>
                      Check
                    </button>
                    {checks[b.id] && (
                      <span className={checks[b.id]!.tone === "error" ? "error" : "hint"} role="status">
                        {" "}
                        {checks[b.id]!.text}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <details>
          <summary>Restoring or copying a backup to another drive</summary>
          <p>
            Backups live on the same disk as your library, so copy one to another drive from time to time (or let Time Machine back up your
            Mac):
          </p>
          <pre>
            <code>npm run backup -- export {latest?.id ?? "<backup name>"} /Volumes/YourDrive{envFlag}</code>
          </pre>
          <p>
            To restore, stop the app first ({data.service.mode === "background" ? <code>npm run service -- stop{envFlag}</code> : "Ctrl+C in its Terminal window"}
            ), then run:
          </p>
          <pre>
            <code>npm run backup -- restore {latest?.id ?? "<backup name>"}{envFlag}</code>
          </pre>
          <p className="hint">
            Restoring saves the current state as a backup first, and pauses every account’s schedules until you review them, so nothing is
            published twice. Backup names are listed by <code>npm run backup -- list{envFlag}</code>.
          </p>
        </details>
      </section>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
