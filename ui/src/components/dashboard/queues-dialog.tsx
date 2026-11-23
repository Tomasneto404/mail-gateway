// Authored by Tomás Neto (TN 2026)
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQueues, type QueueStatus } from '@/api/queries';
import { Dot, Signal } from '@/components/common/badges';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/lib/auth';
import { fmtAgo, fmtNum } from '@/lib/format';
import { cn } from '@/lib/utils';

/*
 * Check Queues. One row per queue answers "is it fine?" at a glance (state, what is waiting,
 * what failed, the last hour drawn like the dashboard's traffic chart); a row opens to the detail.
 * Zeros are quiet so the numbers that matter stand out.
 */

const TONE = { ok: 'green', warn: 'amber', down: 'red' } as const;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** 850 ms · 4.2 s · 3 min · 1.5 h */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0).replace(/\.0$/, '')} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1).replace(/\.0$/, '')} h`;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** A count: quiet when zero, red when it is a failure that happened. */
function Count({ n, bad, className }: { n: number; bad?: boolean; className?: string }) {
  return <span className={cn('tabular', n === 0 ? 'text-muted-foreground' : bad ? 'text-destructive' : 'text-foreground', className)}>{fmtNum(n)}</span>;
}

const COLS = 'grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_1.25rem] sm:grid-cols-[minmax(0,1fr)_4rem_4rem_4.5rem_4rem_7.5rem_1.25rem] items-center gap-x-3';

export function QueuesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const q = useQueues(open);
  const [expanded, setExpanded] = useState<string | null>(null);
  const queues = q.data?.queues;
  const attention = queues?.filter((x) => x.health !== 'ok') ?? [];

  // Open the first queue that needs attention (else delivery) once, when the data first arrives.
  useEffect(() => {
    if (!open) setExpanded(null);
    else if (queues && expanded === null) setExpanded((queues.find((x) => x.health !== 'ok') ?? queues[0]).name);
  }, [open, queues, expanded]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" bodyClassName="gap-5" data-testid="queues-dialog">
        <DialogHeader className="pr-8 text-left">
          <DialogTitle>Queues</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {queues ? (
                <>
                  <Signal tone={attention.some((x) => x.health === 'down') ? 'red' : attention.length ? 'amber' : 'green'} className="text-foreground">
                    {attention.length === 0 ? `All ${queues.length} queues healthy` : `${attention.length} of ${queues.length} need attention`}
                  </Signal>
                  <span className="text-muted-foreground tabular text-xs">Live · updated {clock(q.data!.at)}</span>
                </>
              ) : (
                <span>Reading BullMQ state from Redis</span>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {q.isError && <p className="text-destructive text-sm">Could not read the queues. Is Redis reachable?</p>}

        <div className="overflow-hidden rounded-xl border" role="table" aria-label="Queues">
          <div role="row" className={cn(COLS, 'text-muted-foreground bg-muted/40 h-9 border-b px-4 text-xs')}>
            <span role="columnheader">Queue</span>
            <span role="columnheader" className="text-right">
              Waiting
            </span>
            <span role="columnheader" className="hidden text-right sm:block">
              Running
            </span>
            <span role="columnheader" className="hidden text-right sm:block">
              Done, 1 h
            </span>
            <span role="columnheader" className="text-right">
              Failed, 1 h
            </span>
            <span role="columnheader" className="hidden text-right sm:block">
              Last hour
            </span>
            <span aria-hidden />
          </div>
          {queues
            ? queues.map((x, i) => (
                <QueueRow key={x.name} q={x} last={i === queues.length - 1} open={expanded === x.name} onToggle={() => setExpanded(expanded === x.name ? '' : x.name)} backlogSeconds={q.data!.backlogSeconds} />
              ))
            : !q.isError &&
              [0, 1, 2, 3].map((i) => (
                <div key={i} className="border-b px-4 py-4 last:border-0">
                  <Skeleton className="h-6 w-full" />
                </div>
              ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QueueRow({ q, open, onToggle, last, backlogSeconds }: { q: QueueStatus; open: boolean; onToggle: () => void; last: boolean; backlogSeconds: number }) {
  const waiting = q.counts.waiting + q.counts.prioritized;
  const reasonTone = q.health === 'down' ? 'text-destructive' : q.health === 'warn' ? 'text-warning-foreground' : 'text-muted-foreground';
  const reason = q.health === 'ok' ? `Healthy · ${q.workers < 0 ? 'workers unknown' : `${q.workers} ${q.workers === 1 ? 'worker' : 'workers'}`}` : q.healthReason;
  return (
    <section data-testid={`queue-${q.name}`} aria-label={`Queue ${q.name}`} className={cn(!last && 'border-b')}>
      <button
        type="button"
        role="row"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(COLS, 'hover:bg-muted/40 focus-visible:bg-muted/40 min-h-14 w-full px-4 py-2 text-left text-sm transition-colors outline-none', open && 'bg-muted/40')}
      >
        <span role="cell" className="min-w-0">
          <Signal tone={TONE[q.health]} className="font-mono font-medium">
            {q.name}
          </Signal>
          <span className={cn('mt-0.5 block pl-4 text-xs sm:truncate', reasonTone)}>{reason}</span>
        </span>
        <span role="cell" className="text-right">
          <Count n={waiting} />
        </span>
        <span role="cell" className="hidden text-right sm:block">
          <Count n={q.counts.active} />
        </span>
        <span role="cell" className="hidden text-right sm:block">
          <Count n={q.lastHour.completed} />
        </span>
        <span role="cell" className="text-right">
          <Count n={q.lastHour.failed} bad />
        </span>
        <span role="cell" className="hidden sm:block">
          <MinuteBars completed={q.perMinute.completed} failed={q.perMinute.failed} at={Date.now()} className="h-7" />
        </span>
        <ChevronDown aria-hidden className={cn('text-muted-foreground size-4 justify-self-end transition-transform duration-200', open && 'rotate-180')} strokeWidth={1.5} />
      </button>
      {open && <QueueDetail q={q} backlogSeconds={backlogSeconds} />}
    </section>
  );
}

function QueueDetail({ q, backlogSeconds }: { q: QueueStatus; backlogSeconds: number }) {
  const { can } = useMe();
  const c = q.counts;
  const t = q.timings;
  const backlog = q.oldestWaitingSeconds !== null && q.oldestWaitingSeconds > backlogSeconds;
  return (
    <div className="motion-safe:animate-in motion-safe:fade-in-0 grid gap-5 border-t px-4 py-5 motion-safe:duration-150">
      <p className="text-secondary-foreground text-sm">{q.description}</p>

      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
            <span className="text-secondary-foreground">Finished per minute</span>
            <span className="text-secondary-foreground flex items-center gap-3">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="bg-chart-lead size-2 rounded-xs" /> Completed
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="bg-chart-neg size-2 rounded-xs" /> Failed
              </span>
            </span>
          </div>
          <MinuteBars completed={q.perMinute.completed} failed={q.perMinute.failed} at={Date.now()} className="h-32" />
          <div className="text-muted-foreground mt-1.5 flex justify-between font-mono text-[11px]">
            <span>60 min ago</span>
            <span>now</span>
          </div>
          <p className="text-secondary-foreground mt-3 text-xs">
            Last 24 hours: <Count n={q.lastDay.completed} /> completed, <Count n={q.lastDay.failed} bad /> failed
          </p>
        </div>

        <div className="grid content-start gap-5">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
            <dt className="text-secondary-foreground">Waiting</dt>
            <dd className="text-right">
              <Count n={c.waiting + c.prioritized} />
            </dd>
            <dt className="text-secondary-foreground">Running</dt>
            <dd className="text-right">
              <Count n={c.active} />
            </dd>
            <dt className="text-secondary-foreground" title="Retries in backoff, parked jobs and scheduled runs">
              Scheduled for later
            </dt>
            <dd className="text-right">
              <Count n={c.delayed} />
            </dd>
            <dt className="text-secondary-foreground">Oldest waiting</dt>
            <dd className={cn('tabular text-right', backlog ? 'text-warning-foreground' : q.oldestWaitingSeconds === null ? 'text-muted-foreground' : '')}>
              {q.oldestWaitingSeconds === null ? 'none' : fmtMs(q.oldestWaitingSeconds * 1000)}
            </dd>
            <dt className="text-secondary-foreground">Workers</dt>
            <dd className={cn('tabular text-right', q.workers === 0 && 'text-destructive')}>{q.workers < 0 ? 'unknown' : fmtNum(q.workers)}</dd>
            <dt className="text-secondary-foreground">Failed, kept</dt>
            <dd className="text-right">
              <Count n={c.failed} bad />
            </dd>
          </dl>

          <div>
            <table className="w-full text-sm">
              <caption className="text-secondary-foreground mb-2 text-left text-xs">
                {t.sampled ? `Timing of the last ${fmtNum(t.sampled)} completed jobs` : 'No completed jobs kept to time'}
              </caption>
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th className="pb-1 text-left font-normal" scope="col">
                    <span className="sr-only">Measure</span>
                  </th>
                  <th className="pb-1 text-right font-normal" scope="col">
                    Typical
                  </th>
                  <th className="pb-1 text-right font-normal" scope="col" title="95th percentile: 1 in 20 jobs is slower">
                    Slow 5%
                  </th>
                </tr>
              </thead>
              <tbody className="tabular">
                <tr>
                  <th scope="row" className="text-secondary-foreground py-0.5 text-left font-normal">
                    Waited
                  </th>
                  <td className="text-right">{fmtMs(t.waitP50Ms)}</td>
                  <td className="text-right">{fmtMs(t.waitP95Ms)}</td>
                </tr>
                <tr>
                  <th scope="row" className="text-secondary-foreground py-0.5 text-left font-normal">
                    Ran
                  </th>
                  <td className="text-right">{fmtMs(t.runP50Ms)}</td>
                  <td className="text-right">{fmtMs(t.runP95Ms)}</td>
                </tr>
              </tbody>
            </table>
            {t.sampled > 0 && (
              <p className="text-muted-foreground mt-2 text-xs">
                Slowest {fmtMs(t.runMaxMs)} · {t.retried === 0 ? 'none retried' : `${fmtNum(t.retried)} needed a retry`}
              </p>
            )}
          </div>
        </div>
      </div>

      {q.recentFailures && q.recentFailures.length > 0 && (
        <div>
          <h3 className="text-secondary-foreground mb-2 text-xs font-normal">Recent failures</h3>
          <ul className="divide-y rounded-lg border">
            {q.recentFailures.map((f) => (
              <li key={f.id} className="grid gap-1 px-3 py-2.5 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Dot tone="red" />
                    {q.name === 'delivery' && can('messages:read') ? (
                      <Link to="/messages" search={{ id: f.id }} className="text-brand truncate font-mono hover:underline">
                        message {f.id.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="truncate font-mono">
                        {f.name} {f.id.slice(0, 8)}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground tabular shrink-0">
                    {f.attempts} {f.attempts === 1 ? 'attempt' : 'attempts'} · {fmtAgo(f.at)}
                  </span>
                </div>
                <p className="text-destructive pl-4 font-mono break-words">{f.reason ?? 'no reason recorded'}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {q.recentFailures === null && c.failed > 0 && <p className="text-muted-foreground text-xs">Failure reasons for this queue are hidden for your role</p>}
    </div>
  );
}

/** Completed jobs per minute above the axis, failures below: the dashboard's traffic chart in miniature. */
export function MinuteBars({ completed, failed, at, className }: { completed: number[]; failed: number[]; at: number; className?: string }) {
  const n = completed.length;
  const done = sum(completed);
  const lost = sum(failed);
  const W = 4;
  // Failures get room below the axis only when there are any; otherwise completed bars use the height.
  const up = lost ? 26 : 34;
  const down = lost ? 12 : 0;
  const max = Math.max(1, ...completed, ...failed);
  const label = (i: number) => {
    const t = new Date(at - (n - 1 - i) * 60_000);
    return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  };
  return (
    <svg
      viewBox={`0 0 ${n * W} ${up + down + 1}`}
      preserveAspectRatio="none"
      className={cn('block w-full', className ?? 'h-12')}
      role="img"
      aria-label={done + lost ? `Per minute: ${done} completed and ${lost} failed in the last hour` : 'No jobs finished in the last hour'}
    >
      <line x1={0} x2={n * W} y1={up + 0.5} y2={up + 0.5} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {completed.map((v, i) => {
        const f = failed[i] ?? 0;
        const hu = v ? Math.max(2, (v / max) * up) : 0;
        const hd = f ? Math.min(down, Math.max(2, (f / max) * up)) : 0; // same scale as above the axis
        return (
          <g key={i}>
            <title>{`${label(i)} · ${v} completed${f ? `, ${f} failed` : ''}`}</title>
            <rect x={i * W} y={0} width={W} height={up + down + 1} fill="transparent" />
            {hu > 0 && <rect x={i * W + 0.6} y={up - hu} width={W - 1.2} height={hu} rx={0.6} className="fill-chart-lead" />}
            {hd > 0 && <rect x={i * W + 0.6} y={up + 1} width={W - 1.2} height={hd} rx={0.6} className="fill-chart-neg" />}
          </g>
        );
      })}
    </svg>
  );
}
