// Authored by Tomás Neto (TN 2026)
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { isIpRule } from '../common/ip';
import { EachMatches, HOST_RE, IsPlainEmail, IsRecipientRule, MIME_PATTERN_RE, NAME_RE, NoCrlf } from '../common/validators';

const lower = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v)) : value;
const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export const KEY_MODES = ['sandbox', 'live', 'approval'] as const;
export const LIVE_PROVIDERS = ['smtp', 'resend'] as const;

export class PolicyFieldsDto {
  @ApiPropertyOptional({ description: 'Free text description of what this key is for.' })
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: KEY_MODES, description: 'sandbox: delivered to Mailpit only. live: delivered for real. approval: held until an admin approves, then delivered live.' })
  @IsOptional() @IsIn(KEY_MODES)
  mode?: (typeof KEY_MODES)[number];

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Fixed sender address (required on create). Clients cannot override it.' })
  @IsOptional() @Transform(trimLower) @IsPlainEmail()
  fromAddress?: string;

  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(100) @NoCrlf()
  fromName?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  allowReplyTo?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Exact addresses ("ops@example.com"), domains ("@example.com") and/or "*" (any recipient). Empty = reject everything.' })
  @IsOptional() @Transform(lower) @IsArray() @ArrayMaxSize(500) @IsRecipientRule()
  allowedRecipients?: string[];

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(1000)
  maxRecipientsPerMessage?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(50 * 1024 * 1024)
  maxMessageBytes?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1_000_000)
  quotaPerHour?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10_000_000)
  quotaPerDay?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  attachmentsAllowed?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(40 * 1024 * 1024)
  maxAttachmentBytes?: number;

  @ApiPropertyOptional({ enum: LIVE_PROVIDERS, nullable: true, type: String, description: 'Live provider override; null = gateway default (LIVE_PROVIDER).' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(LIVE_PROVIDERS)
  liveProvider?: (typeof LIVE_PROVIDERS)[number] | null;

  // ---- access
  @ApiPropertyOptional({ type: [String], description: 'Source IPs or CIDR ranges allowed to use the key ("10.0.0.0/24", "2001:db8::/32"). Empty = any.' })
  @IsOptional() @IsArray() @ArrayMaxSize(100) @EachMatches('isIpRule', isIpRule, 'entries must be IP addresses or CIDR ranges')
  allowedIps?: string[];

  @ApiPropertyOptional({ type: String, nullable: true, description: 'ISO date-time after which the key stops working. null = never.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601({ strict: true })
  expiresAt?: string | null;

  // ---- content
  @ApiPropertyOptional({ type: [String], description: 'Domains links in the body may point to (subdomains included). Empty = any.' })
  @IsOptional() @Transform(lower) @IsArray() @ArrayMaxSize(200) @EachMatches('isHost', (v) => HOST_RE.test(v), 'entries must be domain names like "example.com"')
  allowedLinkDomains?: string[];

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Maximum distinct links per message. null = unlimited.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(1000)
  maxLinks?: number | null;

  @ApiPropertyOptional({ description: 'Refuse bodies containing credentials, private keys, card or bank numbers (default true).' })
  @IsOptional() @IsBoolean()
  blockSecrets?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'MIME types allowed as attachments ("application/pdf", "image/*"). Empty = any. Executables are always refused.' })
  @IsOptional() @Transform(lower) @IsArray() @ArrayMaxSize(50) @EachMatches('isMimePattern', (v) => MIME_PATTERN_RE.test(v), 'entries must look like "type/subtype" or "type/*"')
  allowedAttachmentTypes?: string[];

  @ApiPropertyOptional({ description: 'Virus-scan attachments with ClamAV (needs CLAMAV_HOST on the gateway).' })
  @IsOptional() @IsBoolean()
  scanAttachments?: boolean;

  @ApiPropertyOptional({ description: 'Accept identical messages (same recipients, subject and body) inside DEDUP_WINDOW_SECONDS instead of rejecting them with DUPLICATE_MESSAGE (default false). Quotas still apply.' })
  @IsOptional() @IsBoolean()
  allowDuplicates?: boolean;

  // ---- templates
  @ApiPropertyOptional({ description: 'Only server-side templates may be sent; free-form subject/text/html are refused.' })
  @IsOptional() @IsBoolean()
  templatesOnly?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Template names the key may use. Empty = any template.' })
  @IsOptional() @IsArray() @ArrayMaxSize(200) @EachMatches('isTemplateName', (v) => NAME_RE.test(v), 'entries must be template names')
  allowedTemplates?: string[];

  // ---- volume
  @ApiPropertyOptional({ description: 'Ramp up the daily volume over the first days after the key leaves sandbox (WARMUP_SCHEDULE).' })
  @IsOptional() @IsBoolean()
  warmup?: boolean;
}

export class RotateKeyDto {
  @ApiPropertyOptional({ description: 'Minutes the previous secret keeps working (0-10080). 0 = it stops immediately.' })
  @IsOptional() @IsInt() @Min(0) @Max(10_080)
  graceMinutes?: number;
}

export class CreateKeyDto extends PolicyFieldsDto {
  @ApiProperty({ description: 'Unique key name (letters, digits, dot, dash, underscore). Added as X-Mail-Gateway-Key header.' })
  @IsString() @MinLength(2) @MaxLength(64) @Matches(/^[A-Za-z0-9._-]+$/, { message: 'name may only contain letters, digits, ".", "_" and "-"' })
  name!: string;
}

export class UpdateKeyDto extends PolicyFieldsDto {}
