// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable, Optional } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { Actor, AdminAuditService } from '../admin/admin-audit.service';
import { ApiKey, Prisma } from '../generated/prisma/client';
import { WarmupState, parseWarmupSchedule, warmupState } from '../policy/sending-limits';
import { DomainCheckService } from './domain-check.service';
import { CreateKeyDto, PolicyFieldsDto, RotateKeyDto, UpdateKeyDto } from './keys.dto';
import { displayPrefix, generateApiKey, hashApiKey, safeEqual } from './key-format';

export interface PolicyView {
  id: string;
  name: string;
  description: string;
  keyPrefix: string;
  mode: ApiKey['mode'];
  enabled: boolean;
  fromAddress: string;
  fromName: string | null;
  allowReplyTo: boolean;
  allowedRecipients: string[];
  maxRecipientsPerMessage: number;
  maxMessageBytes: number;
  quotaPerHour: number;
  quotaPerDay: number;
  attachmentsAllowed: boolean;
  maxAttachmentBytes: number;
  liveProvider: ApiKey['liveProvider'];
  allowedIps: string[];
  expiresAt: string | null;
  /** the previous secret keeps working until then (rotation grace period) */
  previousSecretValidUntil: string | null;
  allowedLinkDomains: string[];
  maxLinks: number | null;
  blockSecrets: boolean;
  allowedAttachmentTypes: string[];
  scanAttachments: boolean;
  allowDuplicates: boolean;
  templatesOnly: boolean;
  allowedTemplates: string[];
  warmup: boolean;
  liveSince: string | null;
  /** current warm-up step, null when not warming up */
  warmupState: WarmupState | null;
  /** true when the key prefix (mk_sbx_/mk_live_) no longer matches the mode: rotate recommended. */
  prefixStale: boolean;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Warm-up applies only to keys that send for real, with warm-up on. */
export function keyWarmup(k: Pick<ApiKey, 'mode' | 'warmup' | 'liveSince'>, schedule: number[], now = new Date()): WarmupState | null {
  if (k.mode === 'sandbox' || !k.warmup) return null;
  return warmupState(k.liveSince, schedule, now);
}

export function toPolicyView(k: ApiKey, warmupSchedule: number[] = []): PolicyView {
  const issuedLive = k.keyPrefix.startsWith('mk_live_');
  const graceOpen = k.prevKeyExpiresAt && k.prevKeyExpiresAt.getTime() > Date.now();
  return {
    id: k.id,
    name: k.name,
    description: k.description,
    keyPrefix: k.keyPrefix,
    mode: k.mode,
    enabled: k.enabled,
    fromAddress: k.fromAddress,
    fromName: k.fromName,
    allowReplyTo: k.allowReplyTo,
    allowedRecipients: k.allowedRecipients,
    maxRecipientsPerMessage: k.maxRecipientsPerMessage,
    maxMessageBytes: k.maxMessageBytes,
    quotaPerHour: k.quotaPerHour,
    quotaPerDay: k.quotaPerDay,
    attachmentsAllowed: k.attachmentsAllowed,
    maxAttachmentBytes: k.maxAttachmentBytes,
    liveProvider: k.liveProvider,
    allowedIps: k.allowedIps,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    previousSecretValidUntil: graceOpen ? k.prevKeyExpiresAt!.toISOString() : null,
    allowedLinkDomains: k.allowedLinkDomains,
    maxLinks: k.maxLinks,
    blockSecrets: k.blockSecrets,
    allowedAttachmentTypes: k.allowedAttachmentTypes,
    scanAttachments: k.scanAttachments,
    allowDuplicates: k.allowDuplicates,
    templatesOnly: k.templatesOnly,
    allowedTemplates: k.allowedTemplates,
    warmup: k.warmup,
    liveSince: k.liveSince?.toISOString() ?? null,
    warmupState: keyWarmup(k, warmupSchedule),
    prefixStale: issuedLive !== (k.mode !== 'sandbox'),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    rotatedAt: k.rotatedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
    updatedAt: k.updatedAt.toISOString(),
  };
}

export async function validateDto<T extends object>(cls: new () => T, body: unknown): Promise<T> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new GatewayError('VALIDATION_FAILED', 'Request body must be a JSON object.');
  }
  const inst = plainToInstance(cls, body);
  const errors = await validate(inst, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length) {
    const problems = errors.flatMap((e) =>
      e.constraints ? Object.values(e.constraints) : (e.children ?? []).flatMap((c) => Object.values(c.constraints ?? {}).map((m) => `${e.property}: ${m}`)),
    );
    throw new GatewayError('VALIDATION_FAILED', `Invalid request: ${problems.join('; ')}`, { problems });
  }
  return inst;
}

export interface ListKeysQuery {
  q?: string;
  mode?: ApiKey['mode'];
  enabled?: boolean;
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'createdAt' | 'lastUsedAt';
  order?: 'asc' | 'desc';
}

@Injectable()
export class KeysService {
  readonly warmupSchedule: number[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Optional() private readonly domains?: DomainCheckService,
  ) {
    this.warmupSchedule = parseWarmupSchedule(cfg.WARMUP_SCHEDULE);
  }

  view(k: ApiKey): PolicyView {
    return toPolicyView(k, this.warmupSchedule);
  }

  /**
   * Bearer secret → active (non-deleted) key, or null. The previous secret of a rotated key is
   * accepted until its grace period ends (`viaPrevious`).
   */
  async authenticate(secret: string): Promise<(ApiKey & { viaPrevious?: boolean }) | null> {
    if (!secret || secret.length > 200) return null;
    const hash = hashApiKey(secret);
    let key: ApiKey | null = await this.prisma.apiKey.findUnique({ where: { keyHash: hash } });
    let viaPrevious = false;
    if (!key) {
      const prev = await this.prisma.apiKey.findUnique({ where: { prevKeyHash: hash } });
      if (prev?.prevKeyHash && prev.prevKeyExpiresAt && prev.prevKeyExpiresAt.getTime() > Date.now() && safeEqual(hash, prev.prevKeyHash)) {
        key = prev;
        viaPrevious = true;
      }
    } else if (!safeEqual(hash, key.keyHash)) {
      return null;
    }
    if (!key || key.deletedAt) return null;
    // Throttled last-used update (at most once per minute).
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
      void this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return viaPrevious ? { ...key, viaPrevious } : key;
  }

  async create(body: unknown, actor: Actor): Promise<{ key: PolicyView; secret: string }> {
    const dto = await validateDto(CreateKeyDto, body);
    if (!dto.fromAddress) throw new GatewayError('VALIDATION_FAILED', 'fromAddress is required when creating a key.');
    const exists = await this.prisma.apiKey.findUnique({ where: { name: dto.name } });
    if (exists) throw new GatewayError('CONFLICT', `A key named "${dto.name}" already exists.`);
    const mode = dto.mode ?? 'sandbox';
    if (mode !== 'sandbox') await this.domains?.assertReadyForLive(dto.fromAddress);
    const secret = generateApiKey(mode);
    const key = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        description: dto.description ?? '',
        keyHash: hashApiKey(secret),
        keyPrefix: displayPrefix(secret),
        mode,
        enabled: dto.enabled ?? true,
        fromAddress: dto.fromAddress,
        fromName: dto.fromName ?? null,
        allowReplyTo: dto.allowReplyTo ?? false,
        allowedRecipients: dedupe(dto.allowedRecipients ?? []),
        maxRecipientsPerMessage: dto.maxRecipientsPerMessage ?? this.cfg.DEFAULT_MAX_RECIPIENTS,
        maxMessageBytes: dto.maxMessageBytes ?? this.cfg.DEFAULT_MAX_MESSAGE_BYTES,
        quotaPerHour: dto.quotaPerHour ?? this.cfg.DEFAULT_QUOTA_PER_HOUR,
        quotaPerDay: dto.quotaPerDay ?? this.cfg.DEFAULT_QUOTA_PER_DAY,
        attachmentsAllowed: dto.attachmentsAllowed ?? false,
        maxAttachmentBytes: dto.maxAttachmentBytes ?? this.cfg.DEFAULT_MAX_ATTACHMENT_BYTES,
        liveProvider: dto.liveProvider ?? null,
        allowedIps: dedupeKeepCase(dto.allowedIps ?? []),
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        allowedLinkDomains: dedupe(dto.allowedLinkDomains ?? []),
        maxLinks: dto.maxLinks ?? null,
        blockSecrets: dto.blockSecrets ?? true,
        allowedAttachmentTypes: dedupe(dto.allowedAttachmentTypes ?? []),
        scanAttachments: dto.scanAttachments ?? false,
        allowDuplicates: dto.allowDuplicates ?? false,
        templatesOnly: dto.templatesOnly ?? false,
        allowedTemplates: dedupeKeepCase(dto.allowedTemplates ?? []),
        warmup: dto.warmup ?? true,
        liveSince: mode !== 'sandbox' ? new Date() : null,
      },
    });
    await this.audit.record(actor, {
      action: 'key.create',
      targetType: 'api_key',
      targetId: key.id,
      details: { name: key.name, mode: key.mode },
    });
    return { key: this.view(key), secret };
  }

  async update(id: string, body: unknown, actor: Actor): Promise<PolicyView> {
    const dto = await validateDto(UpdateKeyDto, body);
    const before = await this.getActive(id);
    const data: Prisma.ApiKeyUpdateInput = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of Object.keys(dto) as Array<keyof PolicyFieldsDto>) {
      const v = dto[field];
      if (v === undefined) continue;
      let next: unknown = v;
      if (field === 'allowedRecipients' || field === 'allowedLinkDomains' || field === 'allowedAttachmentTypes') next = dedupe(v as string[]);
      else if (field === 'allowedIps' || field === 'allowedTemplates') next = dedupeKeepCase(v as string[]);
      else if (field === 'expiresAt') next = v === null ? null : new Date(v as string);
      const prev = before[field as keyof ApiKey];
      const same = next instanceof Date || prev instanceof Date ? (prev as Date | null)?.getTime() === (next as Date | null)?.getTime() : JSON.stringify(prev) === JSON.stringify(next);
      if (same) continue;
      (data as Record<string, unknown>)[field] = next;
      changes[field] = { from: prev, to: next };
    }
    if (!Object.keys(changes).length) return this.view(before);
    if (changes.mode && before.mode === 'sandbox' && changes.mode.to !== 'sandbox') {
      await this.domains?.assertReadyForLive((data.fromAddress as string | undefined) ?? before.fromAddress);
      // First time out of sandbox: the warm-up starts now.
      if (!before.liveSince) data.liveSince = new Date();
    }
    const key = await this.prisma.apiKey.update({ where: { id }, data });
    const action = changes.mode
      ? changes.mode.to === 'live'
        ? 'key.promote_live'
        : 'key.mode_change'
      : changes.enabled
        ? key.enabled
          ? 'key.enable'
          : 'key.disable'
        : 'key.policy_update';
    await this.audit.record(actor, { action, targetType: 'api_key', targetId: id, details: { name: key.name, changes } });
    return this.view(key);
  }

  async setEnabled(id: string, enabled: boolean, actor: Actor): Promise<PolicyView> {
    return this.update(id, { enabled }, actor);
  }

  /** New secret. With `graceMinutes` the previous secret keeps working that long, so clients can switch without downtime. */
  async rotate(id: string, actor: Actor, body: unknown = {}): Promise<{ key: PolicyView; secret: string }> {
    const { graceMinutes = 0 } = await validateDto(RotateKeyDto, body ?? {});
    const before = await this.getActive(id);
    const secret = generateApiKey(before.mode);
    const key = await this.prisma.apiKey.update({
      where: { id },
      data: {
        keyHash: hashApiKey(secret),
        keyPrefix: displayPrefix(secret),
        rotatedAt: new Date(),
        prevKeyHash: graceMinutes > 0 ? before.keyHash : null,
        prevKeyExpiresAt: graceMinutes > 0 ? new Date(Date.now() + graceMinutes * 60_000) : null,
      },
    });
    await this.audit.record(actor, { action: 'key.rotate', targetType: 'api_key', targetId: id, details: { name: key.name, graceMinutes } });
    return { key: this.view(key), secret };
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const k = await this.getActive(id);
    await this.prisma.apiKey.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        enabled: false,
        name: `${k.name}~deleted~${id.slice(-8)}`,
        keyHash: `deleted:${id}`,
        prevKeyHash: null,
        prevKeyExpiresAt: null,
      },
    });
    await this.audit.record(actor, { action: 'key.delete', targetType: 'api_key', targetId: id, details: { name: k.name } });
  }

  async getActive(id: string): Promise<ApiKey> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GatewayError('KEY_NOT_FOUND', `API key ${id} not found.`);
    const k = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!k || k.deletedAt) throw new GatewayError('KEY_NOT_FOUND', `API key ${id} not found.`);
    return k;
  }

  async findByName(name: string): Promise<ApiKey> {
    const k = await this.prisma.apiKey.findUnique({ where: { name } });
    if (!k || k.deletedAt) throw new GatewayError('KEY_NOT_FOUND', `API key "${name}" not found.`);
    return k;
  }

  async list(q: ListKeysQuery = {}) {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const where: Prisma.ApiKeyWhereInput = {
      deletedAt: null,
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] } : {}),
      ...(q.mode ? { mode: q.mode } : {}),
      ...(q.enabled !== undefined ? { enabled: q.enabled } : {}),
    };
    const sort = q.sort ?? 'name';
    const order = q.order ?? (sort === 'name' ? 'asc' : 'desc');
    const [items, total] = await Promise.all([
      this.prisma.apiKey.findMany({
        where,
        orderBy: sort === 'lastUsedAt' ? { lastUsedAt: { sort: order, nulls: 'last' } } : { [sort]: order },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.apiKey.count({ where }),
    ]);
    return { items: items.map((k) => this.view(k)), total, page, pageSize };
  }
}

function dedupe(a: string[]): string[] {
  return [...new Set(a.map((s) => s.trim().toLowerCase()))];
}

function dedupeKeepCase(a: string[]): string[] {
  return [...new Set(a.map((s) => s.trim()))];
}
