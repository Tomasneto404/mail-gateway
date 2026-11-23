// Authored by Tomás Neto (TN 2026)
// Pure helpers behind the queue overview (admin UI "Check Queues") and the queue Prometheus metrics.
import type { Metrics, WorkerOptions } from 'bullmq';

/** BullMQ keeps per-minute completed/failed counts in Redis when a worker sets this: one day of points. */
export const WORKER_METRICS: WorkerOptions['metrics'] = { maxDataPoints: 1440 };

/** A job waiting longer than this marks its queue as backlogged. */
export const BACKLOG_SECONDS = 300;

/**
 * Turns BullMQ's metrics list into one count per minute for the last `minutes` minutes, oldest first.
 *
 * BullMQ only writes a data point when a job finishes in a later minute than the previous one, so the
 * newest point is for the minute before `meta.prevTS`, and jobs since then (`count - prevCount`) belong
 * to the minute of `prevTS` itself. A queue that has been idle simply ends in zeros.
 */
export function minuteSeries(m: Pick<Metrics, 'data' | 'meta'> | null | undefined, now: number, minutes: number): number[] {
  const out = new Array<number>(minutes).fill(0);
  const prevTS = Number(m?.meta?.prevTS);
  if (!m || !Number.isFinite(prevTS) || prevTS <= 0) return out;
  const nowMin = Math.floor(now / 60_000);
  const curMin = Math.floor(prevTS / 60_000);
  const pending = Math.max(0, Number(m.meta.count ?? 0) - Number(m.meta.prevCount ?? 0));
  for (let i = 0; i < minutes; i++) {
    const minute = nowMin - (minutes - 1) + i;
    if (minute === curMin) out[i] = pending;
    else if (minute < curMin) out[i] = Number(m.data[curMin - 1 - minute] ?? 0) || 0;
  }
  return out;
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Nearest-rank percentile of an unsorted sample; null when empty. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export interface JobTimes {
  timestamp: number;
  processedOn?: number | null;
  finishedOn?: number | null;
  delay?: number | null;
  attemptsMade: number;
}

/**
 * Wait and run times from recently completed jobs. Wait = start of processing minus the time the job
 * became due (creation + delay); it is only taken from first-attempt jobs, since a retried job's
 * processedOn is its last attempt and would count the backoff as waiting.
 */
export function jobTimings(jobs: JobTimes[]) {
  const wait: number[] = [];
  const run: number[] = [];
  let retried = 0;
  for (const j of jobs) {
    if (!j.processedOn || !j.finishedOn) continue;
    run.push(Math.max(0, j.finishedOn - j.processedOn));
    if (j.attemptsMade > 1) retried += 1;
    else wait.push(Math.max(0, j.processedOn - (j.timestamp + (j.delay ?? 0))));
  }
  return {
    sampled: run.length,
    retried,
    waitP50Ms: percentile(wait, 50),
    waitP95Ms: percentile(wait, 95),
    runP50Ms: percentile(run, 50),
    runP95Ms: percentile(run, 95),
    runMaxMs: run.length ? Math.max(...run) : null,
  };
}

export type QueueHealth = 'ok' | 'warn' | 'down';

export function queueHealth(q: { workers: number; paused: boolean; oldestWaitingSeconds: number | null; failedLastHour: number }): {
  health: QueueHealth;
  healthReason: string;
} {
  if (q.workers === 0) return { health: 'down', healthReason: 'No worker is connected' };
  if (q.paused) return { health: 'warn', healthReason: 'Paused' };
  if (q.oldestWaitingSeconds !== null && q.oldestWaitingSeconds > BACKLOG_SECONDS) {
    return { health: 'warn', healthReason: `Oldest job has waited ${fmtSeconds(q.oldestWaitingSeconds)}` };
  }
  if (q.failedLastHour > 0) return { health: 'warn', healthReason: `${q.failedLastHour} failed in the last hour` };
  return { health: 'ok', healthReason: 'Healthy' };
}

export function fmtSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${(s / 3600).toFixed(1).replace(/\.0$/, '')} h`;
  return `${(s / 86_400).toFixed(1).replace(/\.0$/, '')} d`;
}
