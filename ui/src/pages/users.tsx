// Authored by Tomás Neto (TN 2026)
import { Link } from '@tanstack/react-router';
import { MailCheck, MoreHorizontal, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useDeleteUser, useInviteUser, useResetAccess, useResetTotp, useRoles, useUpdateUser, useUsers, type User } from '@/api/queries';
import { Pill, Signal } from '@/components/common/badges';
import { exportUrl } from '@/components/common/export-menu';
import { CopyButton, Field, PageHeader, Callout } from '@/components/common/page';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useMe } from '@/lib/auth';
import { fmtAgo } from '@/lib/format';
import { covers } from '@/lib/permissions';
import { isEmail } from '@/lib/schemas';

type InviteResult = { invitePath: string; expiresInHours: number; emailed: boolean };

function InviteLink({ path, hours, emailed, email }: { path: string; hours: number; emailed: boolean; email?: string }) {
  const url = `${window.location.origin}${path}`;
  return (
    <div className="grid min-w-0 gap-3">
      {emailed ? (
        <Callout data-testid="invite-emailed" tone="ok" icon={<MailCheck />}>
          Invitation emailed{email ? <> to <span className="font-medium">{email}</span></> : null}. The link is valid for {hours}h and can be used once.
        </Callout>
      ) : (
        <p className="text-sm">
          Share this one-time link with the user (valid {hours}h, shown once). They choose a password and can then sign in.
          <span className="text-muted-foreground block text-xs">Configure SYSTEM_MAIL_FROM and SMTP or Resend to send invitations by email.</span>
        </p>
      )}
      <p className="text-muted-foreground text-xs">{emailed ? 'You can also copy the link and share it another way:' : null}</p>
      <div className="bg-muted flex min-w-0 items-center gap-2 rounded-md border p-2">
        <code data-testid="invite-link" className="min-w-0 flex-1 truncate font-mono text-xs">
          {url}
        </code>
        <CopyButton value={url} />
      </div>
    </div>
  );
}

/** Role checklist; roles granting permissions the current user lacks are disabled (anti-escalation). */
function RolePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { user } = useMe();
  const roles = useRoles();
  return (
    <div className="grid gap-1 rounded-md border p-2" role="group" aria-label="Roles">
      {roles.data?.items.map((r) => {
        const allowed = covers(user?.permissions, r.permissions);
        const checked = value.includes(r.id);
        return (
          <label key={r.id} className={`hover:bg-accent/50 flex items-start gap-2 rounded px-2 py-1.5 text-sm ${!allowed ? 'opacity-50' : ''}`}>
            <Checkbox
              className="mt-0.5"
              checked={checked}
              disabled={!allowed && !checked}
              onCheckedChange={(c) => onChange(c ? [...value, r.id] : value.filter((x) => x !== r.id))}
              aria-label={r.name}
            />
            <span className="min-w-0">
              <span className="font-medium">{r.name}</span>
              {r.permissions.includes('*') && <Pill className="ml-1.5">full access</Pill>}
              {r.description && <span className="text-muted-foreground block text-xs">{r.description}</span>}
            </span>
          </label>
        );
      })}
      <Link to="/roles" className="text-brand px-2 pt-1 text-sm hover:underline">
        Manage roles →
      </Link>
    </div>
  );
}

function InviteDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [result, setResult] = useState<InviteResult | null>(null);
  const invite = useInviteUser();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="size-4" /> Invite user
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setResult(null);
            setEmail('');
            setName('');
            setRoleIds([]);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite admin user</DialogTitle>
            <DialogDescription>Local account with a password and optional two-factor authentication. SSO users get their roles from Authentik groups automatically.</DialogDescription>
          </DialogHeader>
          {result ? (
            <InviteLink path={result.invitePath} hours={result.expiresInHours} emailed={result.emailed} email={email} />
          ) : (
            <div className="grid gap-4">
              <div className="grid items-start gap-x-4 gap-y-4 sm:grid-cols-2">
                <Field label="Email" htmlFor="u-email">
                  <Input id="u-email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Name" htmlFor="u-name">
                  <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
              </div>
              <Field label="Roles" hint="Permissions are the union of all selected roles">
                <RolePicker value={roleIds} onChange={setRoleIds} />
              </Field>
            </div>
          )}
          <DialogFooter>
            {result ? (
              <Button onClick={() => setOpen(false)}>Done</Button>
            ) : (
              <Button disabled={!isEmail(email) || !roleIds.length || invite.isPending} onClick={async () => setResult(await invite.mutateAsync({ email, name, roleIds }))}>
                Create invite
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function EditRolesDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const [roleIds, setRoleIds] = useState(user.roles.map((r) => r.id));
  const update = useUpdateUser();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Roles of {user.email}</DialogTitle>
          <DialogDescription>Takes effect immediately. Recorded in the activity log.</DialogDescription>
        </DialogHeader>
        <RolePicker value={roleIds} onChange={setRoleIds} />
        <DialogFooter>
          <Button
            disabled={!roleIds.length || update.isPending}
            onClick={async () => {
              await update.mutateAsync({ id: user.id, body: { roleIds } });
              onClose();
            }}
          >
            Save roles
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UsersPage() {
  const { user: me, can } = useMe();
  const { data, isLoading } = useUsers();
  const update = useUpdateUser();
  const resetTotp = useResetTotp();
  const resetAccess = useResetAccess();
  const del = useDeleteUser();
  const [confirm, setConfirm] = useState<{ kind: 'disable' | 'delete' | 'totp' | 'access'; user: User } | null>(null);
  const [editRoles, setEditRoles] = useState<User | null>(null);
  const [link, setLink] = useState<(InviteResult & { email: string }) | null>(null);
  const manage = can('users:manage');
  const audit = can('audit:read');

  const cols: Column<User>[] = [
    {
      id: 'email',
      header: 'User',
      cell: (u) => (
        <div>
          <div className="font-medium">{u.email}</div>
          {u.name && <div className="text-muted-foreground text-xs">{u.name}</div>}
        </div>
      ),
    },
    {
      id: 'roles',
      header: 'Roles',
      cell: (u) => (
        <span className="flex flex-wrap gap-1">
          {u.roles.length ? u.roles.map((r) => <Pill key={r.id}>{r.name}</Pill>) : <span className="text-muted-foreground text-xs">none</span>}
        </span>
      ),
    },
    {
      id: 'source',
      header: 'Sign-in',
      cell: (u) =>
        <span className="text-secondary-foreground">{u.authSource === 'authentik' ? 'Authentik SSO' : u.totpEnrolled ? 'Password + 2FA' : 'Password'}</span>,
    },
    {
      id: 'state',
      header: 'Status',
      cell: (u) =>
        u.disabled ? (
          <Signal tone="red" className="text-destructive">disabled</Signal>
        ) : u.locked ? (
          <Signal tone="amber">locked</Signal>
        ) : u.pendingInvite ? (
          <Signal tone="amber" hollow className="text-secondary-foreground">invited</Signal>
        ) : (
          <Signal tone="green" className="text-secondary-foreground">active</Signal>
        ),
    },
    { id: 'last', header: 'Last sign-in', cell: (u) => <span className="text-secondary-foreground" title={u.lastLoginAt ?? undefined}>{fmtAgo(u.lastLoginAt)}</span> },
    {
      id: 'actions',
      header: '',
      className: 'text-right pr-6',
      cell: (u) =>
        u.id === me?.id && !audit ? (
          <span className="text-muted-foreground text-xs">you</span>
        ) : manage || audit ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="size-7" aria-label={`Actions for ${u.email}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {audit && (
                <>
                  <DropdownMenuItem asChild>
                    <Link to="/activity" search={{ actorId: u.id }}>
                      View activity
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href={exportUrl('/admin/audit/export.csv', { actorId: u.id })} download data-testid={`export-user-activity-${u.email}`}>
                      Export activity (CSV)
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href={exportUrl('/admin/audit/export.csv', { actorId: u.id }, 'semicolon')} download>
                      Export activity — Excel (semicolon)
                    </a>
                  </DropdownMenuItem>
                  {manage && u.id !== me?.id && <DropdownMenuSeparator />}
                </>
              )}
              {manage && u.id !== me?.id && (
                <>
              {u.authSource === 'local' ? (
                <>
                  <DropdownMenuItem onClick={() => setEditRoles(u)}>Edit roles…</DropdownMenuItem>
                  {u.totpEnrolled && <DropdownMenuItem onClick={() => setConfirm({ kind: 'totp', user: u })}>Reset 2FA…</DropdownMenuItem>}
                  <DropdownMenuItem onClick={() => setConfirm({ kind: 'access', user: u })}>Reset password (new invite)…</DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem disabled>Roles come from Authentik groups</DropdownMenuItem>
              )}
              {u.disabled ? (
                <DropdownMenuItem onClick={() => update.mutate({ id: u.id, body: { disabled: false } })}>Enable</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setConfirm({ kind: 'disable', user: u })}>Disable…</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirm({ kind: 'delete', user: u })}>
                Delete…
              </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ];

  const c = confirm;
  const texts = {
    disable: { title: 'Disable user?', desc: 'They are signed out immediately and cannot sign in.', label: 'Disable' },
    delete: { title: 'Delete user?', desc: 'The account is removed. Activity log entries are kept.', label: 'Delete' },
    totp: { title: 'Reset two-factor authentication?', desc: 'Their authenticator is removed and they are signed out.', label: 'Reset 2FA' },
    access: { title: 'Reset password?', desc: 'Password and 2FA are cleared, sessions revoked, and a new invite link is generated.', label: 'Reset access' },
  };

  return (
    <>
      <PageHeader title="Admin users" description="Who can manage the gateway, and with which roles" actions={manage && <InviteDialog />} />
      <DataTable columns={cols} rows={data?.items} rowKey={(u) => u.id} loading={isLoading} total={data?.total} empty={{ title: 'No users' }} />
      {editRoles && <EditRolesDialog user={editRoles} onClose={() => setEditRoles(null)} />}
      {c && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={texts[c.kind].title}
          description={
            <>
              {c.user.email}: {texts[c.kind].desc}
            </>
          }
          confirmLabel={texts[c.kind].label}
          destructive
          typeToConfirm={c.kind === 'delete' ? c.user.email : undefined}
          onConfirm={async () => {
            if (c.kind === 'disable') await update.mutateAsync({ id: c.user.id, body: { disabled: true } });
            if (c.kind === 'delete') await del.mutateAsync(c.user.id);
            if (c.kind === 'totp') await resetTotp.mutateAsync(c.user.id);
            if (c.kind === 'access') setLink({ ...(await resetAccess.mutateAsync(c.user.id)), email: c.user.email });
          }}
        />
      )}
      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New invite link</DialogTitle>
          </DialogHeader>
          {link && <InviteLink path={link.invitePath} hours={link.expiresInHours} emailed={link.emailed} email={link.email} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
