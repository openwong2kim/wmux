// Phase 3 PR-B — isolated daemon resync probe (갭-프리 실증).
//
// Boots the BUNDLED daemon (dist/daemon-bundle/index.js) in a throwaway HOME
// with WMUX_DATA_SUFFIX isolation, creates a real PTY session, attaches a
// fake-renderer session-pipe client, then repeatedly triggers
// `daemon.resyncSession` WHILE the PTY is flooding output.
//
// What it proves end-to-end (on top of the socket-level unit test):
//  - the client-reconstructed screen (initial flush → live → RESYNC_BEGIN →
//    snapshot replay → live ...) has CONTIGUOUS numbered flood lines after
//    each burst quiesces — a byte lost at any resync seam (T1: snapshot /
//    partial-tail / post-marker tail / live) tears or drops a line;
//  - input written mid-resync still reaches the PTY (무단절);
//  - every reflush took the snapshot path (mode=snapshot in daemon log) —
//    an unexpected raw fallback fails the probe.
//
// Run: node scripts/phase3-resync-probe.mjs   (needs `npm run build:daemon` first)

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import headless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';

const { Terminal } = headless;
const { Unicode11Addon } = unicode11;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SUFFIX = '-resyncprobe';
const USERNAME = os.userInfo().username;
const COLS = 200;
const ROWS = 30;
const BURSTS = 3;
const LINES_PER_BURST = 4000;

const FLUSH_DONE = Buffer.from('\x00WMUX_FLUSH_DONE\x00');
const RESYNC_BEGIN = Buffer.from('\x00WMUX_RESYNC_BEGIN\x00');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

// --- control-pipe RPC client -------------------------------------------------
class ControlClient {
  constructor(pipeName, token) {
    this.pipeName = pipeName;
    this.token = token;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
  }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.pipeName);
      sock.setEncoding('utf8');
      sock.once('connect', () => { this.sock = sock; resolve(); });
      sock.once('error', reject);
      sock.on('data', (chunk) => {
        this.buf += chunk;
        const lines = this.buf.split('\n');
        this.buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
          }
        }
      });
    });
  }
  rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = String(this.nextId++);
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ id, method, params, token: this.token }) + '\n');
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`rpc timeout: ${method}`));
      }, 10000).unref?.();
    });
  }
  close() { this.sock?.destroy(); }
}

// --- fake renderer: session pipe client + marker-aware reconstruction --------
class RendererSim {
  constructor() {
    this.terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true, logLevel: 'off' });
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.mode = 'accumulating'; // initial flush
    this.pendingChunks = [];
    this.liveCarry = Buffer.alloc(0);
    this.lastByteAt = Date.now();
    this.flushCount = 0;
  }
  async write(data) {
    await new Promise((r) => this.terminal.write(data, r));
  }
  /** Feed raw socket bytes; applies the DaemonClient/useTerminal contract:
   *  accumulate → FLUSH_DONE → reset + write(replay) → live; live+BEGIN →
   *  back to accumulate. */
  async feed(chunk) {
    this.lastByteAt = Date.now();
    let rest = chunk;
    for (;;) {
      if (this.mode === 'accumulating') {
        this.pendingChunks.push(rest);
        const combined = Buffer.concat(this.pendingChunks);
        const idx = combined.indexOf(FLUSH_DONE);
        if (idx === -1) return;
        const replay = combined.subarray(0, idx);
        this.terminal.reset();
        await this.write(replay);
        this.flushCount++;
        this.pendingChunks = [];
        this.mode = 'live';
        rest = Buffer.from(combined.subarray(idx + FLUSH_DONE.length));
        if (rest.length === 0) return;
        continue;
      }
      // live: watch for RESYNC_BEGIN (probe always "armed" — simpler than main,
      // and marker bytes never legitimately appear in PTY output). Carry a
      // possible marker-prefix tail across chunk boundaries so a BEGIN split
      // over two socket reads is still detected (mirrors the main scanner).
      const scan = this.liveCarry.length > 0 ? Buffer.concat([this.liveCarry, rest]) : rest;
      this.liveCarry = Buffer.alloc(0);
      const bIdx = scan.indexOf(RESYNC_BEGIN);
      if (bIdx === -1) {
        let hold = 0;
        const maxK = Math.min(RESYNC_BEGIN.length - 1, scan.length);
        for (let k = maxK; k >= 1; k--) {
          if (scan.subarray(scan.length - k).equals(RESYNC_BEGIN.subarray(0, k))) { hold = k; break; }
        }
        this.liveCarry = Buffer.from(scan.subarray(scan.length - hold));
        await this.write(scan.subarray(0, scan.length - hold));
        return;
      }
      await this.write(scan.subarray(0, bIdx));
      this.mode = 'accumulating';
      rest = Buffer.from(scan.subarray(bIdx + RESYNC_BEGIN.length));
      if (rest.length === 0) return;
    }
  }
  bufferLines() {
    const buf = this.terminal.buffer.active;
    const lines = [];
    for (let y = 0; y < buf.length; y++) {
      lines.push(buf.getLine(y)?.translateToString(true) ?? '');
    }
    return lines;
  }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-resyncprobe-'));
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    WMUX_DATA_SUFFIX: SUFFIX,
  };
  console.log(`[probe] home=${home}`);
  const daemonLog = [];
  const daemon = spawn(process.execPath, [path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js')], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.on('data', (d) => daemonLog.push(d.toString()));
  daemon.stderr.on('data', (d) => daemonLog.push(d.toString()));
  const failures = [];
  try {
    const token = await waitFor('auth token', () => {
      try { return fs.readFileSync(path.join(home, `.wmux${SUFFIX}`, 'daemon-auth-token'), 'utf8').trim() || null; } catch { return null; }
    });
    const control = new ControlClient(`\\\\.\\pipe\\wmux-daemon${SUFFIX}-${USERNAME}`, token);
    await waitFor('control pipe', async () => {
      try { await control.connect(); return true; } catch { return null; }
    });
    console.log('[probe] control pipe connected');

    const sessionId = `resyncprobe-${Date.now().toString(36)}`;
    const sessionEnv = {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows',
      SYSTEMDRIVE: process.env.SYSTEMDRIVE ?? 'C:',
      COMSPEC: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
      USERPROFILE: home,
      TEMP: process.env.TEMP ?? home,
      TMP: process.env.TMP ?? home,
      PSModulePath: process.env.PSModulePath ?? '',
    };
    // Pre-write the flood scripts: no inline shell quoting (powershell 5.1
    // mangles the nested-quote one-liner), and cmd.exe keeps the prompt ASCII.
    for (let burst = 0; burst < BURSTS; burst++) {
      const start = burst * LINES_PER_BURST;
      fs.writeFileSync(
        path.join(home, `flood-${burst}.js`),
        `for(let i=${start};i<${start + LINES_PER_BURST};i++)console.log('line-'+String(i).padStart(6,'0')+' probe '.repeat(8))`,
      );
    }
    await control.rpc('daemon.createSession', {
      id: sessionId, cmd: 'cmd.exe', cwd: home, env: sessionEnv, cols: COLS, rows: ROWS,
    });
    await control.rpc('daemon.attachSession', { id: sessionId });

    // Session pipe attach (fake renderer).
    const sim = new RendererSim();
    const sessSock = await new Promise((resolve, reject) => {
      const s = net.createConnection(`\\\\.\\pipe\\wmux-session-${sessionId}`);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    const feedQueue = [];
    let feeding = false;
    sessSock.on('data', (chunk) => {
      feedQueue.push(chunk);
      if (feeding) return;
      feeding = true;
      (async () => {
        while (feedQueue.length) await sim.feed(feedQueue.shift());
        feeding = false;
      })().catch((e) => failures.push(`sim feed error: ${e.message}`));
    });
    sessSock.write(token + '\n');
    await waitFor('initial flush', () => sim.mode === 'live', 10000);
    console.log('[probe] session attached, initial flush complete');

    const quiesce = async () => {
      await waitFor('stream quiesce', () => Date.now() - sim.lastByteAt > 1500 && !feeding, 60000, 200);
    };
    await quiesce(); // let the prompt settle

    for (let burst = 0; burst < BURSTS; burst++) {
      const start = burst * LINES_PER_BURST;
      const cmd = `"${process.execPath}" flood-${burst}.js\r`;
      sessSock.write(cmd);
      // Fire resyncs while the flood is running.
      await sleep(400);
      for (let k = 0; k < 2; k++) {
        const res = await control.rpc('daemon.resyncSession', { id: sessionId, scrollback: 5000 });
        console.log(`[probe] burst=${burst} resync#${k} mode=${res.mode}${res.fallbackReason ? ` fallback=${res.fallbackReason}` : ''}`);
        if (res.mode !== 'snapshot') failures.push(`burst ${burst} resync ${k}: expected snapshot, got ${res.mode} (${res.fallbackReason})`);
        await sleep(350);
      }
      await quiesce();
      // Continuity assertion: every line-N visible in the buffer must be
      // contiguous ascending and end at the burst's last line.
      const nums = [];
      for (const line of sim.bufferLines()) {
        const m = /^line-(\d{6}) probe/.exec(line);
        if (m) nums.push(parseInt(m[1], 10));
      }
      const last = nums[nums.length - 1];
      let contiguous = nums.length > 10;
      for (let i = 1; i < nums.length; i++) {
        if (nums[i] !== nums[i - 1] + 1) { contiguous = false; failures.push(`burst ${burst}: gap ${nums[i - 1]} -> ${nums[i]}`); break; }
      }
      if (last !== start + LINES_PER_BURST - 1) {
        failures.push(`burst ${burst}: last visible line ${last}, expected ${start + LINES_PER_BURST - 1}`);
      }
      console.log(`[probe] burst=${burst} lines-in-buffer=${nums.length} last=${last} contiguous=${contiguous} ${contiguous && last === start + LINES_PER_BURST - 1 ? 'PASS' : 'FAIL'}`);
      if (nums.length === 0) {
        const tail = sim.bufferLines().filter((l) => l.trim()).slice(-12);
        console.log('[probe] screen tail:\n' + tail.map((l) => '    |' + l).join('\n'));
      }
    }

    // 무단절 input check: type an echo during one more resync.
    sessSock.write('echo probe-input-alive\r');
    await control.rpc('daemon.resyncSession', { id: sessionId, scrollback: 5000 }).catch((e) => failures.push(`final resync failed: ${e.message}`));
    await quiesce();
    const flat = sim.bufferLines().join('\n');
    if (!flat.includes('probe-input-alive')) failures.push('input written around resync never echoed (input dead-zone?)');
    else console.log('[probe] input-alive PASS');

    const reflushLogs = daemonLog.join('').split('\n').filter((l) => l.includes('[SessionPipe.reflush]'));
    console.log(`[probe] daemon reflush log lines: ${reflushLogs.length}`);
    for (const l of reflushLogs) console.log('  ' + l.trim());

    await control.rpc('daemon.destroySession', { id: sessionId }).catch(() => { /* teardown is best-effort */ });
    await control.rpc('daemon.shutdown', {}).catch(() => { /* daemon may already be exiting */ });
    control.close();
    sessSock.destroy();
  } finally {
    await sleep(500);
    try { daemon.kill('SIGKILL'); } catch { /* already gone */ }
    // Best-effort temp cleanup — locked files are fine to leave in %TEMP%.
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (failures.length) {
    console.error(`\n[probe] FAIL (${failures.length}):`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\n[probe] ALL PASS');
}

main().catch((err) => {
  console.error('[probe] fatal:', err);
  process.exit(1);
});
