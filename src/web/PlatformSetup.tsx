// Developer-app setup for Instagram, Pinterest and R2 media delivery.
// Secret fields are write-only: they are never pre-filled or shown again.
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, clearPlatformSetup, getPlatformSetup, testR2, updatePlatformSetup, type PlatformSetup } from "./api.ts";
import { Modal, useGuard } from "./dialogs.tsx";

export function PlatformSetupDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  return (
    <Modal open={open} title="Platform setup" onCancel={onClose}>
      <SetupBody onClose={onClose} onChanged={onChanged} />
    </Modal>
  );
}

function SetupBody({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [setup, setSetup] = useState<PlatformSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    getPlatformSetup()
      .then(setSetup)
      .catch(() => setError("Couldn't load the platform setup."));
  useEffect(() => void reload(), []);

  if (!setup) return <p>{error ?? "Loading…"}</p>;
  const c = setup.config;
  const after = () => {
    void reload();
    onChanged();
  };
  return (
    <div className="setup">
      {!setup.keychain.ok && (
        <p className="notice-bar error" role="alert">
          The macOS Keychain isn’t available: {setup.keychain.reason}. Secrets can’t be saved, and connected accounts can’t publish until it is.
        </p>
      )}
      <p className="hint">
        Each app is one you create in that platform’s developer site. IDs are stored by this app; secrets go straight into the macOS
        Keychain and are never shown again. {setup.livePublishing ? "Live publishing is on." : "Live publishing is off: connecting works, but nothing will be published until the app is started with live publishing enabled."}
      </p>

      <Section
        title="Instagram (Meta app)"
        kind="instagram"
        saved={c.instagram.secretSaved}
        onSaved={after}
        fields={[
          { name: "clientId", label: "Instagram app ID", value: c.instagram.clientId ?? "" },
          { name: "clientSecret", label: "Instagram app secret", secret: true, saved: c.instagram.secretSaved },
          { name: "redirectHost", label: "Redirect host", options: ["localhost", "127.0.0.1"], value: c.instagram.redirectHost },
        ]}
        footer={<RedirectNote uri={setup.redirectUris.instagram} where="Meta App Dashboard › Instagram › API setup with Instagram login › Business login settings › OAuth redirect URIs" />}
      />
      <Section
        title="Pinterest"
        kind="pinterest"
        saved={c.pinterest.secretSaved}
        onSaved={after}
        fields={[
          { name: "clientId", label: "Pinterest app ID", value: c.pinterest.clientId ?? "" },
          { name: "clientSecret", label: "Pinterest app secret", secret: true, saved: c.pinterest.secretSaved },
          { name: "redirectHost", label: "Redirect host", options: ["localhost", "127.0.0.1"], value: c.pinterest.redirectHost },
          { name: "tier", label: "API access", options: ["trial", "standard"], value: c.pinterest.tier, labels: { trial: "Trial (sandbox Pins, visible only to you)", standard: "Standard (public Pins)" } },
        ]}
        footer={<RedirectNote uri={setup.redirectUris.pinterest} where="Pinterest developer site › My apps › your app › Configure › Redirect URIs" />}
      />
      <Section
        title="Cloudflare R2 (Instagram media delivery)"
        kind="r2"
        saved={c.r2.secretSaved}
        onSaved={after}
        fields={[
          { name: "accountId", label: "Cloudflare account ID", value: c.r2.accountId ?? "" },
          { name: "bucket", label: "Bucket name", value: c.r2.bucket ?? "" },
          { name: "accessKeyId", label: "Access key ID", value: c.r2.accessKeyId ?? "" },
          { name: "secretAccessKey", label: "Secret access key", secret: true, saved: c.r2.secretSaved },
        ]}
        footer={
          <p className="hint">
            Use a private bucket, an API token limited to this bucket (Object Read & Write), and a lifecycle rule deleting objects after 1
            day. Each photo is uploaded only while Instagram fetches it, then deleted.
          </p>
        }
        test={
          c.r2.secretSaved
            ? { label: "Test connection", busyText: "Testing…", okText: "Connection works: uploaded, read back and deleted a test file.", run: testR2 }
            : undefined
        }
      />
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function RedirectNote({ uri, where }: { uri: string; where: string }) {
  const id = useId();
  return (
    <div className="redirect-note">
      <label htmlFor={id}>Redirect URI to register</label>
      <input id={id} type="text" readOnly value={uri} onFocus={(e) => e.target.select()} />
      <p className="hint">Add it exactly, in {where}.</p>
    </div>
  );
}

interface SectionTest {
  label: string;
  busyText: string;
  okText: string;
  run: () => Promise<unknown>;
}

interface Field {
  name: string;
  label: string;
  value?: string;
  secret?: boolean;
  saved?: boolean;
  options?: string[];
  labels?: Record<string, string>;
}

function Section({
  title,
  kind,
  fields,
  saved,
  onSaved,
  footer,
  test,
}: {
  title: string;
  kind: "instagram" | "pinterest" | "r2";
  fields: Field[];
  saved: boolean;
  onSaved: () => void;
  footer?: ReactNode;
  test?: SectionTest | undefined;
}) {
  const { confirm } = useGuard();
  const initial = Object.fromEntries(fields.map((f) => [f.name, f.secret ? "" : (f.value ?? "")]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const baseId = useId();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const patch: Record<string, string | null> = {};
    for (const f of fields) {
      const v = values[f.name] ?? "";
      if (f.secret) {
        if (v) patch[f.name] = v;
      } else if (v !== (f.value ?? "")) {
        patch[f.name] = v === "" && !f.options ? null : v;
      }
    }
    if (Object.keys(patch).length === 0) return setStatus({ tone: "ok", text: "Nothing changed." });
    setBusy(true);
    try {
      await updatePlatformSetup({ [kind]: patch });
      // Never keep a secret in page state longer than needed.
      setValues((v) => Object.fromEntries(Object.entries(v).map(([k, val]) => [k, fields.find((f) => f.name === k)?.secret ? "" : val])));
      setStatus({ tone: "ok", text: "Saved." });
      onSaved();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof ApiError ? err.message : "Couldn't save." });
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (!test) return;
    setBusy(true);
    setStatus({ tone: "ok", text: test.busyText });
    try {
      await test.run();
      setStatus({ tone: "ok", text: test.okText });
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof ApiError ? err.message : "The test couldn't run." });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${title} setup?`,
      body: "The saved secret is deleted from the Keychain. Connected accounts on this platform won't be able to publish or renew until it's set up again.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await clearPlatformSetup(kind);
      setValues(Object.fromEntries(fields.map((f) => [f.name, f.options ? (f.value ?? "") : ""])));
      setStatus({ tone: "ok", text: "Removed." });
      onSaved();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof ApiError ? err.message : "Couldn't remove." });
    }
  };

  return (
    <form className="setup-section" onSubmit={(e) => void save(e)} aria-labelledby={`${baseId}-title`}>
      <h3 id={`${baseId}-title`}>
        {title} <span className={saved ? "health-ok" : "hint"}>{saved ? "· set up" : "· not set up"}</span>
      </h3>
      <div className="setup-fields">
        {fields.map((f) => (
          <div key={f.name} className="field">
            <label htmlFor={`${baseId}-${f.name}`} className="field-label">
              {f.label}
            </label>
            {f.options ? (
              <select id={`${baseId}-${f.name}`} value={values[f.name]} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {f.labels?.[o] ?? o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${baseId}-${f.name}`}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                value={values[f.name] ?? ""}
                placeholder={f.secret && f.saved ? "Saved in Keychain. Enter a new value to replace it." : ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              />
            )}
          </div>
        ))}
      </div>
      {footer}
      <div className="setup-actions">
        <button type="submit" className="primary" disabled={busy}>
          Save
        </button>
        {test && (
          <button type="button" onClick={() => void runTest()} disabled={busy}>
            {test.label}
          </button>
        )}
        {saved && (
          <button type="button" className="danger" onClick={() => void remove()}>
            Remove…
          </button>
        )}
        {status && (
          <span className={status.tone === "error" ? "error" : "hint"} role={status.tone === "error" ? "alert" : "status"}>
            {status.text}
          </span>
        )}
      </div>
    </form>
  );
}
