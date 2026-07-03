#!/usr/bin/env node
/**
 * Daemon auth-token PATH probe — end-to-end through the REAL bundled daemon
 * (isolated home + pipe; the developer's production wmux is untouched).
 *
 * Guards the fix for the suffix-unaware daemon token path: the daemon control
 * pipe is suffix-aware (`wmux-daemon${suffix}-user`) so a dev/dogfood instance
 * and a packaged instance run concurrently on DIFFERENT pipes — but all three
 * token sites used to hardcode the SHARED `~/.wmux/daemon-auth-token`, so the
 * two daemons collided on one credential file (a cold-start race or rotateToken
 * could then brick one instance's auth). The fix routes the writer
 * (DaemonPipeServer.getTokenPath), the launcher reader
 * (DaemonClient.readDaemonAuthToken) and the CLI reader
 * (cli/client.resolveDaemonAuthToken) through one suffix-aware helper
 * (getDaemonAuthTokenPath = `${getWmuxHomeDir()}/daemon-auth-token`), with a
 * read-only fallback to the legacy unsuffixed path.
 *
 * PASS criteria:
 *   P1  suffixed daemon WRITES its token to `<home>/.wmux${SUFFIX}/daemon-auth-token`
 *   P2  ...and does NOT pollute the shared, unsuffixed `<home>/.wmux/daemon-auth-token`
 *   P3  a reader resolving the token path from the daemon's OWN env (the suffix-aware
 *       ladder — `.wmux${SUFFIX}` then legacy `.wmux`) lands on EXACTLY the path the
 *       daemon wrote: the writer<->reader path agreement ("mismatch = brick").
 *       NOTE: this drives the path FORMULA end-to-end against the real daemon; the
 *       reader FUNCTIONS' own logic (readDaemonAuthToken / resolveDaemonAuthToken,
 *       suffix-first-then-legacy) is asserted with exact paths in the vitest units
 *       (client.daemonPipe.test.ts, DaemonPipeServer.test.ts).
 *   P4  ...and that reader-resolved token authenticates against the live daemon
 *   P5  a WRONG token is rejected (unauthorized) — sanity
 *   P6  BACKWARD COMPAT: with NO suffix, a pre-existing `~/.wmux/daemon-auth-token`
 *       (as older versions wrote) is adopted and still authenticates — no stranding
 *
 * Run: npm run build:daemon && node scripts/daemon-token-path-probe.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');

function writeConfig(wmuxDir, pipeName) {
  fs.writeFileSync(
    path.join(wmuxDir, 'config.json'),
    JSON.stringify({
      version: 1,
      daemon: { pipeName, logLevel: 'info', autoStart: true },
      session: {
        defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        defaultCols: 80, defaultRows: 24, bufferSizeMb: 8, bufferMaxMb: 64,
        deadSessionTtlHours: 24, deadSessionDumpBuffer: true,
      },
    }, null, 2),
  );
}

function makePipeName(tag) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-test-${tag}`
    : path.join(os.tmpdir(), `wmux-test-${tag}.sock`);
}

// Spawn the real daemon with an isolated HOME and (optionally) a data suffix,
// exactly as the main process would inherit it to the detached daemon.
function spawnDaemon(testHome, suffix, logChunks) {
  const d = spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      USERPROFILE: testHome,
      HOME: testHome,
      HOMEDRIVE: undefined,
      HOMEPATH: undefined,
      ...(suffix ? { WMUX_DATA_SUFFIX: suffix } : { WMUX_DATA_SUFFIX: undefined }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  d.stdout.on('data', (c) => logChunks && logChunks.push(c.toString()));
  d.stderr.on('data', (c) => logChunks && logChunks.push(c.toString()));
  return d;
}

async function waitForPipeFile(wmuxDir, timeoutMs = 15_000) {
  const pipeFile = path.join(wmuxDir, 'daemon-pipe');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pipeFile)) {
      const v = fs.readFileSync(pipeFile, 'utf-8').trim();
      if (v) return v;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('daemon-pipe did not appear within timeout');
}

async function waitForFile(p, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function connectSocket(pipeName) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(pipeName, () => resolve(s));
    s.on('error', reject);
  });
}

function rpc(socket, method, params, authToken, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const id = `req-${Math.random().toString(36).slice(2, 10)}`;
    let buffer = '';
    const handler = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            socket.removeListener('data', handler);
            if (msg.ok) resolve({ ok: true, result: msg.result });
            else resolve({ ok: false, error: msg.error });
            return;
          }
        } catch { /* ignore */ }
      }
    };
    socket.on('data', handler);
    socket.write(JSON.stringify({ id, method, params, token: authToken }) + '\n');
    setTimeout(() => { socket.removeListener('data', handler); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
  });
}

// Reader-side path resolution, replicated from the shared helpers so the probe
// EXERCISES the writer<->reader path agreement instead of hardcoding the write
// path. Mirrors getDaemonAuthTokenPath (`${USERPROFILE||HOME}/.wmux${suffix}/
// daemon-auth-token`) then getLegacyDaemonAuthTokenPath (`…/.wmux/…`). The daemon
// was spawned with USERPROFILE/HOME = testHome, so a reader running in that env
// computes exactly these candidates — driving the token READ through this ladder
// is what proves env→path→token agreement E2E ("mismatch = brick"). Keep this in
// lockstep with src/shared/constants.ts if the path formula changes.
function readerResolveToken(testHome, suffix) {
  const candidates = [
    path.join(testHome, `.wmux${suffix ?? ''}`, 'daemon-auth-token'),
    path.join(testHome, '.wmux', 'daemon-auth-token'), // legacy unsuffixed fallback
  ];
  for (const p of candidates) {
    try {
      const t = fs.readFileSync(p, 'utf-8').trim();
      if (t) return { token: t, path: p };
    } catch { /* candidate absent — try the next */ }
  }
  return { token: '', path: null };
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const live = [];
function killAll() {
  for (const d of live) { try { d.kill('SIGKILL'); } catch { /* ignore */ } }
}

async function scenarioSuffixIsolation() {
  const tag = `tokp-${randomUUID().slice(0, 8)}`;
  const suffix = `-probe${randomUUID().slice(0, 4)}`;
  const testHome = path.join(os.tmpdir(), `wmux-${tag}`);
  const suffixedDir = path.join(testHome, `.wmux${suffix}`);
  const legacyDir = path.join(testHome, '.wmux');
  fs.mkdirSync(suffixedDir, { recursive: true });

  const pipeName = makePipeName(tag);
  writeConfig(suffixedDir, pipeName); // NO pre-seeded token — daemon must create it
  const log = [];
  const daemon = spawnDaemon(testHome, suffix, log);
  live.push(daemon);
  let sock;
  try {
    const resolved = await waitForPipeFile(suffixedDir);

    const suffixedToken = path.join(suffixedDir, 'daemon-auth-token');
    const legacyToken = path.join(legacyDir, 'daemon-auth-token');
    const wroteSuffixed = await waitForFile(suffixedToken);
    check('P1 suffixed daemon WRITES token to the suffix-aware dir', wroteSuffixed, suffixedToken);
    check('P2 suffixed daemon does NOT pollute the shared ~/.wmux token', !fs.existsSync(legacyToken), legacyToken);

    // Resolve the token the way a READER does (independent path computation from
    // the daemon's env), NOT by hardcoding the write path — this is what actually
    // exercises the writer<->reader agreement (GLM review).
    const reader = readerResolveToken(testHome, suffix);
    check('P3 a reader resolving from the daemon env lands on the daemon-written path (writer<->reader agreement)',
      reader.path === suffixedToken, `reader-resolved=${reader.path}  daemon-wrote=${suffixedToken}`);

    sock = await connectSocket(resolved);
    const good = await rpc(sock, 'daemon.ping', {}, reader.token);
    check('P4 the reader-resolved token authenticates against the live daemon', good.ok === true, good.ok ? 'pong' : `error=${JSON.stringify(good.error)}`);

    const bad = await rpc(sock, 'daemon.ping', {}, 'not-the-real-token');
    check('P5 a WRONG token is rejected (unauthorized)', bad.ok === false && String(bad.error).includes('unauthorized'), JSON.stringify(bad.error));
  } finally {
    try { sock?.destroy(); } catch { /* ignore */ }
    try { daemon.kill('SIGKILL'); } catch { /* ignore */ }
    if (results.some((r) => !r.ok)) console.log('--- daemon log (suffix scenario) ---\n' + log.join(''));
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function scenarioBackwardCompat() {
  const tag = `tokp-bc-${randomUUID().slice(0, 8)}`;
  const testHome = path.join(os.tmpdir(), `wmux-${tag}`);
  const wmuxDir = path.join(testHome, '.wmux'); // NO suffix — production layout
  fs.mkdirSync(wmuxDir, { recursive: true });

  const pipeName = makePipeName(tag);
  writeConfig(wmuxDir, pipeName);
  // Pre-seed a legacy token EXACTLY where older wmux versions wrote it.
  const legacyToken = `legacy-${randomUUID()}`;
  fs.writeFileSync(path.join(wmuxDir, 'daemon-auth-token'), legacyToken, 'utf-8');

  const log = [];
  const daemon = spawnDaemon(testHome, undefined, log);
  live.push(daemon);
  let sock;
  try {
    const resolved = await waitForPipeFile(wmuxDir);
    sock = await connectSocket(resolved);
    const good = await rpc(sock, 'daemon.ping', {}, legacyToken);
    check('P6 backward-compat: pre-existing ~/.wmux token is adopted & authenticates', good.ok === true, good.ok ? 'pong' : `error=${JSON.stringify(good.error)}`);
  } finally {
    try { sock?.destroy(); } catch { /* ignore */ }
    try { daemon.kill('SIGKILL'); } catch { /* ignore */ }
    if (!results[results.length - 1]?.ok) console.log('--- daemon log (backward-compat scenario) ---\n' + log.join(''));
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  if (!fs.existsSync(DAEMON_BUNDLE)) {
    console.error(`Daemon bundle missing: ${DAEMON_BUNDLE}\nRun: npm run build:daemon`);
    process.exit(2);
  }
  console.log('daemon-token-path-probe — real bundled daemon, isolated homes\n');
  await scenarioSuffixIsolation();
  await scenarioBackwardCompat();

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n${passed}/${total} checks passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('probe crashed:', err);
  killAll();
  process.exit(3);
});
