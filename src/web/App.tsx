import { useEffect, useState } from "react";
import { ApiError, getStatus, logout, startSession, type Status } from "./api.ts";

type State =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: Status };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    startSession()
      .then(getStatus)
      .then((status) => setState({ kind: "ready", status }))
      .catch((err: unknown) =>
        setState(
          err instanceof ApiError && err.status === 401
            ? { kind: "signed-out" }
            : { kind: "error", message: err instanceof Error ? err.message : String(err) },
        ),
      );
  }, []);

  if (state.kind === "loading") return <main className="notice">Loading…</main>;
  if (state.kind === "signed-out") {
    return (
      <main className="notice">
        <h1>Media Manager</h1>
        <p>
          This browser is not signed in. Run <code>npm run open</code> in the project folder to open a fresh
          session.
        </p>
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main className="notice" role="alert">
        <h1>Media Manager</h1>
        <p>Something went wrong: {state.message}</p>
      </main>
    );
  }

  const { status } = state;
  return (
    <main className="notice">
      <h1>Media Manager</h1>
      <dl className="status">
        <dt>Version</dt>
        <dd>{status.version}</dd>
        <dt>Environment</dt>
        <dd>{status.environment}</dd>
        <dt>Database schema</dt>
        <dd>v{status.schemaVersion}</dd>
        <dt>Live publishing</dt>
        <dd>{status.livePublishing}</dd>
      </dl>
      <button
        type="button"
        onClick={() => void logout().then(() => setState({ kind: "signed-out" }))}
      >
        Sign out of this browser
      </button>
    </main>
  );
}
