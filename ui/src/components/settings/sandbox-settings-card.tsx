// Authored by Tomás Neto (TN 2026)
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSandboxInbox, useSandboxSettings, useUpdateSandboxSettings } from '@/api/queries';
import { Signal } from '@/components/common/badges';
import { Field, KV } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useMe } from '@/lib/auth';
import { fmtAgo, fmtNum } from '@/lib/format';

/** Same rule as the server: empty, or a full http(s) URL. Saves a round trip for typos. */
export function urlProblem(v: string): string | undefined {
  const t = v.trim();
  if (!t) return undefined;
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Use an http:// or https:// URL';
    if (u.username || u.password) return 'Leave credentials out; the browser asks for them';
    return undefined;
  } catch {
    return 'Enter a full URL, e.g. https://mailpit.example.com';
  }
}

/**
 * Mailpit links for "Sandbox Messages" on the Messages page. Stored by the gateway (not the
 * environment), so the link is whatever the team actually opens: a host name, a reverse proxy path.
 */
export function SandboxSettingsCard({ mailpitSmtp }: { mailpitSmtp: string }) {
  const { can } = useMe();
  const canEdit = can('settings:manage');
  const { data: s } = useSandboxSettings();
  const inbox = useSandboxInbox(can('messages:bodies'));
  const save = useUpdateSandboxSettings();
  const [uiUrl, setUiUrl] = useState('');
  const [apiUrl, setApiUrl] = useState('');

  useEffect(() => {
    if (!s) return;
    setUiUrl(s.uiUrl ?? '');
    setApiUrl(s.apiUrl ?? '');
  }, [s]);

  const uiErr = urlProblem(uiUrl);
  const apiErr = urlProblem(apiUrl);
  const dirty = !!s && (uiUrl.trim() !== (s.uiUrl ?? '') || apiUrl.trim() !== (s.apiUrl ?? ''));
  const status = inbox.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sandbox</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <KV
          items={[
            ['Mailpit SMTP', <span className="font-mono text-xs">{mailpitSmtp}</span>],
            [
              'Mailpit link',
              !s?.uiUrl ? (
                <span className="text-muted-foreground">not set: no Sandbox Messages button</span>
              ) : status && status.url === s.uiUrl ? (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Signal tone={status.available ? 'green' : 'red'}>{status.available ? 'answering' : 'not answering'}</Signal>
                  {status.messages !== null && <span className="text-muted-foreground tabular font-mono text-xs">{fmtNum(status.messages)} messages</span>}
                </span>
              ) : (
                <span className="text-secondary-foreground">set</span>
              ),
            ],
          ]}
        />
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (uiErr || apiErr || !dirty) return;
            save.mutate({ uiUrl: uiUrl.trim() || null, apiUrl: apiUrl.trim() || null });
          }}
        >
          <Field label="Mailpit URL" htmlFor="sandbox-ui-url" error={uiErr} hint="What the browser opens from Messages → Sandbox Messages. Empty hides the button">
            <div className="flex gap-2">
              <Input
                id="sandbox-ui-url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://mailpit.example.com"
                value={uiUrl}
                onChange={(e) => setUiUrl(e.target.value)}
                disabled={!canEdit || !s}
                aria-invalid={!!uiErr}
                className="font-mono text-xs"
              />
              {s?.uiUrl && (
                <Button type="button" variant="outline" size="icon" asChild>
                  <a href={s.uiUrl} target="_blank" rel="noreferrer noopener" aria-label="Open Mailpit" title="Open Mailpit">
                    <ExternalLink className="size-4" />
                  </a>
                </Button>
              )}
            </div>
          </Field>
          <Field
            label="Health check URL"
            htmlFor="sandbox-api-url"
            error={apiErr}
            hint={
              <>
                Mailpit as the gateway reaches it, inside the network. Empty uses <span className="font-mono">{s?.defaultApiUrl ?? 'http://mailpit:8025'}</span>
              </>
            }
          >
            <Input
              id="sandbox-api-url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={s?.defaultApiUrl ?? 'http://mailpit:8025'}
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              disabled={!canEdit || !s}
              aria-invalid={!!apiErr}
              className="font-mono text-xs"
            />
          </Field>
          {canEdit ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground text-xs">{s?.updatedAt ? `Changed ${fmtAgo(s.updatedAt)}${s.updatedBy ? ` by ${s.updatedBy}` : ''}` : ''}</span>
              <Button type="submit" size="sm" disabled={!dirty || !!uiErr || !!apiErr || save.isPending}>
                Save
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">Only roles with settings:manage can change these links</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
