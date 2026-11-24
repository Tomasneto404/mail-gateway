// Authored by Tomás Neto (TN 2026)
import { useSettings } from '@/api/queries';
import { Signal } from '@/components/common/badges';
import { KV, PageHeader } from '@/components/common/page';
import { SandboxSettingsCard } from '@/components/settings/sandbox-settings-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtBytes } from '@/lib/format';

const onOff = (b: boolean) => (
  <Signal tone={b ? 'green' : 'gray'} hollow={!b} className={b ? undefined : 'text-secondary-foreground'}>
    {b ? 'enabled' : 'disabled'}
  </Signal>
);

export function SettingsPage() {
  const { data: s } = useSettings();
  return (
    <>
      <PageHeader title="Settings" description="Effective configuration. The sandbox links are edited here; everything else comes from environment variables. Secrets are never shown" />
      {!s ? (
        <div className="px-4 sm:px-8 py-6">
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <div className="grid w-full max-w-[1440px] gap-4 px-4 sm:px-8 py-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Live delivery</CardTitle>
            </CardHeader>
            <CardContent>
              <KV
                items={[
                  ['Default provider', <span className="font-mono text-xs">{s.liveProvider}</span>],
                  ['SMTP', onOff(s.smtp.enabled)],
                  ['SMTP target', s.smtp.host ? <span className="font-mono text-xs">{`${s.smtp.host}:${s.smtp.port}`}</span> : '—'],
                  ['TLS', s.smtp.secure ? 'implicit TLS' : s.smtp.requireTls ? 'STARTTLS required' : 'opportunistic'],
                  ['SMTP auth', s.smtp.authConfigured ? 'configured (password hidden)' : 'none'],
                  ['Resend', onOff(s.resend.enabled)],
                  ['Resend webhook', onOff(s.resend.webhookConfigured)],
                  [
                    'System email (invites)',
                    s.systemMail.enabled ? (
                      <span className="text-xs">
                        <Signal tone="green">enabled</Signal> {s.systemMail.from} via {s.systemMail.provider}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">off: set SYSTEM_MAIL_FROM</span>
                    ),
                  ],
                ]}
              />
            </CardContent>
          </Card>
          <SandboxSettingsCard mailpitSmtp={s.mailpitSmtp} />
          <Card>
            <CardHeader>
              <CardTitle>Guardrails</CardTitle>
            </CardHeader>
            <CardContent>
              <KV
                items={[
                  ['Global delivery rate', `${s.globalRateMax} / ${s.globalRateDurationMs} ms`],
                  ['Global accept cap', `${s.globalAcceptPerHour} / hour`],
                  ['Dedup window', `${s.dedupWindowSeconds} s`],
                  ['Idempotency window', `${s.idempotencyTtlSeconds / 3600} h`],
                  ['Delivery attempts', String(s.deliveryMaxAttempts)],
                  ['Circuit breaker', `${s.breakerConsecutiveFailures} consecutive or ≥${Math.round(s.breakerFailureRate * 100)}% in ${s.breakerWindowSeconds}s`],
                  ['Max request', fmtBytes(s.maxRequestBytes)],
                  ['Trust proxy', <span className="font-mono text-xs">{s.trustProxy}</span>],
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Retention & access</CardTitle>
            </CardHeader>
            <CardContent>
              <KV
                items={[
                  ['Message bodies', `${s.bodyRetentionDays} days`],
                  ['Audit records', `${s.recordRetentionDays} days`],
                  ['Retention job', <span className="font-mono text-xs">{s.retentionCron} (UTC)</span>],
                  ['Local login', onOff(s.localLogin)],
                  ['Two-factor (TOTP)', s.totpRequired ? 'required for local users' : 'optional, per user'],
                  ['Static admin token', onOff(s.adminTokenEnabled)],
                  ['Session', `${s.sessionTtlHours} h max · ${s.sessionIdleMinutes} min idle`],
                  ['Authentik SSO', onOff(s.authentik.enabled)],
                  ...(s.authentik.enabled
                    ? ([
                        ['Issuer', <span className="font-mono text-xs">{s.authentik.issuer}</span>],
                        ['Groups claim', <span className="font-mono text-xs">{s.authentik.groupsClaim}</span>],
                        ['Group → role mapping', <span className="text-xs">configured per role on the Roles page</span>],
                      ] as Array<[string, React.ReactNode]>)
                    : []),
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Volume and reputation</CardTitle>
            </CardHeader>
            <CardContent>
              <KV
                items={[
                  [
                    'Per-domain caps',
                    s.recipientDomainLimits.length ? (
                      <span className="font-mono text-xs">{s.recipientDomainLimits.map((d) => `${d.domain} ${d.perHour}/h`).join(' · ')}</span>
                    ) : (
                      'none'
                    ),
                  ],
                  ['Warm-up', s.warmupSchedule.length ? <span className="font-mono text-xs">{s.warmupSchedule.join(' → ')} per day</span> : 'off'],
                  ['Sender domain checks', <span className="font-mono text-xs">{s.senderDomainChecks}</span>],
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Content and records</CardTitle>
            </CardHeader>
            <CardContent>
              <KV
                items={[
                  ['Virus scanner', s.clamav ? <span className="font-mono text-xs">{s.clamav}</span> : 'not configured'],
                  ['Bodies at rest', s.bodiesEncrypted ? 'encrypted (AES-256-GCM)' : <span className="text-warning-foreground">not encrypted: set APP_ENCRYPTION_KEY</span>],
                  ['Activity log chain', s.auditChainKeyed ? 'HMAC-signed' : 'SHA-256 (set APP_ENCRYPTION_KEY to sign)'],
                  [
                    'Alert rules',
                    <span className="text-xs">
                      {s.alertRules.rejectionSpike} rejections or {s.alertRules.failureSpike} failures in {s.alertRules.spikeWindowMinutes} min · quota at {s.alertRules.quotaPercent}% · approvals waiting{' '}
                      {s.alertRules.approvalWaitMinutes} min · keys expiring in {s.alertRules.keyExpiryDays} days · repeated at most every {s.alertRules.cooldownMinutes} min
                    </span>,
                  ],
                ]}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
