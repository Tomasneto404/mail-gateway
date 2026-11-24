// Authored by Tomás Neto (TN 2026)
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check, X } from 'lucide-react';
import { useState } from 'react';
import { useApprove, useKeys, useMessages, useReject, type Message, type MessageListParams } from '@/api/queries';
import { ModeDot, OutcomeBadge, Pill, STATUS_LABEL, StatusBadge } from '@/components/common/badges';
import { ExportMenu } from '@/components/common/export-menu';
import { PageHeader } from '@/components/common/page';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { MessageDrawer } from '@/components/messages/message-drawer';
import { SandboxInboxButton } from '@/components/messages/sandbox-inbox-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FilterSelect } from '@/components/ui/select';
import { useMe } from '@/lib/auth';
import { fmtAgo, fmtShort } from '@/lib/format';
import { cn } from '@/lib/utils';

export type MessagesSearch = MessageListParams & { id?: string };

function recipients(m: Message) {
  const all = [...m.to, ...m.cc, ...m.bcc];
  return all.length > 1 ? `${all[0]} +${all.length - 1}` : (all[0] ?? '—');
}

const baseCols: Column<Message>[] = [
  { id: 'status', header: 'Status', sortable: true, cell: (m) => <StatusBadge status={m.status} /> },
  {
    id: 'subject',
    header: 'Subject',
    sortable: true,
    className: 'max-w-md',
    cell: (m) => (
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="truncate">{m.subject || <span className="text-muted-foreground">(no subject)</span>}</span>
        {m.rejectCode && <span className="text-muted-foreground shrink-0 font-mono text-xs">{m.rejectCode}</span>}
      </div>
    ),
  },
  { id: 'to', header: 'Recipients', cell: (m) => <span className="text-secondary-foreground">{recipients(m)}</span> },
  {
    id: 'key',
    header: 'Key',
    cell: (m) => (
      <span className="flex items-center gap-2" title={`${m.deliveryMode} mode`}>
        <ModeDot mode={m.deliveryMode} />
        <span className="font-mono text-xs">{m.apiKey.name}</span>
        {m.source === 'admin_test' && <Pill>test</Pill>}
      </span>
    ),
  },
  { id: 'outcome', header: '', cell: (m) => <OutcomeBadge outcome={m.deliveryOutcome} /> },
  { id: 'createdAt', header: 'Created', sortable: true, cell: (m) => <span className="text-secondary-foreground tabular font-mono text-xs whitespace-nowrap" title={m.createdAt}>{fmtShort(m.createdAt)}</span> },
];

export function MessagesPage() {
  const search = useSearch({ strict: false }) as MessagesSearch;
  const navigate = useNavigate();
  const { id, ...filters } = search;
  const q: MessageListParams = { page: 1, pageSize: 50, sort: 'createdAt', order: 'desc', ...filters };
  const { data, isLoading } = useMessages(q, { refetchInterval: 10_000 });
  const keys = useKeys({ pageSize: 200 });
  const set = (patch: Partial<MessagesSearch>) => navigate({ to: '/messages', search: { ...search, page: 1, ...patch } as never, replace: true });
  const statuses = (filters.status ?? '').split(',').filter(Boolean);

  return (
    <>
      <PageHeader
        title="Messages"
        description="Every request after authentication: accepted or rejected"
        actions={
          <>
            <SandboxInboxButton />
            <ExportMenu
              path="/admin/messages/export.csv"
              params={{ status: filters.status, keyId: filters.keyId, recipient: filters.recipient, subject: filters.subject, from: filters.from, to: filters.to }}
            />
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-4 sm:px-8 py-3" data-tour="filters">
        <Input placeholder="Subject" className="h-8 w-52" defaultValue={filters.subject} onChange={(e) => set({ subject: e.target.value || undefined })} />
        <Input placeholder="Recipient (exact)" className="h-8 w-52" defaultValue={filters.recipient} onBlur={(e) => set({ recipient: e.target.value.trim() || undefined })} />
        <FilterSelect
          aria-label="Key"
          className="w-48"
          value={filters.keyId}
          onChange={(v) => set({ keyId: v })}
          allLabel="All keys"
          options={(keys.data?.items ?? []).map((k) => ({ value: k.id, label: <span className="font-mono text-xs">{k.name}</span> }))}
        />
        <label className="text-secondary-foreground flex items-center gap-2 text-sm">
          From
          <input type="date" aria-label="From date" className="border-input bg-card h-8 rounded-md border px-2.5 text-sm" value={filters.from?.slice(0, 10) ?? ''} onChange={(e) => set({ from: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
        </label>
        <label className="text-secondary-foreground flex items-center gap-2 text-sm">
          To
          <input
            type="date"
            aria-label="To date"
            className="border-input bg-card h-8 rounded-md border px-2.5 text-sm"
            value={filters.to?.slice(0, 10) ?? ''}
            onChange={(e) => set({ to: e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : undefined })}
          />
        </label>
        <div className="flex flex-wrap gap-1">
          {Object.keys(STATUS_LABEL).map((s) => {
            const on = statuses.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                className={cn(
                  'focus-visible:ring-ring/50 flex h-8 items-center rounded-md border px-2.5 text-sm outline-none transition-colors focus-visible:ring-[3px]',
                  on ? 'bg-card border-input text-foreground shadow-[var(--shadow-sm)]' : 'text-secondary-foreground hover:text-foreground border-transparent',
                )}
                onClick={() => {
                  const next = on ? statuses.filter((x) => x !== s) : [...statuses, s];
                  set({ status: next.join(',') || undefined });
                }}
              >
                <StatusBadge status={s} />
              </button>
            );
          })}
        </div>
        {Object.keys(filters).some((k) => !['page', 'pageSize', 'sort', 'order'].includes(k)) && (
          <Button size="sm" variant="ghost" onClick={() => navigate({ to: '/messages', search: {} as never })}>
            Clear
          </Button>
        )}
      </div>
      <DataTable
        columns={baseCols}
        rows={data?.items}
        rowKey={(m) => m.id}
        loading={isLoading}
        total={data?.total}
        page={q.page}
        pageSize={q.pageSize}
        onPage={(page) => navigate({ to: '/messages', search: { ...search, page } as never })}
        sort={q.sort}
        order={q.order}
        onSort={(sort, order) => set({ sort: sort as MessageListParams['sort'], order })}
        onRowClick={(m) => navigate({ to: '/messages', search: { ...search, id: m.id } as never })}
        activeKey={id}
        empty={{ title: 'No messages match', description: 'Adjust the filters or send a test email from a key page.' }}
      />
      <MessageDrawer id={id} onClose={() => navigate({ to: '/messages', search: { ...search, id: undefined } as never })} />
    </>
  );
}

export function ApprovalsPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { id?: string; page?: number };
  const { can } = useMe();
  const canDecide = can('approvals:decide');
  const q: MessageListParams = { status: 'pending_approval', page: search.page ?? 1, pageSize: 50, sort: 'createdAt', order: 'asc' };
  const { data, isLoading } = useMessages(q, { refetchInterval: 10_000 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<string[] | null>(null);
  const approve = useApprove();
  const reject = useReject();

  const cols: Column<Message>[] = [
    ...baseCols.filter((c) => c.id !== 'status' && c.id !== 'outcome' && c.id !== 'createdAt'),
    { id: 'age', header: 'Waiting', cell: (m) => <span className="text-secondary-foreground whitespace-nowrap" title={fmtShort(m.createdAt)}>{fmtAgo(m.createdAt)}</span> },
    ...(canDecide
      ? [
          {
            id: 'actions',
            header: '',
            className: 'text-right',
            cell: (m: Message) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <Button size="sm" variant="outline" onClick={() => approve.mutate([m.id])}>
                  <Check /> Approve
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRejecting([m.id])}>
                  <X /> Reject
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Messages from keys in approval mode. Approved messages are delivered live."
        actions={
          canDecide &&
          selected.size > 0 && (
            <>
              <span className="text-muted-foreground text-xs">{selected.size} selected</span>
              <Button
                size="sm"
                onClick={async () => {
                  await approve.mutateAsync([...selected]);
                  setSelected(new Set());
                }}
              >
                <Check className="size-4" /> Approve selected
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRejecting([...selected])}>
                <X className="size-4" /> Reject selected
              </Button>
            </>
          )
        }
      />
      <DataTable
        columns={cols}
        rows={data?.items}
        rowKey={(m) => m.id}
        loading={isLoading}
        total={data?.total}
        page={q.page}
        pageSize={q.pageSize}
        onPage={(page) => navigate({ to: '/approvals', search: { page } as never })}
        selected={canDecide ? selected : undefined}
        onSelectedChange={canDecide ? setSelected : undefined}
        onRowClick={(m) => navigate({ to: '/approvals', search: { ...search, id: m.id } as never })}
        activeKey={search.id}
        empty={{ title: 'Inbox zero', description: 'Nothing is waiting for approval.' }}
      />
      <MessageDrawer id={search.id} onClose={() => navigate({ to: '/approvals', search: { ...search, id: undefined } as never })} />
      <ConfirmDialog
        open={!!rejecting}
        onOpenChange={(o) => !o && setRejecting(null)}
        title={`Reject ${rejecting?.length ?? 0} message${rejecting?.length === 1 ? '' : 's'}?`}
        description="Rejected messages are never delivered. The client sees status rejected with your reason."
        confirmLabel="Reject"
        destructive
        reasonLabel="Reason (optional)"
        onConfirm={async (reason) => {
          await reject.mutateAsync({ ids: rejecting ?? [], reason: reason || undefined });
          setSelected(new Set());
        }}
      />
    </>
  );
}
