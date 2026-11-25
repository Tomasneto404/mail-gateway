// Authored by Tomás Neto (TN 2026)
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { KeyPolicy, UpdateKey } from '@/api/queries';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { Field, Callout } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { fmtBytes } from '@/lib/format';
import { HOST_RE, MIME_RE, isIpRule, policySchema, type PolicyForm } from '@/lib/schemas';
import { cn } from '@/lib/utils';
import { ChipsInput } from './chips-input';
import { RecipientChipsInput } from './recipient-chips';
import { Segmented } from './segmented';

export function toForm(k: KeyPolicy): PolicyForm {
  return {
    description: k.description,
    mode: k.mode,
    fromAddress: k.fromAddress,
    fromName: k.fromName ?? '',
    allowReplyTo: k.allowReplyTo,
    allowedRecipients: k.allowedRecipients,
    maxRecipientsPerMessage: k.maxRecipientsPerMessage,
    maxMessageBytes: k.maxMessageBytes,
    quotaPerHour: k.quotaPerHour,
    quotaPerDay: k.quotaPerDay,
    attachmentsAllowed: k.attachmentsAllowed,
    maxAttachmentBytes: k.maxAttachmentBytes,
    liveProvider: k.liveProvider ?? 'default',
    allowedIps: k.allowedIps ?? [],
    expiresAt: k.expiresAt ? toLocalInput(k.expiresAt) : '',
    allowedLinkDomains: k.allowedLinkDomains ?? [],
    maxLinks: k.maxLinks ?? null,
    blockSecrets: k.blockSecrets ?? true,
    allowedAttachmentTypes: k.allowedAttachmentTypes ?? [],
    scanAttachments: k.scanAttachments ?? false,
    allowDuplicates: k.allowDuplicates ?? false,
    templatesOnly: k.templatesOnly ?? false,
    allowedTemplates: k.allowedTemplates ?? [],
    warmup: k.warmup ?? true,
  };
}

/** ISO → value for <input type="datetime-local"> in the browser's time zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Only the fields that changed, in API shape. */
export function diffPolicy(before: PolicyForm, after: PolicyForm): UpdateKey {
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(after) as Array<keyof PolicyForm>) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    if (k === 'liveProvider') patch.liveProvider = after.liveProvider === 'default' ? null : after.liveProvider;
    else if (k === 'fromName') patch.fromName = after.fromName || null;
    else if (k === 'expiresAt') patch.expiresAt = after.expiresAt ? new Date(after.expiresAt).toISOString() : null;
    else patch[k] = after[k];
  }
  return patch as UpdateKey;
}

const ipProblem = (v: string) => (isIpRule(v) ? null : 'use an IP address or a CIDR range like 10.0.0.0/24');
const hostProblem = (v: string) => (HOST_RE.test(v) ? null : 'use a domain like example.com (subdomains are included)');
const mimeProblem = (v: string) => (MIME_RE.test(v) ? null : 'use a MIME type like application/pdf or image/*');


const MODE_HINT: Record<PolicyForm['mode'], string> = {
  sandbox: 'Captured by Mailpit, never reaches real recipients',
  approval: 'Held until an administrator approves, then delivered live',
  live: 'Delivered to real recipients through the live provider',
};

/** Titled form section: a two-column grid (one column when `single`). */
function Section({ title, children, single }: { title: string; children: React.ReactNode; single?: boolean }) {
  return (
    <section className="grid gap-4">
      <h3 className="text-secondary-foreground border-b pb-2 text-sm font-medium">{title}</h3>
      <div className={single ? 'grid gap-2' : 'grid items-start gap-x-6 gap-y-4 sm:grid-cols-2'}>{children}</div>
    </section>
  );
}

function ToggleCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <label className="relative flex h-full min-h-16 items-center justify-between gap-4 rounded-lg border px-4 py-3">
      <span className="grid gap-0.5">
        <span className="text-sm leading-5 font-medium">{title}</span>
        <span className="text-muted-foreground text-xs leading-4">{description}</span>
      </span>
      {children}
    </label>
  );
}

interface Props {
  policy: KeyPolicy;
  readOnly?: boolean;
  /** keys:update — edit everything except leaving sandbox (default true) */
  canUpdate?: boolean;
  /** keys:promote — switch mode to live/approval (default true) */
  canPromote?: boolean;
  onSave: (patch: UpdateKey) => Promise<unknown>;
  providers?: { smtp: boolean; resend: boolean };
  /** template names to choose from (undefined when the user cannot list them) */
  templates?: string[];
  /** ClamAV address when configured */
  clamav?: string | null;
}

const num = { setValueAs: (v: string) => (v === '' ? undefined : Number(v)) };

export function PolicyEditor({ policy, readOnly, onSave, providers, templates, clamav, canUpdate = true, canPromote = true }: Props) {
  const initial = toForm(policy);
  const form = useForm<PolicyForm>({ resolver: zodResolver(policySchema), defaultValues: initial, mode: 'onBlur' });
  const { register, control, handleSubmit, watch, reset, formState } = form;
  const [pending, setPending] = useState<UpdateKey | null>(null);

  useEffect(() => reset(toForm(policy)), [policy, reset]);

  const mode = watch('mode');
  const promoting = mode === 'live' && policy.mode !== 'live';
  const e = formState.errors;

  const submit = handleSubmit(async (values) => {
    const patch = diffPolicy(toForm(policy), values);
    if (!Object.keys(patch).length) return;
    if (patch.mode === 'live') setPending(patch);
    else await onSave(patch);
  });

  return (
    <form onSubmit={submit} className="grid gap-8" aria-label="Policy editor">
      <fieldset disabled={readOnly} className="grid gap-8">
        {!readOnly && (!canUpdate || !canPromote) && (
          <p className="text-muted-foreground -mb-4 text-xs">
            {!canUpdate ? 'Your roles only allow changing the delivery mode.' : 'Your roles do not allow promoting this key out of sandbox (keys:promote).'}
          </p>
        )}
        <Section title="Delivery">
          <Field label="Mode" hint={MODE_HINT[mode]}>
            <Controller
              control={control}
              name="mode"
              render={({ field }) => (
                <Segmented
                  label="Mode"
                  value={field.value}
                  onChange={field.onChange}
                  disabled={readOnly}
                  options={[
                    { value: 'sandbox', label: 'Sandbox', disabled: !canUpdate },
                    { value: 'approval', label: 'Approval', disabled: !canPromote },
                    { value: 'live', label: 'Live', disabled: !canPromote },
                  ]}
                />
              )}
            />
          </Field>
          <Field label="Live provider" hint="Delivers live and approved messages for this key">
            <Controller
              control={control}
              name="liveProvider"
              render={({ field }) => (
                <Segmented
                  label="Live provider"
                  value={field.value}
                  onChange={field.onChange}
                  disabled={readOnly || !canUpdate}
                  options={[
                    { value: 'default', label: 'Default' },
                    { value: 'smtp', label: `SMTP${providers && !providers.smtp ? ' (off)' : ''}` },
                    { value: 'resend', label: `Resend${providers && !providers.resend ? ' (off)' : ''}` },
                  ]}
                />
              )}
            />
          </Field>
          {promoting && (
            <Callout role="alert" tone="warn" icon={<AlertTriangle />} className="sm:col-span-2">
              <div className="font-medium">Promoting to live</div>
              <p className="text-secondary-foreground">
                Every message sent with this key will be delivered to real inboxes using the gateway&apos;s sender reputation. Make sure the allow-list and quotas are tight.
              </p>
            </Callout>
          )}
        </Section>

        <fieldset disabled={readOnly || !canUpdate} className="contents">
        <Section title="Sender">
          <Field label="From address" htmlFor="fromAddress" error={e.fromAddress?.message} hint="Fixed; clients cannot override it">
            <Input id="fromAddress" {...register('fromAddress')} aria-invalid={!!e.fromAddress} />
          </Field>
          <Field label="From name" htmlFor="fromName" error={e.fromName?.message} hint="Optional display name">
            <Input id="fromName" {...register('fromName')} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description" htmlFor="description">
              <Textarea id="description" rows={2} className="min-h-16" {...register('description')} />
            </Field>
          </div>
        </Section>

        <Section title="Allowed recipients" single>
          <Controller
            control={control}
            name="allowedRecipients"
            render={({ field }) => <RecipientChipsInput id="allowedRecipients" value={field.value} onChange={field.onChange} disabled={readOnly || !canUpdate} />}
          />
          <p className="text-muted-foreground text-xs leading-4">Every to/cc/bcc address must match one entry. &quot;@example.com&quot; matches that exact domain only.</p>
        </Section>

        <Section title="Access">
          <div className="sm:col-span-2">
            <Field label="Allowed source IPs" htmlFor="allowedIps" hint="Requests from other addresses are refused (IP_NOT_ALLOWED). Empty = any">
              <Controller
                control={control}
                name="allowedIps"
                render={({ field }) => (
                  <ChipsInput id="allowedIps" label="Add allowed IP" placeholder="10.0.0.0/24 or 2001:db8::/32" value={field.value} onChange={field.onChange} validate={ipProblem} disabled={readOnly || !canUpdate} />
                )}
              />
            </Field>
          </div>
          <Field label="Expires" htmlFor="expiresAt" hint={watch('expiresAt') ? 'The key stops working at this time (your time zone)' : 'Never'}>
            <Input id="expiresAt" type="datetime-local" {...register('expiresAt')} />
          </Field>
        </Section>

        <Section title="Limits">
          <Field label="Quota per hour" htmlFor="quotaPerHour" error={e.quotaPerHour?.message} hint="Messages per UTC hour">
            <Input id="quotaPerHour" type="number" min={0} {...register('quotaPerHour', num)} />
          </Field>
          <Field
            label="Quota per day"
            htmlFor="quotaPerDay"
            error={e.quotaPerDay?.message}
            hint={policy.warmupState ? `Warming up: day ${policy.warmupState.day} of ${policy.warmupState.days}, capped at ${policy.warmupState.dailyCap} today` : 'Messages per UTC day'}
          >
            <Input id="quotaPerDay" type="number" min={0} {...register('quotaPerDay', num)} />
          </Field>
          <Field label="Max recipients per message" htmlFor="maxRecipientsPerMessage" error={e.maxRecipientsPerMessage?.message} hint="to + cc + bcc">
            <Input id="maxRecipientsPerMessage" type="number" min={1} {...register('maxRecipientsPerMessage', num)} />
          </Field>
          <Field label="Max message size (bytes)" htmlFor="maxMessageBytes" error={e.maxMessageBytes?.message} hint={fmtBytes(watch('maxMessageBytes') || 0)}>
            <Input id="maxMessageBytes" type="number" min={1} {...register('maxMessageBytes', num)} />
          </Field>
        </Section>

        <Section title="Options">
          <ToggleCard title="Allow Reply-To" description="Clients may set replyTo">
            <Controller control={control} name="allowReplyTo" render={({ field }) => <Switch aria-label="Allow Reply-To" checked={field.value} onCheckedChange={field.onChange} />} />
          </ToggleCard>
          <ToggleCard title="Allow attachments" description="Base64 attachments up to the size limit">
            <Controller
              control={control}
              name="attachmentsAllowed"
              render={({ field }) => <Switch aria-label="Allow attachments" checked={field.value} onCheckedChange={field.onChange} />}
            />
          </ToggleCard>
          {watch('attachmentsAllowed') && (
            <Field label="Max attachment size (bytes)" htmlFor="maxAttachmentBytes" error={e.maxAttachmentBytes?.message} hint={fmtBytes(watch('maxAttachmentBytes') || 0)}>
              <Input id="maxAttachmentBytes" type="number" min={0} {...register('maxAttachmentBytes', num)} />
            </Field>
          )}
          <ToggleCard title="Warm-up" description="Ramp the daily volume up over the first days out of sandbox">
            <Controller control={control} name="warmup" render={({ field }) => <Switch aria-label="Warm-up" checked={field.value} onCheckedChange={field.onChange} />} />
          </ToggleCard>
          <ToggleCard title="Allow repeated messages" description="Accept identical messages instead of rejecting them as a loop; quotas still apply">
            <Controller
              control={control}
              name="allowDuplicates"
              render={({ field }) => <Switch aria-label="Allow repeated messages" checked={field.value} onCheckedChange={field.onChange} />}
            />
          </ToggleCard>
        </Section>

        <Section title="Content">
          <div className="sm:col-span-2">
            <Field label="Allowed link domains" htmlFor="allowedLinkDomains" hint="Links in the body must point here; subdomains included. Empty = any">
              <Controller
                control={control}
                name="allowedLinkDomains"
                render={({ field }) => (
                  <ChipsInput id="allowedLinkDomains" label="Add link domain" placeholder="example.com" value={field.value} onChange={field.onChange} validate={hostProblem} disabled={readOnly || !canUpdate} />
                )}
              />
            </Field>
          </div>
          <Field label="Max links per message" htmlFor="maxLinks" error={e.maxLinks?.message} hint="Empty = unlimited">
            <Input id="maxLinks" type="number" min={0} placeholder="Unlimited" {...register('maxLinks', { setValueAs: (v: string) => (v === '' || v === null ? null : Number(v)) })} />
          </Field>
          <ToggleCard title="Block secrets" description="Refuse credentials, private keys, card and bank numbers">
            <Controller control={control} name="blockSecrets" render={({ field }) => <Switch aria-label="Block secrets" checked={field.value} onCheckedChange={field.onChange} />} />
          </ToggleCard>
          {watch('attachmentsAllowed') && (
            <>
              <div className="sm:col-span-2">
                <Field label="Allowed attachment types" htmlFor="allowedAttachmentTypes" hint="Content is checked against the type; executables are always refused. Empty = any">
                  <Controller
                    control={control}
                    name="allowedAttachmentTypes"
                    render={({ field }) => (
                      <ChipsInput
                        id="allowedAttachmentTypes"
                        label="Add attachment type"
                        placeholder="application/pdf, image/*"
                        value={field.value}
                        onChange={field.onChange}
                        validate={mimeProblem}
                        disabled={readOnly || !canUpdate}
                      />
                    )}
                  />
                </Field>
              </div>
              <ToggleCard title="Virus scan" description={clamav ? `Scanned by ClamAV (${clamav})` : 'Needs CLAMAV_HOST on the gateway; attachments are refused without it'}>
                <Controller control={control} name="scanAttachments" render={({ field }) => <Switch aria-label="Virus scan" checked={field.value} onCheckedChange={field.onChange} />} />
              </ToggleCard>
            </>
          )}
        </Section>

        <Section title="Templates">
          <ToggleCard title="Templates only" description="Refuse free-form subject and body; clients send a template and its variables">
            <Controller control={control} name="templatesOnly" render={({ field }) => <Switch aria-label="Templates only" checked={field.value} onCheckedChange={field.onChange} />} />
          </ToggleCard>
          <Field label="Allowed templates" hint={templates ? 'None selected = any template' : 'Needs templates:read to list them'}>
            <Controller
              control={control}
              name="allowedTemplates"
              render={({ field }) => (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Allowed templates">
                  {[...new Set([...(templates ?? []), ...field.value])].map((name) => {
                    const on = field.value.includes(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        aria-pressed={on}
                        disabled={readOnly || !canUpdate}
                        onClick={() => field.onChange(on ? field.value.filter((x) => x !== name) : [...field.value, name])}
                        className={cn(
                          'h-7 rounded-md border px-2 font-mono text-xs transition-colors',
                          on ? 'bg-card border-input text-foreground shadow-[var(--shadow-sm)]' : 'text-secondary-foreground hover:text-foreground border-dashed',
                        )}
                      >
                        {name}
                      </button>
                    );
                  })}
                  {!templates?.length && !field.value.length && <span className="text-muted-foreground text-sm">No templates yet</span>}
                </div>
              )}
            />
          </Field>
        </Section>
        </fieldset>
      </fieldset>

      {!readOnly && (
        <div className="bg-card sticky bottom-0 -mx-6 -mb-6 flex items-center justify-end gap-2 rounded-b-xl border-t px-6 py-3">
          <Button type="button" variant="ghost" disabled={!formState.isDirty} onClick={() => reset(toForm(policy))}>
            Discard
          </Button>
          <Button type="submit" disabled={!formState.isDirty || formState.isSubmitting}>
            Save policy
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Promote "${policy.name}" to live?`}
        description="Messages will be delivered to real recipients immediately. This is recorded in the activity log."
        confirmLabel="Promote to live"
        destructive
        onConfirm={async () => {
          if (pending) await onSave(pending);
          setPending(null);
        }}
      />
    </form>
  );
}
