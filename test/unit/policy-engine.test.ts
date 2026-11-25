// Authored by Tomás Neto (TN 2026)
import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../src/common/errors';
import {
  NormalizedMessage,
  PolicySnapshot,
  computeDedupHash,
  computeMessageSize,
  enforcePolicy,
  matchRecipient,
} from '../../src/policy/policy-engine';

const policy = (p: Partial<PolicySnapshot> = {}): PolicySnapshot => ({
  name: 'agent-x',
  allowedRecipients: ['@example.com', 'ops@acme.pt'],
  maxRecipientsPerMessage: 3,
  maxMessageBytes: 10_000,
  allowReplyTo: false,
  attachmentsAllowed: false,
  maxAttachmentBytes: 1000,
  ...p,
});
const msg = (m: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  to: ['a@example.com'],
  cc: [],
  bcc: [],
  subject: 'hi',
  text: 'body',
  attachments: [],
  ...m,
});
const codeOf = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as GatewayError).code;
  }
};

describe('matchRecipient', () => {
  it('matches exact addresses case-insensitively', () => {
    expect(matchRecipient('OPS@acme.pt', ['ops@acme.pt'])).toBe(true);
    expect(matchRecipient('dev@acme.pt', ['ops@acme.pt'])).toBe(false);
  });
  it('matches @domain rules on the exact domain only', () => {
    expect(matchRecipient('x@example.com', ['@example.com'])).toBe(true);
    expect(matchRecipient('x@sub.example.com', ['@example.com'])).toBe(false);
    expect(matchRecipient('x@example.com.evil.io', ['@example.com'])).toBe(false);
    expect(matchRecipient('x@notexample.com', ['@example.com'])).toBe(false);
  });
  it('does not treat an exact address rule as a domain rule', () => {
    expect(matchRecipient('other@acme.pt', ['ops@acme.pt'])).toBe(false);
  });
  it('rejects malformed addresses', () => {
    expect(matchRecipient('@example.com', ['@example.com'])).toBe(false);
    expect(matchRecipient('noat', ['@example.com'])).toBe(false);
  });
  it('* matches any well-formed address, not malformed ones', () => {
    expect(matchRecipient('anyone@anywhere.io', ['*'])).toBe(true);
    expect(matchRecipient('x@sub.example.com', ['ops@acme.pt', '*'])).toBe(true);
    expect(matchRecipient('noat', ['*'])).toBe(false);
    expect(matchRecipient('@example.com', ['*'])).toBe(false);
  });
});

describe('enforcePolicy', () => {
  it('accepts a compliant message', () => {
    expect(codeOf(() => enforcePolicy(policy(), msg({ cc: ['ops@acme.pt'] })))).toBeNull();
  });
  it('empty allow-list rejects everything', () => {
    expect(codeOf(() => enforcePolicy(policy({ allowedRecipients: [] }), msg()))).toBe('RECIPIENT_NOT_ALLOWED');
  });
  it('* allows every recipient, other limits still apply', () => {
    const any = policy({ allowedRecipients: ['*'] });
    expect(codeOf(() => enforcePolicy(any, msg({ to: ['a@gmail.com'], cc: ['b@outlook.com'], bcc: ['c@corp.test'] })))).toBeNull();
    expect(codeOf(() => enforcePolicy(any, msg({ to: ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io'] })))).toBe('TOO_MANY_RECIPIENTS');
  });
  it('every to/cc/bcc must match, and the error lists offenders + allowed', () => {
    for (const m of [msg({ to: ['bad@evil.io'] }), msg({ cc: ['bad@evil.io'] }), msg({ bcc: ['bad@evil.io'] })]) {
      try {
        enforcePolicy(policy(), m);
        expect.unreachable();
      } catch (e) {
        const err = e as GatewayError;
        expect(err.code).toBe('RECIPIENT_NOT_ALLOWED');
        expect(err.message).toContain('bad@evil.io');
        expect(err.message).toContain('GET /v1/me');
        expect(err.details).toMatchObject({ notAllowed: ['bad@evil.io'], allowedRecipients: ['@example.com', 'ops@acme.pt'] });
      }
    }
  });
  it('limits recipients across to+cc+bcc', () => {
    expect(codeOf(() => enforcePolicy(policy(), msg({ to: ['a@example.com', 'b@example.com'], cc: ['c@example.com'], bcc: ['d@example.com'] })))).toBe(
      'TOO_MANY_RECIPIENTS',
    );
  });
  it('replyTo only when allowed', () => {
    expect(codeOf(() => enforcePolicy(policy(), msg({ replyTo: 'r@example.com' })))).toBe('REPLY_TO_NOT_ALLOWED');
    expect(codeOf(() => enforcePolicy(policy({ allowReplyTo: true }), msg({ replyTo: 'r@example.com' })))).toBeNull();
  });
  it('attachments only when allowed and within size', () => {
    const att = (n: number) => ({ filename: 'f.bin', contentType: 'application/octet-stream', content: Buffer.alloc(n) });
    expect(codeOf(() => enforcePolicy(policy(), msg({ attachments: [att(10)] })))).toBe('ATTACHMENTS_NOT_ALLOWED');
    expect(codeOf(() => enforcePolicy(policy({ attachmentsAllowed: true }), msg({ attachments: [att(1001)] })))).toBe('ATTACHMENT_TOO_LARGE');
    expect(codeOf(() => enforcePolicy(policy({ attachmentsAllowed: true }), msg({ attachments: [att(1000)] })))).toBeNull();
  });
  it('limits total message size (multi-byte aware)', () => {
    expect(codeOf(() => enforcePolicy(policy({ maxMessageBytes: 10 }), msg({ subject: 'é', text: '123456789' })))).toBe('MESSAGE_TOO_LARGE');
    expect(computeMessageSize(msg({ subject: 'é', text: 'ab', html: 'c' }))).toBe(2 + 2 + 1);
  });
});

describe('computeDedupHash', () => {
  it('is independent of recipient order/case and duplicates', () => {
    const a = computeDedupHash('k1', msg({ to: ['b@example.com', 'a@example.com'] }));
    const b = computeDedupHash('k1', msg({ to: ['A@example.com'], cc: ['b@example.com', 'a@example.com'] }));
    expect(a).toBe(b);
  });
  it('changes with key, subject or body', () => {
    const base = computeDedupHash('k1', msg());
    expect(computeDedupHash('k2', msg())).not.toBe(base);
    expect(computeDedupHash('k1', msg({ subject: 'other' }))).not.toBe(base);
    expect(computeDedupHash('k1', msg({ text: 'other' }))).not.toBe(base);
    expect(computeDedupHash('k1', msg({ html: '<p>x</p>' }))).not.toBe(base);
  });
});
