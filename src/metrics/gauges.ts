// Authored by Tomás Neto (TN 2026)
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { GatewayStateService } from '../gateway-state/gateway-state.service';
import { QueueInspector } from '../queue/queue-inspector.service';
import { QueueService } from '../queue/queue.service';
import { CircuitBreakerService } from '../worker/circuit-breaker';
import { MetricsService } from './metrics.service';

/** Gauges collected at scrape time in the API process. */
@Injectable()
export class ApiGauges implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly queues: QueueService,
    private readonly gateway: GatewayStateService,
    private readonly prisma: PrismaService,
    private readonly inspector: QueueInspector,
  ) {}

  onModuleInit() {
    this.metrics.gauge('mg_queue_depth', 'Delivery queue jobs by state (kept for existing dashboards; see mg_queue_jobs)', ['state'], async (g) => {
      const counts = await this.queues.depth();
      g.reset();
      for (const [state, n] of Object.entries(counts)) g.set({ state }, n);
    });
    // Every BullMQ queue (delivery, system-mail, alerts, maintenance). One Redis read per scrape (cached 2 s).
    this.metrics.gauge('mg_queue_jobs', 'Jobs per queue and state', ['queue', 'state'], async (g) => {
      const all = await this.inspector.basics();
      g.reset();
      for (const q of all) for (const [state, n] of Object.entries(q.counts)) g.set({ queue: q.name, state }, n);
    });
    this.metrics.gauge('mg_queue_oldest_waiting_seconds', 'Age of the oldest job ready to run (0 when none is waiting)', ['queue'], async (g) => {
      for (const q of await this.inspector.basics()) g.set({ queue: q.name }, q.oldestWaitingSeconds ?? 0);
    });
    this.metrics.gauge('mg_queue_paused', '1 when the queue is paused', ['queue'], async (g) => {
      for (const q of await this.inspector.basics()) g.set({ queue: q.name }, q.paused ? 1 : 0);
    });
    this.metrics.gauge('mg_queue_workers', 'Worker processes connected to the queue', ['queue'], async (g) => {
      for (const q of await this.inspector.basics()) if (q.workers >= 0) g.set({ queue: q.name }, q.workers);
    });
    this.metrics.gauge('mg_gateway_paused', '1 when the gateway is paused', [], async (g) => {
      g.set((await this.gateway.isPaused()) ? 1 : 0);
    });
    this.metrics.gauge('mg_pending_approvals', 'Messages waiting for approval', [], async (g) => {
      g.set(await this.prisma.message.count({ where: { status: 'pending_approval' } }));
    });
  }
}

/** Gauges collected at scrape time in the worker process. */
@Injectable()
export class WorkerGauges implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  onModuleInit() {
    this.metrics.gauge('mg_circuit_breaker_state', 'Circuit breaker state per provider (1 = open/tripped)', ['provider'], async (g) => {
      for (const p of ['smtp', 'resend']) g.set({ provider: p }, (await this.breaker.state(p)) === 'open' ? 1 : 0);
    });
  }
}
