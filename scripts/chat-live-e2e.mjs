/** Live desktop + real Claude E2E (consumes API tokens).
 * Start a disposable WMUX_DATA_SUFFIX=-chat-e2e app, launch Claude with default
 * permissions, submit one terminal prompt so its transcript exists, then open Chat.
 * WMUX_CHAT_E2E_CDP=http://127.0.0.1:<port> WMUX_CHAT_E2E_PTY=daemon-... node scripts/chat-live-e2e.mjs
 * Optional WMUX_CHAT_E2E_FAULT_PID=<isolated daemon pid>: briefly suspend/resume
 * only a daemon verified to own ~/.wmux-chat-e2e/daemon.sock. Never a user profile.
 *
 * Phone mode (`--agent claude|codex|opencode`): drives the phone chat routes
 * (cancel, daemon queue, DELETE, no-cap golden) over HTTP against a real agent.
 * Manual/local only, never CI; it consumes API tokens. Requirements:
 * - A disposable instance: the same WMUX_DATA_SUFFIX for the app and for this
 *   script, starting with -e2e or -df (the default and -dev profiles are always
 *   refused), a marker file `touch ~/.wmux<suffix>/chat-e2e-disposable` created by
 *   you in that data dir, and its web server running with input and transcript
 *   (`WMUX_DATA_SUFFIX=-e2e-chat wmux web --allow-input --allow-transcript`).
 * - One fresh pane in it running the agent, spawned from a scrubbed environment
 *   (no CLAUDE*, ANTHROPIC*, AI_AGENT or outer WMUX_* variables), with one prompt
 *   already answered so its conversation exists. The agent must run
 *   `python3 -c ...` without a permission prompt, for example:
 *     claude --allowedTools "Bash(python3:*)"
 *     codex (in an already-trusted directory; never accept a trust prompt here)
 *     opencode (scratch XDG dirs, permission.bash "allow", wmux chat plugin, any model)
 * The script pairs a throwaway phone device over the isolated daemon socket. On
 * exit, including Ctrl-C, it takes back its queue items, stops a running turn and
 * revokes the device (a failed revoke fails the run). The report holds statuses,
 * error tags and states only: no ids, message text or screen text.
 *   WMUX_DATA_SUFFIX=-e2e-chat node scripts/chat-live-e2e.mjs --agent claude --pty daemon-...
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const argValue = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const INTERRUPTION_PROMPT = 'For an interruption test, write a numbered list of 400 fictional planet names, one per line. Do not use tools or change files.';
const DISPOSABLE_MARKER = 'chat-e2e-disposable';
const phoneAgent = argValue('--agent');
if (phoneAgent) process.exit(await runPhone(phoneAgent, argValue('--pty') || process.env.WMUX_CHAT_E2E_PTY));

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
  const interruptionPrompt = INTERRUPTION_PROMPT;
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


/** Phone routes against a real agent in an isolated instance; returns the exit code. */
async function runPhone(agent, pty) {
  assert(['claude', 'codex', 'opencode'].includes(agent), '--agent must be claude, codex or opencode');
  assert(pty && /^[\w-]{1,64}$/.test(pty), '--pty <pane id> (or WMUX_CHAT_E2E_PTY) is required');
  // Isolation: never the default ('') or dev ('-dev') profile, only a suffix named for
  // disposable runs, and only a data dir the operator marked as disposable.
  const suffix = process.env.WMUX_DATA_SUFFIX ?? '';
  assert(!['', '-dev'].includes(suffix) && /^-(e2e|df)[\w-]*$/.test(suffix),
    'WMUX_DATA_SUFFIX must name a disposable instance (-e2e* or -df*); the default and -dev profiles are refused');
  const dir = path.join(os.homedir(), `.wmux${suffix}`);
  await fs.access(path.join(dir, DISPOSABLE_MARKER)).catch(() => {
    throw new Error(`Refusing: ${path.join(dir, DISPOSABLE_MARKER)} is missing. Create it only in a disposable instance's data dir.`);
  });
  const token = (await fs.readFile(path.join(dir, 'daemon-auth-token'), 'utf8')).trim();
  const web = JSON.parse(await fs.readFile(path.join(dir, 'web-state.json'), 'utf8'));
  assert(web.enabled && web.allowInput && web.allowTranscript, 'Start the isolated web server with --allow-input --allow-transcript');
  const base = `http://127.0.0.1:${web.port}`;
  const CANCEL = 'chat-cancel', QUEUE = 'chat-cancel,chat-queue';
  const report = { agent, startedAt: new Date().toISOString(), checks: [], observations: [] };
  const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
  const note = (name, value) => { report.observations.push({ name, value }); console.log(`NOTE ${name}: ${JSON.stringify(value)}`); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const newId = () => `${Date.now()}-${randomUUID()}`;
  // Status and error tag only: bodies carry session, turn and message ids and may echo text.
  const brief = r => `${r.status}${r.body?.error ? ` ${r.body.error}` : ''}`;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const socket = net.connect(path.join(dir, 'daemon.sock'));
    let buf = '';
    socket.setTimeout(20000, () => { socket.destroy(); reject(new Error(`${method} timed out`)); });
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: '1', method, params, token })}\n`));
    socket.on('data', d => {
      buf += d;
      if (!buf.includes('\n')) return;
      socket.end();
      const r = JSON.parse(buf.slice(0, buf.indexOf('\n')));
      if (r.ok) resolve(r.result); else reject(new Error(`${method} failed`));
    });
    socket.on('error', reject);
    socket.on('close', () => reject(new Error(`${method}: connection closed without an answer`)));
  });
  let device;
  const http = async (method, route, body, caps) => {
    const headers = { Authorization: `Bearer ${device.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(caps ? { 'x-wmux-client-caps': caps } : {}) };
    const r = await fetch(base + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: undefined }; }
  };
  const read = async (caps = CANCEL) => {
    const r = await http('GET', `/api/sessions/${pty}/turns`, undefined, caps);
    assert.equal(r.status, 200, `/turns answered ${brief(r)}`);
    return { chat: r.body.chat ?? {}, events: r.body.events ?? [] };
  };
  const until = async (label, predicate, timeout = 60000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > end) throw new Error(`Timed out after ${timeout}ms: ${label}`);
      await sleep(400);
    }
  };
  const queueIds = []; // every daemon-queue item this run created, taken back on exit
  const send = async (text, caps) => {
    const { chat } = await read(caps);
    const clientMessageId = newId();
    const r = await http('POST', `/api/sessions/${pty}/chat/messages`, { agentSessionId: chat.agentSessionId, historyEpoch: chat.historyEpoch, clientMessageId, text }, caps);
    if (caps === QUEUE && r.body?.state === 'queued') queueIds.push(clientMessageId);
    return { ...r, clientMessageId };
  };
  // Right after an Esc or a turn end the input-quiet fence answers chat-busy for a few seconds, and
  // the history epoch can move between the read and the send (session-changed on the same session).
  const sendWhenReady = async (text, caps, { busy = true } = {}) => {
    for (let attempt = 0; ; attempt++) {
      const r = await send(text, caps);
      const retry = r.status === 409 && (r.body?.error === 'session-changed' || busy && r.body?.error === 'chat-busy');
      if (!retry || attempt >= 15) return r;
      await sleep(1000);
    }
  };
  const hasUserRow = (events, text) => events.some(e => e.kind === 'user_text' && String(e.text).includes(text));
  const idleAndDrained = () => until('idle pane with an empty queue', async () => {
    const { chat } = await read(QUEUE);
    return chat.turn?.state === 'idle' && !(chat.queue ?? []).some(i => i.state === 'queued' || i.state === 'delivering');
  }, 180000);
  // One foreground command, long enough to catch the turn mid-tool.
  const toolPrompt = (word, seconds) => `Run exactly this shell command in the foreground and wait for it to finish: python3 -c "import time; time.sleep(${seconds}); print(1)" . Then reply with the single word ${word}.`;
  const startTurn = async text => {
    const before = await read();
    const r = await sendWhenReady(text, CANCEL);
    assert.equal(r.status, 202, `turn-starting send answered ${brief(r)}`);
    const { chat } = await until('turn running', async () => { const now = await read(); return now.chat.turn?.state === 'running' && now.chat.turn.id !== before.chat.turn?.id && now; });
    return { turnId: chat.turn.id, seen: new Set(before.events.map(e => e.id)) };
  };
  // The daemon writes the Esc only on positive evidence in the screen it reads, which can be mid-redraw.
  const cancelRunning = async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { chat } = await read();
      const r = await http('POST', `/api/sessions/${pty}/chat/cancel`, { agentSessionId: chat.agentSessionId, clientCancelId: newId(), ...(chat.turn?.id ? { turnId: chat.turn.id } : {}) }, CANCEL);
      if (r.status === 202) return { ...r, attempts: attempt + 1 };
      const retry = r.body?.error === 'cancel-cooldown' ? (r.body.retryAfterMs ?? 500) + 50
        : r.body?.error === 'turn-not-running' && chat.turn?.state === 'running' ? 700 : 0;
      if (!retry) throw new Error(`cancel answered ${brief(r)}`);
      await sleep(retry);
    }
    throw new Error('cancel never reached 202');
  };

  // Cleanup runs once, from `finally` or a signal: take back this run's queue items, stop a
  // running turn (a Claude native-queued prompt can only be stopped this way, never taken back),
  // then revoke the device. A revoke that does not answer ok fails the run.
  let cleaning;
  const cleanup = () => cleaning ??= (async () => {
    let failed = false;
    if (device?.token) {
      for (const id of queueIds) {
        const r = await http('DELETE', `/api/sessions/${pty}/chat/queue/${id}`, undefined, QUEUE).catch(() => ({ status: 0 }));
        if (r.status !== 200 && r.body?.error !== 'already-delivered' && r.body?.error !== 'queue-item-final') note('cleanup: queue item not taken back', brief(r));
      }
      for (let i = 0; i < 3; i++) {
        const now = await read().catch(() => null);
        if (now?.chat.turn?.state !== 'running') break;
        await cancelRunning().catch(e => note('cleanup: cancel', e.message));
        await sleep(3000);
      }
    }
    if (device?.deviceId) {
      let revoked = false;
      for (let i = 0; i < 3 && !revoked; i++) {
        const r = await rpc('daemon.web.deviceRevoke', { deviceId: device.deviceId }).catch(() => null);
        revoked = r?.ok === true;
        if (!revoked) await sleep(1000);
      }
      if (!revoked) { failed = true; console.error('FAIL the e2e device could not be revoked: revoke it in the instance before reuse'); }
      report.deviceRevoked = revoked;
    }
    report.finishedAt = new Date().toISOString();
    const out = process.env.WMUX_CHAT_E2E_OUTPUT || '/tmp/wmux-chat-e2e';
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, `phone-${agent}.json`), JSON.stringify(report, null, 2));
    return failed;
  })();
  const onSignal = (signal, exitCode) => process.once(signal, () => {
    report.failure = `interrupted by ${signal}`;
    cleanup().finally(() => process.exit(exitCode));
  });
  onSignal('SIGINT', 130);
  onSignal('SIGTERM', 143);

  let code = 0;
  try {
    const paired = await rpc('daemon.web.pairStart', { name: `chat-e2e-${agent}`, allowInput: true });
    const pairing = await fetch(`${base}/api/pair?code=${encodeURIComponent(paired.code)}`).catch(() => null);
    if (pairing?.status !== 200) {
      await rpc('daemon.web.pairCancel', {}).catch(() => {});
      throw new Error(`pairing failed (${pairing?.status ?? 'no answer'}); the pairing code was canceled`);
    }
    device = await pairing.json();
    const first = await read();
    assert.equal(first.chat.binding, 'terminal', 'The pane needs a live agent conversation (answer one prompt first)');
    assert.equal(first.chat.agent, agent, `The pane does not run ${agent}`);
    await idleAndDrained();

    // Golden: a client that declares no capability reads the chat object it always read.
    const golden = (await http('GET', `/api/sessions/${pty}/turns`)).body.chat;
    assert(!('turn' in golden) && !('queue' in golden), 'no-cap /turns must not carry turn or queue');
    assert.equal(golden.capabilities.cancel, false);
    assert.equal(golden.capabilities.queue === true, agent === 'claude', 'no-cap queue is Claude-only (native)');
    check('No capability: /turns chat object unchanged (no turn, no queue, cancel:false)');

    // Cancel while a tool is running -> 202, then the turn settles idle.
    const long = await startTurn(toolPrompt('LONGCANCEL', 45));
    const tool = await until('tool row for the running turn', async () => (await read()).events.some(e => !long.seen.has(e.id) && e.kind === 'tool_use'), 30000).catch(() => false);
    assert(tool, 'no tool row appeared for the running turn');
    const canceled = await cancelRunning();
    assert.equal(canceled.body.effect, 'interrupt-requested');
    note('cancel attempts', canceled.attempts);
    const sentAt = Date.now();
    await until('idle after cancel', async () => (await read()).chat.turn?.state === 'idle', 30000);
    note('ms from cancel to idle', Date.now() - sentAt);
    check('Cancel while a tool runs answers 202 and the turn goes idle');

    // Cancel right after a turn ended -> 409 turn-not-running.
    await idleAndDrained();
    await sleep(2100); // past the per-pane Esc cooldown, so only the turn state decides
    const before = await read();
    const word = `DONE${Date.now() % 100000}`;
    const short = await sendWhenReady(`Reply with exactly the single word ${word}`, CANCEL);
    assert.equal(short.status, 202, `short send answered ${brief(short)}`);
    const ended = await until('short turn ended', async () => {
      const now = await read();
      return now.chat.turn?.id !== before.chat.turn?.id && now.chat.turn?.state === 'idle' &&
        now.events.some(e => e.kind === 'assistant_text' && String(e.text).includes(word)) && now;
    }, 120000);
    const late = await http('POST', `/api/sessions/${pty}/chat/cancel`, { agentSessionId: ended.chat.agentSessionId, clientCancelId: newId(), turnId: ended.chat.turn.id }, CANCEL);
    assert.equal(late.status, 409, `late cancel answered ${brief(late)}`);
    assert.equal(late.body.error, 'turn-not-running');
    assert.equal(late.body.turn?.state, 'idle');
    check('Cancel right after the turn ended answers 409 turn-not-running');

    // Queue: two items held while a turn runs, delivered in order as separate turns; a third is taken back.
    await idleAndDrained();
    const held = await startTurn(toolPrompt('LONGQUEUE', 15));
    const tag = Date.now() % 100000;
    const items = [];
    for (const w of [`ALPHA${tag}`, `BRAVO${tag}`, `CHARLIE${tag}`]) {
      const r = await sendWhenReady(`Reply with exactly the single word ${w}`, QUEUE, { busy: false });
      assert.equal(r.status, 202, `queue send answered ${brief(r)}`);
      assert.equal(r.body.state, 'queued');
      items.push({ word: w, id: r.clientMessageId });
    }
    const [a, b, c] = items;
    const dropped = await http('DELETE', `/api/sessions/${pty}/chat/queue/${c.id}`, undefined, QUEUE);
    assert.equal(dropped.status, 200, `DELETE answered ${brief(dropped)}`);
    assert.equal(dropped.body.state, 'canceled');
    assert.equal((await http('DELETE', `/api/sessions/${pty}/chat/queue/${c.id}`, undefined, QUEUE)).status, 200);
    check('Queue: items held while running (202 queued); DELETE takes one back (200, also on repeat)');
    const turnIds = new Set();
    const done = await until('both queued items delivered and answered', async () => {
      const now = await read(QUEUE);
      if (now.chat.turn?.state === 'running' && now.chat.turn.id !== held.turnId) turnIds.add(now.chat.turn.id);
      const state = id => now.chat.queue.find(i => i.clientMessageId === id)?.state;
      return state(a.id) === 'delivered' && state(b.id) === 'delivered' && now.chat.turn?.state === 'idle' &&
        now.events.some(e => e.kind === 'assistant_text' && String(e.text).includes(b.word)) && now;
    }, 240000);
    note('queued item states', done.chat.queue.filter(i => items.some(x => x.id === i.clientMessageId)).map(i => i.state + (i.reason ? `:${i.reason}` : '')));
    note('running turns observed after the held turn', turnIds.size);
    const rows = done.events.filter(e => e.kind === 'user_text' || e.kind === 'assistant_text');
    const at = (kind, w) => rows.findIndex(e => e.kind === kind && String(e.text).includes(w));
    const order = [at('user_text', a.word), at('assistant_text', a.word), at('user_text', b.word), at('assistant_text', b.word)];
    assert(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `expected user A, reply A, user B, reply B in order; got ${order}`);
    assert(!hasUserRow(done.events, c.word), 'the taken-back item must never reach the agent');
    check('Queue: delivered in order as separate turns (a reply between them); the taken-back item never arrived');

    if (agent === 'claude') {
      // Claude's own composer queue (no chat-queue cap) + phone cancel. What wmux answers is
      // asserted; what Claude then does with the queued prompt is agent behavior, recorded only.
      await idleAndDrained();
      await sleep(2100);
      const stream = await startTurn(INTERRUPTION_PROMPT);
      await until('answer streaming', async () => (await read()).events.some(e => !stream.seen.has(e.id) && e.kind === 'assistant_text'), 30000).catch(() => false);
      const nativeWord = `NATIVE${Date.now() % 100000}`;
      const native = await sendWhenReady(`Reply with exactly the single word ${nativeWord}`, CANCEL);
      assert.equal(native.status, 202, `native mid-turn send answered ${brief(native)}`);
      assert.equal(native.body.queued, true);
      const second = await send(`Reply with exactly the single word SECOND${nativeWord}`, CANCEL);
      assert.equal(second.status, 409, `a second native mid-turn send answered ${brief(second)}`);
      assert.equal(second.body.error, 'chat-busy');
      check('Claude native queue: one mid-turn send is queued:true, a second in the same turn is 409 chat-busy');
      await cancelRunning();
      const receipt = await http('GET', `/api/sessions/${pty}/chat/messages/${native.clientMessageId}`, undefined, CANCEL);
      assert.equal(receipt.status, 200, `receipt answered ${brief(receipt)}`);
      assert.equal(receipt.body.state, 'submitted');
      assert.equal(receipt.body.queued, true);
      check('Claude native queue + cancel: 202, and the receipt stays submitted queued:true');
      const ran = await until('native-queued prompt ran', async () => hasUserRow((await read()).events, nativeWord), 45000).catch(() => false);
      note('Claude with the native-queued prompt after the Esc', ran ? 'ran it as the next turn' : 'did not run it within 45 s (back in the composer, or dropped)');
    }
  } catch (error) {
    report.failure = String(error.stack || error);
    console.error(`FAIL ${error.message}`);
    code = 1;
  } finally {
    if (await cleanup()) code = 1;
  }
  return code;
}
