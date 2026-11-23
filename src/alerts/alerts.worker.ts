// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { instrumentWorker } from '../metrics/worker-instrumentation';
import { WORKER_METRICS } from '../queue/queue-metrics';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import { APP_CONFIG, AppConfig, systemMailProvider } from '../config/config';
import { EventLogger } from '../common/event-logger';
import { PrismaService } from '../common/prisma.service';
import { SecretBox } from '../auth/crypto';
import { AlertChannel, AlertEvent } from '../generated/prisma/client';
import { QuotaService } from '../policy/quota.service';
import { ALERTS_QUEUE, QUEUE_PREFIX, QueueService, redisConnection } from '../queue/queue.service';
import { AlertJob, AlertsService } from './alerts.service';
import { AlertPayload, emailContent, postJson, signWebhook, slackBody } from './deliver';

/**
 * Worker side of alerting:
 *  - `deliver`: sends one alert to every enabled channel subscribed to its type (retried per channel);
 *  - `scan` (every minute): evaluates the alert rules against the database and Redis.
 */
@Injectable()
export class AlertsWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker?: Worker;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    private readonly queues: QueueService,
    private readonly alerts: AlertsService,
    private readonly quota: QuotaService,
    private readonly events: EventLogger,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async onApplicationBootstrap() {
    await this.queues.alerts.upsertJobScheduler('alerts-scan', { every: 60_000 }, { name: 'scan' });
    this.worker = new Worker(ALERTS_QUEUE, (job) => (job.name === 'scan' ? this.scan() : this.deliver(job as Job<AlertJob>)), {
      connection: redisConnection(this.cfg.REDIS_URL),
      prefix: QUEUE_PREFIX,
      concurrency: 2,
      metrics: WORKER_METRICS,
    });
    instrumentWorker(this.worker, ALERTS_QUEUE, this.metrics);
    this.worker.on('error', () => undefined);
  }

  async onApplicationShutdown() {
    await this.worker?.close();
  }

  // ------------------------------------------------------------------ delivery

  payload(ev: AlertEvent): AlertPayload {
    return {
      id: ev.id,
      type: ev.type,
      severity: ev.severity,
      title: ev.title,
      detail: (ev.detail ?? {}) as Record<string, unknown>,
      at: ev.at.toISOString(),
      gateway: this.cfg.PUBLIC_URL?.replace(/\/$/, '') ?? null,
    };
  }

  async deliver(job: Job<AlertJob>): Promise<void> {
    const ev = await this.prisma.alertEvent.findUnique({ where: { id: job.data.eventId } });
    if (!ev) return;
    const channels = await this.prisma.alertChannel.findMany({
      where: { enabled: true, OR: [{ events: { has: '*' } }, { events: { has: ev.type } }] },
    });
    // A test alert only goes to the channel being tested.
    const targets = ev.type === 'test' ? channels.filter((c) => c.id === (ev.detail as { channelId?: string } | null)?.channelId) : channels;
    const pending = targets.filter((c) => !ev.deliveredTo.includes(c.name));
    const failed: string[] = [];
    for (const c of pending) {
      try {
        await this.send(c, this.payload(ev));
        await this.prisma.$transaction([
          this.prisma.alertEvent.update({ where: { id: ev.id }, data: { deliveredTo: { push: c.name } } }),
          this.prisma.alertChannel.update({ where: { id: c.id }, data: { lastDeliveredAt: new Date(), lastError: null } }),
        ]);
      } catch (e) {
        failed.push(c.name);
        await this.prisma.alertChannel.update({ where: { id: c.id }, data: { lastError: (e as Error).message.slice(0, 500) } });
        this.events.emit('alert_delivery_failed', { outcome: 'failure', alert: ev.type, channel: c.name, error: (e as Error).message });
      }
    }
    await this.prisma.alertEvent.update({ where: { id: ev.id }, data: { failedTo: failed } });
    if (failed.length) {
      const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (!last) throw new Error(`alert delivery failed for ${failed.join(', ')}`);
    }
  }

  async send(c: AlertChannel, p: AlertPayload): Promise<void> {
    const target = this.box.open(c.targetEnc);
    if (c.type === 'webhook') {
      const body = JSON.stringify(p);
      const ts = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = { 'X-Mail-Gateway-Event': p.type, 'X-Mail-Gateway-Timestamp': ts };
      if (c.secretEnc) headers['X-Mail-Gateway-Signature'] = signWebhook(this.box.open(c.secretEnc), ts, body);
      await postJson(target, body, headers);
      return;
    }
    if (c.type === 'slack') {
      await postJson(target, slackBody(p), {});
      return;
    }
    if (c.type === 'email') {
      if (!systemMailProvider(this.cfg) || !this.cfg.SYSTEM_MAIL_FROM) {
        throw new UnrecoverableError('email alerts need SYSTEM_MAIL_FROM and a live provider (SMTP or Resend)');
      }
      const m = emailContent(p);
      for (const to of target.split(',').map((s) => s.trim()).filter(Boolean)) {
        await this.queues.systemMail.add('alert', { kind: 'alert', to, ...m }, { attempts: 5, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 1000 });
      }
      return;
    }
    throw new Error(`unknown channel type ${c.type}`);
  }

  // ------------------------------------------------------------------ rules

  async scan(now = new Date()): Promise<void> {
    const c = this.cfg;
    const since = new Date(now.getTime() - c.ALERT_SPIKE_WINDOW_MINUTES * 60_000);
    const [rejected, failed, waiting, expiring, keys] = await Promise.all([
      this.prisma.message.count({ where: { status: 'rejected', createdAt: { gte: since } } }),
      this.prisma.message.count({ where: { status: 'failed', updatedAt: { gte: since } } }),
      this.prisma.message.count({ where: { status: 'pending_approval', createdAt: { lt: new Date(now.getTime() - c.ALERT_APPROVAL_WAIT_MINUTES * 60_000) } } }),
      this.prisma.apiKey.findMany({
        where: { deletedAt: null, enabled: true, expiresAt: { gt: now, lt: new Date(now.getTime() + c.ALERT_KEY_EXPIRY_DAYS * 86_400_000) } },
        select: { id: true, name: true, expiresAt: true },
      }),
      this.prisma.apiKey.findMany({ where: { deletedAt: null, enabled: true }, select: { id: true, name: true, quotaPerHour: true, quotaPerDay: true } }),
    ]);

    if (rejected >= c.ALERT_REJECTION_SPIKE) {
      const top = await this.prisma.message.groupBy({ by: ['rejectCode'], where: { status: 'rejected', createdAt: { gte: since } }, _count: true, orderBy: { _count: { rejectCode: 'desc' } }, take: 3 });
      await this.alerts.raise(
        'rejection_spike',
        `${rejected} requests rejected in the last ${c.ALERT_SPIKE_WINDOW_MINUTES} minutes`,
        { rejected, windowMinutes: c.ALERT_SPIKE_WINDOW_MINUTES, topReasons: top.map((t) => `${t.rejectCode ?? 'unknown'} (${t._count})`).join(', ') },
        'global',
      );
    }
    if (failed >= c.ALERT_FAILURE_SPIKE) {
      await this.alerts.raise('delivery_failures', `${failed} deliveries failed in the last ${c.ALERT_SPIKE_WINDOW_MINUTES} minutes`, { failed, windowMinutes: c.ALERT_SPIKE_WINDOW_MINUTES }, 'global');
    }
    if (waiting > 0) {
      await this.alerts.raise('approvals_waiting', `${waiting} message${waiting === 1 ? '' : 's'} waiting for approval for over ${c.ALERT_APPROVAL_WAIT_MINUTES} minutes`, { waiting }, 'global');
    }
    for (const k of expiring) {
      await this.alerts.raise('key_expiring', `API key "${k.name}" expires ${k.expiresAt!.toISOString().slice(0, 16).replace('T', ' ')} UTC`, { key: k.name, expiresAt: k.expiresAt!.toISOString() }, k.id);
    }
    if (keys.length) {
      const usage = await this.quota.usage(keys.map((k) => k.id), now);
      const day = now.toISOString().slice(0, 10);
      const hour = now.toISOString().slice(0, 13);
      for (const k of keys) {
        const u = usage[k.id];
        if (!u) continue;
        for (const [window, used, limit, id] of [
          ['hour', u.hour, k.quotaPerHour, hour],
          ['day', u.day, k.quotaPerDay, day],
        ] as const) {
          if (limit > 0 && (used / limit) * 100 >= c.ALERT_QUOTA_PERCENT) {
            await this.alerts.raise(
              'quota_threshold',
              `Key "${k.name}" used ${used} of its ${window === 'hour' ? 'hourly' : 'daily'} quota of ${limit}`,
              { key: k.name, window, used, limit, percent: Math.round((used / limit) * 100) },
              `${k.id}:${window}:${id}`,
            );
          }
        }
      }
    }
  }
}
