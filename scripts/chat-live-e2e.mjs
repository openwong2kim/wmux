/** Live desktop + real Claude E2E (consumes API tokens).
 * Start a disposable WMUX_DATA_SUFFIX=-chat-e2e app, launch Claude with default
 * permissions, submit one terminal prompt so its transcript exists, then open Chat.
 * WMUX_CHAT_E2E_CDP=http://127.0.0.1:<port> WMUX_CHAT_E2E_PTY=daemon-... node scripts/chat-live-e2e.mjs
 * Optional WMUX_CHAT_E2E_FAULT_PID=<isolated daemon pid>: briefly suspend/resume
 * only a daemon verified to own ~/.wmux-chat-e2e/daemon.sock. Never a user profile.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const endpoint = process.env.WMUX_CHAT_E2E_CDP;
const pty = process.env.WMUX_CHAT_E2E_PTY;
assert(endpoint && pty, 'Explicit disposable CDP endpoint and PTY are required');
const faultPid = Number(process.env.WMUX_CHAT_E2E_FAULT_PID || 0);
if (faultPid) {
  const sockets = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(faultPid), '-U'], { encoding: 'utf8' });
  assert(sockets.includes(path.join(os.homedir(), '.wmux-chat-e2e/daemon.sock')), 'Fault injection is restricted to the disposable chat-e2e daemon');
}
const out = process.env.WMUX_CHAT_E2E_OUTPUT || '/tmp/wmux-chat-e2e';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap(c => c.pages()).find(p => /^http:\/\/127\.0\.0\.1:/.test(p.url()));
assert(page, 'Application renderer missing');
const report = { startedAt: new Date().toISOString(), checks: [], states: [], errors: [] };
let suspended = false;
page.on('pageerror', e => report.errors.push(e.message));
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const status = () => page.evaluate(id => window.electronAPI.chat.status(id), pty);
const snapshot = () => page.evaluate(id => window.electronAPI.chat.snapshot(id), pty);
const state = () => page.locator('[data-chat-state]:visible').getAttribute('data-chat-state');
const until = async (predicate, timeout = 30000) => {
  const end = Date.now() + timeout;
  do { if (await predicate()) return; await page.waitForTimeout(200); } while (Date.now() < end);
  throw new Error(`Timed out after ${timeout}ms`);
};
const send = async text => {
  await page.waitForTimeout(3500); // allow the terminal input-quiet guard to settle
  await page.locator('.wmux-chat-input:visible').fill(text);
  await page.locator('.wmux-chat-send:visible').click();
};
try {
  const list = await page.evaluate(() => window.electronAPI.pty.list());
  assert(list.length === 1 && list[0].id === pty, 'Use an isolated app with exactly one test PTY');
  const live = await status();
  assert(live.available && live.agentAlive, 'A live Claude session and readable transcript are required');
  assert.equal(await page.locator('[data-chat-view]:visible').count(), 1);
  const before = new Set((await snapshot()).events.map(e => e.id));
  const a = 500 + Date.now() % 400, b = 317;
  const prompt = `What is ${a} plus ${b}? Answer only the decimal result. Do not use tools.`;
  await send(prompt);
  await until(async () => { const s = await state(); report.states.push(s); return s === 'working'; });
  await until(async () => (await snapshot()).events.some(e => !before.has(e.id) && e.kind === 'user_text' && e.text.includes(prompt)));
  assert(await page.locator('.wmux-chat-send:visible').isDisabled());
  check('Real send starts a turn and blocks duplicate submission');
  await page.locator('[data-surface-view="terminal"]:visible').click();
  await page.locator('[data-surface-view="chat"]:visible').click();
  await until(async () => { const s = await state(); report.states.push(s); return s === 'complete'; }, 60000);
  const events = (await snapshot()).events.filter(e => !before.has(e.id));
  assert.equal(events.filter(e => e.kind === 'user_text' && e.text.includes(prompt)).length, 1);
  assert(events.some(e => e.kind === 'assistant_text' && !e.thinking && e.text.trim() === String(a + b)), 'Expected answer must be in an assistant event, not an echoed prompt');
  assert(await page.locator('.wmux-chat-assistant:visible').filter({ hasText: String(a + b) }).count() > 0);
  check('Real assistant answer completes once; Chat/Terminal switching preserves it');
  const draft = 'Unsent E2E draft — preserve me';
  await page.locator('.wmux-chat-input:visible').fill(draft);
  await page.locator('[data-surface-view="terminal"]:visible').click();
  await page.locator('[data-surface-view="chat"]:visible').click();
  await until(async () => (await page.locator('.wmux-chat-input:visible').inputValue()) === draft);
  check('Unsent draft survives view switching');
  await page.screenshot({ path: path.join(out, 'complete.png') });

  const preInterrupt = new Set((await snapshot()).events.map(e => e.id));
  const interruptionPrompt = 'For an interruption test, write a numbered list of 400 fictional planet names, one per line. Do not use tools or change files.';
  await send(interruptionPrompt);
  await until(async () => (await snapshot()).events.some(e => !preInterrupt.has(e.id) && e.kind === 'user_text' && e.text.includes(interruptionPrompt)));
  await until(async () => (await state()) === 'working');
  await page.waitForTimeout(800);
  await page.evaluate(id => window.electronAPI.pty.write(id, '\u0003'), pty);
  await until(async () => (await state()) === 'unconfirmed', 30000);
  assert.notEqual(await state(), 'complete');
  assert(await page.locator('.wmux-chat-send:visible').isDisabled());
  check('Interrupt before completion settles to completion-unconfirmed, never complete');
  await page.screenshot({ path: path.join(out, 'interrupted.png') });

  if (faultPid) {
    await page.locator('.wmux-chat-input:visible').fill(draft);
    const history = await page.locator('.wmux-chat-messages:visible').innerText();
    process.kill(faultPid, 'SIGSTOP'); suspended = true;
    try {
      await until(async () => (await state()) === 'disconnected', 25000);
      assert.equal(await page.locator('.wmux-chat-messages:visible').innerText(), history);
      assert.equal(await page.locator('.wmux-chat-input:visible').inputValue(), draft);
      assert(await page.locator('.wmux-chat-send:visible').isDisabled());
      await page.screenshot({ path: path.join(out, 'disconnected.png') });
      check('Real daemon timeout retains history and draft, disables send, shows lost updates');
    } finally { process.kill(faultPid, 'SIGCONT'); suspended = false; }
    await until(async () => !['disconnected', 'connecting', 'blocked'].includes(await state()), 30000);
    assert.equal(await page.locator('.wmux-chat-input:visible').inputValue(), draft);
    const recovered = (await snapshot()).events;
    assert.equal(new Set(recovered.map(e => e.id)).size, recovered.length);
    check('Daemon recovery resumes updates without duplicate events or draft loss');
  }
  assert.deepEqual(report.errors, []);
  check('No renderer exceptions');
} catch (error) {
  report.failure = String(error.stack || error);
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (suspended) process.kill(faultPid, 'SIGCONT');
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
