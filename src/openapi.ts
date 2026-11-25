// Authored by Tomás Neto (TN 2026)
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ErrorResponseDto } from './public-api/public.dto';

export const API_DESCRIPTION = `
Central mail-sending gateway for internal applications and LLM agents.

**How to use it (agents: read this):**
1. Authenticate every request with \`Authorization: Bearer mk_...\` (your API key).
2. Call \`GET /v1/me\` first. It tells you your fixed sender, which recipients you may email (exact addresses, "@domain", or "*" for anyone),
   size limits, whether attachments/replyTo are allowed, and your remaining hourly/daily quota.
3. Send with \`POST /v1/send\`. Only recipients allowed by your policy are accepted; the sender cannot be changed.
4. Follow delivery with \`GET /v1/messages/{id}\`.

**Errors** always look like \`{"error":{"code":"...","message":"...","details":{...}}}\`. The message says what to change.
Do not retry \`RECIPIENT_NOT_ALLOWED\`, \`KEY_DISABLED\`, \`FROM_NOT_ALLOWED\` or validation errors unchanged.
Respect \`Retry-After\` for \`QUOTA_EXCEEDED\`, \`GLOBAL_RATE_LIMITED\` and \`GATEWAY_PAUSED\`.
\`DUPLICATE_MESSAGE\` means you already sent the same message recently: you are probably looping, so stop.
To retry safely after a timeout, resend with the same \`Idempotency-Key\` header.

Sandbox keys (\`mk_sbx_\`) deliver only to a test inbox; nothing reaches real recipients.
`.trim();

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('mail-gateway')
    .setDescription(API_DESCRIPTION)
    .setVersion('1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'API key: mk_sbx_... or mk_live_...' }, 'apiKey')
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Static admin token (automation only)' }, 'admin')
    .addCookieAuth('mg_session', { type: 'apiKey', in: 'cookie', description: 'Admin UI session (+ X-CSRF-Token header on mutations)' }, 'session')
    .addTag('send', 'Public API for applications and agents')
    .addTag('admin', 'Administration API')
    .addTag('auth', 'Admin UI authentication')
    .build();
  return SwaggerModule.createDocument(app, config, {
    extraModels: [ErrorResponseDto],
    operationIdFactory: (_controller, method) => method,
  });
}

/** Deterministic JSON (sorted keys) so the committed openapi.json diff is stable. */
export function stableStringify(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]))
        : x;
  return JSON.stringify(sort(v), null, 2) + '\n';
}

export function setupSwagger(app: INestApplication) {
  const doc = buildOpenApiDocument(app);
  // Scalar is the primary reference at /docs; Swagger UI stays available at /swagger.
  SwaggerModule.setup('swagger', app, doc, {
    jsonDocumentUrl: 'openapi.json',
    yamlDocumentUrl: 'openapi.yaml',
    customSiteTitle: 'mail-gateway API',
  });
  return doc;
}
