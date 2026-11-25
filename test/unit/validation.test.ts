// Authored by Tomás Neto (TN 2026)
import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../src/common/errors';
import { isPlainEmail, isRecipientRule } from '../../src/common/validators';
import { CreateKeyDto } from '../../src/keys/keys.dto';
import { validateDto } from '../../src/keys/keys.service';
import { SendDto } from '../../src/send/send.dto';

async function code(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as GatewayError).code;
  }
}

describe('address validators', () => {
  it('accepts plain addresses only', () => {
    expect(isPlainEmail('user@example.com')).toBe(true);
    expect(isPlainEmail('first.last+tag@sub.example.co')).toBe(true);
    expect(isPlainEmail('Name <user@example.com>')).toBe(false);
    expect(isPlainEmail('user@example.com\r\nBcc: x@y.z')).toBe(false);
    expect(isPlainEmail('user@localhost')).toBe(false);
    expect(isPlainEmail('a..b@example.com')).toBe(false);
  });
  it('recipient rules: exact address, @domain or * (anyone)', () => {
    expect(isRecipientRule('@example.com')).toBe(true);
    expect(isRecipientRule('ops@example.com')).toBe(true);
    expect(isRecipientRule('*')).toBe(true);
    expect(isRecipientRule('example.com')).toBe(false);
    expect(isRecipientRule('@*.example.com')).toBe(false);
    expect(isRecipientRule('**')).toBe(false);
  });
});

describe('SendDto (header injection + shape)', () => {
  const ok = { to: 'a@example.com', subject: 'hello', text: 'hi' };
  it('normalizes a single "to" string to an array', async () => {
    const dto = await validateDto(SendDto, ok);
    expect(dto.to).toEqual(['a@example.com']);
  });
  it.each([
    ['subject CR/LF', { ...ok, subject: 'hi\r\nBcc: victim@evil.io' }],
    ['subject LF', { ...ok, subject: 'hi\nX-Injected: 1' }],
    ['to with CRLF', { ...ok, to: 'a@example.com\r\nBcc: x@evil.io' }],
    ['to with display name', { ...ok, to: 'Bob <a@example.com>' }],
    ['replyTo CRLF', { ...ok, replyTo: 'r@example.com\nBcc: x@y.io' }],
    ['attachment filename CRLF', { ...ok, attachments: [{ filename: 'a\r\n.txt', content: 'aGk=' }] }],
    ['attachment not base64', { ...ok, attachments: [{ filename: 'a.txt', content: '!!!' }] }],
    ['unknown field', { ...ok, priority: 'high' }],
    ['empty subject', { ...ok, subject: '' }],
    ['empty to', { ...ok, to: [] }],
  ])('rejects %s', async (_n, body) => {
    expect(await code(validateDto(SendDto, body))).toBe('VALIDATION_FAILED');
  });
  it('rejects non-object bodies', async () => {
    expect(await code(validateDto(SendDto, [1, 2]))).toBe('VALIDATION_FAILED');
    expect(await code(validateDto(SendDto, 'x'))).toBe('VALIDATION_FAILED');
  });
});

describe('CreateKeyDto', () => {
  it('rejects fromName with CR/LF and bad recipient rules', async () => {
    expect(await code(validateDto(CreateKeyDto, { name: 'k1', fromAddress: 'a@example.com', fromName: 'X\r\nBcc: y' }))).toBe('VALIDATION_FAILED');
    expect(await code(validateDto(CreateKeyDto, { name: 'k1', fromAddress: 'a@example.com', allowedRecipients: ['example.com'] }))).toBe('VALIDATION_FAILED');
    expect(await code(validateDto(CreateKeyDto, { name: 'bad name', fromAddress: 'a@example.com' }))).toBe('VALIDATION_FAILED');
  });
  it('lowercases recipients', async () => {
    const d = await validateDto(CreateKeyDto, { name: 'k1', fromAddress: 'A@Example.com', allowedRecipients: ['@Example.COM'] });
    expect(d.allowedRecipients).toEqual(['@example.com']);
    expect(d.fromAddress).toBe('a@example.com');
  });
  it('accepts * (any recipient) next to other rules', async () => {
    const d = await validateDto(CreateKeyDto, { name: 'k1', fromAddress: 'a@example.com', allowedRecipients: ['*', '@example.com'] });
    expect(d.allowedRecipients).toEqual(['*', '@example.com']);
  });
});
