// "Add account": choose Instagram or Pinterest, add that platform's app details
// if they aren't saved yet, then connect. The account only appears in the
// sidebar once connected; until then it's a hidden setup the server discards
// if this dialog closes. Pinterest's sign-in leaves the page and returns to
// the new tab, so the setup must survive that navigation (no cleanup runs).
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  discardAccountSetup,
  getPlatformSetup,
  PLATFORM_LABEL,
  platformReady,
  startAccountSetup,
  type Account,
  type Platform,
  type PlatformSetup,
} from "./api.ts";
import { ConnectAccount } from "./ConnectAccount.tsx";
import { Modal } from "./dialogs.tsx";
import { PlatformIcon } from "./icons.tsx";
import { InstagramTokenSetup, PinterestAppSetup } from "./PlatformSetup.tsx";

interface Props {
  open: boolean;
  onClose: () => void;
  onConnected: (a: Account) => void;
}

export function AddAccountDialog({ open, onClose, onConnected }: Props) {
  return (
    <Modal open={open} title="Add account" onCancel={onClose}>
      <AddAccountFlow onClose={onClose} onConnected={onConnected} />
    </Modal>
  );
}

function AddAccountFlow({ onClose, onConnected }: Omit<Props, "open">) {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [setup, setSetup] = useState<PlatformSetup | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setupId = useRef<string | null>(null);

  const discard = () => {
    const id = setupId.current;
    setupId.current = null;
    // Best effort: starting the next setup removes any leftover one anyway.
    if (id) discardAccountSetup(id).catch(() => undefined);
  };
  useEffect(() => discard, []);

  const attempt = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    }
  };

  // Loads the platform's setup, and starts the account once the platform is ready to connect.
  const advance = (p: Platform) =>
    attempt(async () => {
      const s = await getPlatformSetup();
      setSetup(s);
      if (!platformReady(s.config, p)) return;
      const a = await startAccountSetup(p);
      setupId.current = a.id;
      setAccount(a);
    });

  const choose = (p: Platform) => {
    setPlatform(p);
    void advance(p);
  };

  const back = () => {
    discard();
    setPlatform(null);
    setSetup(null);
    setAccount(null);
    setError(null);
  };

  const connected = (a: Account) => {
    setupId.current = null;
    onConnected(a);
  };

  const label = platform ? PLATFORM_LABEL[platform] : null;
  return (
    <div className="add-account">
      {!platform && (
        <>
          <p>Which kind of account?</p>
          <div className="platform-choices">
            {(["instagram", "pinterest"] as const).map((p) => (
              <button key={p} type="button" className="platform-choice" onClick={() => choose(p)}>
                <PlatformIcon platform={p} />
                {PLATFORM_LABEL[p]}
              </button>
            ))}
          </div>
        </>
      )}

      {platform && !account && setup && !platformReady(setup.config, platform) && (
        <>
          <p>First, add your {label} developer app details. You only need to do this once.</p>
          {platform === "instagram" ? (
            <InstagramTokenSetup setup={setup} onSaved={() => void advance(platform)} />
          ) : (
            <PinterestAppSetup setup={setup} onSaved={() => void advance(platform)} />
          )}
        </>
      )}

      {platform && !account && !setup && !error && <p>Loading…</p>}

      {account && <ConnectAccount account={account} onConnected={connected} />}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="dialog-actions">
        {platform && (
          <button type="button" onClick={back}>
            Back
          </button>
        )}
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
