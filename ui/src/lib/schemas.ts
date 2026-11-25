// Authored by Tomás Neto (TN 2026)
import { z } from 'zod';

/** Mirrors the backend validators (src/common/validators.ts). */
export const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export const DOMAIN_RULE_RE = /^@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export const isEmail = (v: string) => EMAIL_RE.test(v) && !v.includes('..') && v.length <= 254;
/** "*" in an allow-list matches every recipient. */
export const ANY_RECIPIENT = '*';
export const isRecipientRule = (v: string) => v === ANY_RECIPIENT || isEmail(v) || DOMAIN_RULE_RE.test(v);

export const HOST_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export const MIME_RE = /^[\w.+-]+\/(?:\*|[\w.+-]+)$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:]+(?:%\w+)?$/i;
/** "10.0.0.5", "10.0.0.0/24", "2001:db8::/32" (the server validates precisely). */
export function isIpRule(v: string): boolean {
  const [addr, bits, extra] = v.split('/');
  if (extra !== undefined) return false;
  const v4 = IPV4.test(addr);
  const v6 = !v4 && addr.includes(':') && IPV6.test(addr);
  if (!v4 && !v6) return false;
  if (bits === undefined) return true;
  return /^\d{1,3}$/.test(bits) && Number(bits) <= (v4 ? 32 : 128);
}

const noCrlf = (v: string) => !/[\r\n]/.test(v);
const MB = 1024 * 1024;
const int = (min: number, max: number) =>
  z
    .number({ message: 'Required' })
    .int('Whole numbers only')
    .min(min, `Must be ${min} or more`)
    .max(max, `Must be at most ${max.toLocaleString()}`);

export const policySchema = z.object({
  description: z.string().max(500),
  mode: z.enum(['sandbox', 'live', 'approval']),
  fromAddress: z.string().trim().toLowerCase().refine(isEmail, 'Enter a plain email address'),
  fromName: z.string().max(100).refine(noCrlf, 'No line breaks'),
  allowReplyTo: z.boolean(),
  allowedRecipients: z.array(z.string().refine(isRecipientRule, 'Invalid entry')).max(500),
  maxRecipientsPerMessage: int(1, 1000),
  maxMessageBytes: int(1, 50 * MB),
  quotaPerHour: int(0, 1_000_000),
  quotaPerDay: int(0, 10_000_000),
  attachmentsAllowed: z.boolean(),
  maxAttachmentBytes: int(0, 40 * MB),
  liveProvider: z.enum(['default', 'smtp', 'resend']),
  allowedIps: z.array(z.string().refine(isIpRule, 'Invalid IP or range')).max(100),
  /** datetime-local value ("" = never) */
  expiresAt: z.string(),
  allowedLinkDomains: z.array(z.string().refine((v) => HOST_RE.test(v), 'Invalid domain')).max(200),
  maxLinks: int(0, 1000).nullable(),
  blockSecrets: z.boolean(),
  allowedAttachmentTypes: z.array(z.string().refine((v) => MIME_RE.test(v), 'Invalid type')).max(50),
  scanAttachments: z.boolean(),
  allowDuplicates: z.boolean(),
  templatesOnly: z.boolean(),
  allowedTemplates: z.array(z.string()).max(200),
  warmup: z.boolean(),
});
export type PolicyForm = z.infer<typeof policySchema>;

export const keyNameSchema = z
  .string()
  .min(2, 'At least 2 characters')
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, ".", "_" and "-" only');
