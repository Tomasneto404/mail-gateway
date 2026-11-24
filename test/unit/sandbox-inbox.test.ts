// Authored by Tomás Neto (TN 2026)
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminAuditService } from '../../src/admin/admin-audit.service';
import { SandboxInboxService, normalizeMailpitUrl } from '../../src/admin/sandbox-inbox.service';
import type { PrismaService } from '../../src/common/prisma.service';
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

/** The settings row lives in memory; audit records are collected. */
function svc(row: { sandboxUiUrl?: string | null; sandboxApiUrl?: string | null } | null) {
  const state = { row: row ? { id: 1, sandboxUiUrl: null, sandboxApiUrl: null, updatedBy: null, updatedAt: new Date(0), ...row } : null };
  const audits: unknown[] = [];
  const prisma = {
    gatewaySettings: {
      findUnique: async () => state.row,
      upsert: async ({ update }: { update: Record<string, unknown> }) => {
        state.row = { id: 1, sandboxUiUrl: null, sandboxApiUrl: null, updatedBy: null, ...state.row, ...update, updatedAt: new Date() } as never;
        return state.row;
      },
    },
  } as unknown as PrismaService;
  const audit = { record: async (_a: unknown, e: unknown) => void audits.push(e) } as unknown as AdminAuditService;
  return { s: new SandboxInboxService({ MAILPIT_SMTP_HOST: 'mailpit' } as AppConfig, prisma, audit), state, audits };
}

const ui = 'https://mailpit.example.com';

describe('SandboxInboxService', () => {
  it('is not configured without a Mailpit link (and asks nothing)', async () => {
    const before = seen.length;
    expect(await svc(null).s.get()).toEqual({ configured: false, url: null, available: false, messages: null });
    expect(await svc({ sandboxApiUrl: `${base}/ok` }).s.get()).toMatchObject({ configured: false });
    expect(seen.length).toBe(before);
  });

  it('reports the browser URL as saved, availability and the message count', async () => {
    const r = await svc({ sandboxUiUrl: ui, sandboxApiUrl: `${base}/ok` }).s.get();
    expect(r).toEqual({ configured: true, url: ui, available: true, messages: 64 });
    expect(seen.at(-1)).toBe('/ok/api/v1/messages?limit=1');
  });

  it('basic auth in front of Mailpit still counts as available', async () => {
    expect(await svc({ sandboxUiUrl: ui, sandboxApiUrl: `${base}/locked` }).s.get()).toMatchObject({ available: true, messages: null });
  });

  it('unavailable on errors and refused connections', async () => {
    expect(await svc({ sandboxUiUrl: ui, sandboxApiUrl: `${base}/broken` }).s.get()).toMatchObject({ configured: true, available: false });
    expect(await svc({ sandboxUiUrl: ui, sandboxApiUrl: 'http://127.0.0.1:1' }).s.get()).toMatchObject({ configured: true, available: false });
  });

  it('caches the answer for a few seconds', async () => {
    const { s } = svc({ sandboxUiUrl: ui, sandboxApiUrl: `${base}/ok` });
    const before = seen.length;
    await s.get(1_000_000);
    await s.get(1_005_000);
    expect(seen.length).toBe(before + 1);
    await s.get(1_011_000);
    expect(seen.length).toBe(before + 2);
  });

  it('saving normalizes, audits, drops the cache and keeps fields left out', async () => {
    const { s, audits } = svc({ sandboxUiUrl: 'http://localhost:8025', sandboxApiUrl: `${base}/ok` });
    await s.get(2_000_000);
    const saved = await s.update({ uiUrl: ' https://mailpit.example.com/ ' }, { type: 'user', id: 'u1', label: 'alex' } as never);
    expect(saved).toMatchObject({ uiUrl: ui, apiUrl: `${base}/ok`, defaultApiUrl: 'http://mailpit:8025', updatedBy: 'alex' });
    expect(audits).toEqual([expect.objectContaining({ action: 'settings.sandbox_update', details: { before: { uiUrl: 'http://localhost:8025', apiUrl: `${base}/ok` }, after: { uiUrl: ui, apiUrl: `${base}/ok` } } })]);
    expect((await s.get(2_001_000)).url).toBe(ui);
    expect(await s.update({ uiUrl: '', apiUrl: null }, { type: 'user', label: 'alex' } as never)).toMatchObject({ uiUrl: null, apiUrl: null });
  });
});

describe('normalizeMailpitUrl', () => {
  it('accepts http(s) URLs, internal host names and paths', () => {
    expect(normalizeMailpitUrl('http://mailpit:8025', 'apiUrl')).toBe('http://mailpit:8025');
    expect(normalizeMailpitUrl('https://tools.example.com/mailpit/', 'uiUrl')).toBe('https://tools.example.com/mailpit');
    expect(normalizeMailpitUrl('  ', 'uiUrl')).toBeNull();
    expect(normalizeMailpitUrl(null, 'uiUrl')).toBeNull();
  });

  it('refuses other schemes, credentials and junk', () => {
    expect(() => normalizeMailpitUrl('file:///etc/passwd', 'apiUrl')).toThrow(/http\(s\)/);
    expect(() => normalizeMailpitUrl('javascript:alert(1)', 'uiUrl')).toThrow(/http\(s\)/);
    expect(() => normalizeMailpitUrl('https://u:p@mailpit.example.com', 'uiUrl')).toThrow(/credentials/);
    expect(() => normalizeMailpitUrl('mailpit.example.com', 'uiUrl')).toThrow(/full URL/);
    expect(() => normalizeMailpitUrl('http://mailpit:8025/?x=1', 'apiUrl')).toThrow(/query/);
    expect(() => normalizeMailpitUrl('http://mailpit:8025/#x', 'apiUrl')).toThrow(/query/);
  });

  it('fences the health check off link-local and metadata targets, not loopback or private nets', () => {
    for (const bad of ['http://169.254.169.254', 'http://[fe80::1]:8025', 'http://metadata.google.internal', 'http://0.0.0.0:8025', 'http://[::ffff:169.254.169.254]']) {
      expect(() => normalizeMailpitUrl(bad, 'apiUrl'), bad).toThrow(/link-local/);
    }
    for (const ok of ['http://127.0.0.1:8025', 'http://10.0.0.5:8025', 'http://mailpit:8025', 'http://[::1]:8025']) {
      expect(normalizeMailpitUrl(ok, 'apiUrl'), ok).toBeTruthy();
    }
  });
});

describe('SandboxInboxService probe target', () => {
  it('does not call a fenced host even if one is stored', async () => {
    const before = seen.length;
    expect(await svc({ sandboxUiUrl: ui, sandboxApiUrl: 'http://169.254.169.254' }).s.get()).toMatchObject({ configured: true, available: false });
    expect(seen.length).toBe(before);
  });

  it('keeps a base path', async () => {
    await svc({ sandboxUiUrl: ui, sandboxApiUrl: `${base}/ok` }).s.get();
    expect(seen.at(-1)).toBe('/ok/api/v1/messages?limit=1');
  });
});
