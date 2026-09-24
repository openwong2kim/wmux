/** Opt-in: start a native agent from Chat in an already selected disposable,
 * empty shell pane. Requires CDP, PTY and agent env vars; consumes tokens. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
const endpoint = process.env.WMUX_CHAT_E2E_CDP;
const id = process.env.WMUX_CHAT_E2E_PTY;
const agent = process.env.WMUX_CHAT_E2E_AGENT;
const mode = process.env.WMUX_CHAT_E2E_MODE ?? 'default';
assert(['default', agent === 'claude' ? 'bypass' : 'yolo'].includes(mode));
assert(endpoint && /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) && id && ['claude', 'codex'].includes(agent));
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(page => /^http:\/\/127\.0\.0\.1:/.test(page.url()));
  assert(page);
  const pane = (await page.evaluate(() => window.electronAPI.pty.list())).find(pane => pane.id === id);
  assert(pane && /(?:\/tmp\/|\/T\/)wmux-chat-[^/]+\/?$/.test(pane.cwd));
  const before = await page.evaluate(id => window.electronAPI.chat.status(id), id);
  assert(!before.available && !before.agentSessionId && !before.agentAlive);
  await page.locator('[data-surface-view="chat"]:visible').click();
  const marker = `WMUX_CHAT_START_${randomUUID().slice(0, 8)}`;
  await page.locator('.wmux-chat-launch-options select').nth(0).selectOption(agent);
  await page.locator('.wmux-chat-launch-options select').nth(1).selectOption(mode);
  assert.equal(await page.locator('.wmux-chat-input:visible').count(), 1);
  await page.locator('.wmux-chat-input:visible').fill(`Reply exactly ${marker}.\nDo not use tools.`);
  const composer = await page.locator('.wmux-chat-composer:visible').boundingBox();
  const view = await page.locator('[data-chat-view]:visible').boundingBox();
  assert(composer && view && composer.y > view.y + view.height / 2, 'Composer must be at the bottom');
  await page.locator('.wmux-chat-send:visible').click();
  let history;
  for (let count = 0; count < 90; count++) {
    history = await page.evaluate(id => window.electronAPI.chat.snapshot(id), id);
    if (history?.events.some(event => event.kind === 'assistant_text' && event.text.includes(marker))) break;
    await page.waitForTimeout(500);
  }
  assert(history?.events.some(event => event.kind === 'assistant_text' && event.text.includes(marker)), 'Native answer missing; inspect login/trust/usage limits in Terminal');
  assert.equal(history.events.filter(event => event.kind === 'user_text' && event.text.includes(marker)).length, 1);
  const status = await page.evaluate(id => window.electronAPI.chat.status(id), id);
  assert(status.available && status.agentSessionId && !status.managed);
  await page.locator('[data-surface-view="terminal"]:visible').click();
  const terminal = await page.evaluate(id => window.electronAPI.pty.readText(id, { scrollback: 100 }), id);
  const terminalText = terminal.rows.map(row => row.text).join('\n');
  assert(terminalText.includes(marker));
  if (mode !== 'default') assert(terminalText.replace(/\s+/g, '').includes(mode === 'bypass' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox'));
  await page.locator('[data-surface-view="chat"]:visible').click();
  await page.locator('.wmux-chat-prose:visible').filter({ hasText: marker }).last().waitFor();
  console.log(JSON.stringify({ passed: true, agent, mode, ptyId: id, nativeSessionId: status.agentSessionId }));
} finally { await browser.close(); }
