// Authored by Tomás Neto (TN 2026)
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorBodyDto {
  @ApiProperty({ description: 'Stable machine-readable code, e.g. RECIPIENT_NOT_ALLOWED, QUOTA_EXCEEDED, DUPLICATE_MESSAGE, KEY_DISABLED, GATEWAY_PAUSED.' })
  code!: string;
  @ApiProperty({ description: 'Human/LLM-readable explanation of what is wrong and what to change.' })
  message!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Extra data, e.g. notAllowed addresses or retryAfterSeconds.' })
  details?: Record<string, unknown>;
}

export class ErrorResponseDto {
  @ApiProperty({ type: ErrorBodyDto }) error!: ErrorBodyDto;
}

export class MessageStatusDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['queued', 'pending_approval', 'sent', 'failed', 'rejected', 'captured'] }) status!: string;
  @ApiProperty({ enum: ['sandbox', 'live', 'approval'] }) mode!: string;
  @ApiPropertyOptional({ enum: ['smtp', 'resend', 'mailpit'], nullable: true, type: String }) provider!: string | null;
  @ApiProperty({ type: [String] }) to!: string[];
  @ApiProperty({ type: [String] }) cc!: string[];
  @ApiProperty({ type: [String] }) bcc!: string[];
  @ApiProperty() subject!: string;
  @ApiProperty({ description: 'Delivery attempts so far.' }) attempts!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) lastError!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) rejectCode!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) rejectReason!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Provider-reported outcome when available: delivered, bounced, complained, delayed.' }) deliveryOutcome!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) sentAt!: string | null;
}

class UsageWindowDto {
  @ApiProperty() used!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() remaining!: number;
}
class UsageDto {
  @ApiProperty({ type: UsageWindowDto, description: 'Current UTC hour.' }) hour!: UsageWindowDto;
  @ApiProperty({ type: UsageWindowDto, description: 'Current UTC day.' }) day!: UsageWindowDto;
}

export class MeResponseDto {
  @ApiProperty() name!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ description: 'Non-secret display prefix of the key.' }) keyPrefix!: string;
  @ApiProperty({ enum: ['sandbox', 'live', 'approval'], description: 'sandbox: delivered only to a test inbox (Mailpit). live: real delivery. approval: held until an admin approves.' }) mode!: string;
  @ApiProperty({ description: 'false = key disabled; every send is rejected with KEY_DISABLED.' }) enabled!: boolean;
  @ApiProperty({ description: 'Fixed sender address used for every message.' }) fromAddress!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) fromName!: string | null;
  @ApiProperty({ description: 'Whether replyTo may be set.' }) allowReplyTo!: boolean;
  @ApiProperty({ type: [String], description: 'Allowed recipients: exact addresses, "@domain" entries, or "*" (any recipient). Every to/cc/bcc must match one.' }) allowedRecipients!: string[];
  @ApiProperty({ description: 'Max to+cc+bcc per message.' }) maxRecipientsPerMessage!: number;
  @ApiProperty({ description: 'Max subject+text+html+attachments bytes.' }) maxMessageBytes!: number;
  @ApiProperty() quotaPerHour!: number;
  @ApiProperty() quotaPerDay!: number;
  @ApiProperty() attachmentsAllowed!: boolean;
  @ApiProperty() maxAttachmentBytes!: number;
  @ApiPropertyOptional({ enum: ['smtp', 'resend'], nullable: true, type: String }) liveProvider!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'The key stops working at this time (ISO). null = never.' }) expiresAt!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'After a rotation, the previous secret keeps working until then. Switch to the new one before.' }) previousSecretValidUntil!: string | null;
  @ApiProperty({ type: [String], description: 'Domains links in the body may point to (subdomains included). Empty = any.' }) allowedLinkDomains!: string[];
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Max distinct links per message. null = unlimited.' }) maxLinks!: number | null;
  @ApiProperty({ description: 'Bodies with credentials, private keys, card or bank numbers are refused (CONTENT_BLOCKED).' }) blockSecrets!: boolean;
  @ApiProperty({ type: [String], description: 'Allowed attachment MIME types ("image/*" wildcards). Empty = any. Executables are always refused.' }) allowedAttachmentTypes!: string[];
  @ApiProperty({ description: 'Attachments are virus-scanned.' }) scanAttachments!: boolean;
  @ApiProperty({ description: 'true = identical messages are accepted (no DUPLICATE_MESSAGE). false = an identical message (same recipients, subject and body) inside the dedup window is rejected.' }) allowDuplicates!: boolean;
  @ApiProperty({ description: 'Only server-side templates may be sent (see GET /v1/templates).' }) templatesOnly!: boolean;
  @ApiProperty({ type: [String], description: 'Templates the key may use. Empty = any.' }) allowedTemplates!: string[];
  @ApiPropertyOptional({
    type: 'object',
    nullable: true,
    description: 'While warming up after going live: today\'s daily cap ({day, days, dailyCap}). usage.day.limit already includes it.',
    properties: { day: { type: 'number' }, days: { type: 'number' }, dailyCap: { type: 'number' } },
  })
  warmupState!: { day: number; days: number; dailyCap: number } | null;
  @ApiProperty({ type: UsageDto }) usage!: UsageDto;
}
