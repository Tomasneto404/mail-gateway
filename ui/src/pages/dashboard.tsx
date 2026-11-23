// Authored by Tomás Neto (TN 2026)
import { Link } from '@tanstack/react-router';
import { Layers, PauseCircle, PlayCircle } from 'lucide-react';
import { useState } from 'react';
import { usePauseGateway, useResumeGateway, useStats, useSystemState } from '@/api/queries';
import { Dot, Signal } from '@/components/common/badges';
import { PageHeader } from '@/components/common/page';
import { BarList, Legend, StatTile, VolumeChart, changeVs } from '@/components/dashboard/charts';
import { QueuesDialog } from '@/components/dashboard/queues-dialog';
import { Segmented } from '@/components/keys/segmented';
import { PauseDialog } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/lib/auth';
import { fmtAgo, fmtNum } from '@/lib/format';
import { cn } from '@/lib/utils';

const RANGE_LABEL = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' } as const;
const RANGES = { '24h': { hours: 24, bucket: 'hour' }, '7d': { hours: 168, bucket: 'day' }, '30d': { hours: 720, bucket: 'day' } } as const;

export function DashboardPage() {
  const { can } = useMe();
  const [range, setRange] = useState<keyof typeof RANGES>('24h');
  const r = RANGES[range];
  const [from] = useState(() => new Date());
  const stats = useStats({ from: new Date(from.getTime() - r.hours * 3600_000).toISOString(), bucket: r.bucket });
  const sys = useSystemState();
  const pause = usePauseGateway();
  const resume = useResumeGateway();
  const [confirm, setConfirm] = useState(false);
  const [queuesOpen, setQueuesOpen] = useState(false);
  const g = sys.data?.gateway;
  const t = stats.data?.totals;
  const p = stats.data?.previousTotals;
  const period = { '24h': 'previous 24h', '7d': 'previous 7 days', '30d': 'previous 30 days' }[range];
  const delivered = t ? t.sent + t.captured : 0;
  const rejectRate = t && t.accepted + t.rejected > 0 ? (t.rejected / (t.accepted + t.rejected)) * 100 : 0;
  const bounces = stats.data?.outcomes.filter((o) => o.outcome === 'bounced' || o.outcome === 'complained').reduce((n, o) => n + o.count, 0) ?? 0;

  const queued = sys.data ? sys.data.queue.waiting + sys.data.queue.active + sys.data.queue.delayed : 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={RANGE_LABEL[range]}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setQueuesOpen(true)} data-tour="check-queues">
              <Layers /> Check Queues
            </Button>
            <Segmented
              label="Time range"
              size="sm"
              value={range}
              onChange={setRange}
              options={(Object.keys(RANGES) as Array<keyof typeof RANGES>).map((k) => ({ value: k, label: k }))}
            />
          </>
        }
      />
      <div className="grid w-full max-w-[1600px] gap-4 px-4 sm:px-8 py-6">
        <section
          aria-label="Gateway state"
          data-tour="gateway-state"
          className={cn('bg-card flex min-h-16 flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border px-5 py-3 shadow-[var(--shadow-sm)]', g?.paused && 'border-destructive/40')}
        >
          {!sys.data ? (
            <Skeleton className="h-6 w-64" />
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <Signal tone={g?.paused ? 'red' : 'green'} className="text-sm font-medium">
                  <span data-testid="gateway-state">{g?.paused ? 'Gateway paused' : 'Gateway running'}</span>
                </Signal>
                {g?.paused && (
                  <p className="text-secondary-foreground mt-1 pl-4 text-sm">
                    {g.reason} · by {g.pausedBy} · {fmtAgo(g.pausedAt)}
                  </p>
                )}
              </div>
              <dl className="text-secondary-foreground flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
                {sys.data.breakers.map((b) => (
                  <div key={b.provider} className="flex items-center gap-2">
                    <Dot tone={!b.enabled ? 'gray' : b.state === 'open' ? 'red' : 'green'} hollow={!b.enabled} />
                    <dt className="font-mono">{b.provider}</dt>
                    <dd className="text-muted-foreground">{b.enabled ? `breaker ${b.state}` : 'not configured'}</dd>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <Dot tone={sys.data.smtpHealth.status === 'up' ? 'green' : sys.data.smtpHealth.status === 'down' ? 'red' : 'gray'} hollow={sys.data.smtpHealth.status !== 'up' && sys.data.smtpHealth.status !== 'down'} />
                  <dt className="font-mono">relay</dt>
                  <dd className="text-muted-foreground tabular">
                    {sys.data.smtpHealth.status}
                    {sys.data.smtpHealth.latencyMs !== undefined && ` · ${sys.data.smtpHealth.latencyMs} ms`}
                  </dd>
                </div>
              </dl>
              {can('gateway:pause') &&
                (g?.paused ? (
                  <Button size="sm" onClick={() => resume.mutate()} disabled={resume.isPending}>
                    <PlayCircle /> Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>
                    <PauseCircle /> Pause
                  </Button>
                ))}
            </>
          )}
        </section>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatTile label="Accepted" value={t ? fmtNum(t.accepted) : '—'} change={changeVs(t?.accepted, p?.accepted, period)} hint={t ? `${fmtNum(t.accepted + t.rejected)} requests` : undefined} />
          <StatTile
            label="Delivered"
            value={t ? fmtNum(delivered) : '—'}
            change={changeVs(t ? delivered : undefined, p ? p.sent + p.captured : undefined, period)}
            hint={t ? `${fmtNum(t.sent)} live · ${fmtNum(t.captured)} sandbox` : undefined}
          />
          <StatTile
            label="Rejected"
            value={t ? fmtNum(t.rejected) : '—'}
            change={changeVs(t?.rejected, p?.rejected, period)}
            hint={t ? `${rejectRate.toFixed(1)}% of requests` : undefined}
            tone={rejectRate > 20 ? 'warn' : undefined}
          />
          <StatTile
            label="Failed"
            value={t ? fmtNum(t.failed) : '—'}
            change={changeVs(t?.failed, p?.failed, period)}
            tone={t && t.failed > 0 ? 'bad' : undefined}
            hint={bounces ? `${fmtNum(bounces)} bounces or complaints` : 'after all retries'}
          />
          <StatTile
            label="Awaiting approval"
            value={sys.data ? fmtNum(sys.data.pendingApprovals) : '—'}
            hint={
              sys.data?.pendingApprovals ? (
                <Link to="/approvals" className="text-brand hover:underline">
                  Review {sys.data.pendingApprovals === 1 ? 'message' : 'messages'}
                </Link>
              ) : sys.data ? (
                `${fmtNum(queued)} in delivery queue`
              ) : undefined
            }
          />
        </div>

        <Card className="gap-4" data-tour="traffic">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Traffic</CardTitle>
            <Legend />
          </CardHeader>
          <CardContent>{stats.data ? <VolumeChart series={stats.data.series} bucket={stats.data.bucket} /> : <Skeleton className="h-75 w-full" />}</CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="gap-5 lg:col-span-3">
            <CardHeader>
              <CardTitle>Top keys by volume</CardTitle>
            </CardHeader>
            <CardContent>
              {stats.data ? <BarList items={stats.data.topKeys.map((x) => ({ label: x.name, value: x.count }))} emptyTitle="No traffic yet" /> : <Skeleton className="h-32 w-full" />}
            </CardContent>
          </Card>
          <Card className="gap-5 lg:col-span-2">
            <CardHeader>
              <CardTitle>Rejections by reason</CardTitle>
            </CardHeader>
            <CardContent>
              {stats.data ? (
                <BarList accent="neg" mono items={stats.data.rejectionsByReason.map((x) => ({ label: x.reason, value: x.count }))} emptyTitle="No rejections" />
              ) : (
                <Skeleton className="h-32 w-full" />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      <PauseDialog open={confirm} onOpenChange={setConfirm} onConfirm={(reason) => pause.mutateAsync(reason || 'manual (admin UI)')} />
      <QueuesDialog open={queuesOpen} onOpenChange={setQueuesOpen} />
    </>
  );
}
