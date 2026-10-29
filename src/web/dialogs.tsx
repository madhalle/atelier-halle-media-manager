// Modal dialogs on the native <dialog> element, plus a promise-based confirm()
// and a registry of unsaved edits so navigation never discards them silently.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  title: string;
  onCancel: () => void;
  children: ReactNode;
}

export function Modal({ open, title, onCancel, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {open && children}
    </dialog>
  );
}

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface GuardApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  setDirty: (key: string, dirty: boolean) => void;
  /** Resolves true if there are no unsaved edits or the user chooses to discard them. */
  confirmDiscard: () => Promise<boolean>;
}

const GuardContext = createContext<GuardApi | null>(null);

export function GuardProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const dirty = useRef(new Set<string>());

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current.size > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    [],
  );

  const setDirty = useCallback((key: string, isDirty: boolean) => {
    if (isDirty) dirty.current.add(key);
    else dirty.current.delete(key);
  }, []);

  const confirmDiscard = useCallback(async () => {
    if (dirty.current.size === 0) return true;
    const ok = await confirm({
      title: "Discard unsaved changes?",
      body: "You have edits that have not been saved.",
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    if (ok) dirty.current.clear();
    return ok;
  }, [confirm]);

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const api = useMemo(() => ({ confirm, setDirty, confirmDiscard }), [confirm, setDirty, confirmDiscard]);

  return (
    <GuardContext.Provider value={api}>
      {children}
      <Modal open={pending !== null} title={pending?.title ?? ""} onCancel={() => close(false)}>
        <div className="dialog-body">{pending?.body}</div>
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={() => close(false)}>
            {pending?.cancelLabel ?? "Cancel"}
          </button>
          <button type="button" className={pending?.destructive ? "danger" : "primary"} onClick={() => close(true)}>
            {pending?.confirmLabel}
          </button>
        </div>
      </Modal>
    </GuardContext.Provider>
  );
}

export function useGuard(): GuardApi {
  const ctx = useContext(GuardContext);
  if (!ctx) throw new Error("useGuard must be used inside GuardProvider");
  return ctx;
}

/** Registers `dirty` under `key` for as long as the component is mounted. */
export function useDirty(key: string, dirty: boolean): void {
  const { setDirty } = useGuard();
  useEffect(() => {
    setDirty(key, dirty);
    return () => setDirty(key, false);
  }, [key, dirty, setDirty]);
}
