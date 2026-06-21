// LanLink PR-5 — pairing/peer control-pipe RPC live dogfood (daemon-side).
//
// PR-5's renderer bridge (preload → ipcMain.handle → DaemonClient.rpc → daemon
// control pipe) is a thin pass-through, so the daemon control-pipe RPCs are the
// load-bearing half. This proves the 7 RPCs the bridge calls work end-to-end
// against a REAL daemon OS process:
//   pair.begin → pair.status → peers.list → peers.remove → pair.cancel cycle,
//   plus pair.join / send required-field rejection.
// Outbound join/send to a real remote peer need a 2nd physical machine (user's job,
// memory W-T2). pair.begin arms the ≤2min window with no listener required.
// Isolated under WMUX_DATA_SUFFIX so it never touches a real session.
//
//   node scripts/lanlink-pr5-dogfood.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUFFIX = '-lanlink-pr5';
const home = os.homedir();
const username = os.userInfo().username || 'default';
const PIPE = `\\\\.\\pipe\\wmux-daemon${SUFFIX}-${username}`;
const DIR = path.join(home, `.wmux${SUFFIX}`);
const TOKEN_PATH = path.join(home, '.wmux', 'daemon-auth-token');
const DAEMON = path.resolve('dist/daemon-bundle/index.js');

const env = { ...process.env, WMUX_DATA_SUFFIX: SUFFIX };

let pass = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); throw new Error(msg); }
  ok(msg);
}

function spawnDaemon() {
  const p = spawn(process.execPath, [DAEMON], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => { const s = String(d).trim(); if (s) console.log(`    [daemon] ${s}`); });
  p.stderr.on('data', (d) => { const s = String(d).trim(); if (s) console.log(`    [daemon-err] ${s}`); });
  return p;
}

function readToken() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf8').trim(); } catch { return ''; }
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const token = readToken();
    const sock = net.connect(PIPE);
    let buf = '';
    const id = `pr5-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`rpc timeout: ${method}`)); }, 6000);
    sock.on('connect', () => sock.write(JSON.stringify({ id, method, params, token }) + '\n'));
    sock.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        clearTimeout(timer);
        sock.end();
        if (msg.ok) return resolve(msg.result);
        return reject(new Error(msg.error || 'rpc error'));
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { await rpc('daemon.ping', {}); return; } catch { await sleep(300); }
  }
  throw new Error('daemon did not become ready');
}

async function assertReject(method, params, expectSubstr, msg) {
  try {
    await rpc(method, params);
    console.error(`  ✗ FAIL: ${msg} (expected a reject, got success)`);
    throw new Error(msg);
  } catch (e) {
    const m = String(e.message);
    if (m.startsWith('rpc timeout')) {
      console.error(`  ✗ FAIL: ${msg} (timed out instead of rejecting)`);
      throw e;
    }
    // Require the daemon's VALIDATION error — not a transport/auth failure — so an
    // infra error can't masquerade as a validation pass (CodeRabbit).
    if (expectSubstr && !m.includes(expectSubstr)) {
      console.error(`  ✗ FAIL: ${msg} (rejected, but not with the expected validation: "${m}")`);
      throw new Error(msg);
    }
    ok(`${msg} — rejected: "${m}"`);
  }
}

let daemon = null;
async function main() {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* fresh */ }

  console.log('\n=== LanLink PR-5 pairing/peer control-RPC dogfood ===');
  console.log(`pipe=${PIPE}\n`);

  daemon = spawnDaemon();
  await waitReady();
  ok('daemon ready (standalone spawn, isolated suffix)');

  // Mirror the real Settings flow: enable LanLink + pick a NIC first.
  const s0 = await rpc('lanlink.status', {});
  assert(s0.enabled === false, 'precondition: LanLink OFF by default');
  const nic = s0.nics[0] ? { name: s0.nics[0].name, mac: s0.nics[0].mac } : null;
  const s1 = await rpc('lanlink.configure', nic ? { enabled: true, nic } : { enabled: true });
  assert(s1.enabled === true, 'configure: LanLink enabled');
  console.log(`    NIC: ${nic ? nic.name : '(none — enable-only)'}`);

  // 1. pair.begin — mints a 6-digit PIN + arms the window.
  const pb = await rpc('lanlink.pair.begin', {});
  assert(typeof pb.pin === 'string' && /^\d{6}$/.test(pb.pin), 'pair.begin: mints a 6-digit PIN');
  assert(typeof pb.expiresInMs === 'number' && pb.expiresInMs > 0, 'pair.begin: positive expiresInMs');
  console.log(`    PIN=${pb.pin}  expiresInMs=${pb.expiresInMs}`);

  // 2. pair.status — window active, fresh fail count.
  const ps = await rpc('lanlink.pair.status', {});
  assert(ps.active === true, 'pair.status: active=true after begin');
  assert(typeof ps.expiresInMs === 'number' && ps.expiresInMs > 0, 'pair.status: positive expiresInMs');
  assert(ps.failCount === 0, 'pair.status: failCount=0 on a fresh window');

  // 3. peers.list — empty, with the `peers` wrapper key.
  const pl = await rpc('lanlink.peers.list', {});
  assert(pl && Array.isArray(pl.peers), 'peers.list: { peers: [...] } wrapper key');
  assert(pl.peers.length === 0, 'peers.list: empty before any pairing');

  // 4. peers.remove — no-op-but-ok on empty / unknown uuid (NOT an error).
  const rm0 = await rpc('lanlink.peers.remove', { peerUuid: '' });
  assert(rm0 && rm0.ok === true, 'peers.remove(empty uuid): {ok:true} silent no-op');
  const rm1 = await rpc('lanlink.peers.remove', { peerUuid: 'no-such-peer' });
  assert(rm1 && rm1.ok === true, 'peers.remove(unknown uuid): {ok:true} silent no-op');

  // 5. pair.join / send — required-field rejection (real outbound needs a 2nd box).
  await assertReject('lanlink.pair.join', {}, 'required', 'pair.join: rejects missing host/port/pin');
  await assertReject('lanlink.pair.join', { host: '10.0.0.5', port: 0, pin: '123456' }, 'required', 'pair.join: rejects invalid port (coerced to 0)');
  await assertReject('lanlink.send', {}, 'required', 'send: rejects missing host/port/peerUuid');
  await assertReject('lanlink.send', { host: '10.0.0.5', port: 45000 }, 'required', 'send: rejects missing peerUuid');

  // 6. pair.cancel — window goes inactive.
  const pc = await rpc('lanlink.pair.cancel', {});
  assert(pc && pc.ok === true, 'pair.cancel: {ok:true}');
  const ps2 = await rpc('lanlink.pair.status', {});
  assert(ps2.active === false, 'pair.status: active=false after cancel');

  // 7. pair.begin re-mint — a fresh window yields a new PIN.
  const pb2 = await rpc('lanlink.pair.begin', {});
  assert(/^\d{6}$/.test(pb2.pin), 'pair.begin: re-mints a fresh 6-digit PIN');
  await rpc('lanlink.pair.cancel', {});

  console.log(`\n=== ALL PR-5 daemon-RPC CHECKS PASSED (${pass}) ===`);
  console.log('The 7 control-pipe RPCs the PR-5 renderer bridge forwards all work');
  console.log('against a real daemon. Outbound join/send to a remote peer + the');
  console.log('renderer pixel pass (Settings PIN / remote card) follow.\n');
}

main()
  .catch((e) => { console.error('\nDOGFOOD FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    try { if (daemon) daemon.kill('SIGKILL'); } catch { /* ignore */ }
    await sleep(400);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });
