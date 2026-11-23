// Authored by Tomás Neto (TN 2026)
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxInboxService } from '../../src/admin/sandbox-inbox.service';
import type { AppConfig } from '../../src/config/config';

// A stand-in for Mailpit's API: /ok answers like Mailpit, /locked like Mailpit behind basic auth.
let server: Server;
let base = '';
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req.url ?? '');
    if (req.url?.startsWith('/locked/')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic' }).end();
    } else if (req.url?.startsWith('/ok/api/v1/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ total: 64, unread: 3, messages: [] }));
    } else {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const svc = (cfg: Partial<AppConfig>) => new SandboxInboxService({ MAILPIT_SMTP_HOST: 'mailpit', ...cfg } as AppConfig);

describe('SandboxInboxService', () => {
  it('is not configured without MAILPIT_UI_URL (and asks nothing)', async () => {
    const before = seen.length;
    expect(await svc({ MAILPIT_API_URL: `${base}/ok` }).get()).toEqual({ configured: false, url: null, available: false, messages: null });
    expect(seen.length).toBe(before);
  });

  it('reports the browser URL, availability and the message count', async () => {
    const r = await svc({ MAILPIT_UI_URL: 'http://localhost:8025', MAILPIT_API_URL: `${base}/ok/` }).get();
    expect(r).toEqual({ configured: true, url: 'http://localhost:8025', available: true, messages: 64 });
    expect(seen.at(-1)).toBe('/ok/api/v1/messages?limit=1');
  });

  it('basic auth in front of Mailpit still counts as available', async () => {
    expect(await svc({ MAILPIT_UI_URL: 'http://localhost:8025', MAILPIT_API_URL: `${base}/locked` }).get()).toMatchObject({ available: true, messages: null });
  });

  it('unavailable on errors, refused connections and bad URLs', async () => {
    const ui = { MAILPIT_UI_URL: 'http://localhost:8025' };
    expect(await svc({ ...ui, MAILPIT_API_URL: `${base}/broken` }).get()).toMatchObject({ configured: true, available: false });
    expect(await svc({ ...ui, MAILPIT_API_URL: 'http://127.0.0.1:1' }).get()).toMatchObject({ configured: true, available: false });
    expect(await svc({ ...ui, MAILPIT_API_URL: 'file:///etc/passwd' }).get()).toMatchObject({ configured: true, available: false });
  });

  it('caches the answer for a few seconds', async () => {
    const s = svc({ MAILPIT_UI_URL: 'http://localhost:8025', MAILPIT_API_URL: `${base}/ok` });
    const before = seen.length;
    await s.get(1_000_000);
    await s.get(1_005_000);
    expect(seen.length).toBe(before + 1);
    await s.get(1_011_000);
    expect(seen.length).toBe(before + 2);
  });
});
