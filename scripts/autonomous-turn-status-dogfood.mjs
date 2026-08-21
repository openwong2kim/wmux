// Dogfood #935 direction 2: does a turn the agent starts BY ITSELF report
// `running`, or does it wear the previous turn's `complete` for its whole
// length?
//
// Unit tests cannot answer this. The first attempt at this fix (#943) passed
// its own tests and was inert in production, because the thing that decides is
// the interaction between three live parts: the real Stop hook's arrival time,
// the real TUI's byte pattern, and the daemon's status gate. So this drives all
// three for real.
//
// Isolation: the daemon runs under a private WMUX_DATA_SUFFIX, so its control
// pipe name and its `~/.wmux<suffix>/daemon-pipe` hint file are its own. The
// pane inherits that suffix (DaemonSessionManager stamps it), so the hook
// bridge inside the pane resolves the private pipe. HOME stays real — Claude
// Code needs its credentials and its ORDINARY hook settings, which on this
// machine are already the plugin-less shape the report describes (Stop,
// SubagentStop, SessionStart, and the AskUserQuestion pair; no wide
// PostToolUse). The production daemon is never addressed.
//
// Usage: node scripts/autonomous-turn-status-dogfood.mjs
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = process.cwd();
const DAEMON = path.join(REPO, 'dist', 'daemon-bundle', 'index.js');
const TAG = Math.random().toString(36).slice(2, 8);
const SUFFIX = `-935dog-${TAG}`;
const DAEMON_DIR = path.join(os.homedir(), `.wmux${SUFFIX}`);
const PTY_ID = `dog935-${TAG}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readPipeName = () => fs.readFileSync(path.join(DAEMON_DIR, 'daemon-pipe'), 'utf8').trim();
const readToken = () => fs.readFileSync(path.join(DAEMON_DIR, 'daemon-auth-token'), 'utf8').trim();

function rpc(method, params = {}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const s = net.createConnection(readPipeName());
    let buf = '';
    const t = setTimeout(() => { s.destroy(); reject(new Error(`rpc timeout: ${method}`)); }, 20000);
    s.on('connect', () => s.write(`${JSON.stringify({ id, token: readToken(), method, params })}\n`));
    s.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        clearTimeout(t); s.end();
        return msg.ok ? resolve(msg.result) : reject(new Error(String(msg.error)));
      }
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function dumpScreen(label) {
  try {
    const text = await rpc('daemon.readSessionText', { id: PTY_ID, scrollback: 0 });
    const rows = (text?.rows ?? []).map((r) => (typeof r === 'string' ? r : r.text ?? ''));
    const meat = rows.filter((r) => r.trim().length > 0);
    console.log(`\n--- screen: ${label} (${meat.length} non-empty rows) ---`);
    for (const r of meat.slice(-14)) console.log('  |', r.slice(0, 150));
  } catch (e) { console.log(`[warn] screen read (${label}) failed:`, e.message); }
}

/** Long-lived listener: every status-bearing frame, stamped. */
function statusListener(t0) {
  const events = [];
  const s = net.createConnection(readPipeName());
  let buf = '';
  s.on('connect', () => {
    // Pushed events are first-party gated (#659): identify, THEN subscribe on
    // the same connection. Subscribing without the identify silently returns
    // ok:false and the stream stays empty.
    s.write(`${JSON.stringify({ id: `id-${TAG}`, token: readToken(), method: 'daemon.client.identify', params: { role: 'main' } })}\n`);
    setTimeout(() => {
      s.write(`${JSON.stringify({ id: `sub-${TAG}`, token: readToken(), method: 'daemon.events.subscribe', params: {} })}\n`);
    }, 300);
  });
  s.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let f; try { f = JSON.parse(line); } catch { continue; }
      if (f.sessionId && f.sessionId !== PTY_ID) continue;
      const at = ((Date.now() - t0) / 1000).toFixed(1);
      if (f.type === 'agent.event') {
        events.push({ at, kind: `agent.event ${f.data?.status}`, detail: `${f.data?.source ?? '?'}/${f.data?.hookKind ?? f.data?.message ?? ''}` });
      } else if (f.type === 'activity.active') {
        // `data` is the canonical agent name (or null); the repaint flag is
        // consumed daemon-side and does not ride the broadcast.
        events.push({ at, kind: 'activity.active (byte burst)', detail: f.data ?? '' });
      } else if (f.type === 'activity.idle') {
        events.push({ at, kind: 'activity.idle (byte silence)', detail: '' });
      }
    }
  });
  s.on('error', () => {});
  return { events, close: () => { try { s.destroy(); } catch {} } };
}

let daemonPid = null;
let sub = null;
let failed = false;

try {
  console.log(`[setup] bundle mtime=${fs.statSync(DAEMON).mtime.toISOString()}`);
  console.log(`[setup] private instance suffix=${SUFFIX} (production ~/.wmux untouched)`);

  // Scrub the agent env before it reaches the daemon — the pane inherits from
  // here, and a nested Claude Code that sees CLAUDE_CODE_CHILD_SESSION turns
  // transcript persistence off and comes up degraded, which is not the product
  // this is supposed to be measuring.
  const daemonEnv = { WMUX_DATA_SUFFIX: SUFFIX };
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|AI_AGENT)/i.test(k)) continue;
    daemonEnv[k] = v;
  }
  const child = spawn(process.execPath, [DAEMON], {
    env: daemonEnv, detached: true, stdio: 'ignore',
  });
  child.unref();
  daemonPid = child.pid;

  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    if (fs.existsSync(path.join(DAEMON_DIR, 'daemon-pipe')) && fs.existsSync(path.join(DAEMON_DIR, 'daemon-auth-token'))) {
      try { await rpc('daemon.listSessions'); ready = true; break; } catch { /* booting */ }
    }
    await sleep(400);
  }
  if (!ready) throw new Error('daemon never became ready');
  console.log(`[setup] daemon pid=${daemonPid} pipe=${readPipeName()}`);

  const t0 = Date.now();
  sub = statusListener(t0);
  await sleep(500);

  // An ordinary interactive shell pane, then launch the agent by typing —
  // exactly how a wmux pane gets an agent in it.
  await rpc('daemon.createSession', {
    id: PTY_ID,
    cmd: process.env.SHELL || '/bin/zsh',
    cwd: os.homedir(),
    cols: 140,
    rows: 41,
  });
  console.log(`[setup] pane=${PTY_ID} (interactive shell)`);

  // Input rides the SESSION pipe, the way a real client sends keystrokes —
  // that is the path `bridge.noteInput` sits on, so both the submitted-turn
  // boundary and the typing-echo stamp are exercised for real.
  await rpc('daemon.attachSession', { id: PTY_ID });
  const sessionSock = path.join(DAEMON_DIR, `session-${PTY_ID}.sock`);
  const inputSock = await new Promise((resolve, reject) => {
    const c = net.createConnection(sessionSock);
    const t = setTimeout(() => reject(new Error('session pipe connect timeout')), 15000);
    c.on('connect', () => { clearTimeout(t); c.write(`${readToken()}\n`); resolve(c); });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
  });
  inputSock.on('data', () => {});   // drain the output flush
  const write = async (data) => { inputSock.write(data); await sleep(120); };

  await sleep(2500);
  console.log('[setup] launching claude in the pane');
  // Pin the model: this machine's personal config selects one this account
  // cannot reach, and an errored turn ends without the Stop hook that the
  // scenario is built around.
  await write('claude --dangerously-skip-permissions --model sonnet\r');
  // Let the TUI boot and the SessionStart hook land.
  await sleep(20000);
  await dumpScreen('after boot');

  // ── The scenario ────────────────────────────────────────────────────────
  // Ask for a background task that finishes AFTER the turn ends, so the
  // completion resumes the agent with no submitted input behind it.
  console.log('[drive] submitting the turn that will resume itself');
  await write(
    'Run this in the background and then END YOUR TURN immediately without waiting: '
    + 'sleep 45 && echo WOKEUP. Do not comment. When the task completes later, '
    + 'read its output and reply with one short sentence about it.',
  );
  await sleep(1200);
  await write('\r');

  console.log('[drive] waiting out the submitted turn + the autonomous turn');
  for (let i = 0; i < 18; i++) {
    await sleep(10000);
    if ((i + 1) % 6 === 0) await dumpScreen(`t+${(i + 1) * 10}s`);
    else process.stdout.write(`  ..${(i + 1) * 10}s`);
  }
  console.log('');

  // ── The guard ───────────────────────────────────────────────────────────
  // Letting bytes promote a settled pane costs nothing only if the pane's own
  // echo of the user's typing is excluded. Compose a long draft, slowly, with
  // no Enter: the pane must stay settled for all of it.
  const beforeTyping = sub.events.length;
  console.log('\n[drive] typing a draft with no Enter (the echo guard)');
  for (let i = 0; i < 60; i++) {
    await write('abcdefghij'[i % 10]);
    await sleep(150);
  }
  await sleep(3000);
  const duringTyping = sub.events.slice(beforeTyping)
    .filter((e) => e.kind === 'activity.active (byte burst)');
  console.log(`[drive] draft typed; active bursts during it: ${duringTyping.length}`);

  await write('\x15');   // ctrl-U, discard the draft
  await sleep(1500);

  await dumpScreen('final');

  console.log('\n=== status timeline (t=0 at daemon subscribe) ===');
  for (const e of sub.events) console.log(`  ${e.at.padStart(6)}s  ${e.kind.padEnd(28)} ${e.detail}`);

  // ── The verdict ─────────────────────────────────────────────────────────
  // The bug: after the FIRST turn-ending `complete`, nothing reports running
  // again for the autonomous turn. So look for any running-class evidence
  // strictly after the first complete.
  const firstComplete = sub.events.findIndex((e) => e.kind === 'agent.event complete');
  const after = firstComplete >= 0 ? sub.events.slice(firstComplete + 1) : [];
  const resumed = after.filter((e) => e.kind === 'activity.active (byte burst)');

  console.log('\n=== verdict ===');
  if (duringTyping.length > 0) {
    failed = true;
    console.log(`FAIL (echo guard): typing a draft produced ${duringTyping.length} running burst(s)`);
  } else {
    console.log('PASS (echo guard): a draft typed into a settled pane never reported running');
  }
  if (firstComplete < 0) {
    failed = true;
    console.log('INCONCLUSIVE: no turn-ending `complete` was ever observed — the Stop hook did not land.');
  } else if (resumed.length > 0) {
    console.log(`PASS: the autonomous turn reported running — ${resumed.length} burst(s) after the turn-ending complete`);
    console.log(`      first at t=${resumed[0].at}s`);
  } else {
    failed = true;
    console.log('FAIL: the pane stayed settled through the autonomous turn (#935 direction 2 still present)');
  }
} catch (err) {
  failed = true;
  console.error('[error]', err?.message ?? err);
} finally {
  sub?.close();
  try { await rpc('daemon.destroySession', { id: PTY_ID }); } catch {}
  await sleep(500);
  if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM'); } catch {} }
  await sleep(1000);
  try { fs.rmSync(DAEMON_DIR, { recursive: true, force: true }); } catch {}
  console.log('[teardown] private daemon stopped, its data dir removed');
  process.exit(failed ? 1 : 0);
}
