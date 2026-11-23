// Authored by Tomás Neto (TN 2026)
import { describe, expect, it } from 'vitest';
import { failureOutcome } from '../../src/metrics/worker-instrumentation';
import { BACKLOG_SECONDS, fmtSeconds, jobTimings, minuteSeries, percentile, queueHealth } from '../../src/queue/queue-metrics';

const MIN = 60_000;
const at = (minute: number, sec = 0) => minute * MIN + sec * 1000;

describe('minuteSeries', () => {
  it('is all zeros without metrics', () => {
    expect(minuteSeries(null, at(1000), 5)).toEqual([0, 0, 0, 0, 0]);
    expect(minuteSeries({ data: [], meta: { count: 0, prevTS: 0, prevCount: 0 } }, at(1000), 3)).toEqual([0, 0, 0]);
  });

  it('puts the newest data point in the minute before prevTS and pending jobs in the minute of prevTS', () => {
    // last flush during minute 998: minute 997 had 4 jobs, 996 had 0, 995 had 2; 3 jobs since the flush
    const m = { data: [4, 0, 2], meta: { count: 9, prevTS: at(998, 20), prevCount: 6 } };
    expect(minuteSeries(m, at(998, 40), 4)).toEqual([2, 0, 4, 3]);
  });

  it('shifts an idle queue: minutes after the last activity are zero', () => {
    const m = { data: [5], meta: { count: 7, prevTS: at(990, 5), prevCount: 7 } };
    // now = minute 993 → window 990..993: 990 has 0 pending, the 5 belong to 989 (outside)
    expect(minuteSeries(m, at(993), 4)).toEqual([0, 0, 0, 0]);
    expect(minuteSeries(m, at(993), 5)).toEqual([5, 0, 0, 0, 0]);
  });
});

describe('percentile / timings', () => {
  it('nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([10], 95)).toBe(10);
  });

  it('wait only from first attempts, run from every job, retried counted', () => {
    const t = jobTimings([
      { timestamp: 1000, processedOn: 1100, finishedOn: 1300, attemptsMade: 1 }, // wait 100, run 200
      { timestamp: 1000, delay: 500, processedOn: 1600, finishedOn: 1650, attemptsMade: 1 }, // due at 1500 → wait 100, run 50
      { timestamp: 1000, processedOn: 90_000, finishedOn: 90_400, attemptsMade: 3 }, // retried: run 400, no wait
      { timestamp: 1000, processedOn: null, finishedOn: null, attemptsMade: 0 }, // ignored
    ]);
    expect(t).toMatchObject({ sampled: 3, retried: 1, waitP50Ms: 100, waitP95Ms: 100, runP50Ms: 200, runP95Ms: 400, runMaxMs: 400 });
  });

  it('empty sample', () => {
    expect(jobTimings([])).toMatchObject({ sampled: 0, retried: 0, waitP50Ms: null, runMaxMs: null });
  });
});

describe('queueHealth', () => {
  const base = { workers: 1, paused: false, oldestWaitingSeconds: null, failedLastHour: 0 };
  it('orders the problems: no worker, paused, backlog, failures', () => {
    expect(queueHealth(base)).toEqual({ health: 'ok', healthReason: 'Healthy' });
    expect(queueHealth({ ...base, workers: 0, paused: true }).health).toBe('down');
    expect(queueHealth({ ...base, paused: true, failedLastHour: 3 }).healthReason).toBe('Paused');
    expect(queueHealth({ ...base, oldestWaitingSeconds: BACKLOG_SECONDS + 60 }).healthReason).toBe('Oldest job has waited 6 min');
    expect(queueHealth({ ...base, oldestWaitingSeconds: BACKLOG_SECONDS }).health).toBe('ok');
    expect(queueHealth({ ...base, failedLastHour: 2 })).toEqual({ health: 'warn', healthReason: '2 failed in the last hour' });
  });
  it('unknown worker count (-1) is not reported as down', () => {
    expect(queueHealth({ ...base, workers: -1 }).health).toBe('ok');
  });
  it('formats durations', () => {
    expect([fmtSeconds(42), fmtSeconds(600), fmtSeconds(5400), fmtSeconds(3 * 86_400)]).toEqual(['42 s', '10 min', '1.5 h', '3 d']);
  });
});

describe('failureOutcome', () => {
  it('a failed attempt without finishedOn will be retried', () => {
    expect(failureOutcome({ finishedOn: undefined })).toBe('retried');
    expect(failureOutcome({ finishedOn: 123 })).toBe('failed');
    expect(failureOutcome(undefined)).toBe('failed');
  });
});
