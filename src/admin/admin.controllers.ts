// Authored by Tomás Neto (TN 2026)
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RolesService } from '../auth/roles.service';
import { UsersService } from '../auth/users.service';
import { APP_CONFIG, AppConfig, systemMailProvider } from '../config/config';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { GatewayStateService } from '../gateway-state/gateway-state.service';
import { AlertsService } from '../alerts/alerts.service';
import { DomainCheckService } from '../keys/domain-check.service';
import { CreateKeyDto, KEY_MODES, RotateKeyDto, UpdateKeyDto } from '../keys/keys.dto';
import { parseDomainLimits, parseWarmupSchedule } from '../policy/sending-limits';
import { AuditChainService } from './audit-chain.service';
import { KeysService } from '../keys/keys.service';
import { QuotaService } from '../policy/quota.service';
import { QueueInspector } from '../queue/queue-inspector.service';
import { SendAcceptedDto } from '../send/send.dto';
import { SendService } from '../send/send.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuthGuard, AdminRequest, RequirePermission, can } from './admin-auth.guard';
import { AdminMessagesService } from './admin-messages.service';
import { SandboxInboxService, UpdateSandboxSettingsDto } from './sandbox-inbox.service';
import { ExportService } from './export.service';
import { auditWhere, parseAuditQuery, parseMessageQuery, qUuid } from './filters';
import type { CsvDelimiter } from '../common/csv';
import {
  AuditListDto,
  AuditVerifyDto,
  DomainCheckDto,
  BulkResultDto,
  CreateRoleDto,
  GatewayStateDto,
  InviteLinkDto,
  InviteResultDto,
  InviteUserDto,
  KeyCreatedDto,
  KeyDto,
  KeyListDto,
  KeyWithUsageDto,
  MessageActionDto,
  MessageDetailDto,
  MessageListDto,
  PermissionDto,
  RoleDto,
  RoleListDto,
  QueuesOverviewDto,
  SandboxInboxDto,
  SandboxSettingsDto,
  SettingsDto,
  StatsOverviewDto,
  SystemStateDto,
  TestSendDto,
  UpdateRoleDto,
  UpdateUserDto,
  UserDto,
  UserListDto,
} from './admin.dto';
import { qBool, qDate, qEnum, qInt, qList, qStr } from './query';
import { StatsService } from './stats.service';

/** Shared decorators for every admin controller. */
function AdminController(path: string) {
  const ctrl = Controller(path);
  const tags = ApiTags('admin');
  const bearer = ApiBearerAuth('admin');
  const cookie = ApiCookieAuth('session');
  const guard = UseGuards(AdminAuthGuard);
  return (target: object) => {
    for (const d of [ctrl, tags, bearer, cookie, guard]) (d as ClassDecorator)(target as never);
  };
}

const PAGE_QUERIES = [
  ApiQuery({ name: 'page', required: false, type: Number }),
  ApiQuery({ name: 'pageSize', required: false, type: Number }),
  ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] }),
];
function Paged(): MethodDecorator {
  return (t, k, d) => {
    for (const q of PAGE_QUERIES) q(t, k, d);
  };
}

// ---------------------------------------------------------------- keys
@AdminController('admin/keys')
export class AdminKeysController {
  constructor(
    private readonly keys: KeysService,
    private readonly quota: QuotaService,
    private readonly send: SendService,
    private readonly audit: AdminAuditService,
    private readonly domains: DomainCheckService,
  ) {}

  @Get()
  @RequirePermission('keys:read')
  @ApiOperation({ operationId: 'adminListKeys', summary: 'List API keys with current hour/day usage' })
  @Paged()
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'mode', required: false, enum: KEY_MODES })
  @ApiQuery({ name: 'enabled', required: false, type: Boolean })
  @ApiQuery({ name: 'sort', required: false, enum: ['name', 'createdAt', 'lastUsedAt'] })
  @ApiOkResponse({ type: KeyListDto })
  async list(@Query() q: Record<string, string>) {
    const res = await this.keys.list({
      q: qStr(q.q),
      mode: qEnum(q.mode, KEY_MODES),
      enabled: qBool(q.enabled),
      page: qInt(q.page),
      pageSize: qInt(q.pageSize),
      sort: qEnum(q.sort, ['name', 'createdAt', 'lastUsedAt'] as const),
      order: qEnum(q.order, ['asc', 'desc'] as const),
    });
    const usage = await this.quota.usage(res.items.map((k) => k.id));
    return { ...res, items: res.items.map((k) => ({ ...k, usage: usage[k.id] ?? { hour: 0, day: 0 } })) };
  }

  @Post()
  @RequirePermission('keys:create')
  @ApiOperation({ operationId: 'adminCreateKey', summary: 'Create an API key. The secret is returned ONCE.' })
  @ApiBody({ type: CreateKeyDto })
  @ApiCreatedResponse({ type: KeyCreatedDto })
  create(@Req() req: AdminRequest, @Body() body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    // Creating a key directly in live/approval mode is equivalent to promoting it.
    if ((b.mode === 'live' || b.mode === 'approval') && !can(req.actor, 'keys:promote')) {
      throw new GatewayError('FORBIDDEN', `Missing permission keys:promote to create a key in ${String(b.mode)} mode. Create it in sandbox mode instead.`, {
        required: ['keys:promote'],
      });
    }
    return this.keys.create(body, req.actor);
  }

  @Get(':id')
  @RequirePermission('keys:read')
  @ApiOperation({ operationId: 'adminGetKey' })
  @ApiOkResponse({ type: KeyWithUsageDto })
  async get(@Param('id') id: string) {
    const k = this.keys.view(await this.keys.getActive(id));
    const usage = (await this.quota.usage([id]))[id];
    return { ...k, usage };
  }

  @Get(':id/domain-check')
  @RequirePermission('keys:read')
  @ApiOperation({ operationId: 'adminKeyDomainCheck', summary: 'SPF / DMARC / DKIM of the key sender domain (SENDER_DOMAIN_CHECKS; cached 1 h, ?fresh=1 to recheck).' })
  @ApiQuery({ name: 'fresh', required: false, enum: ['0', '1'] })
  @ApiOkResponse({ type: DomainCheckDto })
  async domainCheck(@Param('id') id: string, @Query('fresh') fresh?: string) {
    if (this.domains.mode === 'off') throw new GatewayError('INVALID_STATE', 'Sender domain checks are off (SENDER_DOMAIN_CHECKS=off).');
    const k = await this.keys.getActive(id);
    return this.domains.check(k.fromAddress.slice(k.fromAddress.lastIndexOf('@') + 1), fresh === '1');
  }

  @Patch(':id')
  @RequirePermission('keys:update', 'keys:promote', 'keys:disable')
  @ApiOperation({ operationId: 'adminUpdateKey', summary: 'Update policy fields (mode, recipients, quotas, ...). Takes effect immediately.' })
  @ApiBody({ type: UpdateKeyDto })
  @ApiOkResponse({ type: KeyDto })
  async update(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const current = await this.keys.getActive(id);
    const need = (perm: string, what: string) => {
      if (!can(req.actor, perm)) throw new GatewayError('FORBIDDEN', `Missing permission ${perm} to ${what}.`, { required: [perm] });
    };
    if (b.mode !== undefined && b.mode !== current.mode) {
      // leaving sandbox (to live or approval) can send real mail: separate permission
      if (b.mode === 'live' || b.mode === 'approval') need('keys:promote', `change the mode to ${String(b.mode)}`);
      else need('keys:update', 'change the mode');
    }
    if (b.enabled !== undefined && b.enabled !== current.enabled) need('keys:disable', 'enable or disable the key');
    const other = Object.keys(b).filter((k) => k !== 'mode' && k !== 'enabled');
    if (other.length) need('keys:update', `change ${other.join(', ')}`);
    return this.keys.update(id, body, req.actor);
  }

  @Post(':id/rotate')
  @HttpCode(200)
  @RequirePermission('keys:rotate')
  @ApiOperation({
    operationId: 'adminRotateKey',
    summary: 'Rotate the secret; the new one is returned ONCE. The old secret stops immediately, or after graceMinutes.',
  })
  @ApiBody({ type: RotateKeyDto, required: false })
  @ApiOkResponse({ type: KeyCreatedDto })
  rotate(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.keys.rotate(id, req.actor, body ?? {});
  }

  @Post(':id/enable')
  @HttpCode(200)
  @RequirePermission('keys:disable')
  @ApiOperation({ operationId: 'adminEnableKey' })
  @ApiOkResponse({ type: KeyDto })
  enable(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.keys.setEnabled(id, true, req.actor);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @RequirePermission('keys:disable')
  @ApiOperation({ operationId: 'adminDisableKey', summary: 'Kill switch for one key.' })
  @ApiOkResponse({ type: KeyDto })
  disable(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.keys.setEnabled(id, false, req.actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('keys:delete')
  @ApiOperation({ operationId: 'adminDeleteKey' })
  async remove(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.keys.remove(id, req.actor);
  }

  @Post(':id/test-send')
  @HttpCode(202)
  @RequirePermission('keys:test_send')
  @ApiOperation({ operationId: 'adminTestSend', summary: 'Send a test email through the normal pipeline using this key (policy fully enforced).' })
  @ApiBody({ type: TestSendDto })
  @ApiAcceptedResponse({ type: SendAcceptedDto })
  async testSend(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: TestSendDto) {
    const key = await this.keys.getActive(id);
    const subject = typeof body?.subject === 'string' && body.subject ? body.subject : `mail-gateway test (${key.name})`;
    const text =
      typeof body?.text === 'string' && body.text ? body.text : `Test message sent by ${req.actor.label} via the mail-gateway admin UI for key "${key.name}" (${key.mode}).`;
    try {
      const r = await this.send.submit({ apiKey: key, sourceIp: req.actor.ip, source: 'admin_test' }, { to: body?.to, subject, text });
      await this.audit.record(req.actor, { action: 'key.test_send', targetType: 'api_key', targetId: id, details: { name: key.name, messageId: r.id, status: r.status } });
      return { id: r.id, status: r.status };
    } catch (e) {
      if (e instanceof GatewayError) {
        await this.audit.record(req.actor, { action: 'key.test_send', outcome: 'failure', targetType: 'api_key', targetId: id, details: { name: key.name, code: e.code } });
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- messages
class RejectBody {
  @ApiPropertyOptional({ description: 'Shown to the client as rejectReason.' })
  reason?: string;
}
class BulkBody {
  @ApiProperty({ type: [String], description: 'Message ids (max 500).' })
  ids!: string[];
  @ApiPropertyOptional({ description: 'Reject reason (reject only).' })
  reason?: string;
}

function delimiterOf(q: Record<string, string>): CsvDelimiter {
  return qEnum(q.delimiter, ['comma', 'semicolon'] as const) === 'semicolon' ? ';' : ',';
}

function validIds(body: BulkBody): string[] {
  if (!body || !Array.isArray(body.ids) || !body.ids.every((i) => typeof i === 'string')) {
    throw new GatewayError('VALIDATION_FAILED', 'Body must be { "ids": string[] }.');
  }
  return body.ids;
}

/** CSP for rendering untrusted email HTML: no scripts, no network except (optionally) images. */
export function previewCsp(remoteImages: boolean) {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data: cid:${remoteImages ? ' https: http:' : ''}`,
    'font-src data:',
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    'sandbox',
  ].join('; ');
}

/** Removes constructs that could navigate the frame without user interaction. Scripts are already blocked by CSP + sandbox. */
export function neutralizeHtml(html: string): string {
  return html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '').replace(/<base\b[^>]*>/gi, '');
}

@AdminController('admin/messages')
export class AdminMessagesController {
  constructor(
    private readonly messages: AdminMessagesService,
    private readonly exports: ExportService,
    private readonly sandbox: SandboxInboxService,
  ) {}

  // Mailpit shows full bodies without the gateway's access control, so only body readers get the link.
  @Get('sandbox-inbox')
  @RequirePermission('messages:bodies')
  @ApiOperation({ operationId: 'adminSandboxInbox', summary: 'Mailpit (sandbox inbox): whether it is configured and reachable, its URL and message count' })
  @ApiOkResponse({ type: SandboxInboxDto })
  sandboxInbox() {
    return this.sandbox.get();
  }

  @Get()
  @RequirePermission('messages:read')
  @ApiOperation({ operationId: 'adminListMessages', summary: 'Search messages (status, key, recipient, subject, date range)' })
  @Paged()
  @ApiQuery({ name: 'status', required: false, description: 'Comma list of queued, pending_approval, sent, failed, rejected, captured' })
  @ApiQuery({ name: 'keyId', required: false })
  @ApiQuery({ name: 'recipient', required: false })
  @ApiQuery({ name: 'subject', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date' })
  @ApiQuery({ name: 'sort', required: false, enum: ['createdAt', 'status', 'subject'] })
  @ApiOkResponse({ type: MessageListDto })
  list(@Query() q: Record<string, string>) {
    return this.messages.list(parseMessageQuery(q));
  }

  @Get('export.csv')
  @RequirePermission('messages:read')
  @ApiOperation({
    operationId: 'adminExportMessages',
    summary: 'Export messages as CSV (same filters as the list; e.g. keyId for one API key). Metadata only, never bodies.',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'keyId', required: false })
  @ApiQuery({ name: 'recipient', required: false })
  @ApiQuery({ name: 'subject', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'delimiter', required: false, enum: ['comma', 'semicolon'], description: 'semicolon for Excel in locales using a decimal comma' })
  @ApiProduces('text/csv')
  async export(@Req() req: AdminRequest, @Query() q: Record<string, string>, @Res() res: Response) {
    await this.exports.messages(parseMessageQuery(q), delimiterOf(q), req.actor, res);
  }

  @Get(':id')
  @RequirePermission('messages:read')
  @ApiOperation({ operationId: 'adminGetMessage', summary: 'Message detail. Bodies are null for viewers without canViewBodies.' })
  @ApiOkResponse({ type: MessageDetailDto })
  get(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.messages.get(id, { includeBodies: can(req.actor, 'messages:bodies') });
  }

  @Get(':id/preview')
  @RequirePermission('messages:bodies')
  @ApiOperation({ operationId: 'adminPreviewMessage', summary: 'HTML body for a sandboxed iframe (strict CSP; remote images blocked unless remoteImages=1).' })
  @ApiQuery({ name: 'remoteImages', required: false, enum: ['0', '1'] })
  @ApiProduces('text/html')
  async preview(@Req() req: AdminRequest, @Param('id') id: string, @Query('remoteImages') remote: string | undefined, @Res() res: Response) {
    const html = await this.messages.htmlBody(id);
    res.setHeader('Content-Security-Policy', previewCsp(remote === '1'));
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html').send(html ? neutralizeHtml(html) : '<!doctype html><p style="font-family:sans-serif;color:#888">No HTML body.</p>');
  }

  @Post('approve')
  @HttpCode(200)
  @RequirePermission('approvals:decide')
  @ApiOperation({ operationId: 'adminBulkApprove' })
  @ApiOkResponse({ type: BulkResultDto })
  bulkApprove(@Req() req: AdminRequest, @Body() body: BulkBody) {
    return this.messages.bulk(validIds(body), (id) => this.messages.approve(id, req.actor));
  }

  @Post('reject')
  @HttpCode(200)
  @RequirePermission('approvals:decide')
  @ApiOperation({ operationId: 'adminBulkReject' })
  @ApiOkResponse({ type: BulkResultDto })
  bulkReject(@Req() req: AdminRequest, @Body() body: BulkBody) {
    return this.messages.bulk(validIds(body), (id) => this.messages.reject(id, body?.reason, req.actor));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('approvals:decide')
  @ApiOperation({ operationId: 'adminApproveMessage' })
  @ApiOkResponse({ type: MessageActionDto })
  approve(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.messages.approve(id, req.actor);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('approvals:decide')
  @ApiOperation({ operationId: 'adminRejectMessage' })
  @ApiOkResponse({ type: MessageActionDto })
  reject(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: RejectBody) {
    return this.messages.reject(id, typeof body?.reason === 'string' ? body.reason : undefined, req.actor);
  }
}

// ---------------------------------------------------------------- gateway + stats
class PauseBody {
  @ApiPropertyOptional({ description: 'Why the gateway is paused (shown in the UI and audit log).' })
  reason?: string;
}

@AdminController('admin/gateway')
export class AdminGatewayController {
  constructor(private readonly gateway: GatewayStateService) {}

  @Get()
  @RequirePermission('dashboard:read')
  @ApiOperation({ operationId: 'adminGatewayState' })
  @ApiOkResponse({ type: GatewayStateDto })
  state() {
    return this.gateway.get();
  }

  @Post('pause')
  @HttpCode(200)
  @RequirePermission('gateway:pause')
  @ApiOperation({ operationId: 'adminPauseGateway', summary: 'Stop accepting and delivering mail.' })
  @ApiOkResponse({ type: GatewayStateDto })
  pause(@Req() req: AdminRequest, @Body() body: PauseBody) {
    return this.gateway.pause(typeof body?.reason === 'string' && body.reason ? body.reason.slice(0, 500) : 'manual', req.actor);
  }

  @Post('resume')
  @HttpCode(200)
  @RequirePermission('gateway:pause')
  @ApiOperation({ operationId: 'adminResumeGateway', summary: 'Resume and reset circuit breakers.' })
  @ApiOkResponse({ type: GatewayStateDto })
  resume(@Req() req: AdminRequest) {
    return this.gateway.resume(req.actor);
  }
}

@AdminController('admin/stats')
export class AdminStatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('overview')
  @RequirePermission('dashboard:read', 'keys:read')
  @ApiOperation({ operationId: 'adminStatsOverview', summary: 'Time series + breakdowns from the hourly roll-up' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'bucket', required: false, enum: ['hour', 'day'] })
  @ApiQuery({ name: 'keyId', required: false })
  @ApiOkResponse({ type: StatsOverviewDto })
  overview(@Query() q: Record<string, string>) {
    return this.stats.overview({ from: qDate(q.from), to: qDate(q.to), bucket: qEnum(q.bucket, ['hour', 'day'] as const), keyId: qUuid(q.keyId, 'keyId') });
  }

  @Get('system')
  @RequirePermission('dashboard:read')
  @ApiOperation({ operationId: 'adminSystemState', summary: 'Gateway state, breakers, queue depth, pending approvals, SMTP health' })
  @ApiOkResponse({ type: SystemStateDto })
  system() {
    return this.stats.system();
  }
}

@AdminController('admin/queues')
export class AdminQueuesController {
  constructor(private readonly inspector: QueueInspector) {}

  @Get()
  @RequirePermission('dashboard:read')
  @ApiOperation({
    operationId: 'adminQueues',
    summary: 'BullMQ queues: job counts, workers, oldest waiting job, throughput, wait/run times, recent failures',
  })
  @ApiOkResponse({ type: QueuesOverviewDto })
  overview(@Req() req: AdminRequest) {
    return this.inspector.overview((perm) => can(req.actor, perm));
  }
}

// ---------------------------------------------------------------- users (admin only)
@AdminController('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('users:read')
  @ApiOperation({ operationId: 'adminListUsers' })
  @ApiOkResponse({ type: UserListDto })
  list() {
    return this.users.list();
  }

  @Post()
  @RequirePermission('users:manage')
  @ApiOperation({ operationId: 'adminInviteUser', summary: 'Create a local user and return a one-time invite link (shown once).' })
  @ApiBody({ type: InviteUserDto })
  @ApiCreatedResponse({ type: InviteResultDto })
  invite(@Req() req: AdminRequest, @Body() body: Record<string, unknown>) {
    return this.users.invite(body ?? {}, req.actor, req.headers.origin);
  }

  @Patch(':id')
  @RequirePermission('users:manage')
  @ApiOperation({ operationId: 'adminUpdateUser', summary: 'Change role/body access, enable/disable.' })
  @ApiBody({ type: UpdateUserDto })
  @ApiOkResponse({ type: UserDto })
  update(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.users.update(id, body ?? {}, req.actor);
  }

  @Post(':id/reset-2fa')
  @HttpCode(200)
  @RequirePermission('users:manage')
  @ApiOperation({ operationId: 'adminResetUserTotp', summary: 'Force TOTP re-enrollment at next login (signs the user out).' })
  @ApiOkResponse({ type: UserDto })
  resetTotp(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.users.resetTotp(id, req.actor);
  }

  @Post(':id/reset-access')
  @HttpCode(200)
  @RequirePermission('users:manage')
  @ApiOperation({ operationId: 'adminResetUserAccess', summary: 'Clear password + TOTP and issue a new invite link.' })
  @ApiOkResponse({ type: InviteLinkDto })
  resetAccess(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.users.resetAccess(id, req.actor, req.headers.origin);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('users:manage')
  @ApiOperation({ operationId: 'adminDeleteUser' })
  async remove(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.users.remove(id, req.actor);
  }
}

// ---------------------------------------------------------------- roles
@AdminController('admin/roles')
export class AdminRolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission('users:read', 'roles:manage')
  @ApiOperation({ operationId: 'adminListRoles' })
  @ApiOkResponse({ type: RoleListDto })
  list() {
    return this.roles.list();
  }

  @Get('permissions')
  @RequirePermission('users:read', 'roles:manage')
  @ApiOperation({ operationId: 'adminListPermissions', summary: 'Permission catalog' })
  @ApiOkResponse({ type: [PermissionDto] })
  permissions() {
    return this.roles.catalog();
  }

  @Post()
  @RequirePermission('roles:manage')
  @ApiOperation({ operationId: 'adminCreateRole', summary: 'Create a role. You can only grant permissions you hold.' })
  @ApiBody({ type: CreateRoleDto })
  @ApiCreatedResponse({ type: RoleDto })
  create(@Req() req: AdminRequest, @Body() body: Record<string, unknown>) {
    return this.roles.create(body, req.actor);
  }

  @Patch(':id')
  @RequirePermission('roles:manage')
  @ApiOperation({ operationId: 'adminUpdateRole', summary: 'Edit a role (not the built-in Admin). Changes apply immediately to every member.' })
  @ApiBody({ type: UpdateRoleDto })
  @ApiOkResponse({ type: RoleDto })
  update(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.roles.update(id, body, req.actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('roles:manage')
  @ApiOperation({ operationId: 'adminDeleteRole', summary: 'Delete a custom role (built-in roles cannot be deleted).' })
  async remove(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.roles.remove(id, req.actor);
  }
}

// ---------------------------------------------------------------- activity + settings
@AdminController('admin/audit')
export class AdminAuditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exports: ExportService,
    private readonly chain: AuditChainService,
    private readonly alerts: AlertsService,
  ) {}

  @Get('verify')
  @RequirePermission('audit:read')
  @ApiOperation({
    operationId: 'adminVerifyAudit',
    summary: 'Integrity check of the activity log hash chain. Record headSeq/headHash elsewhere to also detect removal of the newest rows.',
  })
  @ApiOkResponse({ type: AuditVerifyDto })
  async verify(): Promise<AuditVerifyDto> {
    const r = await this.chain.verify();
    if (!r.ok) {
      await this.alerts.raise('audit_chain_broken', `Activity log integrity check failed at row ${r.brokenAtSeq}`, { reason: r.reason, row: r.brokenAtSeq, checked: r.checked }, 'on-demand');
    }
    return r;
  }

  @Get()
  @RequirePermission('audit:read')
  @ApiOperation({ operationId: 'adminListAudit', summary: 'Admin activity log (general, per user via actorId, per API key via keyId)' })
  @Paged()
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'actor', required: false })
  @ApiQuery({ name: 'actorType', required: false, enum: ['user', 'token', 'cli', 'system'] })
  @ApiQuery({ name: 'actorId', required: false, description: 'Activity performed by this admin user' })
  @ApiQuery({ name: 'keyId', required: false, description: 'Activity performed on this API key' })
  @ApiQuery({ name: 'outcome', required: false, enum: ['success', 'failure'] })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiOkResponse({ type: AuditListDto })
  async list(@Query() raw: Record<string, string>) {
    const q = parseAuditQuery(raw);
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const where = auditWhere(q);
    const order = q.order ?? 'desc';
    const [rows, total, actions] = await Promise.all([
      this.prisma.adminAudit.findMany({ where, orderBy: [{ at: order }, { seq: order }], skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.adminAudit.count({ where }),
      this.prisma.adminAudit.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
    ]);
    // BigInt is not JSON: the chain fields are exposed as strings.
    const items = rows.map(({ seq, prevHash: _p, ...r }) => ({ ...r, seq: String(seq) }));
    return { items, total, page, pageSize, actions: actions.map((a) => a.action) };
  }

  @Get('export.csv')
  @RequirePermission('audit:read')
  @ApiOperation({ operationId: 'adminExportAudit', summary: 'Export the activity log as CSV (same filters as the list: general, actorId, keyId, …).' })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'actor', required: false })
  @ApiQuery({ name: 'actorType', required: false, enum: ['user', 'token', 'cli', 'system'] })
  @ApiQuery({ name: 'actorId', required: false })
  @ApiQuery({ name: 'keyId', required: false })
  @ApiQuery({ name: 'outcome', required: false, enum: ['success', 'failure'] })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'delimiter', required: false, enum: ['comma', 'semicolon'] })
  @ApiProduces('text/csv')
  async export(@Req() req: AdminRequest, @Query() q: Record<string, string>, @Res() res: Response) {
    await this.exports.auditLog(parseAuditQuery(q), delimiterOf(q), req.actor, res);
  }
}

@AdminController('admin/settings')
export class AdminSettingsController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly sandbox: SandboxInboxService,
  ) {}

  @Get('sandbox')
  @RequirePermission('settings:read')
  @ApiOperation({ operationId: 'adminSandboxSettings', summary: 'Mailpit links used by "Sandbox Messages" (edited in the UI, not the environment)' })
  @ApiOkResponse({ type: SandboxSettingsDto })
  sandboxSettings() {
    return this.sandbox.settings();
  }

  @Put('sandbox')
  @RequirePermission('settings:manage')
  @ApiOperation({ operationId: 'adminUpdateSandboxSettings', summary: 'Set the Mailpit links. Empty or null removes the link (uiUrl) or falls back to the default (apiUrl).' })
  @ApiBody({ type: UpdateSandboxSettingsDto })
  @ApiOkResponse({ type: SandboxSettingsDto })
  updateSandboxSettings(@Req() req: AdminRequest, @Body() body: unknown) {
    return this.sandbox.update(body, req.actor);
  }

  @Get()
  @RequirePermission('settings:read')
  @ApiOperation({ operationId: 'adminSettings', summary: 'Effective configuration (read-only, never secrets)' })
  @ApiOkResponse({ type: SettingsDto })
  get(): SettingsDto {
    const c = this.cfg;
    return {
      liveProvider: c.LIVE_PROVIDER,
      smtp: { enabled: c.smtpEnabled, host: c.SMTP_HOST ?? null, port: c.SMTP_PORT, secure: c.SMTP_SECURE, requireTls: c.SMTP_REQUIRE_TLS, authConfigured: !!c.SMTP_USER },
      resend: { enabled: c.RESEND_ENABLED, webhookConfigured: !!c.RESEND_WEBHOOK_SECRET },
      mailpitSmtp: `${c.MAILPIT_SMTP_HOST}:${c.MAILPIT_SMTP_PORT}`,
      systemMail: { enabled: systemMailProvider(c) !== null, from: c.SYSTEM_MAIL_FROM ?? null, provider: systemMailProvider(c) },
      bodyRetentionDays: c.AUDIT_BODY_RETENTION_DAYS,
      recordRetentionDays: c.AUDIT_RECORD_RETENTION_DAYS,
      retentionCron: c.RETENTION_CRON,
      globalRateMax: c.GLOBAL_RATE_MAX,
      globalRateDurationMs: c.GLOBAL_RATE_DURATION_MS,
      globalAcceptPerHour: c.GLOBAL_ACCEPT_PER_HOUR,
      dedupWindowSeconds: c.DEDUP_WINDOW_SECONDS,
      idempotencyTtlSeconds: c.IDEMPOTENCY_TTL_SECONDS,
      deliveryMaxAttempts: c.DELIVERY_MAX_ATTEMPTS,
      breakerConsecutiveFailures: c.BREAKER_CONSECUTIVE_FAILURES,
      breakerFailureRate: c.BREAKER_FAILURE_RATE,
      breakerWindowSeconds: c.BREAKER_WINDOW_SECONDS,
      maxRequestBytes: c.MAX_REQUEST_BYTES,
      trustProxy: c.TRUST_PROXY,
      localLogin: c.LOCAL_LOGIN_ENABLED,
      totpRequired: c.TOTP_REQUIRED,
      adminTokenEnabled: c.ADMIN_TOKEN_ENABLED && !!c.ADMIN_TOKEN,
      sessionTtlHours: c.SESSION_TTL_HOURS,
      sessionIdleMinutes: c.SESSION_IDLE_MINUTES,
      authentik: { enabled: c.AUTHENTIK_ENABLED, issuer: c.AUTHENTIK_ISSUER ?? null, scopes: c.AUTHENTIK_SCOPES, groupsClaim: c.AUTHENTIK_GROUPS_CLAIM },
      recipientDomainLimits: [...parseDomainLimits(c.RECIPIENT_DOMAIN_LIMITS)].map(([domain, perHour]) => ({ domain, perHour })),
      warmupSchedule: parseWarmupSchedule(c.WARMUP_SCHEDULE),
      senderDomainChecks: c.SENDER_DOMAIN_CHECKS,
      clamav: c.CLAMAV_HOST ? `${c.CLAMAV_HOST}:${c.CLAMAV_PORT}` : null,
      bodiesEncrypted: !!c.APP_ENCRYPTION_KEY,
      auditChainKeyed: !!c.APP_ENCRYPTION_KEY,
      alertRules: {
        rejectionSpike: c.ALERT_REJECTION_SPIKE,
        failureSpike: c.ALERT_FAILURE_SPIKE,
        spikeWindowMinutes: c.ALERT_SPIKE_WINDOW_MINUTES,
        quotaPercent: c.ALERT_QUOTA_PERCENT,
        approvalWaitMinutes: c.ALERT_APPROVAL_WAIT_MINUTES,
        keyExpiryDays: c.ALERT_KEY_EXPIRY_DAYS,
        cooldownMinutes: c.ALERT_COOLDOWN_MINUTES,
      },
    };
  }
}
