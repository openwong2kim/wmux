/** Opt-in native-terminal probe. The test pane must ALREADY run Codex or OpenCode, have
 * completed a harmless terminal prompt and have its native wmux integration enabled.
 * No managed-session start/resume or background provider is used here.
 * Requires WMUX_CHAT_E2E_CDP and WMUX_CHAT_E2E_PTY; consumes provider tokens. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
const endpoint = process.env.WMUX_CHAT_E2E_CDP;
const id = process.env.WMUX_CHAT_E2E_PTY;
assert(endpoint && /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) && id);
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser.contexts().flatMap(c => c.pages()).find(p => /^http:\/\/127\.0\.0\.1:/.test(p.url()));
  assert(page);
  const pane = (await page.evaluate(() => window.electronAPI.pty.list())).find(p => p.id === id);
  assert(pane && /(?:\/tmp\/|\/T\/)wmux-chat-[^/]+\/?$/.test(pane.cwd), 'Use a disposable native terminal pane');
  const status = await page.evaluate(id => window.electronAPI.chat.status(id), id);
  assert(status.available && status.agentSessionId && !status.managed, 'An existing native conversation is required');
  const before = await page.evaluate(id => window.electronAPI.chat.snapshot(id), id);
  assert(before.events.some(e => e.kind === 'user_text') && before.events.some(e => e.kind === 'assistant_text'));
  await page.locator('[data-surface-view="chat"]:visible').click({ timeout: 5000 });
  await page.locator('.wmux-chat-input:visible').waitFor();
  await page.locator('.wmux-chat-input:visible:not(:disabled)').waitFor({ timeout: 5000 });
  const marker = `WMUX_SAME_TERMINAL_${randomUUID().slice(0, 8)}`;
  await page.locator('.wmux-chat-input:visible').fill(`Reply exactly ${marker}. Do not use tools.`);
  await page.locator('.wmux-chat-send:visible').click();
  const deadline = Date.now() + 45000;
  let after;
  do {
    after = await page.evaluate(id => window.electronAPI.chat.snapshot(id), id);
    if (after.events.some(e => e.kind === 'assistant_text' && e.text.includes(marker))) break;
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  assert(after.events.some(e => e.kind === 'assistant_text' && e.text.includes(marker)), 'Native answer missing');
  assert.equal(after.events.filter(e => e.kind === 'user_text' && e.text.includes(marker)).length, 1);
  const current = await page.evaluate(id => window.electronAPI.chat.status(id), id);
  assert.equal(current.agentSessionId, status.agentSessionId);
  assert(!current.managed);
  await page.locator('[data-surface-view="terminal"]:visible').click();
  const terminal = await page.evaluate(id => window.electronAPI.pty.readText(id, { scrollback: 300 }), id);
  assert(terminal.success && terminal.rows.map(r => r.text).join('\n').includes(marker), 'Same terminal must contain the chat turn');
  await page.locator('[data-surface-view="chat"]:visible').click();
  await page.locator('.wmux-chat-prose:visible').filter({ hasText: marker }).last().waitFor();
  if (process.env.WMUX_CHAT_E2E_SCREENSHOT) await page.screenshot({ path: process.env.WMUX_CHAT_E2E_SCREENSHOT });
  console.log(JSON.stringify({ passed: true, agentSessionId: current.agentSessionId,
    checks: ['existing terminal history', 'chat input into same PTY', 'native answer', 'no duplicate user turn', 'same native session', 'terminal/chat roundtrip'] }));
} finally { await browser.close(); }
