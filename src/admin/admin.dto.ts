// Authored by Tomás Neto (TN 2026)
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes of the admin API. They exist for the OpenAPI document, from which the
 * admin UI's client/types are generated (so the UI cannot drift from the backend).
 */

const MODES = ['sandbox', 'live', 'approval'];
const STATUSES = ['queued', 'pending_approval', 'sent', 'failed', 'rejected', 'captured'];

export class KeyUsageDto {
  @ApiProperty() hour!: number;
  @ApiProperty() day!: number;
}

export class WarmupStateDto {
  @ApiProperty({ description: 'Day of the warm-up (1-based)' }) day!: number;
  @ApiProperty() days!: number;
  @ApiProperty({ description: 'Daily cap that applies today' }) dailyCap!: number;
}

export class DomainCheckItemDto {
  @ApiProperty({ enum: ['pass', 'warn', 'fail'] }) status!: 'pass' | 'warn' | 'fail';
  @ApiProperty({ type: String, nullable: true }) record!: string | null;
  @ApiProperty() note!: string;
}
export class DmarcCheckDto extends DomainCheckItemDto {
  @ApiProperty({ type: String, nullable: true }) policy!: string | null;
}
export class DkimCheckDto extends DomainCheckItemDto {
  @ApiProperty({ type: String, nullable: true }) selector!: string | null;
}
export class DomainCheckDto {
  @ApiProperty() domain!: string;
  @ApiProperty({ enum: ['off', 'warn', 'enforce'] }) mode!: 'off' | 'warn' | 'enforce';
  @ApiProperty() checkedAt!: string;
  @ApiProperty({ type: DomainCheckItemDto }) spf!: DomainCheckItemDto;
  @ApiProperty({ type: DmarcCheckDto }) dmarc!: DmarcCheckDto;
  @ApiProperty({ type: DkimCheckDto }) dkim!: DkimCheckDto;
  @ApiProperty({ description: 'SPF and DMARC do not fail' }) ok!: boolean;
}

export class AuditVerifyDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty() checked!: number;
  @ApiProperty({ type: String, nullable: true }) headSeq!: string | null;
  @ApiProperty({ type: String, nullable: true }) headHash!: string | null;
  @ApiProperty({ type: String, nullable: true }) anchorSeq!: string | null;
  @ApiProperty({ type: String, nullable: true }) brokenAtSeq!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
}

export class KeyDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() description!: string;
  @ApiProperty() keyPrefix!: string;
  @ApiProperty({ enum: MODES }) mode!: 'sandbox' | 'live' | 'approval';
  @ApiProperty() enabled!: boolean;
  @ApiProperty() fromAddress!: string;
  @ApiProperty({ type: String, nullable: true }) fromName!: string | null;
  @ApiProperty() allowReplyTo!: boolean;
  @ApiProperty({ type: [String] }) allowedRecipients!: string[];
  @ApiProperty() maxRecipientsPerMessage!: number;
  @ApiProperty() maxMessageBytes!: number;
  @ApiProperty() quotaPerHour!: number;
  @ApiProperty() quotaPerDay!: number;
  @ApiProperty() attachmentsAllowed!: boolean;
  @ApiProperty() maxAttachmentBytes!: number;
  @ApiProperty({ enum: ['smtp', 'resend'], nullable: true, type: String }) liveProvider!: 'smtp' | 'resend' | null;
  @ApiProperty({ type: [String], description: 'Source IPs/CIDRs allowed; empty = any' }) allowedIps!: string[];
  @ApiProperty({ type: String, nullable: true }) expiresAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Rotation grace: the previous secret works until then' }) previousSecretValidUntil!: string | null;
  @ApiProperty({ type: [String] }) allowedLinkDomains!: string[];
  @ApiProperty({ type: Number, nullable: true }) maxLinks!: number | null;
  @ApiProperty() blockSecrets!: boolean;
  @ApiProperty({ type: [String] }) allowedAttachmentTypes!: string[];
  @ApiProperty() scanAttachments!: boolean;
  @ApiProperty() templatesOnly!: boolean;
  @ApiProperty({ type: [String] }) allowedTemplates!: string[];
  @ApiProperty() warmup!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'First time the key left sandbox' }) liveSince!: string | null;
  @ApiProperty({ type: () => WarmupStateDto, nullable: true }) warmupState!: WarmupStateDto | null;
  @ApiProperty() prefixStale!: boolean;
  @ApiProperty({ type: String, nullable: true }) lastUsedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) rotatedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class KeyWithUsageDto extends KeyDto {
  @ApiProperty({ type: KeyUsageDto }) usage!: KeyUsageDto;
}

export class KeyListDto {
  @ApiProperty({ type: [KeyWithUsageDto] }) items!: KeyWithUsageDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class KeyCreatedDto {
  @ApiProperty({ type: KeyDto }) key!: KeyDto;
  @ApiProperty({ description: 'The API key secret. Shown ONCE; only its hash is stored.' }) secret!: string;
}

export class TestSendDto {
  @ApiProperty({ description: 'Recipient (must be allowed by the key policy)' }) to!: string;
  @ApiPropertyOptional() subject?: string;
  @ApiPropertyOptional() text?: string;
}

export class KeyRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

export class MessageListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ enum: MODES }) deliveryMode!: string;
  @ApiProperty({ type: String, nullable: true, enum: ['smtp', 'resend', 'mailpit'] }) provider!: string | null;
  @ApiProperty({ enum: ['api', 'admin_test'] }) source!: string;
  @ApiProperty({ type: [String] }) to!: string[];
  @ApiProperty({ type: [String] }) cc!: string[];
  @ApiProperty({ type: [String] }) bcc!: string[];
  @ApiProperty() subject!: string;
  @ApiProperty({ type: String, nullable: true }) rejectCode!: string | null;
  @ApiProperty() attempts!: number;
  @ApiProperty({ type: String, nullable: true }) deliveryOutcome!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) sentAt!: string | null;
  @ApiProperty({ type: KeyRefDto }) apiKey!: KeyRefDto;
}

export class MessageListDto {
  @ApiProperty({ type: [MessageListItemDto] }) items!: MessageListItemDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class MessageEventDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['status', 'attempt', 'provider_event', 'admin'] }) type!: string;
  @ApiProperty({ type: String, nullable: true, enum: STATUSES }) fromStatus!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: STATUSES }) toStatus!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true }) detail!: Record<string, unknown> | null;
  @ApiProperty() at!: string;
}

export class AttachmentMetaDto {
  @ApiProperty() id!: string;
  @ApiProperty() filename!: string;
  @ApiProperty() contentType!: string;
  @ApiProperty() sizeBytes!: number;
}

export class MessageKeyRefDto extends KeyRefDto {
  @ApiProperty({ enum: MODES }) mode!: string;
}

export class MessageDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ enum: MODES }) deliveryMode!: string;
  @ApiProperty({ type: String, nullable: true }) provider!: string | null;
  @ApiProperty() source!: string;
  @ApiProperty({ type: String, nullable: true }) rejectCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) rejectReason!: string | null;
  @ApiProperty() fromAddress!: string;
  @ApiProperty({ type: String, nullable: true }) fromName!: string | null;
  @ApiProperty({ type: [String] }) to!: string[];
  @ApiProperty({ type: [String] }) cc!: string[];
  @ApiProperty({ type: [String] }) bcc!: string[];
  @ApiProperty({ type: String, nullable: true }) replyTo!: string | null;
  @ApiProperty() subject!: string;
  @ApiProperty() bodyHash!: string;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true }) metadata!: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) sourceIp!: string | null;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() attempts!: number;
  @ApiProperty({ type: String, nullable: true }) lastError!: string | null;
  @ApiProperty({ type: String, nullable: true }) providerResponse!: string | null;
  @ApiProperty({ type: String, nullable: true }) providerMessageId!: string | null;
  @ApiProperty({ type: String, nullable: true }) deliveryOutcome!: string | null;
  @ApiProperty({ type: String, nullable: true }) bodyPurgedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ type: String, nullable: true }) sentAt!: string | null;
  @ApiProperty({ type: MessageKeyRefDto }) apiKey!: MessageKeyRefDto;
  @ApiProperty({ type: [AttachmentMetaDto] }) attachments!: AttachmentMetaDto[];
  @ApiProperty({ type: [MessageEventDto] }) events!: MessageEventDto[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) headers!: Record<string, string>;
  @ApiProperty({ description: 'false when the caller may not see bodies (viewer without canViewBodies)' }) bodiesVisible!: boolean;
  @ApiProperty({ type: String, nullable: true }) textBody!: string | null;
  @ApiProperty({ type: String, nullable: true }) htmlBody!: string | null;
  @ApiProperty() hasHtml!: boolean;
  @ApiProperty() hasText!: boolean;
}

export class MessageActionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
}

export class BulkItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() ok!: boolean;
  @ApiPropertyOptional() error?: string;
}
export class BulkResultDto {
  @ApiProperty({ type: [BulkItemDto] }) results!: BulkItemDto[];
}

export class GatewayStateDto {
  @ApiProperty() paused!: boolean;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, nullable: true }) pausedBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) pausedAt!: string | null;
}

export class SeriesPointDto {
  @ApiProperty({ description: 'Bucket start (ISO)' }) t!: string;
  @ApiProperty() accepted!: number;
  @ApiProperty() sent!: number;
  @ApiProperty() captured!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() rejected!: number;
}
export class ReasonCountDto {
  @ApiProperty() reason!: string;
  @ApiProperty() count!: number;
}
export class TopKeyDto {
  @ApiProperty() keyId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() count!: number;
}
export class OutcomeCountDto {
  @ApiProperty({ enum: ['delivered', 'delayed', 'bounced', 'complained'] }) outcome!: string;
  @ApiProperty() count!: number;
}
export class TotalsDto {
  @ApiProperty() accepted!: number;
  @ApiProperty() sent!: number;
  @ApiProperty() captured!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() rejected!: number;
}
export class StatsOverviewDto {
  @ApiProperty({ enum: ['hour', 'day'] }) bucket!: 'hour' | 'day';
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: TotalsDto }) totals!: TotalsDto;
  @ApiProperty({ type: TotalsDto, description: 'Same totals for the period of equal length just before "from"' }) previousTotals!: TotalsDto;
  @ApiProperty({ type: [SeriesPointDto] }) series!: SeriesPointDto[];
  @ApiProperty({ type: [ReasonCountDto] }) rejectionsByReason!: ReasonCountDto[];
  @ApiProperty({ type: [TopKeyDto] }) topKeys!: TopKeyDto[];
  @ApiProperty({ type: [OutcomeCountDto] }) outcomes!: OutcomeCountDto[];
}

export class CheckDto {
  @ApiProperty({ enum: ['up', 'down', 'skipped'] }) status!: 'up' | 'down' | 'skipped';
  @ApiPropertyOptional() latencyMs?: number;
  @ApiPropertyOptional() error?: string;
}
export class BreakerDto {
  @ApiProperty({ enum: ['smtp', 'resend'] }) provider!: string;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: ['open', 'closed'] }) state!: 'open' | 'closed';
}
export class QueueDepthDto {
  @ApiProperty() waiting!: number;
  @ApiProperty() active!: number;
  @ApiProperty() delayed!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() paused!: number;
  @ApiProperty() prioritized!: number;
}
export class SystemStateDto {
  @ApiProperty({ type: GatewayStateDto }) gateway!: GatewayStateDto;
  @ApiProperty({ type: [BreakerDto] }) breakers!: BreakerDto[];
  @ApiProperty({ type: QueueDepthDto }) queue!: QueueDepthDto;
  @ApiProperty() pendingApprovals!: number;
  @ApiProperty({ type: CheckDto }) smtpHealth!: CheckDto;
}

export class SandboxSettingsDto {
  @ApiProperty({ type: String, nullable: true, description: 'Mailpit UI as the browser reaches it; null = no "Sandbox Messages" link' }) uiUrl!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Mailpit as the API container reaches it; null = defaultApiUrl' }) apiUrl!: string | null;
  @ApiProperty({ description: 'Used when apiUrl is not set: http://<MAILPIT_SMTP_HOST>:8025' }) defaultApiUrl!: string;
  @ApiProperty({ type: String, nullable: true }) updatedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) updatedBy!: string | null;
}

export class SandboxInboxDto {
  @ApiProperty({ description: 'A Mailpit link is set on the Settings page' }) configured!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'Mailpit UI as the browser reaches it' }) url!: string | null;
  @ApiProperty({ description: 'Mailpit answered its API from the gateway' }) available!: boolean;
  @ApiProperty({ type: Number, nullable: true, description: 'Messages in Mailpit, when known' }) messages!: number | null;
}

// ---------------------------------------------------------------- queues (BullMQ)
export class QueueCountsDto {
  @ApiProperty({ description: 'Ready to run (includes jobs held while the queue is paused)' }) waiting!: number;
  @ApiProperty() active!: number;
  @ApiProperty({ description: 'Scheduled for later: retries in backoff, parked jobs, repeatable jobs' }) delayed!: number;
  @ApiProperty() prioritized!: number;
  @ApiProperty() waitingChildren!: number;
  @ApiProperty({ description: 'Failed after all attempts and still kept' }) failed!: number;
  @ApiProperty({ description: 'Completed and still kept (each queue trims these)' }) completed!: number;
}
export class QueueWindowDto {
  @ApiProperty() completed!: number;
  @ApiProperty() failed!: number;
}
export class QueuePerMinuteDto {
  @ApiProperty({ type: [Number], description: 'Last 60 minutes, oldest first' }) completed!: number[];
  @ApiProperty({ type: [Number], description: 'Last 60 minutes, oldest first' }) failed!: number[];
}
export class QueueTimingsDto {
  @ApiProperty({ description: 'Recently completed jobs the figures are taken from' }) sampled!: number;
  @ApiProperty({ description: 'Of those, jobs that needed more than one attempt' }) retried!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Time from due to started, first-attempt jobs' }) waitP50Ms!: number | null;
  @ApiProperty({ type: Number, nullable: true }) waitP95Ms!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Processing time of the last attempt' }) runP50Ms!: number | null;
  @ApiProperty({ type: Number, nullable: true }) runP95Ms!: number | null;
  @ApiProperty({ type: Number, nullable: true }) runMaxMs!: number | null;
}
export class QueueFailureDto {
  @ApiProperty({ description: 'Job id (for delivery jobs, the message id)' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty() attempts!: number;
  @ApiProperty({ type: String, nullable: true }) at!: string | null;
}
export class QueueStatusDto {
  @ApiProperty() name!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: ['ok', 'warn', 'down'] }) health!: 'ok' | 'warn' | 'down';
  @ApiProperty() healthReason!: string;
  @ApiProperty() paused!: boolean;
  @ApiProperty({ description: 'Connected worker processes; -1 when Redis does not allow CLIENT LIST' }) workers!: number;
  @ApiProperty({ type: QueueCountsDto }) counts!: QueueCountsDto;
  @ApiProperty({ type: Number, nullable: true }) oldestWaitingSeconds!: number | null;
  @ApiProperty({ type: QueueWindowDto }) lastHour!: QueueWindowDto;
  @ApiProperty({ type: QueueWindowDto }) lastDay!: QueueWindowDto;
  @ApiProperty({ type: QueuePerMinuteDto }) perMinute!: QueuePerMinuteDto;
  @ApiProperty({ type: QueueTimingsDto }) timings!: QueueTimingsDto;
  @ApiProperty({ type: [QueueFailureDto], nullable: true, description: 'null when the caller may not see this queue\'s failure reasons' })
  recentFailures!: QueueFailureDto[] | null;
}
export class QueuesOverviewDto {
  @ApiProperty() at!: string;
  @ApiProperty({ description: 'A job waiting longer than this marks the queue as backlogged' }) backlogSeconds!: number;
  @ApiProperty({ type: [QueueStatusDto] }) queues!: QueueStatusDto[];
}

export class RoleRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}
export class UserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [RoleRefDto] }) roles!: RoleRefDto[];
  @ApiProperty({ type: [String], description: 'Effective permissions (union of roles); ["*"] = everything' }) permissions!: string[];
  @ApiProperty({ enum: ['local', 'authentik'] }) authSource!: string;
  @ApiProperty() totpEnrolled!: boolean;
  @ApiProperty() disabled!: boolean;
  @ApiProperty() locked!: boolean;
  @ApiProperty() pendingInvite!: boolean;
  @ApiProperty({ type: String, nullable: true }) lastLoginAt!: string | null;
  @ApiProperty() createdAt!: string;
}
export class UserListDto {
  @ApiProperty({ type: [UserDto] }) items!: UserDto[];
  @ApiProperty() total!: number;
}
export class InviteUserDto {
  @ApiProperty() email!: string;
  @ApiPropertyOptional() name?: string;
  @ApiProperty({ type: [String], description: 'Role ids (at least one)' }) roleIds!: string[];
}
export class UpdateUserDto {
  @ApiPropertyOptional() name?: string;
  @ApiPropertyOptional({ type: [String], description: 'Replace the user roles (local users only)' }) roleIds?: string[];
  @ApiPropertyOptional() disabled?: boolean;
}

export class PermissionDto {
  @ApiProperty() id!: string;
  @ApiProperty() area!: string;
  @ApiProperty() label!: string;
}
export class RoleDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: [String] }) permissions!: string[];
  @ApiProperty({ type: [String], description: 'Authentik groups that grant this role on SSO login' }) ssoGroups!: string[];
  @ApiProperty() builtin!: boolean;
  @ApiProperty({ description: 'false for the built-in Admin role' }) editable!: boolean;
  @ApiProperty() userCount!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
export class RoleListDto {
  @ApiProperty({ type: [RoleDto] }) items!: RoleDto[];
  @ApiProperty() total!: number;
}
export class CreateRoleDto {
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ type: [String], description: 'Permission ids, "<area>:*" or "*"' }) permissions!: string[];
  @ApiPropertyOptional({ type: [String] }) ssoGroups?: string[];
}
export class UpdateRoleDto {
  @ApiPropertyOptional() name?: string;
  @ApiPropertyOptional() description?: string;
  @ApiPropertyOptional({ type: [String] }) permissions?: string[];
  @ApiPropertyOptional({ type: [String] }) ssoGroups?: string[];
}
export class InviteLinkDto {
  @ApiProperty({ description: 'Relative URL of the one-time invite page (shown once)' }) invitePath!: string;
  @ApiProperty() expiresInHours!: number;
  @ApiProperty({ description: 'true when the link was queued for delivery by email (SYSTEM_MAIL_FROM + SMTP/Resend configured)' }) emailed!: boolean;
}
export class InviteResultDto extends InviteLinkDto {
  @ApiProperty({ type: UserDto }) user!: UserDto;
}

export class AuditEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Position in the tamper-evident chain' }) seq!: string;
  @ApiProperty({ type: String, nullable: true }) hash!: string | null;
  @ApiProperty() at!: string;
  @ApiProperty({ enum: ['user', 'token', 'cli', 'system'] }) actorType!: string;
  @ApiProperty({ type: String, nullable: true }) actorId!: string | null;
  @ApiProperty() actorLabel!: string;
  @ApiProperty() action!: string;
  @ApiProperty({ type: String, nullable: true }) targetType!: string | null;
  @ApiProperty({ type: String, nullable: true }) targetId!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true }) details!: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) ip!: string | null;
  @ApiProperty({ enum: ['success', 'failure'] }) outcome!: string;
}
export class AuditListDto {
  @ApiProperty({ type: [AuditEntryDto] }) items!: AuditEntryDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: [String], description: 'Distinct action names (for filters)' }) actions!: string[];
}

export class SmtpSettingsDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) host!: string | null;
  @ApiProperty() port!: number;
  @ApiProperty({ description: 'implicit TLS' }) secure!: boolean;
  @ApiProperty() requireTls!: boolean;
  @ApiProperty() authConfigured!: boolean;
}
export class ResendSettingsDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty() webhookConfigured!: boolean;
}
export class AuthentikSettingsDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) issuer!: string | null;
  @ApiProperty() scopes!: string;
  @ApiProperty() groupsClaim!: string;
}
export class SystemMailSettingsDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) from!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['smtp', 'resend'] }) provider!: string | null;
}
export class DomainLimitDto {
  @ApiProperty({ description: '"*" = every other domain' }) domain!: string;
  @ApiProperty() perHour!: number;
}

export class AlertRulesDto {
  @ApiProperty() rejectionSpike!: number;
  @ApiProperty() failureSpike!: number;
  @ApiProperty() spikeWindowMinutes!: number;
  @ApiProperty() quotaPercent!: number;
  @ApiProperty() approvalWaitMinutes!: number;
  @ApiProperty() keyExpiryDays!: number;
  @ApiProperty() cooldownMinutes!: number;
}

export class SettingsDto {
  @ApiProperty({ enum: ['smtp', 'resend'] }) liveProvider!: string;
  @ApiProperty({ type: SmtpSettingsDto }) smtp!: SmtpSettingsDto;
  @ApiProperty({ type: ResendSettingsDto }) resend!: ResendSettingsDto;
  @ApiProperty() mailpitSmtp!: string;
  @ApiProperty({ type: SystemMailSettingsDto }) systemMail!: SystemMailSettingsDto;
  @ApiProperty() bodyRetentionDays!: number;
  @ApiProperty() recordRetentionDays!: number;
  @ApiProperty() retentionCron!: string;
  @ApiProperty() globalRateMax!: number;
  @ApiProperty() globalRateDurationMs!: number;
  @ApiProperty() globalAcceptPerHour!: number;
  @ApiProperty() dedupWindowSeconds!: number;
  @ApiProperty() idempotencyTtlSeconds!: number;
  @ApiProperty() deliveryMaxAttempts!: number;
  @ApiProperty() breakerConsecutiveFailures!: number;
  @ApiProperty() breakerFailureRate!: number;
  @ApiProperty() breakerWindowSeconds!: number;
  @ApiProperty() maxRequestBytes!: number;
  @ApiProperty() trustProxy!: string;
  @ApiProperty() localLogin!: boolean;
  @ApiProperty() totpRequired!: boolean;
  @ApiProperty() adminTokenEnabled!: boolean;
  @ApiProperty() sessionTtlHours!: number;
  @ApiProperty() sessionIdleMinutes!: number;
  @ApiProperty({ type: AuthentikSettingsDto }) authentik!: AuthentikSettingsDto;
  @ApiProperty({ type: () => [DomainLimitDto] }) recipientDomainLimits!: DomainLimitDto[];
  @ApiProperty({ type: [Number], description: 'Daily caps for day 1, 2, … after a key leaves sandbox' }) warmupSchedule!: number[];
  @ApiProperty({ enum: ['off', 'warn', 'enforce'] }) senderDomainChecks!: 'off' | 'warn' | 'enforce';
  @ApiProperty({ type: String, nullable: true }) clamav!: string | null;
  @ApiProperty() bodiesEncrypted!: boolean;
  @ApiProperty() auditChainKeyed!: boolean;
  @ApiProperty({ type: () => AlertRulesDto }) alertRules!: AlertRulesDto;
}
