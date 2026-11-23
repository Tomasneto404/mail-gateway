// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';

export interface SandboxInbox {
  /** MAILPIT_UI_URL is set: there is a sandbox inbox people can open */
  configured: boolean;
  /** browser-facing Mailpit URL, null when not configured */
  url: string | null;
  /** Mailpit answered its API just now */
  available: boolean;
  /** messages currently in Mailpit, null when unknown */
  messages: number | null;
}

/**
 * Where sandbox mail can be read: Mailpit's own UI. The browser URL (MAILPIT_UI_URL) is usually
 * localhost, which the API container cannot reach, so health is checked on Mailpit's API inside the
 * network (MAILPIT_API_URL, default http://<MAILPIT_SMTP_HOST>:8025). Cached briefly: the page polls.
 */
@Injectable()
export class SandboxInboxService {
  private cache?: { at: number; value: Promise<SandboxInbox> };

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  private apiBase(): string | null {
    const raw = this.cfg.MAILPIT_API_URL || `http://${this.cfg.MAILPIT_SMTP_HOST}:8025`;
    try {
      const u = new URL(raw);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString().replace(/\/$/, '') : null;
    } catch {
      return null;
    }
  }

  get(now = Date.now()): Promise<SandboxInbox> {
    if (this.cache && now - this.cache.at < 10_000) return this.cache.value;
    const value = this.probe();
    this.cache = { at: now, value };
    return value;
  }

  private async probe(): Promise<SandboxInbox> {
    const url = this.cfg.MAILPIT_UI_URL ?? null;
    if (!url) return { configured: false, url: null, available: false, messages: null };
    const base = this.apiBase();
    if (!base) return { configured: true, url, available: false, messages: null };
    try {
      const res = await fetch(`${base}/api/v1/messages?limit=1`, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
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
