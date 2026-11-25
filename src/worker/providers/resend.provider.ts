// Authored by Tomás Neto (TN 2026)
import { Resend } from 'resend';
import { DeliveryProvider, ErrorClassification, OutboundMessage, SendOutcome } from './provider';
import { extractInlineImages } from '../../common/inline-images';

export class ResendApiError extends Error {
  constructor(
    readonly errorName: string,
    readonly statusCode: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ResendApiError';
  }
}

const TRANSIENT_NAMES = new Set(['rate_limit_exceeded', 'application_error', 'internal_server_error', 'concurrent_idempotent_requests']);
const SYSTEMIC_NAMES = new Set([
  'missing_api_key',
  'invalid_api_key',
  'restricted_api_key',
  'invalid_access',
  'invalid_from_address',
  'monthly_quota_exceeded',
  'daily_quota_exceeded',
  'security_error',
  'rate_limit_exceeded',
  'application_error',
  'internal_server_error',
]);

/** 429/5xx/network → transient; 4xx validation/domain errors → permanent. */
export function classifyResendError(err: unknown): ErrorClassification {
  if (err instanceof ResendApiError) {
    const sc = err.statusCode;
    const transient = TRANSIENT_NAMES.has(err.errorName) || sc === null || sc === 429 || (sc >= 500 && sc < 600);
    return { transient, systemic: SYSTEMIC_NAMES.has(err.errorName) || sc === null || (sc ?? 0) >= 500, message: `${err.errorName}: ${err.message}`.slice(0, 1000) };
  }
  return { transient: true, systemic: true, message: String((err as Error)?.message ?? err).slice(0, 1000) };
}

/** Resend tag values: ASCII letters, numbers, underscores, dashes; max 256. */
export function sanitizeTag(v: string): string {
  return v.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || '_';
}

export function toResendPayload(m: OutboundMessage) {
  const inline = m.html ? extractInlineImages(m.html, m.gatewayMessageId) : { html: m.html, images: [] };
  const attachments = [
    ...m.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64'), contentType: a.contentType })),
    ...inline.images.map((i) => ({ filename: i.filename, content: i.content.toString('base64'), contentType: i.contentType, contentId: i.cid })),
  ];
  return {
    from: m.from.name ? `${m.from.name.replace(/["<>]/g, '')} <${m.from.address}>` : m.from.address,
    to: m.to,
    ...(m.cc.length ? { cc: m.cc } : {}),
    ...(m.bcc.length ? { bcc: m.bcc } : {}),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    subject: m.subject,
    ...(m.text ? { text: m.text } : {}),
    ...(inline.html ? { html: inline.html } : {}),
    headers: { ...m.headers, 'Message-ID': m.headerMessageId },
    tags: [
      { name: 'gateway_key', value: sanitizeTag(m.keyName) },
      { name: 'gateway_message_id', value: sanitizeTag(m.gatewayMessageId) },
    ],
    ...(attachments.length ? { attachments } : {}),
  };
}

export class ResendProvider implements DeliveryProvider {
  readonly name = 'resend' as const;
  private readonly client: Resend;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new Resend(apiKey, baseUrl ? { baseUrl } : undefined);
  }

  async send(m: OutboundMessage): Promise<SendOutcome> {
    // Idempotency-Key = our message id: BullMQ retries can never double-send.
    const { data, error } = await this.client.emails.send(toResendPayload(m) as never, { idempotencyKey: m.gatewayMessageId });
    if (error) throw new ResendApiError(error.name, error.statusCode, error.message);
    if (!data?.id) throw new ResendApiError('application_error', null, 'Resend returned no email id');
    return { providerMessageId: data.id, response: `resend id=${data.id}` };
  }

  classify(err: unknown) {
    return classifyResendError(err);
  }

  async close() {}
}
