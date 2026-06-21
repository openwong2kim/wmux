// LanLink PR-3 — control-plane persistence live dogfood (daemon-side).
//
// Proves what unit tests cannot: a real daemon OS process persists the lanlink
// control-plane config to config.json, and after a HARD KILL + respawn the
// enable/NIC state survives on disk and the NIC list is re-resolved live. Network
// 0 — nothing here opens a port (PR-4 builds the listener). Isolated under
// WMUX_DATA_SUFFIX so it never touches a real session.
//
//   node scripts/lanlink-pr3-dogfood.mjs
//
// Checks: status read (OFF default + live NICs) · configure persists to
// config.json · disk survives SIGKILL · respawn restores enable+NIC · re-resolved
// NIC list · disable round-trip · idempotent no-op.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUFFIX = '-lanlink-pr3';
const home = os.homedir();
const username = os.userInfo().username || 'default';
const PIPE = `\\\\.\\pipe\\wmux-daemon${SUFFIX}-${username}`;
const DIR = path.join(home, `.wmux${SUFFIX}`);
const CONFIG = path.join(DIR, 'config.json');
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
    const id = `pr3-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`rpc timeout: ${method}`)); }, 6000);
    sock.on('connect', () => sock.write(JSON.stringify({ id, method, params, token }) + '\n'));
    sock.on('data', (c) => {
      buf += c;
      // Match our response by `id`; broadcast event lines may interleave.
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

function readConfigLanlink() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).lanlink;
}

let daemon = null;
async function main() {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* fresh */ }

  console.log('\n=== LanLink PR-3 control-plane persistence dogfood ===');
  console.log(`pipe=${PIPE}\nconfig=${CONFIG}\n`);

  // 1. Spawn daemon, read status — must default OFF with no NIC + a live NIC list.
  daemon = spawnDaemon();
  await waitReady();
  ok('daemon ready (standalone spawn)');

  const s0 = await rpc('lanlink.status', {});
  assert(s0.enabled === false, 'status: enabled defaults OFF');
  assert(s0.nic === null, 'status: no NIC selected by default');
  assert(Array.isArray(s0.nics), 'status: nics is a live array');
  console.log(`    live NICs: ${s0.nics.map((n) => n.name).join(', ') || '(none)'}`);

  const diskDefault = readConfigLanlink();
  assert(diskDefault && diskDefault.enabled === false && diskDefault.nic === null,
    'config.json seeded with OFF lanlink slice at first boot');

  // Pick a real NIC if the host has one; otherwise exercise the enable toggle only.
  const nic = s0.nics[0] ? { name: s0.nics[0].name, mac: s0.nics[0].mac } : null;

  // 2. Configure: enable + (optionally) pick a NIC. Response echoes new status.
  const s1 = await rpc('lanlink.configure', nic ? { enabled: true, nic } : { enabled: true });
  assert(s1.enabled === true, 'configure(enable): status echoes enabled=true');
  if (nic) assert(s1.nic && s1.nic.name === nic.name && s1.nic.mac === nic.mac, 'configure: NIC identity echoed');

  // 3. config.json on disk reflects the change.
  const disk1 = readConfigLanlink();
  assert(disk1.enabled === true, 'config.json reflects enabled=true');
  if (nic) assert(disk1.nic && disk1.nic.name === nic.name && disk1.nic.mac === nic.mac,
    'config.json persisted NIC identity (name+MAC, not a raw IP)');

  // 4. HARD KILL — config must survive on disk.
  daemon.kill('SIGKILL');
  await sleep(1200);
  assert(daemon.killed || daemon.exitCode !== null, 'daemon process killed');
  const disk2 = readConfigLanlink();
  assert(disk2.enabled === true, 'config.json survived SIGKILL with enabled=true');
  if (nic) assert(disk2.nic && disk2.nic.name === nic.name, 'config.json survived SIGKILL with NIC identity');

  // 5. Respawn (same suffix) — status restores enable+NIC, NIC list re-resolved live.
  daemon = spawnDaemon();
  await waitReady();
  ok('daemon respawned (same WMUX_DATA_SUFFIX)');

  const s2 = await rpc('lanlink.status', {});
  assert(s2.enabled === true, 'PERSIST: enabled=true restored from disk after respawn');
  if (nic) assert(s2.nic && s2.nic.name === nic.name && s2.nic.mac === nic.mac,
    'PERSIST: NIC identity restored from disk');
  assert(Array.isArray(s2.nics), 'NIC list re-resolved live after respawn');

  // 6. Idempotent no-op: re-configure the SAME enabled value — status unchanged.
  const s3 = await rpc('lanlink.configure', { enabled: true });
  assert(s3.enabled === true, 'idempotent configure(enabled=true) keeps status enabled');

  // 7. Disable round-trip — persists OFF.
  const s4 = await rpc('lanlink.configure', { enabled: false });
  assert(s4.enabled === false, 'configure(disable): status echoes enabled=false');
  assert(readConfigLanlink().enabled === false, 'config.json reflects enabled=false');

  console.log(`\n=== ALL PR-3 CHECKS PASSED (${pass}) ===`);
  console.log('network-0: no listener was started — lanlink.configure only flips persisted');
  console.log('config and fires the in-daemon "changed" seam (PR-4 subscribes).\n');
}

main()
  .catch((e) => { console.error('\nDOGFOOD FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    try { if (daemon) daemon.kill('SIGKILL'); } catch { /* ignore */ }
    await sleep(400);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });
