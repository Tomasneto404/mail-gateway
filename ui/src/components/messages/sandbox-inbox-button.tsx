// Authored by Tomás Neto (TN 2026)
import { ExternalLink } from 'lucide-react';
import { useSandboxInbox } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/auth';
import { fmtNum } from '@/lib/format';

/**
 * Opens Mailpit, where sandbox keys deliver. Shown only when a Mailpit link is set (Settings → Sandbox) and to roles
 * with messages:bodies (Mailpit shows full bodies without the gateway's access control). Disabled
 * while Mailpit does not answer.
 */
export function SandboxInboxButton() {
  const { can } = useMe();
  const allowed = can('messages:bodies');
  const q = useSandboxInbox(allowed);
  const s = q.data;
  if (!allowed || !s?.configured || !s.url) return null;

  const count = s.messages !== null ? <span className="text-muted-foreground tabular font-mono text-xs">{fmtNum(s.messages)}</span> : null;
  if (!s.available) {
    return (
      <span title="Mailpit is not answering. Is the mailpit service running?" data-testid="sandbox-inbox">
        <Button size="sm" variant="outline" disabled>
          <ExternalLink className="size-4" /> Sandbox Messages
        </Button>
      </span>
    );
  }
  return (
    <Button size="sm" variant="outline" asChild data-testid="sandbox-inbox">
      <a href={s.url} target="_blank" rel="noreferrer noopener" title="Open Mailpit, the inbox of sandbox keys, in a new tab">
        <ExternalLink className="size-4" /> Sandbox Messages {count}
      </a>
    </Button>
  );
}
