// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { validateDto } from '../keys/keys.service';
import { Actor, AdminAuditService } from './admin-audit.service';

export interface SandboxInbox {
  /** a Mailpit link is set on the Settings page: there is a sandbox inbox people can open */
  configured: boolean;
  /** browser-facing Mailpit URL, null when not configured */
  url: string | null;
  /** Mailpit answered its API just now */
  available: boolean;
  /** messages currently in Mailpit, null when unknown */
  messages: number | null;
}

export interface SandboxSettings {
  /** Mailpit as the browser reaches it; null = no "Sandbox Messages" link */
  uiUrl: string | null;
  /** Mailpit as the API container reaches it; null = defaultApiUrl */
  apiUrl: string | null;
  defaultApiUrl: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export class UpdateSandboxSettingsDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Mailpit UI as the browser reaches it, e.g. https://mailpit.example.com. Empty or null removes the link.' })
  @IsOptional() @IsString() @MaxLength(2000)
  uiUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Mailpit as the API container reaches it (health and count). Empty or null = http://<MAILPIT_SMTP_HOST>:8025.' })
  @IsOptional() @IsString() @MaxLength(2000)
  apiUrl?: string | null;
}

/** '' / null → null; otherwise an http(s) URL without credentials, stored without a trailing slash. */
export function normalizeMailpitUrl(raw: string | null | undefined, field: string): string | null {
  const t = raw?.trim();
  if (!t) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new GatewayError('VALIDATION_FAILED', `${field} must be a full URL, e.g. https://mailpit.example.com`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new GatewayError('VALIDATION_FAILED', `${field} must be an http(s) URL.`);
  if (u.username || u.password) throw new GatewayError('VALIDATION_FAILED', `${field} must not contain credentials; the browser asks for Mailpit's basic auth itself.`);
  if (u.search || u.hash || t.includes('#') || t.includes('?')) throw new GatewayError('VALIDATION_FAILED', `${field} must not contain a query string or fragment.`);
  if (field === 'apiUrl' && blockedHost(u.hostname)) throw new GatewayError('VALIDATION_FAILED', `${field} must not point at a link-local or cloud metadata address.`);
  return u.href.replace(/\/$/, '');
}

/**
 * The health check is a server-side request, so its target is fenced: never link-local
 * (169.254/16, fe80::/10: cloud metadata services), the unspecified address or metadata host names.
 * Loopback and private ranges stay allowed: Mailpit is normally a sibling container or on localhost.
 */
export function blockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'metadata' || h === 'metadata.google.internal' || h.endsWith('.metadata.google.internal')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::ffff:0.0.0.0') return true;
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (v4 && Number(v4[1]) === 169 && Number(v4[2]) === 254) return true;
  if (/^(?:::ffff:)?a9fe:/.test(h)) return true; // ::ffff:169.254.x.x in hex form
  return /^fe[89ab][0-9a-f]:/.test(h);
}

/** Resolves the host and refuses it when any address is fenced off (a name can point at 169.254.169.254). */
async function resolvesToBlocked(host: string): Promise<boolean> {
  if (blockedHost(host)) return true;
  if (isIP(host.replace(/^\[|\]$/g, ''))) return false;
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.some((a) => blockedHost(a.address));
  } catch {
    return false; // unresolvable: the fetch fails on its own
  }
}

const SINGLETON = 1;

/**
 * Where sandbox mail can be read: Mailpit's own UI. Both links are set on the Settings page (stored in
 * gateway_settings). The browser URL is often a host name the API container cannot reach, so health is
 * checked on Mailpit's API inside the network (default http://<MAILPIT_SMTP_HOST>:8025). Cached briefly:
 * the Messages page polls.
 */
@Injectable()
export class SandboxInboxService {
  private cache?: { at: number; value: Promise<SandboxInbox> };

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  private defaultApiUrl(): string {
    return `http://${this.cfg.MAILPIT_SMTP_HOST}:8025`;
  }

  async settings(): Promise<SandboxSettings> {
    const row = await this.prisma.gatewaySettings.findUnique({ where: { id: SINGLETON } });
    return {
      uiUrl: row?.sandboxUiUrl ?? null,
      apiUrl: row?.sandboxApiUrl ?? null,
      defaultApiUrl: this.defaultApiUrl(),
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  async update(body: unknown, actor: Actor): Promise<SandboxSettings> {
    const dto = await validateDto(UpdateSandboxSettingsDto, body);
    const before = await this.settings();
    const data = {
      sandboxUiUrl: dto.uiUrl === undefined ? before.uiUrl : normalizeMailpitUrl(dto.uiUrl, 'uiUrl'),
      sandboxApiUrl: dto.apiUrl === undefined ? before.apiUrl : normalizeMailpitUrl(dto.apiUrl, 'apiUrl'),
      updatedBy: actor.label,
    };
    await this.prisma.gatewaySettings.upsert({ where: { id: SINGLETON }, create: { id: SINGLETON, ...data }, update: data });
    this.cache = undefined;
    await this.audit.record(actor, {
      action: 'settings.sandbox_update',
      targetType: 'settings',
      targetId: 'sandbox',
      details: { before: { uiUrl: before.uiUrl, apiUrl: before.apiUrl }, after: { uiUrl: data.sandboxUiUrl, apiUrl: data.sandboxApiUrl } },
    });
    return this.settings();
  }

  get(now = Date.now()): Promise<SandboxInbox> {
    if (this.cache && now - this.cache.at < 10_000) return this.cache.value;
    const value = this.probe();
    this.cache = { at: now, value };
    return value;
  }

  private async probe(): Promise<SandboxInbox> {
    const s = await this.settings();
    const url = s.uiUrl;
    if (!url) return { configured: false, url: null, available: false, messages: null };
    try {
      // Built with URL so the path is appended to the base path and nothing in the base changes the request.
      const base = new URL(s.apiUrl ?? this.defaultApiUrl());
      if (base.protocol !== 'http:' && base.protocol !== 'https:') return { configured: true, url, available: false, messages: null };
      const target = new URL(`${base.pathname.replace(/\/$/, '')}/api/v1/messages`, base.origin);
      target.searchParams.set('limit', '1');
      if (await resolvesToBlocked(target.hostname)) return { configured: true, url, available: false, messages: null };
      const res = await fetch(target, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
      // 401: Mailpit is up but protects its UI/API with basic auth; the browser will ask for it.
      if (res.status === 401) return { configured: true, url, available: true, messages: null };
      if (!res.ok) return { configured: true, url, available: false, messages: null };
      const body = (await res.json().catch(() => null)) as { total?: unknown } | null;
      return { configured: true, url, available: true, messages: typeof body?.total === 'number' ? body.total : null };
    } catch {
      return { configured: true, url, available: false, messages: null };
    }
  }
}
