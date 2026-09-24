/** Opt-in live UI probe; consumes provider tokens.
 * Start a disposable WMUX_DATA_SUFFIX=-chat-managed-e2e app with a fresh pane
 * whose original cwd is a temporary wmux-chat-* directory. Enable experimental
 * Chat view in Settings and open that pane.
 * Set WMUX_CHAT_E2E_CDP, WMUX_CHAT_E2E_PTY, and optional WMUX_CHAT_E2E_PROVIDER.
 * Never use a production app/profile or an existing conversation.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const endpoint = process.env.WMUX_CHAT_E2E_CDP;
const ptyId = process.env.WMUX_CHAT_E2E_PTY;
const provider = process.env.WMUX_CHAT_E2E_PROVIDER ?? 'codex';
assert(endpoint && /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) && ptyId, 'Explicit disposable CDP endpoint and PTY are required');
assert(['codex', 'opencode'].includes(provider), 'Choose codex or opencode');
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((item) => /^http:\/\/127\.0\.0\.1:/.test(item.url()));
  assert(page, 'Development renderer missing');
  const panes = await page.evaluate(() => window.electronAPI.pty.list());
  const pane = panes.find((item) => item.id === ptyId);
  assert(pane && /(?:\/tmp\/|\/T\/)wmux-chat-[^/]+\/?$/.test(pane.cwd), 'Use a disposable temporary wmux-chat-* workspace');
  const before = await page.evaluate((id) => window.electronAPI.chat.status(id), ptyId);
  assert(!before.available && !before.managed, 'An unused test pane is required');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const until = async (test) => {
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      if (await test()) return;
      await page.waitForTimeout(200);
    }
    throw new Error('Timed out waiting for provider state');
  };
  const status = () => page.evaluate((id) => window.electronAPI.chat.status(id), ptyId);
  await page.locator('[data-surface-view="chat"]:visible').click();
  await page.locator('.wmux-chat-controls select').selectOption(provider);
  await page.getByRole('button', { name: 'Start new chat', exact: true }).click();
  await until(async () => (await status()).managed?.phase === 'ready');
  await page.locator('.wmux-chat-input:visible').fill('Reply with exactly WMUX_CHAT_UI_OK. Do not use tools or change any files.');
  await page.locator('.wmux-chat-send:visible').click();
  await until(async () => {
    const snapshot = await page.evaluate((id) => window.electronAPI.chat.snapshot(id), ptyId);
    return snapshot?.events.some((event) => event.kind === 'assistant_text' && event.text.includes('WMUX_CHAT_UI_OK'));
  });
  await until(async () => (await status()).managed?.phase === 'ready');
  await page.locator('[data-surface-view="terminal"]:visible').click();
  await page.locator('[data-surface-view="chat"]:visible').click();
  await page.locator('.wmux-chat-prose:visible').filter({ hasText: 'WMUX_CHAT_UI_OK' }).waitFor();
  if (process.env.WMUX_CHAT_E2E_SCREENSHOT) await page.screenshot({ path: process.env.WMUX_CHAT_E2E_SCREENSHOT });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, provider, checks: ['UI start', 'composer send', 'real response', 'provider completion', 'view switching', 'no renderer errors'] }));
} finally {
  await browser.close();
}
