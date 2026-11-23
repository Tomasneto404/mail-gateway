// Authored by Tomás Neto (TN 2026)
import { ExternalLink, ImageOff, Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { useMessage } from '@/api/queries';
import { Dot, ModeBadge, OutcomeBadge, Pill, STATUS_LABEL, StatusBadge } from '@/components/common/badges';
import { KV } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fmtBytes, fmtDate, fmtTime } from '@/lib/format';

/**
 * HTML body in a fully sandboxed iframe (no scripts, opaque origin). The preview endpoint adds a
 * strict CSP that blocks all network access; remote images only load when the user opts in.
 */
export function HtmlPreviewFrame({ id }: { id: string }) {
  const [remote, setRemote] = useState(false);
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">{remote ? 'Remote images loaded, the sender may be notified' : 'Remote images blocked'}</span>
        <Button size="sm" variant="outline" onClick={() => setRemote((r) => !r)}>
          {remote ? <ImageOff className="size-3.5" /> : <ImageIcon className="size-3.5" />}
          {remote ? 'Block remote images' : 'Load remote images'}
        </Button>
      </div>
      <iframe
        key={String(remote)}
        title="HTML preview"
        data-testid="html-preview"
        sandbox=""
        referrerPolicy="no-referrer"
        src={`/admin/messages/${id}/preview?remoteImages=${remote ? 1 : 0}`}
        className="h-105 w-full rounded-lg border bg-white"
      />
    </div>
  );
}

type Ev = { id: string; type: string; fromStatus: string | null; toStatus: string | null; at: string; detail: Record<string, unknown> | null };
type Tone = 'gray' | 'brand' | 'green' | 'red' | 'amber';
type Stop = { label: string; at?: string | null; tone: Tone; hollow?: boolean; note?: string };

/**
 * The route a message took through the gateway, read like the postmarks on an envelope:
 * received → (held for approval) → queued → delivered / captured / failed. Rejected messages stop at the policy.
 */
function routeOf(m: NonNullable<ReturnType<typeof useMessage>['data']>): Stop[] {
  const ev = m.events as Ev[];
  const firstAt = (s: string) => ev.find((e) => e.type === 'status' && e.toStatus === s)?.at;
  const stops: Stop[] = [{ label: 'Received', at: m.createdAt, tone: 'gray', note: m.sourceIp ?? undefined }];
  if (m.status === 'rejected') return [...stops, { label: 'Rejected by policy', at: firstAt('rejected') ?? m.createdAt, tone: 'red', hollow: true, note: m.rejectCode ?? undefined }];
  if (m.deliveryMode === 'approval') {
    stops.push(m.status === 'pending_approval' ? { label: 'Awaiting approval', tone: 'amber', hollow: true } : { label: 'Approved', at: firstAt('queued'), tone: 'gray' });
  }
  if (m.status === 'pending_approval') return [...stops, { label: 'Delivery', tone: 'gray', hollow: true }];
  stops.push({ label: 'Queued', at: firstAt('queued'), tone: 'gray', note: m.provider ?? undefined });
  const tries = `${m.attempts} ${m.attempts === 1 ? 'attempt' : 'attempts'}`;
  if (m.status === 'sent') stops.push({ label: 'Delivered', at: m.sentAt, tone: 'green', note: tries });
  else if (m.status === 'captured') stops.push({ label: 'Captured in sandbox', at: m.sentAt, tone: 'green', note: tries });
  else if (m.status === 'failed') stops.push({ label: 'Failed', at: firstAt('failed') ?? m.updatedAt, tone: 'red', note: tries });
  else stops.push({ label: 'Delivering', tone: 'gray', hollow: true, note: m.attempts ? tries : undefined });
  return stops;
}

function Route({ stops }: { stops: Stop[] }) {
  return (
    <ol className="grid rounded-lg border px-4 py-4" style={{ gridTemplateColumns: `repeat(${stops.length}, minmax(0, 1fr))` }} aria-label="Route">
      {stops.map((s, i) => (
        <li key={s.label} className="relative grid min-w-0 content-start gap-1 pr-3">
          <div className="flex h-4 items-center">
            <Dot tone={s.tone} hollow={s.hollow} className="relative z-10" />
            {i < stops.length - 1 && <span aria-hidden className={`mx-2 h-px flex-1 ${stops[i + 1].hollow && stops[i + 1].tone !== 'red' ? 'border-t border-dashed' : 'bg-border'}`} />}
          </div>
          <div className={`truncate text-sm ${s.tone === 'red' ? 'text-destructive' : s.hollow ? 'text-secondary-foreground' : ''}`}>{s.label}</div>
          <div className="text-muted-foreground truncate font-mono text-xs">{s.at ? fmtTime(s.at) : '—'}</div>
          {s.note && <div className="text-muted-foreground truncate font-mono text-xs">{s.note}</div>}
        </li>
      ))}
    </ol>
  );
}

function Timeline({ events }: { events: Ev[] }) {
  return (
    <ol className="grid gap-0">
      {events.map((e, i) => {
        const failed = e.type === 'attempt' || e.toStatus === 'failed' || e.toStatus === 'rejected';
        return (
          <li key={e.id} className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-3">
            <div className="flex flex-col items-center pt-1.5">
              <Dot tone={failed ? 'red' : e.toStatus === 'sent' || e.toStatus === 'captured' ? 'green' : 'gray'} hollow={e.type !== 'status'} />
              {i < events.length - 1 && <span aria-hidden className="bg-border mt-1 w-px flex-1" />}
            </div>
            <div className="min-w-0 pb-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span>{e.type === 'status' && e.toStatus ? (STATUS_LABEL[e.toStatus] ?? e.toStatus) : e.type === 'attempt' ? 'Attempt failed' : String(e.detail?.type ?? e.type)}</span>
                <span className="text-muted-foreground tabular font-mono text-xs">{fmtTime(e.at)}</span>
              </div>
              {e.detail && Object.keys(e.detail).length > 0 && (
                <pre className="bg-muted/60 text-secondary-foreground mt-2 max-h-32 overflow-auto rounded-md border px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap">{JSON.stringify(e.detail, null, 2)}</pre>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function MessageDrawer({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  const { data: m, isLoading } = useMessage(id);
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl" bodyClassName="gap-0">
        <SheetHeader className="gap-1 border-b px-6 py-5">
          <SheetTitle className="pr-8 text-base leading-6">{m?.subject || (isLoading ? 'Loading' : '(no subject)')}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{id}</SheetDescription>
          {m && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2 text-sm">
              <StatusBadge status={m.status} />
              <ModeBadge mode={m.deliveryMode} />
              {m.provider && <span className="text-secondary-foreground font-mono text-xs">{m.provider}</span>}
              <OutcomeBadge outcome={m.deliveryOutcome} />
              {m.source === 'admin_test' && <Pill>test</Pill>}
            </div>
          )}
        </SheetHeader>
        {!m ? (
          <div className="grid gap-2 p-6">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <Tabs defaultValue="overview" className="px-6 py-5">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="body">Body</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="headers">Headers</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="grid gap-6 pt-4">
              <Route stops={routeOf(m)} />
              {m.rejectCode && (
                <div className="grid gap-1 text-sm">
                  <div className="font-mono text-xs">{m.rejectCode}</div>
                  <div className="text-secondary-foreground">{m.rejectReason}</div>
                </div>
              )}
              <KV
                items={[
                  ['Key', <span className="font-mono text-xs">{m.apiKey.name}</span>],
                  ['From', m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress],
                  ['To', m.to.join(', ') || '—'],
                  ...(m.cc.length ? ([['Cc', m.cc.join(', ')]] as Array<[string, string]>) : []),
                  ...(m.bcc.length ? ([['Bcc', m.bcc.join(', ')]] as Array<[string, string]>) : []),
                  ...(m.replyTo ? ([['Reply-To', m.replyTo]] as Array<[string, string]>) : []),
                  ['Created', fmtDate(m.createdAt)],
                  ['Sent', fmtDate(m.sentAt)],
                  ['Attempts', String(m.attempts)],
                  ['Size', fmtBytes(m.sizeBytes)],
                  ['Source IP', <span className="font-mono text-xs">{m.sourceIp ?? '—'}</span>],
                  ['Last error', m.lastError ? <span className="text-destructive font-mono text-xs">{m.lastError}</span> : '—'],
                  ['Provider response', <span className="font-mono text-xs">{m.providerResponse ?? '—'}</span>],
                  ['Provider id', <span className="font-mono text-xs">{m.providerMessageId ?? '—'}</span>],
                  ['Body hash', <span className="font-mono text-xs">{m.bodyHash.slice(0, 16)}…</span>],
                ]}
              />
              {m.attachments.length > 0 && (
                <div className="grid gap-1 text-sm">
                  <div className="font-medium">Attachments</div>
                  {m.attachments.map((a) => (
                    <div key={a.id} className="text-muted-foreground font-mono text-xs">
                      {a.filename} · {a.contentType} · {fmtBytes(a.sizeBytes)}
                    </div>
                  ))}
                </div>
              )}
              {m.metadata && (
                <div className="grid gap-1 text-sm">
                  <div className="font-medium">Metadata</div>
                  <pre className="bg-muted/60 overflow-auto rounded-md border px-3 py-2 font-mono text-xs leading-5">{JSON.stringify(m.metadata, null, 2)}</pre>
                </div>
              )}
            </TabsContent>
            <TabsContent value="body" className="grid gap-4 pt-4">
              {!m.bodiesVisible ? (
                <p className="text-muted-foreground text-sm">Your role does not allow viewing message bodies</p>
              ) : m.bodyPurgedAt ? (
                <p className="text-muted-foreground text-sm">Body purged by retention on {fmtDate(m.bodyPurgedAt)}.</p>
              ) : (
                <>
                  {m.hasHtml && <HtmlPreviewFrame id={m.id} />}
                  {m.hasText && (
                    <div className="grid gap-1">
                      <div className="text-sm font-medium">Text</div>
                      <pre className="bg-muted/60 max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs leading-5 whitespace-pre-wrap">{m.textBody}</pre>
                    </div>
                  )}
                </>
              )}
            </TabsContent>
            <TabsContent value="timeline" className="pt-5">
              <Timeline events={m.events} />
            </TabsContent>
            <TabsContent value="headers" className="pt-4">
              <KV items={Object.entries(m.headers).map(([k, v]) => [<span className="font-mono text-xs">{k}</span>, <span className="font-mono text-xs">{v}</span>])} />
              <a className="text-brand mt-4 inline-flex items-center gap-1 text-sm hover:underline" href={`/admin/messages/${m.id}`} target="_blank" rel="noreferrer">
                Raw JSON <ExternalLink className="size-3" />
              </a>
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>
    </Sheet>
  );
}
