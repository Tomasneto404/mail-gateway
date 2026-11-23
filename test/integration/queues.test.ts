// Authored by Tomás Neto (TN 2026)
import { Job, UnrecoverableError, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetricsService } from '../../src/metrics/metrics.service';
import { instrumentWorker } from '../../src/metrics/worker-instrumentation';
import { WORKER_METRICS } from '../../src/queue/queue-metrics';
import { MAINTENANCE_QUEUE, QUEUE_PREFIX, QueueService, redisConnection } from '../../src/queue/queue.service';
import { login } from '../helpers/admin-login';
import { ADMIN_TOKEN, Stack, resetState, startStack, waitFor } from '../helpers/stack';

// No gateway worker here: nothing is delivered. A throwaway worker on the maintenance queue runs
// no-op jobs so the overview has real counts, metrics and timings to report.
let s: Stack;
let worker: Worker;
const metrics = new MetricsService();
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };

beforeAll(async () => {
  s = await startStack({}, { worker: false });
  await resetState(s);
  let flaky = 0;
  worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job: Job) => {
      if (job.name === 'boom') throw new UnrecoverableError('disk full on /var/lib/test');
      if (job.name === 'flaky' && flaky++ === 0) throw new Error('first attempt fails');
      await new Promise((r) => setTimeout(r, 20));
    },
    { connection: redisConnection(s.cfg.REDIS_URL), prefix: QUEUE_PREFIX, metrics: WORKER_METRICS },
  );
  instrumentWorker(worker, MAINTENANCE_QUEUE, metrics);
  await worker.waitUntilReady();
});
afterAll(async () => {
  await worker?.close();
  await s?.close();
});

const overview = async (headers = admin) => {
  const r = await s.http.get('/admin/queues').set(headers);
  expect(r.status).toBe(200);
  return r.body as { queues: Array<Record<string, any>>; backlogSeconds: number };
};
const byName = (o: { queues: Array<Record<string, any>> }, name: string) => o.queues.find((q) => q.name === name)!;

describe('GET /admin/queues', () => {
  it('reports every queue; a queue without a worker is down', async () => {
    const o = await overview();
    expect(o.queues.map((q) => q.name)).toEqual(['delivery', 'system-mail', 'alerts', 'maintenance']);
    const d = byName(o, 'delivery');
    expect(d).toMatchObject({ workers: 0, health: 'down', healthReason: 'No worker is connected', paused: false });
    expect(d.perMinute.completed).toHaveLength(60);
    expect(d.counts).toEqual({ waiting: 0, active: 0, delayed: 0, prioritized: 0, waitingChildren: 0, failed: 0, completed: 0 });
  });

  it('counts, throughput, timings, retries and failures from real jobs', async () => {
    const q = s.api.get(QueueService).maintenance;
    await q.add('noop', {});
    await q.add('noop', {});
    await q.add('flaky', {}, { attempts: 2 });
    await q.add('boom', {}, { attempts: 3 });
    const m = await waitFor(async () => {
      const x = byName(await overview(), 'maintenance');
      return x.counts.completed === 3 && x.counts.failed === 1 ? x : null;
    });
    expect(m.workers).toBeGreaterThanOrEqual(1);
    expect(m.lastHour).toEqual({ completed: 3, failed: 1 });
    expect(m.lastDay).toEqual({ completed: 3, failed: 1 });
    expect(m.perMinute.completed.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    expect(m.timings).toMatchObject({ sampled: 3, retried: 1 });
    expect(m.timings.runP50Ms).toBeGreaterThanOrEqual(15);
    expect(m.timings.waitP95Ms).toEqual(expect.any(Number));
    expect(m).toMatchObject({ health: 'warn', healthReason: '1 failed in the last hour' });
    expect(m.recentFailures).toEqual([expect.objectContaining({ name: 'boom', reason: 'disk full on /var/lib/test', attempts: 1, at: expect.any(String) })]);

    // the same jobs in Prometheus (worker side)
    const text = await metrics.registry.metrics();
    expect(text).toContain('mg_queue_jobs_processed_total{queue="maintenance",outcome="completed"} 3');
    expect(text).toContain('mg_queue_jobs_processed_total{queue="maintenance",outcome="failed"} 1');
    expect(text).toContain('mg_queue_jobs_processed_total{queue="maintenance",outcome="retried"} 1');
    expect(text).toMatch(/mg_queue_job_duration_seconds_count\{queue="maintenance",outcome="completed"\} 3/);
  });

  it('a waiting job ages; a paused queue is reported', async () => {
    const q = s.api.get(QueueService).maintenance;
    await q.pause();
    try {
      await q.add('noop', {}, { timestamp: Date.now() - 400_000 });
      const m = byName(await overview(), 'maintenance');
      expect(m.paused).toBe(true);
      expect(m.counts.waiting).toBe(1);
      expect(m.oldestWaitingSeconds).toBeGreaterThanOrEqual(399);
      expect(m.healthReason).toBe('Paused');
    } finally {
      await q.resume();
    }
    await waitFor(async () => byName(await overview(), 'maintenance').counts.waiting === 0);
  });

  it('failure reasons follow the queue\'s permission; the endpoint needs dashboard:read', async () => {
    const viewer = await login(s, 'viewer'); // dashboard, messages, alerts read; no users:read
    const r = await viewer.agent.get('/admin/queues');
    expect(r.status).toBe(200);
    const names = Object.fromEntries((r.body.queues as Array<Record<string, any>>).map((q) => [q.name, q.recentFailures]));
    expect(names['delivery']).toEqual([]);
    expect(names['alerts']).toEqual([]);
    expect(names['system-mail']).toBeNull();

    const nobody = await login(s, ['Body reader']); // messages:bodies only
    expect((await nobody.agent.get('/admin/queues')).status).toBe(403);
  });
});
