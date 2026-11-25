// Authored by Tomás Neto (TN 2026)
import { createHash } from 'node:crypto';
import { GatewayError } from '../common/errors';
import { ANY_RECIPIENT } from '../common/validators';

/** The subset of a key's policy the pure engine needs. */
export interface PolicySnapshot {
  name: string;
  allowedRecipients: string[];
  maxRecipientsPerMessage: number;
  maxMessageBytes: number;
  allowReplyTo: boolean;
  attachmentsAllowed: boolean;
  maxAttachmentBytes: number;
}

export interface NormalizedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface NormalizedMessage {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  attachments: NormalizedAttachment[];
}

export const normalizeAddress = (a: string) => a.trim().toLowerCase();

/** Exact address match, `@domain` match on the exact domain (not subdomains), or `*` for any address. */
export function matchRecipient(address: string, allowed: string[]): boolean {
  const addr = normalizeAddress(address);
  const at = addr.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = addr.slice(at);
  for (const rule of allowed) {
    const r = normalizeAddress(rule);
    if (r === ANY_RECIPIENT || (r.startsWith('@') ? r === domain : r === addr)) return true;
  }
  return false;
}

export function allRecipients(m: Pick<NormalizedMessage, 'to' | 'cc' | 'bcc'>): string[] {
  return [...m.to, ...m.cc, ...m.bcc];
}

/** Approximate on-the-wire size: subject + bodies + decoded attachments. */
export function computeMessageSize(m: NormalizedMessage): number {
  return (
    Buffer.byteLength(m.subject, 'utf8') +
    Buffer.byteLength(m.text ?? '', 'utf8') +
    Buffer.byteLength(m.html ?? '', 'utf8') +
    m.attachments.reduce((n, a) => n + a.content.length, 0)
  );
}

const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} bytes`);

/**
 * Evaluates the policy. Throws the first violation as a GatewayError whose message
 * explains exactly what to change.
 */
export function enforcePolicy(p: PolicySnapshot, m: NormalizedMessage): void {
  const recipients = allRecipients(m);
  if (p.allowedRecipients.length === 0) {
    throw new GatewayError(
      'RECIPIENT_NOT_ALLOWED',
      `Key "${p.name}" has an empty recipient allow-list, so it cannot send to anyone. Ask an administrator to add allowed recipients.`,
      { notAllowed: recipients, allowedRecipients: [] },
    );
  }
  const notAllowed = [...new Set(recipients.filter((r) => !matchRecipient(r, p.allowedRecipients)))];
  if (notAllowed.length) {
    throw new GatewayError(
      'RECIPIENT_NOT_ALLOWED',
      `Recipient(s) ${notAllowed.join(', ')} not allowed by key "${p.name}". Allowed: ${p.allowedRecipients.join(', ')}. ` +
        'Every to/cc/bcc address must match an exact address, an "@domain" entry or "*". Remove them, or call GET /v1/me to see your policy.',
      { notAllowed, allowedRecipients: p.allowedRecipients },
    );
  }
  if (recipients.length > p.maxRecipientsPerMessage) {
    throw new GatewayError(
      'TOO_MANY_RECIPIENTS',
      `Message has ${recipients.length} recipients (to+cc+bcc) but key "${p.name}" allows at most ${p.maxRecipientsPerMessage}. Split it into several messages.`,
      { recipients: recipients.length, max: p.maxRecipientsPerMessage },
    );
  }
  if (m.replyTo && !p.allowReplyTo) {
    throw new GatewayError('REPLY_TO_NOT_ALLOWED', `Key "${p.name}" does not allow setting replyTo. Remove the replyTo field.`);
  }
  if (m.attachments.length) {
    if (!p.attachmentsAllowed) {
      throw new GatewayError('ATTACHMENTS_NOT_ALLOWED', `Key "${p.name}" does not allow attachments. Remove the attachments field or put the content in the body.`);
    }
    const attBytes = m.attachments.reduce((n, a) => n + a.content.length, 0);
    if (attBytes > p.maxAttachmentBytes) {
      throw new GatewayError(
        'ATTACHMENT_TOO_LARGE',
        `Attachments total ${fmtBytes(attBytes)} (decoded) but key "${p.name}" allows at most ${fmtBytes(p.maxAttachmentBytes)}.`,
        { attachmentBytes: attBytes, max: p.maxAttachmentBytes },
      );
    }
  }
  const size = computeMessageSize(m);
  if (size > p.maxMessageBytes) {
    throw new GatewayError(
      'MESSAGE_TOO_LARGE',
      `Message is ${fmtBytes(size)} but key "${p.name}" allows at most ${fmtBytes(p.maxMessageBytes)} (subject + text + html + attachments). Shorten it.`,
      { sizeBytes: size, max: p.maxMessageBytes },
    );
  }
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function computeBodyHash(m: Pick<NormalizedMessage, 'text' | 'html'>): string {
  return sha256(JSON.stringify([m.text ?? '', m.html ?? '']));
}

/** Loop detector: (key, sorted recipients, subject, body). */
export function computeDedupHash(keyId: string, m: NormalizedMessage): string {
  const rcpts = [...new Set(allRecipients(m).map(normalizeAddress))].sort();
  return sha256(JSON.stringify([keyId, rcpts, m.subject.trim(), m.text ?? '', m.html ?? '']));
}
