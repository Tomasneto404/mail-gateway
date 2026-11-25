// Authored by Tomás Neto (TN 2026)
import { registerDecorator, ValidationOptions } from 'class-validator';

export const CRLF_RE = /[\r\n]/;

/** Rejects CR/LF anywhere in the value (header injection protection). Arrays are checked element-wise. */
export function NoCrlf(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'noCrlf',
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} must not contain line breaks (CR/LF)`, ...options },
      validator: {
        validate(value: unknown) {
          if (value === undefined || value === null) return true;
          const vals = Array.isArray(value) ? value : [value];
          return vals.every((v) => typeof v !== 'string' || !CRLF_RE.test(v));
        },
      },
    });
}

/**
 * Strict plain address check: local@domain, no display names, no whitespace, no angle brackets.
 * Intentionally conservative: the gateway never needs exotic address syntax.
 */
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export function isPlainEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v) && !v.includes('..');
}

const DOMAIN_RE = /^@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
/** Allow-list entry that matches every recipient. */
export const ANY_RECIPIENT = '*';

/** Allowed-recipient entry: an exact address, `@domain`, or `*` (any recipient). */
export function isRecipientRule(v: unknown): v is string {
  return typeof v === 'string' && (v === ANY_RECIPIENT || isPlainEmail(v) || DOMAIN_RE.test(v));
}

export function IsPlainEmail(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isPlainEmail',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must contain only plain email addresses like "user@example.com" (no display names)`,
        ...options,
      },
      validator: {
        validate(value: unknown) {
          if (value === undefined || value === null) return true;
          const vals = Array.isArray(value) ? value : [value];
          return vals.every(isPlainEmail);
        },
      },
    });
}

/** Array-of-strings validator with a predicate per element. */
export function EachMatches(name: string, test: (v: string) => boolean, message: string) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name,
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} ${message}` },
      validator: {
        validate(value: unknown) {
          if (value === undefined) return true;
          return Array.isArray(value) && value.every((v) => typeof v === 'string' && test(v));
        },
      },
    });
}

export const HOST_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export const MIME_PATTERN_RE = /^[\w.+-]+\/(?:\*|[\w.+-]+)$/;
export const NAME_RE = /^[A-Za-z0-9._-]{2,64}$/;

export function IsRecipientRule(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isRecipientRule',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} entries must be an exact address ("ops@example.com"), a domain ("@example.com") or "*" (any recipient)`,
        ...options,
      },
      validator: {
        validate(value: unknown) {
          if (!Array.isArray(value)) return false;
          return value.every(isRecipientRule);
        },
      },
    });
}
