// Authored by Tomás Neto (TN 2026)
/**
 * RBAC permission catalog. Roles hold a list of these ids; "*" grants everything and
 * "<area>:*" grants every permission of an area. A user's effective permissions are the
 * union of the permissions of all their roles.
 */
export const PERMISSIONS = [
  { id: 'dashboard:read', area: 'dashboard', label: 'View dashboard, statistics and system state' },
  { id: 'keys:read', area: 'keys', label: 'View API keys and their policies' },
  { id: 'keys:create', area: 'keys', label: 'Create API keys' },
  { id: 'keys:update', area: 'keys', label: 'Edit key policies (except promoting to live)' },
  { id: 'keys:promote', area: 'keys', label: 'Change key mode to live or approval' },
  { id: 'keys:rotate', area: 'keys', label: 'Rotate key secrets' },
  { id: 'keys:disable', area: 'keys', label: 'Enable / disable keys (kill switch)' },
  { id: 'keys:delete', area: 'keys', label: 'Delete keys' },
  { id: 'keys:test_send', area: 'keys', label: 'Send test emails with a key' },
  { id: 'messages:read', area: 'messages', label: 'Search messages and view metadata' },
  { id: 'messages:bodies', area: 'messages', label: 'View message bodies and HTML previews' },
  { id: 'approvals:decide', area: 'approvals', label: 'Approve / reject pending messages' },
  { id: 'gateway:pause', area: 'gateway', label: 'Pause and resume the gateway' },
  { id: 'users:read', area: 'users', label: 'View admin users and roles' },
  { id: 'users:manage', area: 'users', label: 'Invite, edit, disable and delete users; assign roles' },
  { id: 'roles:manage', area: 'roles', label: 'Create, edit and delete roles' },
  { id: 'templates:read', area: 'templates', label: 'View message templates' },
  { id: 'templates:manage', area: 'templates', label: 'Create, edit and delete message templates' },
  { id: 'alerts:read', area: 'alerts', label: 'View alert channels and alert history' },
  { id: 'alerts:manage', area: 'alerts', label: 'Create, edit, test and delete alert channels' },
  { id: 'audit:read', area: 'audit', label: 'View the activity log and verify its integrity' },
  { id: 'settings:read', area: 'settings', label: 'View the effective configuration' },
  { id: 'settings:manage', area: 'settings', label: 'Change settings editable in the UI (sandbox inbox link)' },
] as const;

export type PermissionId = (typeof PERMISSIONS)[number]['id'];
export const ALL = '*';

const KNOWN = new Set<string>(PERMISSIONS.map((p) => p.id));
const AREAS = new Set<string>(PERMISSIONS.map((p) => p.area));

/** Valid entries: "*", a known permission id, or "<known area>:*". */
export function isValidPermission(p: string): boolean {
  if (p === ALL || KNOWN.has(p)) return true;
  const m = /^([a-z_]+):\*$/.exec(p);
  return !!m && AREAS.has(m[1]);
}

/** Does a granted set satisfy one needed permission? */
export function hasPermission(granted: Iterable<string>, needed: string): boolean {
  const g = granted instanceof Set ? (granted as Set<string>) : new Set(granted);
  if (g.has(ALL) || g.has(needed)) return true;
  const area = needed.split(':')[0];
  if (needed.endsWith(':*')) return false; // an area wildcard is only covered by "*" or itself
  return g.has(`${area}:*`);
}

/**
 * Anti-escalation: may a holder of `granted` hand out `requested`?
 * Every requested entry must be covered (wildcards only by equal-or-broader wildcards).
 */
export function covers(granted: Iterable<string>, requested: Iterable<string>): boolean {
  const g = new Set(granted);
  if (g.has(ALL)) return true;
  for (const r of requested) {
    if (r === ALL) return false;
    if (!hasPermission(g, r)) return false;
  }
  return true;
}

export function effectivePermissions(roles: Array<{ permissions: string[] }>): string[] {
  const set = new Set<string>();
  for (const r of roles) for (const p of r.permissions) set.add(p);
  return set.has(ALL) ? [ALL] : [...set].sort();
}

/** Built-in roles seeded by the RBAC migration (names are stable identifiers). */
export const ADMIN_ROLE = 'Admin';
export const BUILTIN_ROLE_NAMES = [ADMIN_ROLE, 'Operator', 'Approver', 'Auditor', 'Viewer', 'Body reader'] as const;
