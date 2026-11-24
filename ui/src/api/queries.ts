// Authored by Tomás Neto (TN 2026)
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, call, errorMessage, setCsrfToken, type Schemas } from './client';

export type Key = Schemas['KeyWithUsageDto'];
export type KeyPolicy = Schemas['KeyDto'];
export type Message = Schemas['MessageListItemDto'];
export type MessageDetail = Schemas['MessageDetailDto'];
export type User = Schemas['UserDto'];
export type Session = Schemas['SessionDto'];
export type UpdateKey = Schemas['UpdateKeyDto'];

// ---------------------------------------------------------------- session
export const sessionQuery = {
  queryKey: ['session'] as QueryKey,
  queryFn: async (): Promise<Session> => {
    const s = await call(api.GET('/admin/auth/session'));
    setCsrfToken(s.csrfToken);
    return s;
  },
  staleTime: 60_000,
  retry: false,
};
export const useSession = () => useQuery(sessionQuery);
export const useAuthConfig = () => useQuery({ queryKey: ['auth-config'], queryFn: () => call(api.GET('/admin/auth/config')), staleTime: Infinity });

/** Mutation helper: toast on error, invalidate keys on success. */
function useAction<TVars, TData>(fn: (v: TVars) => Promise<TData>, opts: { invalidate?: QueryKey[]; success?: string | ((d: TData) => string) } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (d) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      const msg = typeof opts.success === 'function' ? opts.success(d) : opts.success;
      if (msg) toast.success(msg);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

// ---------------------------------------------------------------- dashboard
export const useSystemState = (enabled = true) =>
  useQuery({ queryKey: ['system'], queryFn: () => call(api.GET('/admin/stats/system')), refetchInterval: 10_000, enabled });

/** Mailpit link for the Messages page; only asked for by roles that may read bodies. */
export const useSandboxInbox = (enabled: boolean) =>
  useQuery({ queryKey: ['sandbox-inbox'], queryFn: () => call(api.GET('/admin/messages/sandbox-inbox')), refetchInterval: 30_000, enabled, retry: false });

export type QueuesOverview = Schemas['QueuesOverviewDto'];
export type QueueStatus = Schemas['QueueStatusDto'];
/** Live while the queues dialog is open. */
export const useQueues = (enabled: boolean) =>
  useQuery({ queryKey: ['queues'], queryFn: () => call(api.GET('/admin/queues')), refetchInterval: 5_000, enabled });

export const useStats = (q: { from?: string; to?: string; bucket?: 'hour' | 'day'; keyId?: string }) =>
  useQuery({
    queryKey: ['stats', q],
    queryFn: () => call(api.GET('/admin/stats/overview', { params: { query: q } })),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

export const usePauseGateway = () =>
  useAction((reason: string) => call(api.POST('/admin/gateway/pause', { body: { reason } })), { invalidate: [['system']], success: 'Gateway paused' });
export const useResumeGateway = () =>
  useAction(() => call(api.POST('/admin/gateway/resume')), { invalidate: [['system']], success: 'Gateway resumed' });

// ---------------------------------------------------------------- keys
export interface KeyListParams {
  q?: string;
  mode?: 'sandbox' | 'live' | 'approval';
  enabled?: boolean;
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'createdAt' | 'lastUsedAt';
  order?: 'asc' | 'desc';
}
export const useKeys = (q: KeyListParams) =>
  useQuery({ queryKey: ['keys', q], queryFn: () => call(api.GET('/admin/keys', { params: { query: q } })), placeholderData: keepPreviousData });
export const useKey = (id: string) => useQuery({ queryKey: ['keys', id], queryFn: () => call(api.GET('/admin/keys/{id}', { params: { path: { id } } })) });

export const useCreateKey = () =>
  useAction((body: Schemas['CreateKeyDto']) => call(api.POST('/admin/keys', { body })), { invalidate: [['keys']] });
export const useUpdateKey = (id: string) =>
  useAction((body: UpdateKey) => call(api.PATCH('/admin/keys/{id}', { params: { path: { id } }, body })), { invalidate: [['keys']], success: 'Policy saved' });
export const useRotateKey = (id: string) =>
  useAction((graceMinutes: number = 0) => call(api.POST('/admin/keys/{id}/rotate', { params: { path: { id } }, body: { graceMinutes } })), { invalidate: [['keys']] });
export const useDomainCheck = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: ['keys', id, 'domain-check'],
    queryFn: () => call(api.GET('/admin/keys/{id}/domain-check', { params: { path: { id } } })),
    enabled,
    retry: false,
    staleTime: 300_000,
  });
export const useSetKeyEnabled = (id: string) =>
  useAction(
    (enabled: boolean) =>
      enabled ? call(api.POST('/admin/keys/{id}/enable', { params: { path: { id } } })) : call(api.POST('/admin/keys/{id}/disable', { params: { path: { id } } })),
    { invalidate: [['keys']], success: (k) => (k.enabled ? 'Key enabled' : 'Key disabled') },
  );
export const useDeleteKey = (id: string) =>
  useAction(() => call(api.DELETE('/admin/keys/{id}', { params: { path: { id } } })), { invalidate: [['keys']], success: 'Key deleted' });
export const useTestSend = (id: string) =>
  useAction((body: Schemas['TestSendDto']) => call(api.POST('/admin/keys/{id}/test-send', { params: { path: { id } }, body })), {
    invalidate: [['messages'], ['keys']],
  });

// ---------------------------------------------------------------- messages
export interface MessageListParams {
  status?: string;
  keyId?: string;
  recipient?: string;
  subject?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  sort?: 'createdAt' | 'status' | 'subject';
  order?: 'asc' | 'desc';
}
export const useMessages = (q: MessageListParams, opts: { refetchInterval?: number } = {}) =>
  useQuery({
    queryKey: ['messages', q],
    queryFn: () => call(api.GET('/admin/messages', { params: { query: q } })),
    placeholderData: keepPreviousData,
    ...opts,
  });
export const useMessage = (id: string | undefined) =>
  useQuery({
    queryKey: ['messages', 'detail', id],
    queryFn: () => call(api.GET('/admin/messages/{id}', { params: { path: { id: id! } } })),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ['queued', 'pending_approval'].includes(q.state.data.status) ? 2000 : false),
  });
export const useApprove = () =>
  useAction((ids: string[]) => call(api.POST('/admin/messages/approve', { body: { ids } })), {
    invalidate: [['messages'], ['system']],
    success: (r) => `${r.results.filter((x) => x.ok).length} approved`,
  });
export const useReject = () =>
  useAction((v: { ids: string[]; reason?: string }) => call(api.POST('/admin/messages/reject', { body: v })), {
    invalidate: [['messages'], ['system']],
    success: (r) => `${r.results.filter((x) => x.ok).length} rejected`,
  });

// ---------------------------------------------------------------- users / audit / settings
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => call(api.GET('/admin/users')) });
export const useInviteUser = () => useAction((body: Schemas['InviteUserDto']) => call(api.POST('/admin/users', { body })), { invalidate: [['users'], ['roles']] });
export const useUpdateUser = () =>
  useAction((v: { id: string; body: Schemas['UpdateUserDto'] }) => call(api.PATCH('/admin/users/{id}', { params: { path: { id: v.id } }, body: v.body })), {
    invalidate: [['users'], ['roles'], ['session']],
    success: 'User updated',
  });
export const useResetTotp = () =>
  useAction((id: string) => call(api.POST('/admin/users/{id}/reset-2fa', { params: { path: { id } } })), { invalidate: [['users']], success: '2FA reset' });
export const useResetAccess = () => useAction((id: string) => call(api.POST('/admin/users/{id}/reset-access', { params: { path: { id } } })), { invalidate: [['users']] });
export const useDeleteUser = () =>
  useAction((id: string) => call(api.DELETE('/admin/users/{id}', { params: { path: { id } } })), { invalidate: [['users']], success: 'User deleted' });

export interface AuditParams {
  action?: string;
  actor?: string;
  actorType?: 'user' | 'token' | 'cli' | 'system';
  /** activity performed by this admin user */
  actorId?: string;
  /** activity performed on this API key */
  keyId?: string;
  outcome?: 'success' | 'failure';
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  order?: 'asc' | 'desc';
}
export const useAudit = (q: AuditParams) =>
  useQuery({ queryKey: ['audit', q], queryFn: () => call(api.GET('/admin/audit', { params: { query: q } })), placeholderData: keepPreviousData });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => call(api.GET('/admin/settings')), staleTime: 300_000 });
export type SandboxSettings = Schemas['SandboxSettingsDto'];
export const useSandboxSettings = () => useQuery({ queryKey: ['settings', 'sandbox'], queryFn: () => call(api.GET('/admin/settings/sandbox')) });
export const useUpdateSandboxSettings = () =>
  useAction((body: Schemas['UpdateSandboxSettingsDto']) => call(api.PUT('/admin/settings/sandbox', { body })), {
    invalidate: [['settings', 'sandbox'], ['sandbox-inbox']],
    success: 'Sandbox links saved',
  });

// ---------------------------------------------------------------- roles (RBAC)
export type RoleT = Schemas['RoleDto'];
export const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => call(api.GET('/admin/roles')) });
export const usePermissionCatalog = () =>
  useQuery({ queryKey: ['roles', 'catalog'], queryFn: () => call(api.GET('/admin/roles/permissions')), staleTime: Infinity });
export const useCreateRole = () =>
  useAction((body: Schemas['CreateRoleDto']) => call(api.POST('/admin/roles', { body })), { invalidate: [['roles'], ['users'], ['session']], success: 'Role created' });
export const useUpdateRole = () =>
  useAction((v: { id: string; body: Schemas['UpdateRoleDto'] }) => call(api.PATCH('/admin/roles/{id}', { params: { path: { id: v.id } }, body: v.body })), {
    invalidate: [['roles'], ['users'], ['session']],
    success: 'Role saved',
  });
export const useDeleteRole = () =>
  useAction((id: string) => call(api.DELETE('/admin/roles/{id}', { params: { path: { id } } })), { invalidate: [['roles'], ['users'], ['session']], success: 'Role deleted' });

export const useVerifyAudit = () => useMutation({ mutationFn: () => call(api.GET('/admin/audit/verify')), onError: (e) => toast.error(errorMessage(e)) });

// ---------------------------------------------------------------- templates
export type TemplateT = Schemas['TemplateDto'];
export const useTemplates = (enabled = true) => useQuery({ queryKey: ['templates'], queryFn: () => call(api.GET('/admin/templates')), enabled });
export const useCreateTemplate = () =>
  useAction((body: Schemas['CreateTemplateDto']) => call(api.POST('/admin/templates', { body })), { invalidate: [['templates']], success: 'Template created' });
export const useUpdateTemplate = () =>
  useAction((v: { id: string; body: Schemas['UpdateTemplateDto'] }) => call(api.PATCH('/admin/templates/{id}', { params: { path: { id: v.id } }, body: v.body })), {
    invalidate: [['templates'], ['keys']],
    success: 'Template saved',
  });
export const useDeleteTemplate = () =>
  useAction((id: string) => call(api.DELETE('/admin/templates/{id}', { params: { path: { id } } })), { invalidate: [['templates']], success: 'Template deleted' });
export const previewTemplate = (id: string, variables: Record<string, string>) =>
  call(api.POST('/admin/templates/{id}/preview', { params: { path: { id } }, body: { variables } }));

// ---------------------------------------------------------------- alerts
export type AlertChannelT = Schemas['AlertChannelDto'];
export const useAlertTypes = () => useQuery({ queryKey: ['alerts', 'types'], queryFn: () => call(api.GET('/admin/alerts/types')), staleTime: Infinity });
export const useAlertChannels = () => useQuery({ queryKey: ['alerts', 'channels'], queryFn: () => call(api.GET('/admin/alerts/channels')) });
export const useAlertEvents = (page: number) =>
  useQuery({
    queryKey: ['alerts', 'events', page],
    queryFn: () => call(api.GET('/admin/alerts/events', { params: { query: { page, pageSize: 25 } } })),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
export const useCreateAlertChannel = () =>
  useAction((body: Schemas['CreateAlertChannelDto']) => call(api.POST('/admin/alerts/channels', { body })), { invalidate: [['alerts']] });
export const useUpdateAlertChannel = () =>
  useAction((v: { id: string; body: Schemas['UpdateAlertChannelDto'] }) => call(api.PATCH('/admin/alerts/channels/{id}', { params: { path: { id: v.id } }, body: v.body })), {
    invalidate: [['alerts']],
    success: 'Channel saved',
  });
export const useDeleteAlertChannel = () =>
  useAction((id: string) => call(api.DELETE('/admin/alerts/channels/{id}', { params: { path: { id } } })), { invalidate: [['alerts']], success: 'Channel deleted' });
export const useTestAlertChannel = () =>
  useAction((id: string) => call(api.POST('/admin/alerts/channels/{id}/test', { params: { path: { id } } })), {
    invalidate: [['alerts']],
    success: 'Test alert queued',
  });

// ---------------------------------------------------------------- account security
export const useChangePassword = () =>
  useAction((body: { currentPassword: string; newPassword: string }) => call(api.POST('/admin/account/password', { body })), {
    invalidate: [['account', 'sessions']],
    success: (r) => `Password changed${r.otherSessionsRevoked ? `, ${r.otherSessionsRevoked} other session${r.otherSessionsRevoked === 1 ? '' : 's'} signed out` : ''}`,
  });
export const useAccountSessions = (enabled = true) => useQuery({ queryKey: ['account', 'sessions'], queryFn: () => call(api.GET('/admin/account/sessions')), enabled });
export const useRevokeSession = () =>
  useAction((id: string) => call(api.DELETE('/admin/account/sessions/{id}', { params: { path: { id } } })), { invalidate: [['account', 'sessions']], success: 'Session signed out' });
export const useRevokeOtherSessions = () =>
  useAction(() => call(api.POST('/admin/account/sessions/revoke-others')), {
    invalidate: [['account', 'sessions']],
    success: (r) => `${r.revoked} session${r.revoked === 1 ? '' : 's'} signed out`,
  });
export const usePasskeys = (enabled = true) => useQuery({ queryKey: ['account', 'passkeys'], queryFn: () => call(api.GET('/admin/account/passkeys')), enabled });
export const useRemovePasskey = () =>
  useAction((id: string) => call(api.DELETE('/admin/account/passkeys/{id}', { params: { path: { id } } })), { invalidate: [['account', 'passkeys']], success: 'Passkey removed' });

/** Name lookups for filter chips (optional, permission-dependent). */
export const useUsersLookup = (enabled: boolean) => useQuery({ queryKey: ['users'], queryFn: () => call(api.GET('/admin/users')), enabled });
export const useKeyLookup = (id: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: ['keys', id], queryFn: () => call(api.GET('/admin/keys/{id}', { params: { path: { id: id! } } })), enabled: !!id && enabled, retry: false });
