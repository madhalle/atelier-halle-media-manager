// Connects one account to its real platform account, used by "Add account"
// and by a tab's settings (reconnecting). Instagram through a Meta business
// portfolio token picks an account here; every other route signs in on the
// platform, which redirects back to this app to finish.
import { useEffect, useState } from "react";
import {
  ApiError,
  connectBusinessInstagram,
  connectsViaBusinessToken,
  getPlatformSetup,
  listBusinessInstagramAccounts,
  PLATFORM_LABEL,
  platformReady,
  startConnect,
  type Account,
  type BusinessInstagramAccount,
} from "./api.ts";
import { useGuard } from "./dialogs.tsx";

export function ConnectAccount({ account: a, onConnected }: { account: Account; onConnected: (a: Account) => void }) {
  const { confirmDiscard } = useGuard();
  const [route, setRoute] = useState<"business" | "sign-in" | "not-set-up" | null>(null);
  const [choices, setChoices] = useState<BusinessInstagramAccount[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = PLATFORM_LABEL[a.platform];
  const identity = a.connection.identity;

  useEffect(() => {
    getPlatformSetup()
      .then(({ config }) => setRoute(connectsViaBusinessToken(config, a.platform) ? "business" : platformReady(config, a.platform) ? "sign-in" : "not-set-up"))
      .catch(() => setRoute("not-set-up"));
  }, [a.platform]);

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const loadChoices = () =>
    run(async () => {
      const r = await listBusinessInstagramAccounts(a.id);
      if (r.missing.length > 0) {
        setError(`The token is missing ${r.missing.join(" and ")}. Add it in Meta, generate a new token, and save it in Platform setup.`);
        return;
      }
      // Meta's list can be empty even when the token can reach the account; then ask for the ID.
      setChoices(r.accounts);
      setChosen(r.accounts.find((c) => c.username !== null && c.username === identity?.username)?.id ?? r.accounts[0]?.id ?? "");
    }, "Couldn't load the Instagram accounts.");

  const connectChosen = () =>
    run(async () => {
      onConnected(await connectBusinessInstagram(a.id, chosen));
      setChoices(null);
    }, "Couldn't connect.");

  const signIn = async () => {
    if (!(await confirmDiscard())) return;
    // Same tab: the platform redirects back to this app to finish.
    await run(async () => window.location.assign(await startConnect(a.id)), "Couldn't start connecting.");
  };

  return (
    <div className="connect-account">
      {route === "business" && !choices && <p className="hint">Connecting uses your Meta business portfolio token: choose which Instagram account to post to.</p>}
      {route === "sign-in" && <p className="hint">Connecting signs in to {label}, verifies the real account and checks it can publish.</p>}
      {route === "not-set-up" && <p className="hint">Set up the {label} developer app first: Settings › Platform setup.</p>}

      {choices && choices.length === 0 && (
        <div className="field">
          <label htmlFor={`choose-${a.id}`} className="field-label">
            Instagram account ID
          </label>
          <input
            id={`choose-${a.id}`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            value={chosen}
            onChange={(e) => setChosen(e.target.value.trim())}
          />
          <p className="hint">
            Meta didn’t list the accounts this token can use. Copy the ID from Meta Business settings › Accounts › Instagram accounts (the number
            under the username). The app checks with Meta that the token can reach it before connecting.
          </p>
        </div>
      )}
      {choices && choices.length > 0 && (
        <div className="field">
          <label htmlFor={`choose-${a.id}`} className="field-label">
            Instagram account
          </label>
          <select id={`choose-${a.id}`} value={chosen} onChange={(e) => setChosen(e.target.value)}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.username ? `@${c.username}` : c.id}
                {c.name ? ` (${c.name})` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="setup-actions">
        {choices ? (
          <>
            <button type="button" className="primary" disabled={busy || !/^\d{1,30}$/.test(chosen)} onClick={() => void connectChosen()}>
              Connect this account
            </button>
            <button type="button" disabled={busy} onClick={() => setChoices(null)}>
              Back
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy || route === null || route === "not-set-up"}
            onClick={() => void (route === "business" ? loadChoices() : signIn())}
          >
            {a.connection.state === "unconnected" ? `Connect ${label} account` : `Reconnect ${label}`}
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
