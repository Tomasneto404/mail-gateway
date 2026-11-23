// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DelayedError, Job, UnrecoverableError, Worker } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../config/config';
import { BodyCrypto } from '../common/body-crypto';
import { EventLogger } from '../common/event-logger';
import { GatewayStateService } from '../gateway-state/gateway-state.service';
import { MessagesRepository } from '../messages/messages.repository';
import { DELIVERY_QUEUE, DeliveryJob, QUEUE_PREFIX, redisConnection } from '../queue/queue.service';
import { MetricsService } from '../metrics/metrics.service';
import { instrumentWorker } from '../metrics/worker-instrumentation';
import { WORKER_METRICS } from '../queue/queue-metrics';
import { CircuitBreakerService } from './circuit-breaker';
import { ProvidersRegistry } from './providers.registry';
import { OutboundMessage, ProviderName, gatewayHeaders } from './providers/provider';

const LIVE: ProviderName[] = ['smtp', 'resend'];

@Injectable()
export class DeliveryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker?: Worker<DeliveryJob>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly repo: MessagesRepository,
    private readonly providers: ProvidersRegistry,
    private readonly breaker: CircuitBreakerService,
    private readonly gateway: GatewayStateService,
    private readonly events: EventLogger,
    private readonly metrics: MetricsService,
    private readonly crypto: BodyCrypto,
  ) {}

  onApplicationBootstrap() {
    this.worker = new Worker<DeliveryJob>(DELIVERY_QUEUE, (job, token) => this.process(job, token), {
      connection: redisConnection(this.cfg.REDIS_URL),
      prefix: QUEUE_PREFIX,
      concurrency: this.cfg.WORKER_CONCURRENCY,
      // Global rate limit protecting the provider (shared by all worker replicas via Redis).
      limiter: { max: this.cfg.GLOBAL_RATE_MAX, duration: this.cfg.GLOBAL_RATE_DURATION_MS },
      metrics: WORKER_METRICS,
    });
    instrumentWorker(this.worker, DELIVERY_QUEUE, this.metrics);
    this.worker.on('error', (err) => this.events.emit('delivery_failed', { outcome: 'failure', reason: 'worker_error', error: err.message }));
  }

  async onApplicationShutdown() {
    await this.worker?.close();
  }

  get isRunning() {
    return !!this.worker?.isRunning();
  }

  async process(job: Job<DeliveryJob>, token?: string): Promise<void> {
    const msg = await this.repo.findForDelivery(job.data.messageId);
    if (!msg || msg.status !== 'queued') {
      this.events.emit('delivery_skipped', { messageId: job.data.messageId, outcome: 'info', reason: msg ? `status=${msg.status}` : 'missing' });
      return;
    }
    if (await this.gateway.isPaused()) {
      // Picked up just before a pause: park it without consuming an attempt.
      await job.moveToDelayed(Date.now() + 30_000, token);
      throw new DelayedError();
    }
    const providerName = (msg.provider ?? 'mailpit') as ProviderName;
    const provider = this.providers.get(providerName);
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const keyName = msg.apiKey.name;

    if (!provider) {
      await this.repo.transition(msg.id, ['queued'], 'failed', { lastError: `provider ${providerName} not configured on worker`, attempts: attempt });
      this.events.emit('delivery_failed', { keyName, messageId: msg.id, outcome: 'failure', reason: 'provider_not_configured', provider: providerName });
      throw new UnrecoverableError(`provider ${providerName} not configured`);
    }

    const domain = msg.fromAddress.split('@')[1] ?? 'mail-gateway.local';
    const out: OutboundMessage = {
      gatewayMessageId: msg.id,
      keyName,
      headerMessageId: msg.headerMessageId ?? `<${msg.id}@${domain}>`,
      from: { address: msg.fromAddress, name: msg.fromName },
      to: msg.to,
      cc: msg.cc,
      bcc: msg.bcc,
      replyTo: msg.replyTo,
      subject: msg.subject,
      text: this.crypto.openText(msg.textBody),
      html: this.crypto.openText(msg.htmlBody),
      attachments: msg.attachments
        .filter((a) => a.content)
        .map((a) => ({ filename: a.filename, contentType: a.contentType, content: this.crypto.openBytes(a.content as Uint8Array) })),
      headers: gatewayHeaders(keyName, msg.id),
    };

    await this.repo.update(msg.id, { attempts: attempt, headerMessageId: out.headerMessageId });
    const started = process.hrtime.bigint();
    try {
      const res = await provider.send(out);
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      this.metrics.providerLatency.observe({ provider: providerName, outcome: 'success' }, seconds);
      if (LIVE.includes(providerName)) await this.breaker.recordSuccess(providerName);
      const to = providerName === 'mailpit' ? 'captured' : 'sent';
      await this.repo.transition(
        msg.id,
        ['queued'],
        to,
        { sentAt: new Date(), providerMessageId: res.providerMessageId, providerResponse: res.response.slice(0, 1000), lastError: null },
        { attempt, provider: providerName, response: res.response.slice(0, 500) },
      );
      this.events.emit('delivery_succeeded', { keyName, messageId: msg.id, outcome: 'success', provider: providerName, attempt, status: to, latencyMs: Math.round(seconds * 1000) });
    } catch (err) {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      this.metrics.providerLatency.observe({ provider: providerName, outcome: 'failure' }, seconds);
      const c = provider.classify(err);
      await this.repo.addEvent(msg.id, 'attempt', { attempt, provider: providerName, error: c.message, transient: c.transient });
      if (LIVE.includes(providerName)) await this.breaker.recordFailure(providerName, c.systemic);
      const final = !c.transient || attempt >= maxAttempts;
      if (final) {
        await this.repo.transition(msg.id, ['queued'], 'failed', { lastError: c.message, providerResponse: c.message }, { attempt, provider: providerName, permanent: !c.transient });
        this.events.emit('delivery_failed', { keyName, messageId: msg.id, outcome: 'failure', reason: c.transient ? 'attempts_exhausted' : 'permanent_error', provider: providerName, attempt, error: c.message });
        if (!c.transient) throw new UnrecoverableError(c.message);
        throw err;
      }
      await this.repo.update(msg.id, { lastError: c.message });
      this.events.emit('delivery_retry', { keyName, messageId: msg.id, outcome: 'retry', reason: 'transient_error', provider: providerName, attempt, error: c.message });
      throw err;
    }
  }
}
