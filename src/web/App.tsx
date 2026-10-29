import { useCallback, useEffect, useRef, useState } from "react";
import { AccountPanel } from "./AccountPanel.tsx";
import { AddAccountDialog } from "./AddAccountDialog.tsx";
import {
  acknowledgeReview,
  ApiError,
  archiveAccount,
  getStatus,
  listAccounts,
  reorderAccounts,
  restoreAccount,
  startSession,
  type Account,
  type Status,
} from "./api.ts";
import { GuardProvider, useGuard } from "./dialogs.tsx";
import { Sidebar, type AccountActions } from "./Sidebar.tsx";

type Boot = { kind: "loading" } | { kind: "signed-out" } | { kind: "error"; message: string } | { kind: "ready"; status: Status; accounts: Account[] };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });

  useEffect(() => {
    startSession()
      .then(() => Promise.all([getStatus(), listAccounts()]))
      .then(([status, accounts]) => setBoot({ kind: "ready", status, accounts }))
      .catch((err: unknown) =>
        setBoot(
          err instanceof ApiError && err.status === 401
            ? { kind: "signed-out" }
            : { kind: "error", message: err instanceof Error ? err.message : String(err) },
        ),
      );
  }, []);

  if (boot.kind === "loading") return <main className="notice">Loading…</main>;
  if (boot.kind === "signed-out") {
    return (
      <main className="notice">
        <h1>Media Manager</h1>
        <p>
          This browser is not signed in. Run <code>npm run open</code> in the project folder to open a fresh session.
        </p>
      </main>
    );
  }
  if (boot.kind === "error") {
    return (
      <main className="notice" role="alert">
        <h1>Media Manager</h1>
        <p>Something went wrong: {boot.message}</p>
      </main>
    );
  }
  return (
    <GuardProvider>
      <Shell status={boot.status} initialAccounts={boot.accounts} />
    </GuardProvider>
  );
}

const HASH_PREFIX = "#/accounts/";

function initialSelection(accounts: Account[]): string | null {
  const fromHash = location.hash.startsWith(HASH_PREFIX) ? location.hash.slice(HASH_PREFIX.length) : null;
  if (fromHash && accounts.some((a) => a.id === fromHash)) return fromHash;
  return accounts.find((a) => !a.archived)?.id ?? null;
}

function Shell({ status, initialAccounts }: { status: Status; initialAccounts: Account[] }) {
  const { confirm, confirmDiscard } = useGuard();
  const [accounts, setAccounts] = useState(initialAccounts);
  const [selectedId, setSelectedId] = useState<string | null>(() => initialSelection(initialAccounts));
  const [addOpen, setAddOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const titleFocus = useRef(false);

  const selected = accounts.find((a) => a.id === selectedId) ?? null;

  useEffect(() => {
    history.replaceState(null, "", selectedId ? `${HASH_PREFIX}${selectedId}` : location.pathname);
  }, [selectedId]);

  useEffect(() => {
    if (titleFocus.current) {
      titleFocus.current = false;
      document.getElementById("account-title")?.focus();
    }
  }, [selectedId, drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const upsert = useCallback((a: Account) => setAccounts((list) => list.map((x) => (x.id === a.id ? a : x))), []);

  const reload = useCallback(async () => setAccounts(await listAccounts()), []);

  const fail = useCallback(
    async (err: unknown) => {
      const text = err instanceof ApiError ? err.message : "Something went wrong.";
      setNotice({ text, tone: "error" });
      if (err instanceof ApiError && err.status === 409) await reload();
    },
    [reload],
  );

  const select = useCallback(
    async (a: Account): Promise<boolean> => {
      if (a.id === selectedId) {
        setDrawerOpen(false);
        return true;
      }
      if (!(await confirmDiscard())) return false;
      setNotice(null);
      setSelectedId(a.id);
      if (drawerOpen) {
        titleFocus.current = true;
        setDrawerOpen(false);
      }
      return true;
    },
    [selectedId, confirmDiscard, drawerOpen],
  );

  const actions: AccountActions = {
    select: (a) => void select(a),
    rename: (a) =>
      void select(a).then((ok) => {
        if (ok) setRenameTarget(a.id);
      }),
    move: (a, delta) => {
      const active = accounts.filter((x) => !x.archived);
      const i = active.findIndex((x) => x.id === a.id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= active.length) return;
      const ids = active.map((x) => x.id);
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      reorderAccounts(ids)
        .then((updated) => setAccounts((list) => [...updated, ...list.filter((x) => x.archived)]))
        .catch(fail);
    },
    archive: (a) =>
      void (async () => {
        const ok = await confirm({
          title: `Archive “${a.displayName}”?`,
          body: (
            <>
              <p>The tab is hidden and any pending publication is paused. Posts, photos and history are kept, and you can restore it later.</p>
              <p>A post that is already being sent to the platform may still go out. The app checks the result afterwards rather than assuming it stopped.</p>
            </>
          ),
          confirmLabel: "Archive account",
          destructive: true,
        });
        if (!ok) return;
        if (a.id === selectedId && !(await confirmDiscard())) return;
        try {
          const archived = await archiveAccount(a);
          const nextList = accounts.map((x) => (x.id === a.id ? archived : x));
          setAccounts(nextList);
          if (a.id === selectedId) setSelectedId(nextList.find((x) => !x.archived)?.id ?? null);
          setNotice({ text: `Archived “${a.displayName}”.`, tone: "info" });
        } catch (err) {
          await fail(err);
        }
      })(),
    restore: (a) =>
      void restoreAccount(a)
        .then(async (restored) => {
          await reload();
          setSelectedId(restored.id);
          setNotice({ text: `Restored “${restored.displayName}”. Any pending schedules stay paused until you review them.`, tone: "info" });
        })
        .catch(fail),
  };

  const active = accounts.filter((a) => !a.archived);

  return (
    <div className={`app${drawerOpen ? " drawer-open" : ""}`}>
      <header className="mobile-bar">
        <button type="button" aria-expanded={drawerOpen} aria-controls="sidebar" onClick={() => setDrawerOpen((v) => !v)}>
          ☰ Accounts
        </button>
        <span className="mobile-current">{selected?.displayName ?? "No account selected"}</span>
      </header>

      <aside id="sidebar" aria-label="Accounts sidebar">
        <Sidebar accounts={accounts} selectedId={selectedId} actions={actions} onAdd={() => setAddOpen(true)} />
        <p className="service-line">
          v{status.version} · {status.environment} · live publishing {status.livePublishing}
        </p>
      </aside>
      {drawerOpen && <div className="backdrop" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}

      <main id="main">
        {notice && (
          <div className={`notice-bar ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
            <span>{notice.text}</span>
            <button type="button" className="link-button" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
        {selected ? (
          <AccountPanel
            key={selected.id}
            account={selected}
            focusRename={renameTarget === selected.id}
            onRenameFocused={() => setRenameTarget(null)}
            onUpdated={upsert}
            onArchive={actions.archive}
            onRestore={actions.restore}
            onAcknowledgeReview={(a) => void acknowledgeReview(a).then(upsert).catch(fail)}
          />
        ) : (
          <div className="welcome">
            <h1 id="account-title" tabIndex={-1}>
              {active.length === 0 && accounts.length === 0 ? "Welcome" : "No account selected"}
            </h1>
            <p>Add an Instagram or Pinterest account to start planning posts. Accounts start unconnected and never publish until connected.</p>
            <button type="button" className="primary" onClick={() => setAddOpen(true)}>
              + Add account
            </button>
          </div>
        )}
      </main>

      <AddAccountDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(a) => {
          setAddOpen(false);
          setAccounts((list) => [...list.filter((x) => !x.archived), a, ...list.filter((x) => x.archived)]);
          void select(a);
        }}
      />
    </div>
  );
}
