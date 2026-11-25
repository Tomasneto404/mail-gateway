// Authored by Tomás Neto (TN 2026)
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { BodyCrypto } from '../../src/common/body-crypto';
import { EventLogger } from '../../src/common/event-logger';
import { AuditChainService } from '../../src/admin/audit-chain.service';
import { AlertsService } from '../../src/alerts/alerts.service';
import { RetentionService } from '../../src/worker/retention.service';
import { ADMIN_TOKEN, Stack, createKey, mailpit, resetState, startStack, uname, waitFor } from '../helpers/stack';

const stackEnv = () => inject('stack');
let s: Stack;
const auth = (secret: string) => ({ Authorization: `Bearer ${secret}` });
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };

async function statusOf(secret: string, id: string, want: string[]) {
  return waitFor(async () => {
    const r = await s.http.get(`/v1/messages/${id}`).set(auth(secret));
    return want.includes(r.body.status) ? r.body : null;
  });
}

beforeAll(async () => {
  s = await startStack();
  await resetState(s);
});
afterAll(async () => s?.close());

describe('sandbox mode', () => {
  it('delivers to Mailpit with gateway headers and never to the live SMTP', async () => {
    const { key, secret } = await createKey(s, { name: uname('sbx') });
    expect(secret).toMatch(/^mk_sbx_/);
    expect(key.mode).toBe('sandbox');
    const subject = `sandbox ${uname('subj')}`;
    const res = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'alice@example.com', subject, text: 'hello' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: expect.any(String), status: 'queued' });

    const final = await statusOf(secret, res.body.id, ['captured', 'failed']);
    expect(final.status).toBe('captured');
    expect(final.provider).toBe('mailpit');

    const found = await waitFor(async () => {
      const r = await mailpit.search(stackEnv().SANDBOX_API, `subject:"${subject}"`);
      return r.messages.length ? r.messages : null;
    });
    const headers = await mailpit.headers(stackEnv().SANDBOX_API, found[0].ID);
    expect(headers['X-Mail-Gateway-Key']).toEqual([key.name]);
    expect(headers['X-Mail-Gateway-Message-Id']).toEqual([res.body.id]);
    expect(headers['From'][0]).toContain('bot@gateway.test');

    const live = await mailpit.search(stackEnv().LIVE_API, `subject:"${subject}"`);
    expect(live.messages).toHaveLength(0);
  });
});

describe('live mode', () => {
  it('delivers through the live SMTP and records sent', async () => {
    const { secret } = await createKey(s, { name: uname('live'), mode: 'live', fromName: 'Gateway Bot' });
    expect(secret).toMatch(/^mk_live_/);
    const subject = `live ${uname('subj')}`;
    const res = await s.http.post('/v1/send').set(auth(secret)).send({ to: ['bob@example.com'], cc: 'carol@example.com', subject, html: '<p>hi</p>' });
    expect(res.status).toBe(202);
    const final = await statusOf(secret, res.body.id, ['sent', 'failed']);
    expect(final.status).toBe('sent');
    const live = await waitFor(async () => (await mailpit.search(stackEnv().LIVE_API, `subject:"${subject}"`)).messages[0]);
    expect(live.To.map((t) => t.Address)).toContain('bob@example.com');
    expect((await mailpit.search(stackEnv().SANDBOX_API, `subject:"${subject}"`)).messages).toHaveLength(0);
  });
});

describe('policy rejections are explicit, audited and logged', () => {
  it('RECIPIENT_NOT_ALLOWED', async () => {
    const { key, secret } = await createKey(s, { name: uname('rcpt') });
    const res = await s.http.post('/v1/send').set(auth(secret)).send({ to: ['ok@example.com', 'evil@attacker.io'], subject: 'x', text: 'y' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RECIPIENT_NOT_ALLOWED');
    expect(res.body.error.message).toContain('evil@attacker.io');
    expect(res.body.error.details.notAllowed).toEqual(['evil@attacker.io']);

    const row = await s.prisma.message.findFirst({ where: { apiKeyId: key.id }, orderBy: { createdAt: 'desc' } });
    expect(row).toMatchObject({ status: 'rejected', rejectCode: 'RECIPIENT_NOT_ALLOWED', subject: 'x' });
    // bodies are sealed at rest (APP_ENCRYPTION_KEY) and still readable by the gateway
    expect(BodyCrypto.isSealedText(row!.textBody)).toBe(true);
    expect(s.api.get(BodyCrypto).openText(row!.textBody)).toBe('y');
    const ev = s.logs.events('policy_rejected').find((l) => l.keyName === key.name);
    expect(ev).toMatchObject({ reason: 'RECIPIENT_NOT_ALLOWED', outcome: 'rejected', messageId: row!.id });
  });

  it('QUOTA_EXCEEDED with Retry-After', async () => {
    const { key, secret } = await createKey(s, { name: uname('quota'), quotaPerHour: 2 });
    for (const i of [1, 2]) {
      const r = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject: `q${i}`, text: 'x' });
      expect(r.status).toBe(202);
    }
    const r = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject: 'q3', text: 'x' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    const me = await s.http.get('/v1/me').set(auth(secret));
    expect(me.body.usage.hour).toEqual({ used: 2, limit: 2, remaining: 0 });
    expect(await s.prisma.message.count({ where: { apiKeyId: key.id, rejectCode: 'QUOTA_EXCEEDED' } })).toBe(1);
    expect(s.logs.events('policy_rejected').some((l) => l.keyName === key.name && l.reason === 'QUOTA_EXCEEDED')).toBe(true);
  });

  it('DUPLICATE_MESSAGE catches loops, and does not consume quota', async () => {
    const { key, secret } = await createKey(s, { name: uname('dup') });
    const body = { to: ['b@example.com', 'a@example.com'], subject: 'same', text: 'same body' };
    expect((await s.http.post('/v1/send').set(auth(secret)).send(body)).status).toBe(202);
    const again = await s.http.post('/v1/send').set(auth(secret)).send({ ...body, to: ['a@example.com', 'b@example.com'] });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_MESSAGE');
    const me = await s.http.get('/v1/me').set(auth(secret));
    expect(me.body.usage.hour.used).toBe(1);
    expect(await s.prisma.message.count({ where: { apiKeyId: key.id, rejectCode: 'DUPLICATE_MESSAGE' } })).toBe(1);
  });

  it('allowDuplicates accepts identical messages, each counted against the quota', async () => {
    const { key, secret } = await createKey(s, { name: uname('rep'), allowDuplicates: true });
    const body = { to: 'a@example.com', subject: 'repeat', text: 'same body' };
    const a = await s.http.post('/v1/send').set(auth(secret)).send(body);
    const b = await s.http.post('/v1/send').set(auth(secret)).send(body);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body.id).not.toBe(b.body.id);
    const me = await s.http.get('/v1/me').set(auth(secret));
    expect(me.body.allowDuplicates).toBe(true);
    expect(me.body.usage.hour.used).toBe(2);
    expect(await s.prisma.message.count({ where: { apiKeyId: key.id, rejectCode: 'DUPLICATE_MESSAGE' } })).toBe(0);

    // switching it off restores loop protection
    expect((await s.http.patch(`/admin/keys/${key.id}`).set(admin).send({ allowDuplicates: false })).status).toBe(200);
    expect((await s.http.post('/v1/send').set(auth(secret)).send({ ...body, subject: 'repeat 2' })).status).toBe(202);
    expect((await s.http.post('/v1/send').set(auth(secret)).send({ ...body, subject: 'repeat 2' })).body.error.code).toBe('DUPLICATE_MESSAGE');
  });

  it('Idempotency-Key returns the original message', async () => {
    const { key, secret } = await createKey(s, { name: uname('idem') });
    const body = { to: 'a@example.com', subject: 'idem', text: 'x' };
    const a = await s.http.post('/v1/send').set(auth(secret)).set('Idempotency-Key', 'req-1').send(body);
    const b = await s.http.post('/v1/send').set(auth(secret)).set('Idempotency-Key', 'req-1').send(body);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(await s.prisma.message.count({ where: { apiKeyId: key.id, status: { not: 'rejected' } } })).toBe(1);
    // Redis loss: durable fallback still finds it
    await s.redis.del(`mg:idem:${key.id}:req-1`);
    const c = await s.http.post('/v1/send').set(auth(secret)).set('Idempotency-Key', 'req-1').send(body);
    expect(c.body.id).toBe(a.body.id);
  });

  it('rejects from override, header injection, missing body, policy limits', async () => {
    const { secret } = await createKey(s, { name: uname('val'), maxRecipientsPerMessage: 1 });
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ to: 'a@example.com', subject: 'x', text: 'y', from: 'ceo@example.com' }, 400, 'FROM_NOT_ALLOWED'],
      [{ to: 'a@example.com', subject: 'x\r\nBcc: v@evil.io', text: 'y' }, 400, 'VALIDATION_FAILED'],
      [{ to: 'a@example.com', subject: 'x' }, 400, 'VALIDATION_FAILED'],
      [{ to: ['a@example.com', 'b@example.com'], subject: 'x', text: 'y' }, 400, 'TOO_MANY_RECIPIENTS'],
      [{ to: 'a@example.com', subject: 'x', text: 'y', replyTo: 'r@example.com' }, 400, 'REPLY_TO_NOT_ALLOWED'],
      [{ to: 'a@example.com', subject: 'x', text: 'y', attachments: [{ filename: 'a.txt', content: 'aGk=' }] }, 400, 'ATTACHMENTS_NOT_ALLOWED'],
    ];
    for (const [body, status, code] of cases) {
      const r = await s.http.post('/v1/send').set(auth(secret)).send(body);
      expect({ status: r.status, code: r.body.error?.code }).toEqual({ status, code });
    }
  });

  it('INVALID_JSON and REQUEST_TOO_LARGE', async () => {
    const { secret } = await createKey(s, { name: uname('raw') });
    const bad = await s.http.post('/v1/send').set(auth(secret)).set('Content-Type', 'application/json').send('{"to":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    const big = await s.http
      .post('/v1/send')
      .set(auth(secret))
      .send({ to: 'a@example.com', subject: 'x', text: 'y'.repeat(s.cfg.MAX_REQUEST_BYTES + 10) });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('REQUEST_TOO_LARGE');
  });

  it('MESSAGE_TOO_LARGE by key policy', async () => {
    const { secret } = await createKey(s, { name: uname('size'), maxMessageBytes: 100 });
    const r = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject: 'x', text: 'y'.repeat(200) });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('MESSAGE_TOO_LARGE');
  });
});

describe('authentication and key lifecycle', () => {
  it('missing / invalid keys get 401 and are logged without the secret', async () => {
    const none = await s.http.post('/v1/send').send({});
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('UNAUTHORIZED');
    const fake = 'mk_live_' + 'x'.repeat(43);
    const bad = await s.http.post('/v1/send').set(auth(fake)).send({});
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_API_KEY');
    expect(s.logs.events('auth_failed').length).toBeGreaterThan(0);
    expect(s.logs.raw).not.toContain(fake);
  });

  it('kill switch: disabled key → KEY_DISABLED (audited)', async () => {
    const { key, secret } = await createKey(s, { name: uname('kill') });
    const d = await s.http.post(`/admin/keys/${key.id}/disable`).set(admin);
    expect(d.status).toBe(200);
    expect(d.body.enabled).toBe(false);
    const r = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject: 'x', text: 'y' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('KEY_DISABLED');
    expect(await s.prisma.adminAudit.count({ where: { action: 'key.disable', targetId: key.id } })).toBe(1);
  });

  it('rotation invalidates the old secret immediately', async () => {
    const { key, secret } = await createKey(s, { name: uname('rot') });
    const r = await s.http.post(`/admin/keys/${key.id}/rotate`).set(admin);
    expect(r.status).toBe(200);
    expect(r.body.secret).not.toBe(secret);
    expect((await s.http.get('/v1/me').set(auth(secret))).status).toBe(401);
    expect((await s.http.get('/v1/me').set(auth(r.body.secret))).status).toBe(200);
  });

  it('promotion to live takes effect immediately; prefix flagged stale', async () => {
    const { key, secret } = await createKey(s, { name: uname('promo') });
    const p = await s.http.patch(`/admin/keys/${key.id}`).set(admin).send({ mode: 'live' });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ mode: 'live', prefixStale: true });
    const me = await s.http.get('/v1/me').set(auth(secret));
    expect(me.body.mode).toBe('live');
    expect(await s.prisma.adminAudit.count({ where: { action: 'key.promote_live', targetId: key.id } })).toBe(1);
  });

  it('a key cannot read another key’s messages', async () => {
    const a = await createKey(s, { name: uname('ka') });
    const b = await createKey(s, { name: uname('kb') });
    const sent = await s.http.post('/v1/send').set(auth(a.secret)).send({ to: 'a@example.com', subject: 'mine', text: 'x' });
    expect((await s.http.get(`/v1/messages/${sent.body.id}`).set(auth(b.secret))).status).toBe(404);
    expect((await s.http.get(`/v1/messages/${sent.body.id}`).set(auth(a.secret))).status).toBe(200);
  });

  it('/v1/me exposes the policy without secrets', async () => {
    const { secret } = await createKey(s, { name: uname('me'), allowedRecipients: ['@example.com', 'ops@acme.pt'] });
    const me = await s.http.get('/v1/me').set(auth(secret));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ mode: 'sandbox', allowedRecipients: ['@example.com', 'ops@acme.pt'], fromAddress: 'bot@gateway.test' });
    expect(JSON.stringify(me.body)).not.toContain(secret);
    expect(me.body).not.toHaveProperty('keyHash');
  });
});

describe('approval mode', () => {
  it('holds messages until approved, then delivers live', async () => {
    const { secret } = await createKey(s, { name: uname('appr'), mode: 'approval' });
    const subject = `approval ${uname('s')}`;
    const r = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject, text: 'x' });
    expect(r.body.status).toBe('pending_approval');
    const ok = await s.http.post(`/admin/messages/${r.body.id}/approve`).set(admin);
    expect(ok.status).toBe(200);
    expect((await statusOf(secret, r.body.id, ['sent', 'failed'])).status).toBe('sent');
    await waitFor(async () => (await mailpit.search(inject('stack').LIVE_API, `subject:"${subject}"`)).messages[0]);
    // second approval is an invalid transition
    expect((await s.http.post(`/admin/messages/${r.body.id}/approve`).set(admin)).body.error.code).toBe('INVALID_STATE');
  });

  it('admin can reject with a reason (bulk)', async () => {
    const { secret } = await createKey(s, { name: uname('apprj'), mode: 'approval' });
    const r = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject: 'nope', text: 'x' });
    const rj = await s.http.post('/admin/messages/reject').set(admin).send({ ids: [r.body.id], reason: 'not today' });
    expect(rj.body.results).toEqual([{ id: r.body.id, ok: true }]);
    const st = await s.http.get(`/v1/messages/${r.body.id}`).set(auth(secret));
    expect(st.body).toMatchObject({ status: 'rejected', rejectCode: 'REJECTED_BY_ADMIN', rejectReason: 'not today' });
  });
});

describe('admin API', () => {
  it('requires the admin token', async () => {
    expect((await s.http.get('/admin/keys')).status).toBe(401);
    expect((await s.http.get('/admin/keys').set({ Authorization: 'Bearer wrong' })).status).toBe(401);
  });
  it('lists and searches messages with timeline', async () => {
    const { key, secret } = await createKey(s, { name: uname('search') });
    const subject = `findme ${uname('x')}`;
    const sent = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'zed@example.com', subject, text: 'x' });
    await statusOf(secret, sent.body.id, ['captured']);
    const list = await s.http.get('/admin/messages').query({ subject: 'findme', keyId: key.id, recipient: 'zed@example.com' }).set(admin);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    const detail = await s.http.get(`/admin/messages/${sent.body.id}`).set(admin);
    expect(detail.body.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['queued', 'captured']);
    expect(detail.body.textBody).toBe('x');
  });
  it('rejects unknown query values with a clear error', async () => {
    const r = await s.http.get('/admin/messages').query({ status: 'bogus' }).set(admin);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('retention', () => {
  it('purges bodies after AUDIT_BODY_RETENTION_DAYS and keeps metadata', async () => {
    const { secret } = await createKey(s, { name: uname('ret') });
    const sent = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject: 'old', text: 'secret body' });
    await statusOf(secret, sent.body.id, ['captured']);
    const svc = new RetentionService(s.cfg, s.prisma, {} as never, s.api.get(EventLogger), s.api.get(AuditChainService), s.api.get(AlertsService));
    const res = await svc.run(new Date(Date.now() + (s.cfg.AUDIT_BODY_RETENTION_DAYS + 1) * 86_400_000));
    expect(res.purgedBodies).toBeGreaterThan(0);
    const row = await s.prisma.message.findUnique({ where: { id: sent.body.id } });
    expect(row).toMatchObject({ textBody: null, htmlBody: null, subject: 'old' });
    expect(row!.bodyPurgedAt).not.toBeNull();
  });
});
