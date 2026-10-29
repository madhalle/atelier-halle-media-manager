// Service health in the sidebar, and app-wide settings.
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { ApiError, getHealth, updateSettings, type Health, type Settings } from "./api.ts";
import { Modal } from "./dialogs.tsx";

/** Polls service health; `refresh` reloads it immediately after user actions. */
export function useHealth(): [Health | null, () => void] {
  const [health, setHealth] = useState<Health | null>(null);
  const refresh = useCallback(() => void getHealth().then(setHealth).catch(() => setHealth(null)), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);
  return [health, refresh];
}

export function HealthLine({ health, version, onSettings, onPlatforms }: { health: Health | null; version: string; onSettings: () => void; onPlatforms: () => void }) {
  if (!health) return <p className="service-line">v{version} · status unavailable</p>;
  const { scheduler, counts } = health;
  const last = scheduler.lastCheckAt ? new Date(scheduler.lastCheckAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "never";
  return (
    <div className="service-line" aria-live="polite">
      <p>
        <span className={scheduler.stale ? "health-bad" : "health-ok"}>{scheduler.stale ? "⚠ Scheduler not checking" : "● Scheduler running"}</span>
        {" · "}last check {last}
      </p>
      <p>
        {counts.scheduled} scheduled · {counts.overdue} overdue · {counts.needsAttention} need attention
      </p>
      <p>
        Publishing: {health.publishing === "simulated" ? "SIMULATED" : health.publishing === "live" ? "live" : "not set up"} · v{version} ·{" "}
        <button type="button" className="link-button" onClick={onSettings}>
          Settings
        </button>{" "}
        ·{" "}
        <button type="button" className="link-button" onClick={onPlatforms}>
          Platform setup
        </button>
      </p>
    </div>
  );
}

export function HealthBanner({ health }: { health: Health | null }) {
  if (!health) return null;
  return (
    <>
      {health.publishing === "simulated" && (
        <div className="notice-bar simulated" role="status">
          Simulated publishing is on (development mode). Nothing is sent to Instagram or Pinterest.
        </div>
      )}
      {health.scheduler.stale && (
        <div className="notice-bar error" role="alert">
          The scheduler hasn’t checked in recently{health.scheduler.lastError ? `: ${health.scheduler.lastError}` : ""}. Scheduled posts won’t go out
          until the app is running and your Mac is awake.
        </div>
      )}
    </>
  );
}

export function SettingsDialog({ open, settings, onClose, onSaved }: { open: boolean; settings: Settings | null; onClose: () => void; onSaved: () => void }) {
  return (
    <Modal open={open} title="Settings" onCancel={onClose}>
      {settings && <SettingsForm settings={settings} onClose={onClose} onSaved={onSaved} />}
    </Modal>
  );
}

function SettingsForm({ settings, onClose, onSaved }: { settings: Settings; onClose: () => void; onSaved: () => void }) {
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const [tz, setTz] = useState(settings.defaultTimezone);
  const [grace, setGrace] = useState(String(settings.missedGraceMinutes));
  const [error, setError] = useState<string | null>(null);
  const tzId = useId();
  const graceId = useId();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await updateSettings({ defaultTimezone: tz, missedGraceMinutes: Number(grace) });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save settings.");
    }
  };

  return (
    <form onSubmit={(e) => void save(e)}>
      <label htmlFor={tzId}>Default time zone for new schedules</label>
      <select id={tzId} value={tz} onChange={(e) => setTz(e.target.value)}>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <label htmlFor={graceId}>Late publishing window (minutes)</label>
      <input id={graceId} type="number" min={0} max={1440} value={grace} onChange={(e) => setGrace(e.target.value)} />
      <p className="hint">
        If the Mac was asleep or the app was off at the scheduled time, posts that are at most this late still publish automatically. Later
        ones wait for your review. Existing schedules keep their own time zone.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Save settings
        </button>
      </div>
    </form>
  );
}
