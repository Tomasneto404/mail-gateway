// Authored by Tomás Neto (TN 2026)
import { expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';

// Visual/CSP smoke: visits every screen in light + dark, fails on CSP violations or console errors.
const CLI = process.env.MG_CLI ?? 'docker compose exec -T api node dist/cli.js';
const ROOT = new URL('../..', import.meta.url).pathname;
const OUT = process.env.MG_SHOTS;
const EMAIL = `shots-${Date.now().toString(36)}@admins.test`;
const PASSWORD = 'screens correct horse battery';

test('every screen renders without CSP violations', async ({ page }) => {
  execSync(`${CLI} users:create --email ${EMAIL} --role admin --password-stdin`, { cwd: ROOT, input: PASSWORD, stdio: ['pipe', 'pipe', 'inherit'] });
  if (process.env.MG_VIEWPORT_W) await page.setViewportSize({ width: Number(process.env.MG_VIEWPORT_W), height: 1000 });
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.goto('/ui/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const firstKey = await page.request.get('/admin/keys?pageSize=1').then((r) => r.json());
  // the key detail screen needs a key; an empty database (fresh stack) skips it
  const keyId: string | undefined = firstKey.items[0]?.id;
  const screens = ['', 'keys', ...(keyId ? [`keys/${keyId}`] : []), 'messages', 'approvals', 'users', 'roles', 'templates', 'alerts', 'activity', 'settings'];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => localStorage.setItem('mg-theme', t), theme);
    for (const s of screens) {
      await page.goto(`/ui/${s}`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(300);
      if (OUT) await page.screenshot({ path: `${OUT}/${theme}-${s.replace(/\//g, '_').slice(0, 20) || 'dashboard'}.png`, fullPage: true });
      if (OUT && s.startsWith('keys/')) {
        await page.locator('main > div.overflow-auto').evaluate((el) => el.scrollTo(0, el.scrollHeight));
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${OUT}/${theme}-key-bottom.png` });
      }
    }
  }
  // Check Queues: every BullMQ queue, live from Redis
  await page.goto('/ui/');
  await page.getByRole('button', { name: 'Check Queues' }).click();
  const dialog = page.getByTestId('queues-dialog');
  for (const q of ['delivery', 'system-mail', 'alerts', 'maintenance']) await expect(dialog.getByTestId(`queue-${q}`)).toBeVisible();
  // the first queue opens on its own and shows the per-minute chart
  await expect(dialog.getByTestId('queue-delivery').locator('[aria-expanded="true"]')).toBeVisible();
  await expect(dialog.getByTestId('queue-delivery').getByText('Finished per minute')).toBeVisible();
  if (OUT) await page.screenshot({ path: `${OUT}/queues.png` });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  expect(problems.filter((p) => !p.includes('401'))).toEqual([]);
});
