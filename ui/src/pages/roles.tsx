// Authored by Tomás Neto (TN 2026)
import { Lock, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { usePermissionCatalog, useCreateRole, useDeleteRole, useRoles, useUpdateRole, type RoleT } from '@/api/queries';
import { Pill } from '@/components/common/badges';
import { Field, PageHeader } from '@/components/common/page';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useMe } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { cn } from '@/lib/utils';

const AREA_LABEL: Record<string, string> = {
  dashboard: 'Dashboard',
  keys: 'API keys',
  messages: 'Messages',
  approvals: 'Approvals',
  gateway: 'Gateway',
  users: 'Users',
  roles: 'Roles',
  audit: 'Activity log',
  settings: 'Settings',
};

/** Free-text chips (Authentik group names). */
function TagInput({ value, onChange, disabled, id }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean; id?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && draft.trim()) {
      e.preventDefault();
      add();
    } else if (e.key === 'Enter') e.preventDefault();
    else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className={cn('border-input dark:bg-input/30 flex min-h-9 flex-wrap items-center gap-1 rounded-md border px-2 py-1 shadow-xs', disabled && 'opacity-60')}>
      {value.map((g) => (
        <span key={g} className="bg-secondary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs">
          {g}
          {!disabled && (
            <button type="button" aria-label={`Remove ${g}`} onClick={() => onChange(value.filter((x) => x !== g))}>
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      <input
        id={id}
        className="min-w-40 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
        placeholder={value.length ? '' : 'e.g. mail-gateway-operators — press Enter'}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
      />
    </div>
  );
}

interface EditorProps {
  role?: RoleT;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

function RoleEditor({ role, open, onOpenChange }: EditorProps) {
  const { user, can } = useMe();
  const catalog = usePermissionCatalog();
  const create = useCreateRole();
  const update = useUpdateRole();
  const readOnly = !can('roles:manage') || (role && !role.editable);
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const [groups, setGroups] = useState<string[]>(role?.ssoGroups ?? []);
  const mine = user?.permissions;

  const areas = useMemo(() => {
    const m = new Map<string, Array<{ id: string; label: string }>>();
    for (const p of catalog.data ?? []) m.set(p.area, [...(m.get(p.area) ?? []), p]);
    return [...m.entries()];
  }, [catalog.data]);

  const all = perms.includes('*');
  const toggle = (p: string, on: boolean) => setPerms((cur) => (on ? [...new Set([...cur, p])] : cur.filter((x) => x !== p)));
  const effective = (p: string) => hasPermission(perms, p);
  // anti-escalation: you can only grant what you hold (the server enforces it)
  const grantable = (p: string) => hasPermission(mine, p) && (p !== '*' || !!mine?.includes('*'));

  const submit = async () => {
    const body = { name, description, permissions: perms, ssoGroups: groups };
    if (role) await update.mutateAsync({ id: role.id, body: role.builtin ? { description, permissions: perms, ssoGroups: groups } : body });
    else await create.mutateAsync(body);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {role ? role.name : 'New role'} {role?.builtin && <Pill>built-in</Pill>}
          </DialogTitle>
          <DialogDescription>
            {role && !role.editable
              ? 'The Admin role always has full access and cannot be modified.'
              : 'Users get the union of the permissions of all their roles. Changes apply immediately to every member.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <div className="grid items-start gap-x-6 gap-y-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="role-name" hint={role?.builtin ? 'Built-in roles cannot be renamed.' : undefined}>
              <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly || role?.builtin} />
            </Field>
            <Field label="Description" htmlFor="role-desc">
              <Input id="role-desc" value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} />
            </Field>
          </div>

          <div className="grid gap-2">
            <div className="text-sm font-medium">Permissions</div>
            <label className="flex items-center gap-2 rounded-md border p-3 text-sm">
              <Checkbox checked={all} disabled={readOnly || !grantable('*')} onCheckedChange={(c) => setPerms(c ? ['*'] : [])} aria-label="Full access" />
              <span>
                <span className="font-medium">Full access</span>
                <span className="text-muted-foreground block text-xs">Everything, including future permissions (*).</span>
              </span>
            </label>
            <div className={cn('grid gap-3 sm:grid-cols-2', all && 'opacity-50')}>
              {areas.map(([area, items]) => {
                const areaPerm = `${area}:*`;
                return (
                  <fieldset key={area} className="grid content-start gap-1.5 rounded-md border p-3" disabled={readOnly || all}>
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <Checkbox
                        checked={effective(areaPerm) || perms.includes(areaPerm)}
                        disabled={readOnly || all || !grantable(areaPerm)}
                        onCheckedChange={(c) => setPerms((cur) => (c ? [...cur.filter((x) => !x.startsWith(`${area}:`)), areaPerm] : cur.filter((x) => x !== areaPerm)))}
                        aria-label={`All ${AREA_LABEL[area] ?? area}`}
                      />
                      {AREA_LABEL[area] ?? area}
                    </label>
                    {items.map((p) => (
                      <label key={p.id} className="text-muted-foreground flex items-start gap-2 pl-6 text-xs" title={p.id}>
                        <Checkbox
                          className="mt-px"
                          checked={effective(p.id)}
                          disabled={readOnly || all || perms.includes(areaPerm) || !grantable(p.id)}
                          onCheckedChange={(c) => toggle(p.id, !!c)}
                          aria-label={p.id}
                        />
                        <span>
                          <span className="text-foreground font-mono text-xs">{p.id.split(':')[1]}</span> — {p.label}
                          {!grantable(p.id) && <Lock className="ml-1 inline size-3" aria-label="You do not hold this permission" />}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                );
              })}
            </div>
          </div>

          <Field label="Authentik groups" htmlFor="role-groups" hint="Members of any of these groups get this role when they sign in with SSO">
            <TagInput id="role-groups" value={groups} onChange={setGroups} disabled={readOnly} />
          </Field>
        </div>
        {!readOnly && (
          <DialogFooter>
            <Button disabled={!name.trim() || create.isPending || update.isPending} onClick={submit}>
              {role ? 'Save role' : 'Create role'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RolesPage() {
  const { can } = useMe();
  const { data, isLoading } = useRoles();
  const del = useDeleteRole();
  const [editing, setEditing] = useState<RoleT | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RoleT | null>(null);

  const cols: Column<RoleT>[] = [
    {
      id: 'name',
      header: 'Role',
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-medium">
            {r.name} {r.builtin && <Pill>built-in</Pill>}
          </div>
          {r.description && <div className="text-muted-foreground truncate text-xs">{r.description}</div>}
        </div>
      ),
    },
    {
      id: 'perms',
      header: 'Permissions',
      className: 'max-w-md',
      cell: (r) =>
        r.permissions.includes('*') ? (
          <Pill>full access</Pill>
        ) : (
          <span className="text-muted-foreground block truncate font-mono text-xs" title={r.permissions.join(', ')}>
            {r.permissions.join(' · ') || '—'}
          </span>
        ),
    },
    { id: 'groups', header: 'Authentik groups', cell: (r) => <span className="text-secondary-foreground font-mono text-xs">{r.ssoGroups.join(', ') || '—'}</span> },
    { id: 'users', header: 'Users', className: 'tabular', cell: (r) => r.userCount },
    {
      id: 'actions',
      header: '',
      className: 'text-right pr-6',
      cell: (r) =>
        can('roles:manage') && !r.builtin ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`Delete ${r.name}`}
            onClick={(e) => {
              e.stopPropagation();
              setDeleting(r);
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Roles"
        description="Role-based access control: each role is a set of permissions; users can hold several roles"
        actions={
          can('roles:manage') && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="size-4" /> New role
            </Button>
          )
        }
      />
      <DataTable columns={cols} rows={data?.items} rowKey={(r) => r.id} loading={isLoading} total={data?.total} onRowClick={(r) => setEditing(r)} empty={{ title: 'No roles' }} />
      {editing && <RoleEditor key={editing === 'new' ? 'new' : editing.id} role={editing === 'new' ? undefined : editing} open onOpenChange={(o) => !o && setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`Delete role "${deleting.name}"?`}
          description={`${deleting.userCount} user(s) lose the permissions it grants, immediately.`}
          confirmLabel="Delete role"
          destructive
          typeToConfirm={deleting.name}
          onConfirm={async () => {
            await del.mutateAsync(deleting.id);
          }}
        />
      )}
    </>
  );
}
