// Scheduling controls and publishing state for one post.
import { useEffect, useId, useMemo, useState } from "react";
import {
  ApiError,
  cancelSchedule,
  dismissAttention,
  formatInZone,
  listAttempts,
  PLATFORM_LABEL,
  resolveOutcome,
  ScheduleConflict,
  schedulePost,
  type Account,
  type Attempt,
  type Post,
} from "./api.ts";
import { useGuard } from "./dialogs.tsx";

/** Wall-clock "YYYY-MM-DDTHH:mm" for `date` in `timeZone`. */
function wallClock(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function defaultLocalTime(timeZone: string): string {
  const next = new Date(Date.now() + 60 * 60_000);
  next.setUTCMinutes(0, 0, 0);
  return wallClock(next, timeZone);
}

const OUTCOME_LABEL: Record<string, string> = {
  published: "Published",
  retry: "Will retry",
  pending: "Platform still processing",
  rate_limited: "Rate limited; will retry",
  auth_expired: "Connection expired",
  permanent: "Not published",
  ambiguous: "Outcome uncertain",
  not_published: "Not published",
  skipped: "Skipped; nothing sent",
  canceled: "Canceled",
  paused: "Paused",
  interrupted: "Interrupted",
  in_progress: "In progress",
};

interface Props {
  post: Post;
  account: Account;
  defaultTimezone: string;
  /** Unsaved edits in the composer; scheduling uses the saved version. */
  dirty: boolean;
  onChanged: (p: Post) => void;
  onNotice: (text: string) => void;
}

export function SchedulePanel({ post, account, defaultTimezone, dirty, onChanged, onNotice }: Props) {
  const { confirm } = useGuard();
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const [timeZone, setTimeZone] = useState(post.timezone ?? defaultTimezone);
  const [local, setLocal] = useState(() => post.localTime ?? defaultLocalTime(post.timezone ?? defaultTimezone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [conflict, setConflict] = useState<ScheduleConflict | null>(null);
  const dateId = useId();
  const timeId = useId();
  const zoneId = useId();

  const [date, time] = local.split("T") as [string, string];
  const canSchedule =
    post.status === "draft" ||
    post.status === "canceled" ||
    post.status === "scheduled" ||
    post.status === "retry_waiting" ||
    (post.status === "needs_attention" && post.attentionKind !== "ambiguous");
  const inFlight = post.status === "preparing" || post.status === "publishing" || (post.status === "retry_waiting" && post.commitStartedAt !== null);

  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (choice?: "earlier" | "later", overrideLocal?: string) => {
    setConflict(null);
    setWarnings([]);
    const when = overrideLocal ?? local;
    setBusy(true);
    setError(null);
    try {
      const r = await schedulePost(post, when, timeZone, choice);
      if (overrideLocal) setLocal(overrideLocal);
      setWarnings(r.warnings);
      onChanged(r.post);
      onNotice(`Scheduled for ${formatInZone(r.post.scheduledAt!, timeZone)}.`);
    } catch (err) {
      if (err instanceof ScheduleConflict) setConflict(err);
      else setError(err instanceof ApiError ? err.message : "Could not schedule.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (inFlight) {
      const ok = await confirm({
        title: "Try to cancel?",
        body: "This post is already being sent. If it hasn't reached the platform yet it will be stopped; if it has, it may still be published. Either way the app will check and show the result.",
        confirmLabel: "Request cancel",
        destructive: true,
      });
      if (!ok) return;
    }
    const r = await run(() => cancelSchedule(post));
    if (r) {
      onChanged(r.post);
      onNotice(r.message);
    }
  };

  return (
    <section className="schedule-panel" aria-labelledby="schedule-heading">
      <h3 id="schedule-heading">Schedule</h3>
      <StatusSummary post={post} account={account} />

      {post.status === "needs_attention" && post.attentionKind === "ambiguous" && (
        <div className="resolve">
          <p>
            Check the {PLATFORM_LABEL[account.platform]} account{account.connection.identity?.username ? ` @${account.connection.identity.username}` : ""}. Was
            this post published?
          </p>
          <button type="button" onClick={() => void run(() => resolveOutcome(post, "published")).then((p) => p && onChanged(p))} disabled={busy}>
            Yes, it was published
          </button>
          <button type="button" onClick={() => void run(() => resolveOutcome(post, "not_published")).then((p) => p && onChanged(p))} disabled={busy}>
            No, it wasn’t published
          </button>
        </div>
      )}

      {post.status === "needs_attention" && post.attentionKind !== "ambiguous" && (
        <button type="button" onClick={() => void run(() => dismissAttention(post)).then((p) => p && onChanged(p))} disabled={busy}>
          Back to draft
        </button>
      )}

      {(post.status === "scheduled" || inFlight || (post.status === "retry_waiting" && !inFlight)) && !post.cancelRequested && (
        <button type="button" className="danger" onClick={() => void cancel()} disabled={busy}>
          {inFlight ? "Try to cancel…" : "Cancel schedule"}
        </button>
      )}
      {post.cancelRequested && <p className="hint">Cancel requested. The app will stop the post if it can, then show what happened.</p>}

      {canSchedule && !inFlight && (
        <form
          className="schedule-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="schedule-fields">
            <label htmlFor={dateId}>Date</label>
            <input id={dateId} type="date" value={date} required onChange={(e) => setLocal(`${e.target.value}T${time}`)} />
            <label htmlFor={timeId}>Time</label>
            <input id={timeId} type="time" value={time} required onChange={(e) => setLocal(`${date}T${e.target.value}`)} />
            <label htmlFor={zoneId}>Time zone</label>
            <select id={zoneId} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          {dirty && <p className="hint">Save your changes first; scheduling uses the saved version.</p>}
          <button type="submit" className="primary" disabled={busy || dirty}>
            {post.status === "scheduled" || post.status === "retry_waiting" ? "Reschedule" : "Schedule"}
          </button>
          <p className="hint">
            Times are kept in the zone you choose, so travelling or changing your Mac’s time zone won’t move them. The app checks about
            once a minute; your Mac must be awake, online and running the app. Sleep, shutdown or logging out can delay or prevent publishing.
          </p>
        </form>
      )}

      {conflict && (
        <div className="conflict" role="alert">
          <p>{conflict.message}</p>
          {conflict.detail.suggestion && (
            <button type="button" onClick={() => void submit(undefined, conflict.detail.suggestion!.localTime)}>
              Use {conflict.detail.suggestion.localTime.replace("T", " ")} instead
            </button>
          )}
          {conflict.detail.earlier && conflict.detail.later && (
            <>
              <button type="button" onClick={() => void submit("earlier")}>
                First time ({formatInZone(conflict.detail.earlier.instant, timeZone)})
              </button>
              <button type="button" onClick={() => void submit("later")}>
                Second time ({formatInZone(conflict.detail.later.instant, timeZone)})
              </button>
            </>
          )}
        </div>
      )}
      {warnings.length > 0 && (
        <ul className="warnings" role="status">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <History postId={post.id} revision={post.revision} />
    </section>
  );
}

export function StatusSummary({ post, account }: { post: Post; account: Account }) {
  const zone = post.timezone ?? "UTC";
  switch (post.status) {
    case "scheduled":
      return (
        <p className="state scheduled">
          Scheduled for <strong>{formatInZone(post.scheduledAt!, zone)}</strong>
          {!account.publishing.ready && <span className="hint"> · paused: {account.publishing.blockers[0]}</span>}
        </p>
      );
    case "retry_waiting":
      return (
        <p className="state scheduled">
          {post.commitStartedAt ? "Checking whether the last attempt was published" : "Will retry"} around{" "}
          <strong>{formatInZone(post.nextAttemptAt!, zone)}</strong> (attempt {post.attemptCount + 1}).
        </p>
      );
    case "preparing":
    case "publishing":
      return <p className="state inflight">Being published now. Editing is locked until it finishes.</p>;
    case "published":
      return (
        <p className="state published">
          {post.publishedSimulated ? "Simulated publish" : "Published"} {post.publishedAt ? formatInZone(post.publishedAt, zone) : ""}
          {post.publishedSimulated && <strong> · nothing was actually posted</strong>}
          {post.remotePermalink && (
            <>
              {" · "}
              <a href={post.remotePermalink} target="_blank" rel="noreferrer noopener">
                View on {PLATFORM_LABEL[account.platform]}
              </a>
            </>
          )}
        </p>
      );
    case "needs_attention":
      return (
        <p className="state attention" role="alert">
          {post.attentionMessage}
        </p>
      );
    case "canceled":
      return <p className="state">Schedule canceled. Not published.</p>;
    default:
      return <p className="state">Not scheduled.</p>;
  }
}

function History({ postId, revision }: { postId: string; revision: number }) {
  const [open, setOpen] = useState(false);
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  useEffect(() => {
    if (open) void listAttempts(postId).then(setAttempts);
  }, [open, postId, revision]);
  return (
    <details className="history" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Publishing history</summary>
      {attempts === null ? (
        <p className="hint">Loading…</p>
      ) : attempts.length === 0 ? (
        <p className="hint">No attempts yet.</p>
      ) : (
        <ol>
          {attempts.map((a) => (
            <li key={a.id}>
              <strong>{OUTCOME_LABEL[a.outcome] ?? a.outcome}</strong> · {new Date(a.startedAt).toLocaleString()}
              {a.simulated && " · simulated"}
              {a.errorMessage && <span className="hint"> · {a.errorMessage}</span>}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
