// Vertical account list. Up/Down/Home/End move between accounts; Enter or
// Space selects. Each account has its own settings menu.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CONNECTION_LABEL, PLATFORM_LABEL, type Account } from "./api.ts";
import { PlatformIcon } from "./icons.tsx";

export interface AccountActions {
  select: (a: Account) => void;
  rename: (a: Account) => void;
  move: (a: Account, delta: -1 | 1) => void;
  archive: (a: Account) => void;
  restore: (a: Account) => void;
}

interface SidebarProps {
  accounts: Account[];
  selectedId: string | null;
  actions: AccountActions;
  onAdd: () => void;
}

export function Sidebar({ accounts, selectedId, actions, onAdd }: SidebarProps) {
  const active = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);
  const [showArchived, setShowArchived] = useState(() => archived.some((a) => a.id === selectedId));
  const listRef = useRef<HTMLUListElement>(null);

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button.account-tab") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) return;
    e.preventDefault();
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
    buttons[next]?.focus();
  };

  return (
    <div className="sidebar">
      <h2 className="sidebar-title" id="accounts-heading">
        Accounts
      </h2>
      <nav className="account-scroll" aria-labelledby="accounts-heading">
        {active.length === 0 ? (
          <p className="empty-accounts">No accounts yet. Add an Instagram or Pinterest account to start planning posts.</p>
        ) : (
          <ul className="account-list" ref={listRef} onKeyDown={onListKeyDown}>
            {active.map((a, i) => (
              <AccountRow
                key={a.id}
                account={a}
                selected={a.id === selectedId}
                isFirst={i === 0}
                isLast={i === active.length - 1}
                actions={actions}
              />
            ))}
          </ul>
        )}
        {archived.length > 0 && (
          <div className="archived-section">
            <button type="button" className="link-button" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
              Archived ({archived.length})
            </button>
            {showArchived && (
              <ul className="account-list archived" onKeyDown={onListKeyDown}>
                {archived.map((a) => (
                  <AccountRow key={a.id} account={a} selected={a.id === selectedId} isFirst isLast actions={actions} />
                ))}
              </ul>
            )}
          </div>
        )}
      </nav>
      <div className="sidebar-footer">
        <button type="button" className="primary add-account" onClick={onAdd}>
          + Add account
        </button>
      </div>
    </div>
  );
}

function AccountRow({
  account: a,
  selected,
  isFirst,
  isLast,
  actions,
}: {
  account: Account;
  selected: boolean;
  isFirst: boolean;
  isLast: boolean;
  actions: AccountActions;
}) {
  const handle = a.connection.identity?.username;
  return (
    <li className={`account-row${selected ? " selected" : ""}`} data-account-id={a.id}>
      <button
        type="button"
        className="account-tab"
        aria-current={selected ? "page" : undefined}
        onClick={() => actions.select(a)}
      >
        <PlatformIcon platform={a.platform} />
        <span className="account-text">
          <span className="account-name">{a.displayName}</span>
          <span className="account-meta">
            {PLATFORM_LABEL[a.platform]} · <span className={`conn conn-${a.connection.state}`}>{CONNECTION_LABEL[a.connection.state]}</span>
            {handle ? ` · @${handle}` : ""}
          </span>
        </span>
      </button>
      <AccountMenu account={a} isFirst={isFirst} isLast={isLast} actions={actions} />
    </li>
  );
}

interface MenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
}

function AccountMenu({ account: a, isFirst, isLast, actions }: { account: Account; isFirst: boolean; isLast: boolean; actions: AccountActions }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  const items: MenuItem[] = a.archived
    ? [{ label: "Restore", run: () => actions.restore(a) }]
    : [
        { label: "Rename…", run: () => actions.rename(a) },
        { label: "Move up", run: () => actions.move(a, -1), disabled: isFirst },
        { label: "Move down", run: () => actions.move(a, 1), disabled: isLast },
        { label: "Archive…", run: () => actions.archive(a) },
      ];

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && e.target !== buttonRef.current) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const enabled = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const n = enabled.length;
      enabled[(i + (e.key === "ArrowDown" ? 1 : -1) + n) % n]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="menu-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Settings for ${a.displayName}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }
        }}
      >
        ⋯
      </button>
      {open && (
        <ul className="menu" role="menu" ref={menuRef} aria-label={`${a.displayName} settings`} onKeyDown={onMenuKeyDown}>
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  close(true);
                  item.run();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
