// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { instrumentWorker } from '../metrics/worker-instrumentation';
import { WORKER_METRICS } from '../queue/queue-metrics';
import { Worker } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../config/config';
import { AuditChainService } from '../admin/audit-chain.service';
import { AlertsService } from '../alerts/alerts.service';
import { EventLogger } from '../common/event-logger';
import { PrismaService } from '../common/prisma.service';
import { MAINTENANCE_QUEUE, QUEUE_PREFIX, QueueService, redisConnection } from '../queue/queue.service';

/** Daily audit-log retention: purge bodies after N days, delete rows after M days. */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker?: Worker;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly events: EventLogger,
    private readonly chain: AuditChainService,
    private readonly alerts: AlertsService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async onApplicationBootstrap() {
    await this.queues.maintenance.upsertJobScheduler('retention', { pattern: this.cfg.RETENTION_CRON, tz: 'UTC' }, { name: 'retention' });
    this.worker = new Worker(MAINTENANCE_QUEUE, async (job) => (job.name === 'retention' ? this.run() : undefined), {
      connection: redisConnection(this.cfg.REDIS_URL),
      prefix: QUEUE_PREFIX,
      concurrency: 1,
      metrics: WORKER_METRICS,
    });
    this.worker.on('error', () => undefined);
    instrumentWorker(this.worker, MAINTENANCE_QUEUE, this.metrics);
  }

  async onApplicationShutdown() {
    await this.worker?.close();
  }

  async run(now = new Date()) {
    const bodyCutoff = new Date(now.getTime() - this.cfg.AUDIT_BODY_RETENTION_DAYS * 86_400_000);
    const recordCutoff = new Date(now.getTime() - this.cfg.AUDIT_RECORD_RETENTION_DAYS * 86_400_000);

    const purgedBodies = await this.prisma.$executeRaw`
      UPDATE messages SET text_body = NULL, html_body = NULL, body_purged_at = ${now}
      WHERE created_at < ${bodyCutoff} AND body_purged_at IS NULL`;
    const purgedAttachments = await this.prisma.$executeRaw`
      UPDATE message_attachments a SET content = NULL
      FROM messages m WHERE a.message_id = m.id AND m.created_at < ${bodyCutoff} AND a.content IS NOT NULL`;
    const deleted = await this.prisma.message.deleteMany({ where: { createdAt: { lt: recordCutoff } } });
    const deletedStats = await this.prisma.messageStatsHourly.deleteMany({ where: { bucket: { lt: recordCutoff } } });
    // The activity log is a hash chain: pruning moves its anchor instead of breaking it.
    const deletedAudit = await this.chain.prune(recordCutoff);
    const deletedAlerts = await this.prisma.alertEvent.deleteMany({ where: { at: { lt: recordCutoff } } });

    // Daily integrity check of the activity log.
    const chain = await this.chain.verify();
    if (!chain.ok) {
      await this.alerts.raise('audit_chain_broken', `Activity log integrity check failed at row ${chain.brokenAtSeq}`, { reason: chain.reason, row: chain.brokenAtSeq, checked: chain.checked }, 'daily');
    }

    const result = {
      purgedBodies,
      purgedAttachments,
      deletedMessages: deleted.count,
      deletedStats: deletedStats.count,
      deletedAdminAudit: deletedAudit,
      deletedAlerts: deletedAlerts.count,
      auditChainOk: chain.ok,
    };
    this.events.emit('retention_completed', { outcome: chain.ok ? 'success' : 'failure', ...result });
    return result;
  }
}
