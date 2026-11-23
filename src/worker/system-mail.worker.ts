// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { instrumentWorker } from '../metrics/worker-instrumentation';
import { WORKER_METRICS } from '../queue/queue-metrics';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, AppConfig, systemMailProvider } from '../config/config';
import { EventLogger } from '../common/event-logger';
import { QUEUE_PREFIX, SYSTEM_MAIL_QUEUE, SystemMailJob, redisConnection } from '../queue/queue.service';
import { ProvidersRegistry } from './providers.registry';

/** Delivers system emails (admin invites) through the live provider. Not subject to key policies. */
@Injectable()
export class SystemMailWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker?: Worker<SystemMailJob>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly providers: ProvidersRegistry,
    private readonly events: EventLogger,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onApplicationBootstrap() {
    this.worker = new Worker<SystemMailJob>(SYSTEM_MAIL_QUEUE, (job) => this.process(job), {
      connection: redisConnection(this.cfg.REDIS_URL),
      prefix: QUEUE_PREFIX,
      concurrency: 2,
      metrics: WORKER_METRICS,
    });
    instrumentWorker(this.worker, SYSTEM_MAIL_QUEUE, this.metrics);
    this.worker.on('error', () => undefined);
  }

  async onApplicationShutdown() {
    await this.worker?.close();
  }

  async process(job: Job<SystemMailJob>) {
    const name = systemMailProvider(this.cfg);
    const provider = name ? this.providers.get(name) : undefined;
    if (!provider || !this.cfg.SYSTEM_MAIL_FROM) {
      this.events.emit('system_mail_failed', { outcome: 'failure', kind: job.data.kind, to: job.data.to, reason: 'not_configured' });
      throw new UnrecoverableError('system mail not configured on the worker');
    }
    const id = randomUUID();
    const domain = this.cfg.SYSTEM_MAIL_FROM.split('@')[1];
    try {
      await provider.send({
        gatewayMessageId: id,
        keyName: 'system',
        headerMessageId: `<${id}@${domain}>`,
        from: { address: this.cfg.SYSTEM_MAIL_FROM, name: this.cfg.SYSTEM_MAIL_FROM_NAME },
        to: [job.data.to],
        cc: [],
        bcc: [],
        subject: job.data.subject,
        text: job.data.text,
        html: job.data.html,
        attachments: [],
        headers: { 'X-Mail-Gateway-Key': 'system', 'X-Mail-Gateway-Message-Id': id, 'Auto-Submitted': 'auto-generated' },
      });
      this.events.emit('system_mail_sent', { outcome: 'success', kind: job.data.kind, to: job.data.to, provider: name });
    } catch (err) {
      const c = provider.classify(err);
      this.events.emit('system_mail_failed', { outcome: 'failure', kind: job.data.kind, to: job.data.to, provider: name, reason: c.message });
      if (!c.transient) throw new UnrecoverableError(c.message);
      throw err;
    }
  }
}
