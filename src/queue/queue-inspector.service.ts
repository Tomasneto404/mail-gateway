// Authored by Tomás Neto (TN 2026)
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { BACKLOG_SECONDS, jobTimings, minuteSeries, queueHealth, sum } from './queue-metrics';
import { ALERTS_QUEUE, DELIVERY_QUEUE, MAINTENANCE_QUEUE, QueueService, SYSTEM_MAIL_QUEUE } from './queue.service';

export const QUEUE_INFO = [
  { name: DELIVERY_QUEUE, description: 'Messages on their way to the relay, Resend or Mailpit', failuresPermission: 'messages:read' },
  { name: SYSTEM_MAIL_QUEUE, description: 'Invitations, password resets and alerts sent by email', failuresPermission: 'users:read' },
  { name: ALERTS_QUEUE, description: 'Alert deliveries, and the scan that raises alerts every minute', failuresPermission: 'alerts:read' },
  { name: MAINTENANCE_QUEUE, description: 'Daily retention: purges old bodies and records', failuresPermission: 'dashboard:read' },
] as const;

const COUNT_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'failed', 'completed', 'paused'] as const;
/** Recently completed jobs sampled for wait/run times. */
const TIMING_SAMPLE = 200;
const RECENT_FAILURES = 5;

export interface QueueBasics {
  name: string;
  paused: boolean;
  workers: number;
  counts: Record<(typeof COUNT_STATES)[number], number>;
  oldestWaitingSeconds: number | null;
}

/** Reads BullMQ's own bookkeeping in Redis; nothing here touches the jobs. */
@Injectable()
export class QueueInspector {
  private basicsCache?: { at: number; value: Promise<QueueBasics[]> };

  constructor(private readonly queues: QueueService) {}

  private queue(name: string): Queue {
    return (
      {
        [DELIVERY_QUEUE]: this.queues.delivery,
        [SYSTEM_MAIL_QUEUE]: this.queues.systemMail,
        [ALERTS_QUEUE]: this.queues.alerts,
        [MAINTENANCE_QUEUE]: this.queues.maintenance,
      } as Record<string, Queue>
    )[name];
  }

  private async basicsOf(name: string, now: number): Promise<QueueBasics> {
    const q = this.queue(name);
    const [counts, paused, workers, oldest] = await Promise.all([
      q.getJobCounts(...COUNT_STATES),
      q.isPaused(),
      q.getWorkersCount().catch(() => -1),
      q.getJobs(['waiting', 'prioritized', 'paused'], 0, 0, true),
    ]);
    const first = oldest.filter(Boolean).map((j) => j.timestamp + (j.opts?.delay ?? 0));
    return {
      name,
      paused,
      workers,
      counts: Object.fromEntries(COUNT_STATES.map((s) => [s, counts[s] ?? 0])) as QueueBasics['counts'],
      oldestWaitingSeconds: first.length ? Math.max(0, (now - Math.min(...first)) / 1000) : null,
    };
  }

  /** Counts, pause flag, workers and oldest waiting job; cached briefly so one Prometheus scrape reads Redis once. */
  basics(now = Date.now()): Promise<QueueBasics[]> {
    if (this.basicsCache && now - this.basicsCache.at < 2000) return this.basicsCache.value;
    const value = Promise.all(QUEUE_INFO.map((i) => this.basicsOf(i.name, now)));
    this.basicsCache = { at: now, value };
    value.catch(() => (this.basicsCache = undefined));
    return value;
  }

  async overview(canSee: (permission: string) => boolean, now = Date.now()) {
    const basics = await Promise.all(QUEUE_INFO.map((i) => this.basicsOf(i.name, now)));
    const queues = await Promise.all(
      QUEUE_INFO.map(async (info, idx) => {
        const q = this.queue(info.name);
        const showFailures = canSee(info.failuresPermission);
        const [completedM, failedM, recent, failures] = await Promise.all([
          q.getMetrics('completed', 0, 1439).catch(() => null),
          q.getMetrics('failed', 0, 1439).catch(() => null),
          q.getJobs(['completed'], 0, TIMING_SAMPLE - 1),
          showFailures ? q.getJobs(['failed'], 0, RECENT_FAILURES - 1) : Promise.resolve([]),
        ]);
        const completedDay = minuteSeries(completedM, now, 1440);
        const failedDay = minuteSeries(failedM, now, 1440);
        const completedHour = completedDay.slice(-60);
        const failedHour = failedDay.slice(-60);
        const b = basics[idx];
        const timings = jobTimings(
          recent.filter(Boolean).map((j) => ({ timestamp: j.timestamp, processedOn: j.processedOn, finishedOn: j.finishedOn, delay: j.opts?.delay, attemptsMade: j.attemptsMade })),
        );
        return {
          name: info.name,
          description: info.description,
          ...queueHealth({ workers: b.workers, paused: b.paused, oldestWaitingSeconds: b.oldestWaitingSeconds, failedLastHour: sum(failedHour) }),
          paused: b.paused,
          workers: b.workers,
          counts: {
            waiting: b.counts.waiting + b.counts.paused,
            active: b.counts.active,
            delayed: b.counts.delayed,
            prioritized: b.counts.prioritized,
            waitingChildren: b.counts['waiting-children'],
            failed: b.counts.failed,
            completed: b.counts.completed,
          },
          oldestWaitingSeconds: b.oldestWaitingSeconds === null ? null : Math.round(b.oldestWaitingSeconds),
          lastHour: { completed: sum(completedHour), failed: sum(failedHour) },
          lastDay: { completed: sum(completedDay), failed: sum(failedDay) },
          perMinute: { completed: completedHour, failed: failedHour },
          timings,
          recentFailures: showFailures
            ? failures.filter(Boolean).map((j) => ({
                id: String(j.id ?? ''),
                name: j.name,
                reason: j.failedReason ? j.failedReason.slice(0, 300) : null,
                attempts: j.attemptsMade,
                at: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
              }))
            : null,
        };
      }),
    );
    return { at: new Date(now).toISOString(), backlogSeconds: BACKLOG_SECONDS, queues };
  }
}
