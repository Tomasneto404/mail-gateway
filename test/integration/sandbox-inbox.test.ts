// Authored by Tomás Neto (TN 2026)
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login } from '../helpers/admin-login';
import { Stack, resetState, startStack } from '../helpers/stack';

// No worker and no mail: a stub answers as Mailpit's API.
let s: Stack;
let stub: Server;
let stubUrl = '';

beforeAll(async () => {
  stub = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ total: 12 })));
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  s = await startStack({}, { worker: false });
  await resetState(s);
  await s.prisma.gatewaySettings.deleteMany();
});
afterAll(async () => {
  await s?.close();
  await new Promise<void>((r) => stub.close(() => r()));
});

describe('Mailpit links (Settings → Sandbox)', () => {
  it('no link until one is saved on the Settings page', async () => {
    const reader = await login(s, 'viewer', true);
    expect((await reader.agent.get('/admin/messages/sandbox-inbox')).body).toMatchObject({ configured: false, url: null });
  });

  it('admins save the links; body readers then get the link exactly as saved', async () => {
    const admin = await login(s, 'admin');
    const put = await admin.agent.put('/admin/settings/sandbox').set(admin.h).send({ uiUrl: 'https://mailpit.example.com', apiUrl: stubUrl });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ uiUrl: 'https://mailpit.example.com', apiUrl: stubUrl, defaultApiUrl: expect.stringMatching(/:8025$/) });
    expect((await admin.agent.get('/admin/settings/sandbox')).body.uiUrl).toBe('https://mailpit.example.com');

    const reader = await login(s, 'viewer', true);
    const r = await reader.agent.get('/admin/messages/sandbox-inbox');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ configured: true, url: 'https://mailpit.example.com', available: true, messages: 12 });

    const audit = await s.prisma.adminAudit.findFirst({ where: { action: 'settings.sandbox_update' }, orderBy: { seq: 'desc' } });
    expect(audit?.actorLabel).toBe(admin.email);
  });

  it('refuses bad URLs and users without settings:manage', async () => {
    const admin = await login(s, 'admin');
    const bad = await admin.agent.put('/admin/settings/sandbox').set(admin.h).send({ uiUrl: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');

    const viewer = await login(s, 'viewer', true);
    expect((await viewer.agent.get('/admin/settings/sandbox')).status).toBe(200);
    expect((await viewer.agent.put('/admin/settings/sandbox').set(viewer.h).send({ uiUrl: 'https://x.example.com' })).status).toBe(403);
  });

  it('the inbox status is refused without messages:bodies (Mailpit shows full bodies)', async () => {
    const viewer = await login(s, 'viewer');
    expect((await viewer.agent.get('/admin/messages/sandbox-inbox')).status).toBe(403);
  });
});
