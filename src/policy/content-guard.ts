// Authored by Tomás Neto (TN 2026)
import { GatewayError } from '../common/errors';
import { extractInlineImages } from '../common/inline-images';
import { NormalizedAttachment, NormalizedMessage } from './policy-engine';

/** The content part of a key's policy. */
export interface ContentPolicy {
  name: string;
  allowedLinkDomains: string[];
  maxLinks: number | null;
  blockSecrets: boolean;
  allowedAttachmentTypes: string[];
}

// ------------------------------------------------------------------ links

const HREF_RE = /\b(?:href|src|action|formaction|background|poster)\s*=\s*["']?\s*([^"'\s>]+)/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+/gi;

/** Every absolute http(s) URL in the bodies: attributes of the HTML plus bare URLs in text and HTML. */
export function extractLinks(m: Pick<NormalizedMessage, 'text' | 'html'>): string[] {
  const out = new Set<string>();
  for (const body of [m.html ?? '', m.text ?? '']) {
    for (const x of body.matchAll(HREF_RE)) if (/^https?:\/\//i.test(x[1])) out.add(x[1].replace(/&amp;/g, '&'));
    for (const x of body.matchAll(URL_RE)) out.add(x[0].replace(/[.,;:!?]+$/, ''));
  }
  return [...out];
}

export function linkHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/** "example.com" allows example.com and every subdomain of it. */
export function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((d) => {
    const rule = d.trim().toLowerCase().replace(/^\*\./, '').replace(/^@/, '');
    return host === rule || host.endsWith(`.${rule}`);
  });
}

// ------------------------------------------------------------------ secrets

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

interface SecretRule {
  kind: string;
  re: RegExp;
  check?: (match: string) => boolean;
}

/** Credentials and payment data that must never leave in an email body. */
const SECRET_RULES: SecretRule[] = [
  { kind: 'private_key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/ },
  { kind: 'gitlab_token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'stripe_secret_key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'openai_api_key', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/ },
  { kind: 'mail_gateway_key', re: /\bmk_(?:live|sbx)_[A-Za-z0-9]{30,}\b/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: 'password_in_url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s/]+/i },
  {
    kind: 'card_number',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    check: (m) => {
      const d = m.replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && /^[2-6]/.test(d) && !/^(\d)\1+$/.test(d) && luhn(d);
    },
  },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, check: ibanValid },
];

/** The kind of the first secret found, or null. */
export function findSecret(text: string): string | null {
  for (const rule of SECRET_RULES) {
    if (!rule.check) {
      if (rule.re.test(text)) return rule.kind;
      continue;
    }
    for (const m of text.matchAll(new RegExp(rule.re.source, 'g'))) if (rule.check(m[0])) return rule.kind;
  }
  return null;
}

// ------------------------------------------------------------------ attachments

/** Always refused, whatever the policy says. */
const DANGEROUS_EXT = /\.(?:exe|com|scr|pif|bat|cmd|msi|msp|cpl|dll|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|hta|lnk|reg|iso|img|vhd|vhdx|appx|msix|apk|dmg|pkg|sh|app)$/i;

function sniff(b: Buffer): string | null {
  const s = (sig: number[], off = 0) => b.length >= off + sig.length && sig.every((x, i) => b[off + i] === x);
  if (s([0x4d, 0x5a])) return 'executable/pe';
  if (s([0x7f, 0x45, 0x4c, 0x46])) return 'executable/elf';
  if (s([0xcf, 0xfa, 0xed, 0xfe]) || s([0xfe, 0xed, 0xfa, 0xcf]) || s([0xca, 0xfe, 0xba, 0xbe])) return 'executable/macho';
  if (s([0x23, 0x21])) return 'executable/script';
  if (s([0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (s([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (s([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (s([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (s([0x52, 0x49, 0x46, 0x46]) && s([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (s([0x50, 0x4b, 0x03, 0x04]) || s([0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (s([0xd0, 0xcf, 0x11, 0xe0])) return 'ole';
  return null;
}

/** Declared types whose content has a known signature, and what the content must look like. */
const EXPECTED: Record<string, string[]> = {
  'application/pdf': ['application/pdf'],
  'image/png': ['image/png'],
  'image/jpeg': ['image/jpeg'],
  'image/gif': ['image/gif'],
  'image/webp': ['image/webp'],
  'application/zip': ['zip'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['zip'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['zip'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['zip'],
  'application/vnd.oasis.opendocument.text': ['zip'],
  'application/vnd.oasis.opendocument.spreadsheet': ['zip'],
  'application/msword': ['ole'],
  'application/vnd.ms-excel': ['ole'],
};

export function typeAllowed(contentType: string, allowed: string[]): boolean {
  const t = contentType.toLowerCase().split(';')[0].trim();
  return allowed.some((a) => {
    const r = a.trim().toLowerCase();
    return r.endsWith('/*') ? t.startsWith(r.slice(0, -1)) : r === t;
  });
}

/** Problem with one attachment, or null. */
export function attachmentProblem(a: NormalizedAttachment, allowed: string[]): string | null {
  if (DANGEROUS_EXT.test(a.filename.trim())) return `"${a.filename}" has an executable or script extension, which is never accepted`;
  const real = sniff(a.content);
  if (real?.startsWith('executable/')) return `"${a.filename}" is an executable program, which is never accepted`;
  const declared = a.contentType.toLowerCase().split(';')[0].trim();
  if (allowed.length && !typeAllowed(declared, allowed)) return `"${a.filename}" has type ${declared}, allowed: ${allowed.join(', ')}`;
  const expected = EXPECTED[declared];
  if (expected && (!real || !expected.includes(real))) return `"${a.filename}" is declared as ${declared} but its content does not match`;
  return null;
}

// ------------------------------------------------------------------ enforcement

/** Content guardrails. Throws the first violation with an explanation an agent can act on. */
export function enforceContent(p: ContentPolicy, m: NormalizedMessage): void {
  const links = extractLinks(m);
  if (p.maxLinks !== null && links.length > p.maxLinks) {
    throw new GatewayError(
      'TOO_MANY_LINKS',
      `The message contains ${links.length} links but key "${p.name}" allows at most ${p.maxLinks}. Remove links.`,
      { links: links.length, max: p.maxLinks },
    );
  }
  if (p.allowedLinkDomains.length) {
    const bad = [...new Set(links.map((l) => linkHost(l) ?? l).filter((h) => !hostAllowed(h, p.allowedLinkDomains)))];
    if (bad.length) {
      throw new GatewayError(
        'LINK_NOT_ALLOWED',
        `Links to ${bad.join(', ')} are not allowed by key "${p.name}". Allowed domains: ${p.allowedLinkDomains.join(', ')} (and their subdomains).`,
        { notAllowed: bad, allowedLinkDomains: p.allowedLinkDomains },
      );
    }
  }
  if (p.blockSecrets) {
    const textAttachments = m.attachments
      .filter((a) => /^text\/|json|xml|csv|yaml/i.test(a.contentType) && a.content.length <= 1024 * 1024)
      .map((a) => a.content.toString('utf8'));
    // scan the HTML as delivered: inline images become cid: attachments, every other data: URI stays in
    for (const part of [m.subject, m.text ?? '', extractInlineImages(m.html ?? '', 'scan').html, ...textAttachments]) {
      const kind = findSecret(part);
      if (kind) {
        throw new GatewayError(
          'CONTENT_BLOCKED',
          `The message looks like it contains a secret (${kind.replace(/_/g, ' ')}). Credentials, private keys and payment card or bank numbers must not be sent by email. Remove it; do not retry the same content.`,
          { kind },
        );
      }
    }
  }
  for (const a of m.attachments) {
    const problem = attachmentProblem(a, p.allowedAttachmentTypes);
    if (problem) {
      throw new GatewayError('ATTACHMENT_TYPE_NOT_ALLOWED', `Attachment refused: ${problem}.`, {
        filename: a.filename,
        contentType: a.contentType,
        allowedAttachmentTypes: p.allowedAttachmentTypes,
      });
    }
  }
}
