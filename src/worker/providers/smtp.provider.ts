// Authored by Tomás Neto (TN 2026)
import nodemailer, { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { DeliveryProvider, ErrorClassification, OutboundMessage, ProviderName, SendOutcome } from './provider';
import { extractInlineImages } from '../../common/inline-images';

const NETWORK_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EPIPE', 'ETLS', 'EPROTOCOL']);
/** Server-wide (not per-recipient) SMTP replies: service unavailable, TLS/auth problems. */
const SYSTEMIC_REPLY_CODES = new Set([421, 454, 530, 534, 535, 538]);

export interface SmtpErrorLike {
  code?: string;
  responseCode?: number;
  response?: string;
  message?: string;
  command?: string;
}

/** 4xx + connection errors → transient; 5xx → permanent. Auth errors are systemic and permanent. */
export function classifySmtpError(err: unknown): ErrorClassification {
  const e = (err ?? {}) as SmtpErrorLike;
  const message = (e.response || e.message || String(err)).slice(0, 1000);
  const rc = typeof e.responseCode === 'number' ? e.responseCode : undefined;
  if (e.code === 'EAUTH') return { transient: false, systemic: true, message };
  if (rc !== undefined) {
    if (rc >= 400 && rc < 500) return { transient: true, systemic: SYSTEMIC_REPLY_CODES.has(rc), message };
    if (rc >= 500) return { transient: false, systemic: SYSTEMIC_REPLY_CODES.has(rc), message };
  }
  if (e.code && NETWORK_CODES.has(e.code)) return { transient: true, systemic: true, message };
  if (e.code === 'EENVELOPE' || e.code === 'EMESSAGE') return { transient: false, systemic: false, message };
  // Unknown errors without an SMTP reply are most likely transport problems.
  return { transient: true, systemic: true, message };
}

export interface SmtpProviderOptions {
  name: ProviderName;
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  rejectUnauthorized: boolean;
  user?: string;
  password?: string;
  timeoutMs: number;
  pool?: boolean;
}

export class SmtpProvider implements DeliveryProvider {
  readonly name: ProviderName;
  private readonly transport: Transporter<SMTPTransport.SentMessageInfo>;

  constructor(o: SmtpProviderOptions) {
    this.name = o.name;
    this.transport = nodemailer.createTransport({
      host: o.host,
      port: o.port,
      secure: o.secure,
      requireTLS: !o.secure && o.requireTLS,
      ignoreTLS: !o.secure && !o.requireTLS && o.name === 'mailpit',
      auth: o.user ? { user: o.user, pass: o.password ?? '' } : undefined,
      tls: { rejectUnauthorized: o.rejectUnauthorized },
      connectionTimeout: o.timeoutMs,
      greetingTimeout: o.timeoutMs,
      socketTimeout: o.timeoutMs,
      pool: o.pool ?? true,
      maxConnections: 4,
      disableFileAccess: true,
      disableUrlAccess: true,
    } as SMTPTransport.Options);
  }

  async send(m: OutboundMessage): Promise<SendOutcome> {
    const inline = m.html ? extractInlineImages(m.html, m.gatewayMessageId) : { html: m.html, images: [] };
    const info = await this.transport.sendMail({
      from: m.from.name ? { name: m.from.name, address: m.from.address } : m.from.address,
      to: m.to,
      cc: m.cc.length ? m.cc : undefined,
      bcc: m.bcc.length ? m.bcc : undefined,
      replyTo: m.replyTo ?? undefined,
      subject: m.subject,
      text: m.text ?? undefined,
      html: inline.html ?? undefined,
      messageId: m.headerMessageId,
      headers: m.headers,
      attachments: [
        ...m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
        ...inline.images.map((i) => ({ filename: i.filename, contentType: i.contentType, content: i.content, cid: i.cid, contentDisposition: 'inline' as const })),
      ],
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return { providerMessageId: info.messageId, response: info.response };
  }

  classify(err: unknown) {
    return classifySmtpError(err);
  }

  async close() {
    this.transport.close();
  }
}
