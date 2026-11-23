// Authored by Tomás Neto (TN 2026)
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login } from '../helpers/admin-login';
import { Stack, resetState, startStack } from '../helpers/stack';

// No worker and no mail: a stub answers as Mailpit's API.
let s: Stack;
let stub: Server;

beforeAll(async () => {
  stub = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ total: 12 })));
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as AddressInfo).port;
  s = await startStack({ MAILPIT_UI_URL: 'http://localhost:8025', MAILPIT_API_URL: `http://127.0.0.1:${port}` }, { worker: false });
  await resetState(s);
});
afterAll(async () => {
  await s?.close();
  await new Promise<void>((r) => stub.close(() => r()));
});

describe('GET /admin/messages/sandbox-inbox', () => {
  it('gives body readers the Mailpit link, availability and count', async () => {
    const reader = await login(s, 'viewer', true);
    const r = await reader.agent.get('/admin/messages/sandbox-inbox');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ configured: true, url: 'http://localhost:8025', available: true, messages: 12 });
  });

  it('is refused without messages:bodies (Mailpit shows full bodies)', async () => {
    const viewer = await login(s, 'viewer');
    expect((await viewer.agent.get('/admin/messages/sandbox-inbox')).status).toBe(403);
  });
});
