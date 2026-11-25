// Authored by Tomás Neto (TN 2026)
import 'reflect-metadata';
import { DynamicModule, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { AdminMessagesService } from './admin/admin-messages.service';
import { CLI_ACTOR } from './admin/admin-audit.service';
import { buildConfig } from './config/config';
import { createRootLogger } from './common/logger';
import { isGatewayError } from './common/errors';
import { CoreModule, CoreOptions } from './core.module';
import { GatewayStateService } from './gateway-state/gateway-state.service';
import { KeysService } from './keys/keys.service';
import { DomainCheckService } from './keys/domain-check.service';
import { AuditChainService } from './admin/audit-chain.service';
import { QuotaService } from './policy/quota.service';
import { SessionsService } from './auth/sessions.service';
import { RolesService } from './auth/roles.service';
import { SystemMailService } from './auth/system-mail.service';
import { UsersService } from './auth/users.service';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

@Module({})
class CliModule {
  static forRoot(opts: CoreOptions): DynamicModule {
    return {
      module: CliModule,
      imports: [CoreModule.forRoot(opts)],
      providers: [KeysService, QuotaService, AdminMessagesService, SessionsService, UsersService, RolesService, SystemMailService, DomainCheckService],
    };
  }
}

const HELP = `mail-gateway CLI (bootstrap/automation without the admin API)

Usage: npm run cli -- <command> [options]

Keys
  keys:create  --name <n> --from <addr> [--from-name <s>] [--allow <a,@domain,*,...>] [--mode sandbox|live|approval]
               [--quota-hour <n>] [--quota-day <n>] [--max-recipients <n>] [--max-bytes <n>]
               [--reply-to] [--attachments] [--max-attachment-bytes <n>] [--provider smtp|resend|default]
               [--allow-duplicates]   (accept identical messages; quotas still apply)
               [--description <s>]
               Boolean flags take a --no- form to switch off, e.g. --no-allow-duplicates
  keys:update  --name <n> [same options as create, plus --enabled true|false]
  keys:list
  keys:show    --name <n>
  keys:rotate  --name <n> [--grace-minutes <n>]   (old secret keeps working that long; default 0)
  keys:enable  --name <n>
  keys:disable --name <n>
  keys:delete  --name <n>

Gateway
  gateway:status
  gateway:pause  [--reason <s>]
  gateway:resume

Admin users (UI)
  users:create      --email <e> [--name <n>] [--role <Role> ...] [--password-stdin]
                    (roles by name, repeatable; default Admin. See roles:list)
                    (prompts for the password unless --password-stdin; 2FA is optional unless TOTP_REQUIRED=true)
  users:list
  roles:list
  users:reset-2fa   --email <e>
  users:reset-access --email <e>   (clears password + TOTP, prints a new invite link)
  users:disable     --email <e>
  users:enable      --email <e>

Approvals
  messages:approve --id <id>
  messages:reject  --id <id> [--reason <s>]

Security
  audit:verify              integrity check of the activity log hash chain (exit code 3 when broken)
  messages:encrypt-bodies   encrypt message bodies stored before APP_ENCRYPTION_KEY was set
`;

const OPTIONS = {
  name: { type: 'string' },
  from: { type: 'string' },
  'from-name': { type: 'string' },
  allow: { type: 'string', multiple: true },
  mode: { type: 'string' },
  'quota-hour': { type: 'string' },
  'quota-day': { type: 'string' },
  'max-recipients': { type: 'string' },
  'max-bytes': { type: 'string' },
  'reply-to': { type: 'boolean' },
  attachments: { type: 'boolean' },
  'allow-duplicates': { type: 'boolean' },
  'max-attachment-bytes': { type: 'string' },
  provider: { type: 'string' },
  description: { type: 'string' },
  enabled: { type: 'string' },
  reason: { type: 'string' },
  id: { type: 'string' },
  email: { type: 'string' },
  role: { type: 'string', multiple: true },
  'password-stdin': { type: 'boolean' },
  'grace-minutes': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Opts = ReturnType<typeof parse>['values'];
function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true, allowNegative: true });
}

function policyFromOpts(o: Opts): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  if (o.from !== undefined) p.fromAddress = o.from;
  if (o['from-name'] !== undefined) p.fromName = o['from-name'];
  if (o.allow !== undefined) p.allowedRecipients = o.allow.flatMap((a) => a.split(',')).map((s) => s.trim()).filter(Boolean);
  if (o.mode !== undefined) p.mode = o.mode;
  if (o['quota-hour'] !== undefined) p.quotaPerHour = num(o['quota-hour']);
  if (o['quota-day'] !== undefined) p.quotaPerDay = num(o['quota-day']);
  if (o['max-recipients'] !== undefined) p.maxRecipientsPerMessage = num(o['max-recipients']);
  if (o['max-bytes'] !== undefined) p.maxMessageBytes = num(o['max-bytes']);
  if (o['reply-to'] !== undefined) p.allowReplyTo = o['reply-to'];
  if (o.attachments !== undefined) p.attachmentsAllowed = o.attachments;
  if (o['allow-duplicates'] !== undefined) p.allowDuplicates = o['allow-duplicates'];
  if (o['max-attachment-bytes'] !== undefined) p.maxAttachmentBytes = num(o['max-attachment-bytes']);
  if (o.provider !== undefined) p.liveProvider = o.provider === 'default' ? null : o.provider;
  if (o.description !== undefined) p.description = o.description;
  if (o.enabled !== undefined) p.enabled = o.enabled === 'true';
  return p;
}

function need(v: string | undefined, flag: string): string {
  if (!v) throw new Error(`Missing required option --${flag}`);
  return v;
}

async function readPassword(fromStdin: boolean): Promise<string> {
  if (fromStdin || !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const ask = (q: string) =>
    new Promise<string>((resolve) => {
      let muted = false;
      const output = new Writable({
        write(chunk, _enc, cb) {
          if (!muted) process.stdout.write(chunk);
          cb();
        },
      });
      const rl = createInterface({ input: process.stdin, output, terminal: true });
      rl.question(q, (a) => {
        rl.close();
        process.stdout.write('\n');
        resolve(a);
      });
      muted = true;
    });
  const a = await ask('Password (min 12 chars): ');
  const b = await ask('Repeat password: ');
  if (a !== b) throw new Error('Passwords do not match');
  return a;
}

const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');

async function main() {
  const { values: o, positionals } = parse(process.argv.slice(2));
  const cmd = positionals[0];
  if (!cmd || o.help) {
    process.stdout.write(HELP);
    return;
  }
  const cfg = buildConfig();
  const logger = createRootLogger({ level: process.env.CLI_LOG_LEVEL ?? 'warn', service: 'cli' });
  const app = await NestFactory.createApplicationContext(CliModule.forRoot({ cfg, logger }), { logger: false });
  try {
    const keys = app.get(KeysService);
    const gateway = app.get(GatewayStateService);
    const messages = app.get(AdminMessagesService);
    switch (cmd) {
      case 'keys:create': {
        const { key, secret } = await keys.create({ name: need(o.name, 'name'), ...policyFromOpts(o) }, CLI_ACTOR);
        out({ key });
        process.stdout.write(`\nAPI key (shown ONCE, store it securely now):\n\n  ${secret}\n\n`);
        break;
      }
      case 'keys:update': {
        const k = await keys.findByName(need(o.name, 'name'));
        out(await keys.update(k.id, policyFromOpts(o), CLI_ACTOR));
        break;
      }
      case 'keys:list': {
        const res = await keys.list({ pageSize: 200 });
        const usage = await app.get(QuotaService).usage(res.items.map((k) => k.id));
        console.table(
          res.items.map((k) => ({
            name: k.name,
            mode: k.mode,
            enabled: k.enabled,
            from: k.fromAddress,
            hour: `${usage[k.id]?.hour ?? 0}/${k.quotaPerHour}`,
            day: `${usage[k.id]?.day ?? 0}/${k.quotaPerDay}`,
            lastUsed: k.lastUsedAt ?? '-',
          })),
        );
        break;
      }
      case 'keys:show': {
        out(keys.view(await keys.findByName(need(o.name, 'name'))));
        break;
      }
      case 'keys:rotate': {
        const k = await keys.findByName(need(o.name, 'name'));
        const graceMinutes = o['grace-minutes'] !== undefined ? Number(o['grace-minutes']) : 0;
        const { secret, key } = await keys.rotate(k.id, CLI_ACTOR, { graceMinutes });
        const old = key.previousSecretValidUntil ? `The old secret keeps working until ${key.previousSecretValidUntil}.` : 'The old secret no longer works.';
        process.stdout.write(`Key "${k.name}" rotated. ${old}\n\nNew API key (shown ONCE):\n\n  ${secret}\n\n`);
        break;
      }
      case 'keys:enable':
      case 'keys:disable': {
        const k = await keys.findByName(need(o.name, 'name'));
        out(await keys.setEnabled(k.id, cmd === 'keys:enable', CLI_ACTOR));
        break;
      }
      case 'keys:delete': {
        const k = await keys.findByName(need(o.name, 'name'));
        await keys.remove(k.id, CLI_ACTOR);
        process.stdout.write(`Key "${k.name}" deleted.\n`);
        break;
      }
      case 'gateway:status':
        out(await gateway.get());
        break;
      case 'gateway:pause':
        out(await gateway.pause(o.reason ?? 'manual (cli)', CLI_ACTOR));
        break;
      case 'gateway:resume':
        out(await gateway.resume(CLI_ACTOR));
        break;
      case 'users:create': {
        const users = app.get(UsersService);
        const password = await readPassword(!!o['password-stdin']);
        const roles = (o.role ?? []).flatMap((r) => r.split(',')).map((r) => r.trim()).filter(Boolean);
        const u = await users.createLocal({ email: need(o.email, 'email'), name: o.name, roles, password }, CLI_ACTOR);
        out(u);
        process.stdout.write('\nUser created. Sign in at /ui/. Two-factor authentication can be enabled from the account menu (mandatory if TOTP_REQUIRED=true).\n');
        break;
      }
      case 'users:list': {
        const { items } = await app.get(UsersService).list();
        console.table(items.map((u) => ({ email: u.email, roles: u.roles.map((r) => r.name).join(', '), source: u.authSource, totp: u.totpEnrolled, disabled: u.disabled, lastLogin: u.lastLoginAt ?? '-' })));
        break;
      }
      case 'roles:list': {
        const { items } = await app.get(RolesService).list();
        console.table(items.map((r) => ({ name: r.name, builtin: r.builtin, users: r.userCount, permissions: r.permissions.join(' '), authentikGroups: r.ssoGroups.join(', ') })));
        break;
      }
      case 'users:reset-2fa': {
        const users = app.get(UsersService);
        const u = await users.getByEmail(need(o.email, 'email'));
        out(await users.resetTotp(u.id, CLI_ACTOR));
        break;
      }
      case 'users:reset-access': {
        const users = app.get(UsersService);
        const u = await users.getByEmail(need(o.email, 'email'));
        const r = await users.resetAccess(u.id, CLI_ACTOR);
        process.stdout.write(`${r.emailed ? `Invite emailed to ${u.email}. ` : ''}Invite link (valid ${r.expiresInHours}h, shown once): <PUBLIC_URL>${r.invitePath}\n`);
        break;
      }
      case 'users:disable':
      case 'users:enable': {
        const users = app.get(UsersService);
        const u = await users.getByEmail(need(o.email, 'email'));
        out(await users.update(u.id, { disabled: cmd === 'users:disable' }, CLI_ACTOR));
        break;
      }
      case 'messages:approve':
        out(await messages.approve(need(o.id, 'id'), CLI_ACTOR));
        break;
      case 'messages:reject':
        out(await messages.reject(need(o.id, 'id'), o.reason, CLI_ACTOR));
        break;
      case 'audit:verify': {
        const chain = app.get(AuditChainService);
        await chain.backfill();
        const r = await chain.verify();
        out(r);
        if (!r.ok) process.exitCode = 3;
        break;
      }
      case 'messages:encrypt-bodies':
        out(await messages.encryptLegacyBodies());
        break;
      default:
        process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
        process.exitCode = 2;
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  if (isGatewayError(err)) process.stderr.write(`Error ${err.code}: ${err.message}\n`);
  else process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
