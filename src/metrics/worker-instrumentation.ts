// Authored by Tomás Neto (TN 2026)
import type { Job, Worker } from 'bullmq';
import type { MetricsService } from './metrics.service';

/** Final failure vs. a failed attempt that BullMQ will retry: only a final failure sets finishedOn. */
export function failureOutcome(job: Pick<Job, 'finishedOn'> | undefined): 'failed' | 'retried' {
  return job && !job.finishedOn ? 'retried' : 'failed';
}

/** Records completed/failed/retried counts and wait/run times of a BullMQ worker in Prometheus. */
export function instrumentWorker(worker: Worker, queue: string, metrics: MetricsService | undefined) {
  if (!metrics) return;
  const run = (job: Job, outcome: string) => {
    if (job.processedOn) metrics.queueRun.observe({ queue, outcome }, Math.max(0, Date.now() - job.processedOn) / 1000);
  };
  worker.on('completed', (job) => {
    metrics.queueJobs.inc({ queue, outcome: 'completed' });
    run(job, 'completed');
    if (job.processedOn && job.attemptsMade <= 1) {
      metrics.queueWait.observe({ queue }, Math.max(0, job.processedOn - (job.timestamp + (job.opts?.delay ?? 0))) / 1000);
    }
  });
  worker.on('failed', (job) => {
    const outcome = failureOutcome(job);
    metrics.queueJobs.inc({ queue, outcome });
    if (job) run(job, outcome);
  });
}
