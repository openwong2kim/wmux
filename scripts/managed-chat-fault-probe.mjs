/** Opt-in live cancellation/crash probe; consumes provider tokens.
 * Requires an isolated wmux-chat-* daemon, a managed test conversation in a
 * temporary wmux-chat-* cwd, and that pane's Chat view visible on its own.
 * Set WMUX_CHAT_E2E_CDP, WMUX_CHAT_E2E_PTY, WMUX_CHAT_E2E_DAEMON_SOCKET.
 * Only the verified isolated daemon's sole matching provider child is killed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const endpoint = process.env.WMUX_CHAT_E2E_CDP;
const ptyId = process.env.WMUX_CHAT_E2E_PTY;
const socket = process.env.WMUX_CHAT_E2E_DAEMON_SOCKET;
assert(endpoint && /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) && ptyId, 'Explicit loopback endpoint and test PTY required');
assert(socket && /\/\.wmux-chat-[^/]+\/daemon\.sock$/.test(socket), 'Use only an isolated wmux-chat-* daemon');
assert(process.platform !== 'win32', 'This process-fault probe currently requires POSIX');
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((item) => /^http:\/\/127\.0\.0\.1:/.test(item.url()));
  assert(page, 'Development renderer missing');
  const panes = await page.evaluate(() => window.electronAPI.pty.list());
  const pane = panes.find((item) => item.id === ptyId);
  assert(pane && /(?:\/tmp\/|\/T\/)wmux-chat-[^/]+\/?$/.test(pane.cwd), 'Temporary test workspace required');
  const status = () => page.evaluate((id) => window.electronAPI.chat.status(id), ptyId);
  const snapshot = () => page.evaluate((id) => window.electronAPI.chat.snapshot(id), ptyId);
  const initial = await status();
  const provider = initial.managed?.provider.id;
  assert(['codex', 'opencode'].includes(provider) && initial.managed.phase === 'ready');
  const until = async (test, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await test()) return; await page.waitForTimeout(100); }
    throw new Error('Timed out waiting for fault recovery');
  };
  const send = async (marker) => {
    await page.locator('.wmux-chat-input:visible').fill(`Output 2000 numbered lines explaining basic arithmetic, starting with ${marker}. Do not use tools, read files, or access the network.`);
    await page.locator('.wmux-chat-send:visible').click();
    await until(async () => (await status()).managed?.phase === 'running');
  };
  await send(`WMUX_CANCEL_${randomUUID()}`);
  await page.waitForTimeout(1500);
  assert(await page.locator('.wmux-chat-send:visible').isDisabled());
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await until(async () => (await status()).managed?.phase === 'ready', 25_000);
  console.log(JSON.stringify({ provider, check: 'requested cancellation confirmed', passed: true }));

  const marker = `WMUX_CRASH_${randomUUID()}`;
  await send(marker);
  await page.waitForTimeout(1500);
  const socketPids = execFileSync('/usr/sbin/lsof', ['-t', socket], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: +match[1], ppid: +match[2], command: match[3] }] : [];
  });
  const daemon = rows.find((row) => socketPids.includes(row.pid) && row.command.includes('/dist/daemon-bundle/index.js'));
  assert(daemon, 'Isolated daemon ownership could not be verified');
  const descendants = new Set([daemon.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
  }
  const candidates = rows.filter((row) => descendants.has(row.pid) && (provider === 'codex'
    ? row.command.includes('codex') && row.command.includes('app-server') && !row.command.includes('node ')
    : row.command.includes('opencode') && row.command.includes('serve --hostname=127.0.0.1')));
  assert.equal(candidates.length, 1, 'Require exactly one matching provider child; no arbitrary process selection');
  process.kill(candidates[0].pid, 'SIGKILL');
  await until(async () => (await status()).managed?.phase === 'unconfirmed');
  assert(await page.locator('.wmux-chat-input:visible').isDisabled());
  const count = async () => (await snapshot()).events.filter((event) => event.kind === 'user_text' && event.text.includes(marker)).length;
  const before = await count();
  assert.equal(before, 1, 'Native history must contain the dispatched request');
  await page.getByRole('button', { name: 'Reconnect and review history', exact: true }).click();
  await until(async () => (await status()).managed?.phase === 'ready');
  assert.equal((await status()).agentSessionId, initial.agentSessionId);
  await page.waitForTimeout(1500);
  assert.equal(await count(), before);
  console.log(JSON.stringify({ provider, check: 'crash blocks input; resume preserves identity/history without resend', passed: true }));
} finally { await browser.close(); }
