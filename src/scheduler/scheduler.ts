// Polls SQLite about once a minute. No per-post timers: every tick re-reads
// due work, so schedules survive restarts and the browser can be closed.
import { processNext, type WorkerDeps } from "./worker.ts";

export const DEFAULT_INTERVAL_MS = 60_000;
/** Upper bound on posts processed per tick, one at a time. */
const MAX_PER_TICK = 10;

export interface Scheduler {
  /** Runs one tick now. Concurrent calls wait for the tick in progress. */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

export function startScheduler(deps: WorkerDeps & { intervalMs: number; autoStart?: boolean }): Scheduler {
  const { schedule, now, log, intervalMs } = deps;
  schedule.markStarted(now(), intervalMs);
  let current: Promise<void> | null = null;
  let lastTickStarted: number | null = null;
  let stopped = false;

  async function run(): Promise<void> {
    const started = now();
    if (lastTickStarted !== null && started.getTime() - lastTickStarted > intervalMs * 2.5) {
      // Sleep, suspended process or a stalled event loop. Missed-schedule rules apply to anything now overdue.
      log.warn({ gapSeconds: Math.round((started.getTime() - lastTickStarted) / 1000) }, "scheduler resumed after a gap");
    }
    lastTickStarted = started.getTime();
    try {
      const recovered = schedule.recoverExpiredClaims(started);
      if (recovered > 0) log.warn({ recovered }, "recovered expired publishing leases");
      schedule.markDueOnUnconnected(started);
      for (let i = 0; i < MAX_PER_TICK && !stopped; i++) {
        if (!(await processNext(deps))) break;
      }
      schedule.heartbeat(now(), intervalMs, null);
    } catch (err) {
      log.error({ err }, "scheduler tick failed");
      schedule.heartbeat(now(), intervalMs, "The last scheduler check failed. Details are in the server log.");
    }
  }

  const tick = () => {
    if (!current) current = run().finally(() => (current = null));
    return current;
  };

  const timer = deps.autoStart === false ? null : setInterval(() => void tick(), intervalMs);
  timer?.unref();
  if (deps.autoStart !== false) void tick();

  return {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await current;
    },
  };
}
