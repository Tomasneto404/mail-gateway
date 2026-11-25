// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig, liveProvidersEnabled } from '../config/config';
import { EventLogger } from '../common/event-logger';
import { GatewayError, isGatewayError } from '../common/errors';
import { ApiKey, DeliveryProvider, MessageSource, MessageStatus, Prisma } from '../generated/prisma/client';
import { GatewayStateService } from '../gateway-state/gateway-state.service';
import { keyWarmup, validateDto } from '../keys/keys.service';
import { MessagesRepository } from '../messages/messages.repository';
import { ClamavService } from '../policy/clamav.service';
import { enforceContent } from '../policy/content-guard';
import { DedupService } from '../policy/dedup.service';
import { IdempotencyService } from '../policy/idempotency.service';
import {
  NormalizedMessage,
  allRecipients,
  computeBodyHash,
  computeDedupHash,
  computeMessageSize,
  enforcePolicy,
} from '../policy/policy-engine';
import { QuotaService, QuotaTicket } from '../policy/quota.service';
import { parseWarmupSchedule } from '../policy/sending-limits';
import { QueueService } from '../queue/queue.service';
import { renderTemplate } from '../templates/template-engine';
import { TemplatesService } from '../templates/templates.service';
import { SendDto } from './send.dto';

export interface SendContext {
  apiKey: ApiKey;
  sourceIp?: string;
  source?: MessageSource;
  idempotencyKey?: string;
}

export interface SendResult {
  id: string;
  status: MessageStatus;
  replayed: boolean;
}

const METADATA_MAX_BYTES = 8 * 1024;
const FROM_FIELDS = ['from', 'fromAddress', 'fromName', 'sender'];

/**
 * THE send pipeline. Every entry point (REST /v1/send, admin "send test email",
 * and any future MCP tool) goes through submit(), so policies are enforced identically.
 */
@Injectable()
export class SendService {
  private readonly warmupSchedule: number[];

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly gateway: GatewayStateService,
    private readonly idempotency: IdempotencyService,
    private readonly dedup: DedupService,
    private readonly quota: QuotaService,
    private readonly repo: MessagesRepository,
    private readonly queues: QueueService,
    private readonly events: EventLogger,
    private readonly templates: TemplatesService,
    private readonly clamav: ClamavService,
  ) {
    this.warmupSchedule = parseWarmupSchedule(cfg.WARMUP_SCHEDULE);
  }

  async submit(ctx: SendContext, raw: unknown): Promise<SendResult> {
    const key = ctx.apiKey;
    let idem: string | undefined;
    let idemReserved = false;
    let dedupHash: string | undefined;
    let ticket: QuotaTicket | undefined;
    let accepted = false;

    try {
      if (await this.gateway.isPaused()) {
        throw new GatewayError(
          'GATEWAY_PAUSED',
          'The mail gateway is paused by an administrator or by the SMTP circuit breaker. Nothing is being accepted; retry later and do not loop.',
          { retryAfterSeconds: 300 },
        );
      }
      if (!key.enabled) {
        throw new GatewayError('KEY_DISABLED', `API key "${key.name}" is disabled. Contact an administrator; do not retry.`);
      }
      if (isObject(raw)) {
        const fromField = FROM_FIELDS.find((f) => f in raw);
        if (fromField) {
          throw new GatewayError(
            'FROM_NOT_ALLOWED',
            `The sender is fixed by your key's policy ("${key.fromName ? `${key.fromName} <${key.fromAddress}>` : key.fromAddress}"). Remove the "${fromField}" field.`,
          );
        }
      }

      idem = IdempotencyService.validate(ctx.idempotencyKey);
      if (idem) {
        const original = await this.idempotency.reserve(key.id, idem);
        if (original) {
          const msg = await this.repo.findById(original);
          if (msg) {
            this.events.emit('message_replayed', { keyName: key.name, messageId: msg.id, outcome: 'info' });
            return { id: msg.id, status: msg.status, replayed: true };
          }
        }
        idemReserved = true;
      }

      const dto = await validateDto(SendDto, raw);
      let templateName: string | null = null;
      if (dto.template) {
        if (dto.subject !== undefined || dto.text !== undefined || dto.html !== undefined) {
          throw new GatewayError('VALIDATION_FAILED', 'With "template", do not send "subject", "text" or "html": they come from the template. Pass values in "variables".');
        }
        const t = await this.templates.forSend(key, dto.template);
        Object.assign(dto, renderTemplate(t, dto.variables));
        templateName = t.name;
      } else {
        if (key.templatesOnly) {
          throw new GatewayError('TEMPLATE_REQUIRED', `Key "${key.name}" may only send server-side templates. Send {"template": "<name>", "variables": {...}}; call GET /v1/templates to list them.`);
        }
        if (dto.variables) throw new GatewayError('VALIDATION_FAILED', '"variables" only applies together with "template".');
      }
      if (!dto.text && !dto.html) {
        throw new GatewayError('VALIDATION_FAILED', 'Provide a body: at least one of "text" or "html" is required.');
      }
      if (dto.metadata && Buffer.byteLength(JSON.stringify(dto.metadata)) > METADATA_MAX_BYTES) {
        throw new GatewayError('VALIDATION_FAILED', `metadata must serialize to at most ${METADATA_MAX_BYTES} bytes of JSON.`);
      }
      const msg = normalize(dto);
      enforcePolicy(key, msg);
      enforceContent(key, msg);
      if (key.scanAttachments) await this.clamav.assertClean(key.name, msg.attachments);
      const provider = this.resolveProvider(key);

      const contentHash = computeDedupHash(key.id, msg);
      // Keys with allowDuplicates skip the claim (the hash is still stored); quotas still apply.
      if (!key.allowDuplicates) {
        dedupHash = contentHash; // set before the claim: a rejected claim is not released below
        await this.dedup.claim(contentHash, key.name);
      }

      const warmup = keyWarmup(key, this.warmupSchedule);
      ticket = await this.quota.consume({
        keyId: key.id,
        keyName: key.name,
        quotaPerHour: key.quotaPerHour,
        quotaPerDay: warmup ? Math.min(key.quotaPerDay, warmup.dailyCap) : key.quotaPerDay,
        warmup: warmup && warmup.dailyCap < key.quotaPerDay ? warmup : null,
      });
      // Shared per-domain caps protect the reputation where mail really leaves (not sandbox).
      if (key.mode !== 'sandbox') await this.quota.consumeDomains(ticket, allRecipients(msg));

      const status: MessageStatus = key.mode === 'approval' ? 'pending_approval' : 'queued';
      const saved = await this.repo.create({
        apiKeyId: key.id,
        status,
        deliveryMode: key.mode,
        provider,
        source: ctx.source ?? 'api',
        fromAddress: key.fromAddress,
        fromName: key.fromName,
        to: msg.to,
        cc: msg.cc,
        bcc: msg.bcc,
        replyTo: msg.replyTo ?? null,
        subject: msg.subject,
        textBody: msg.text ?? null,
        htmlBody: msg.html ?? null,
        templateName,
        bodyHash: computeBodyHash(msg),
        dedupHash: contentHash,
        idempotencyKey: idem ?? null,
        metadata: (dto.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        sourceIp: ctx.sourceIp ?? null,
        sizeBytes: computeMessageSize(msg),
        attachments: msg.attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          sizeBytes: a.content.length,
          content: a.content,
        })),
      });
      accepted = true;

      if (status === 'queued') {
        try {
          await this.queues.enqueueDelivery(saved.id);
        } catch (err) {
          await this.repo.transition(saved.id, ['queued'], 'failed', { lastError: 'enqueue failed' });
          throw new GatewayError('QUEUE_UNAVAILABLE', 'The delivery queue is unavailable. Retry later.', { retryAfterSeconds: 60 });
        }
      }
      if (idem) await this.idempotency.commit(key.id, idem, saved.id);

      this.events.emit('message_accepted', {
        keyName: key.name,
        keyId: key.id,
        messageId: saved.id,
        outcome: 'success',
        status,
        mode: key.mode,
        provider,
        recipients: msg.to.length + msg.cc.length + msg.bcc.length,
        source: ctx.source ?? 'api',
      });
      return { id: saved.id, status, replayed: false };
    } catch (err) {
      if (!accepted) {
        if (ticket) await this.quota.rollback(ticket).catch(() => undefined);
        if (dedupHash && !(isGatewayError(err) && err.code === 'DUPLICATE_MESSAGE')) {
          await this.dedup.release(dedupHash).catch(() => undefined);
        }
      }
      if (idem && idemReserved) await this.idempotency.release(key.id, idem).catch(() => undefined);
      if (isGatewayError(err) && !accepted) await this.recordRejection(ctx, raw, err);
      throw err;
    }
  }

  private resolveProvider(key: ApiKey): DeliveryProvider {
    if (key.mode === 'sandbox') return 'mailpit';
    const p = key.liveProvider ?? this.cfg.LIVE_PROVIDER;
    if (!liveProvidersEnabled(this.cfg).includes(p)) {
      throw new GatewayError(
        'PROVIDER_UNAVAILABLE',
        `Live provider "${p}" configured for key "${key.name}" is not enabled on this gateway. Contact an administrator.`,
      );
    }
    return p;
  }

  /** Every rejection after authentication is persisted to the audit log and logged as `policy_rejected`. */
  private async recordRejection(ctx: SendContext, raw: unknown, err: GatewayError) {
    const key = ctx.apiKey;
    const d = draftFromRaw(raw);
    let messageId: string | undefined;
    try {
      const saved = await this.repo.create({
        apiKeyId: key.id,
        status: 'rejected',
        deliveryMode: key.mode,
        source: ctx.source ?? 'api',
        rejectCode: err.code,
        rejectReason: err.message.slice(0, 2000),
        fromAddress: key.fromAddress,
        fromName: key.fromName,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        replyTo: d.replyTo,
        subject: d.subject,
        textBody: d.text,
        htmlBody: d.html,
        templateName: d.template,
        bodyHash: computeBodyHash({ text: d.text ?? undefined, html: d.html ?? undefined }),
        sourceIp: ctx.sourceIp ?? null,
      });
      messageId = saved.id;
    } catch {
      // never mask the original rejection
    }
    this.events.emit('policy_rejected', {
      keyName: key.name,
      keyId: key.id,
      messageId,
      outcome: 'rejected',
      reason: err.code,
      source: ctx.source ?? 'api',
      ip: ctx.sourceIp,
    });
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalize(dto: SendDto): NormalizedMessage {
  return {
    to: dto.to,
    cc: dto.cc ?? [],
    bcc: dto.bcc ?? [],
    subject: dto.subject,
    text: dto.text,
    html: dto.html,
    replyTo: dto.replyTo,
    attachments: (dto.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType ?? 'application/octet-stream',
      content: Buffer.from(a.content, 'base64'),
    })),
  };
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
const addrList = (v: unknown) =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v])
    .filter((x): x is string => typeof x === 'string')
    .slice(0, 100)
    .map((x) => x.slice(0, 320));

/** Best-effort extraction of whatever the client sent, for the audit row of a rejected request. */
function draftFromRaw(raw: unknown) {
  const r = isObject(raw) ? raw : {};
  return {
    to: addrList(r.to),
    cc: addrList(r.cc),
    bcc: addrList(r.bcc),
    replyTo: str(r.replyTo, 320),
    subject: str(r.subject, 998) ?? '',
    text: str(r.text, 5 * 1024 * 1024),
    html: str(r.html, 5 * 1024 * 1024),
    template: str(r.template, 64),
  };
}
