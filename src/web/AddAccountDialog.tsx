import { useId, useState, type FormEvent } from "react";
import { ApiError, createAccount, PLATFORM_LABEL, type Account, type Platform } from "./api.ts";
import { Modal, useGuard } from "./dialogs.tsx";

const MAX = 60;

export function AddAccountDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (a: Account) => void }) {
  return (
    <Modal open={open} title="Add account" onCancel={onClose}>
      <AddAccountForm onClose={onClose} onCreated={onCreated} />
    </Modal>
  );
}

function AddAccountForm({ onClose, onCreated }: { onClose: () => void; onCreated: (a: Account) => void }) {
  const { confirm } = useGuard();
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const hintId = useId();
  const errorId = useId();

  const cancel = async () => {
    if (platform === null && name === "") return onClose();
    const discard = await confirm({
      title: "Discard this new account?",
      body: "The account has not been created yet.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    if (discard) onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!platform) return setError("Choose Instagram or Pinterest.");
    if (name.trim() === "") return setError("Enter a display name.");
    setBusy(true);
    setError(null);
    try {
      onCreated(await createAccount(platform, name));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the account.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <fieldset>
        <legend>Platform</legend>
        {(["instagram", "pinterest"] as const).map((p) => (
          <label key={p} className="radio">
            <input type="radio" name="platform" value={p} checked={platform === p} onChange={() => setPlatform(p)} />
            {PLATFORM_LABEL[p]}
          </label>
        ))}
      </fieldset>
      <label htmlFor={nameId}>Display name</label>
      <input
        id={nameId}
        type="text"
        value={name}
        maxLength={MAX}
        autoComplete="off"
        placeholder={platform === "pinterest" ? "e.g. Atelier Halle Pinterest" : "e.g. Business Instagram"}
        aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
        aria-invalid={error !== null}
        onChange={(e) => setName(e.target.value)}
      />
      <p id={hintId} className="hint">
        The name is only a label for you. The new tab starts <strong>not connected</strong>: you can plan drafts there, and connect the
        real account later.
      </p>
      {error && (
        <p id={errorId} className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={() => void cancel()}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy}>
          Create account
        </button>
      </div>
    </form>
  );
}
