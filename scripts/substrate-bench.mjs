#!/usr/bin/env node
/**
 * substrate-bench.mjs — performance characterization of the wmux substrate.
 *
 * WHAT THIS PROVES
 * ----------------
 * Resolves the open profiling TODO in docs/internal/m0-design.md §8 Q5
 * ("MetadataStore.snapshot() performance under high write load: 1000
 * writes/sec for 60s, then a snapshot() mid-burst — does it block the main
 * process?") and supplies issue #15 the missing honest perf numbers:
 * burst throughput, the real ring-overflow point, and reconciliation latency.
 *
 * It measures the substrate END TO END over the real Named Pipe against the
 * packaged production app — not the in-memory store in isolation. So the
 * numbers it reports are "what an external plugin actually sees", which
 * includes the JSON-over-pipe IPC round-trip and the per-socket / global
 * rate limiters (PipeServer: 50 rpc/s per socket, 200 rpc/s global). Those
 * wire caps bound external throughput well below the store's internal
 * capacity, so several scenarios are deliberately rate-limiter-bound; each
 * such line is annotated CAP-BOUND so nobody mistakes the rate limiter for
 * a store bottleneck. See docs/internal/substrate-perf.md for the analysis.
 *
 * SCENARIOS
 * ---------
 *   B1  metadata write throughput   — sustained pane.setMetadata rate,
 *                                      latency p50/p95/p99, version monotonic.
 *   B2  events.poll latency         — round-trip p50/p95 at a few page sizes.
 *   B3  ring-overflow point         — drive > RING_CAPACITY (1024) events
 *                                      between two polls, confirm resync:true
 *                                      + droppedCount>0, recover via pane.list.
 *   B4  snapshot/reconcile latency  — pane.list p50/p95 while writes are in
 *                                      flight (the direct answer to §8 Q5:
 *                                      does a snapshot mid-burst block?).
 *
 * ISOLATION MODEL (copied from scripts/m0-dynamic-verify.mjs)
 * ----------------------------------------------------------
 *   - Spawns out/wmux-win32-x64/wmux.exe with a temp USERPROFILE/HOME/APPDATA/
 *     LOCALAPPDATA so .wmux/, the auth token, pid-map and tcp-port are
 *     sandboxed. WMUX_DISABLE_CDP=true keeps the browser engine out.
 *   - The win32 pipe name is shared per Windows account (os.userInfo()), so
 *     we pre-flight pipeAlive() and ABORT if a real wmux is already on it —
 *     running two daemons collides on the single per-user pipe.
 *   - Reads the token from <TEST_HOME>/.wmux-auth-token once the app writes it.
 *   - Raw newline-delimited JSON-RPC over the pipe, carrying clientName
 *     'wmux-bench'. The sandbox trust DB is seeded with a `trusted` row
 *     declaring exactly the capabilities B1-B4 need, so the bench runs against
 *     the production enforce-mode app with no approval dialog. It used to send
 *     NO clientName and ride the 'legacy' grandfather; #1111 closes that lane
 *     in the first release on or after 2026-09-30. Not 'wmux-cli': that lane's
 *     allowlist covers none of events.poll / pane.getMetadata /
 *     pane.setMetadata, and widening a NON_IDENTIFYING name would grant those
 *     to every caller that claims it.
 *   - SIGTERM then SIGKILL on cleanup; awaits the cleanup deadline before exit
 *     so the temp HOME is actually removed.
 *
 * HOW TO RUN (single line, PowerShell — package first):
 *   npm run package; node scripts/substrate-bench.mjs --json out\substrate-bench.json
 *
 * Useful flags: --duration <sec> (B1/B4 burst window, default 10),
 *               --json <path> (also write machine-readable results),
 *               --help.
 *
 * THE NUMBERS ARE ENVIRONMENT-DEPENDENT. Pipe IPC latency, CPU, and disk
 * (each write persists metadata.json synchronously) all move the results.
 * Treat them as order-of-magnitude characterization, not a fixed spec. Re-run
 * on the target machine before quoting figures.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// === Constants mirrored from source (verify against the cited files) ===
// src/shared/events.ts
const RING_CAPACITY = 1024;
const POLL_DEFAULT_MAX = 256;
// src/main/pipe/PipeServer.ts
const PER_SOCKET_RATE = 50;   // rpc/s per socket
const GLOBAL_RATE = 200;      // rpc/s across all sockets

// `import.meta.dirname` is only on Node 20.11+; package.json declares
// engines.node >=18, so use the fileURLToPath shim like the other scripts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const APP_EXE = path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
const PIPE_NAME = `\\\\.\\pipe\\wmux-${os.userInfo().username}`;

// === CLI ===
function parseArgs(argv) {
  const out = { duration: 10, json: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--duration') out.duration = Math.max(1, Number(argv[++i]) || 10);
    else if (a === '--json') out.json = argv[++i];
    else { console.error(`unknown arg: ${a}`); out.help = true; }
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) {
  console.log(`substrate-bench.mjs — wmux substrate performance characterization

Usage (PowerShell, package first):
  npm run package; node scripts/substrate-bench.mjs [--duration <sec>] [--json <path>]

Flags:
  --duration <sec>   B1/B4 burst window in seconds (default 10).
  --json <path>      Also write machine-readable results JSON to <path>.
  -h, --help         Show this help.

Spawns the packaged app at out/wmux-win32-x64/wmux.exe in an isolated temp
HOME, talks raw JSON-RPC over the per-user Named Pipe (clientName 'wmux-bench'
→ a seeded trusted identity), runs B1-B4, and prints a results table. Numbers are
environment-dependent; re-run on the target machine. See
docs/internal/substrate-perf.md.`);
  process.exit(0);
}

if (!fs.existsSync(APP_EXE)) {
  console.error(`Packaged app missing at ${APP_EXE}. Run \`npm run package\` first.`);
  process.exit(2);
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bench-'));
const AUTH_TOKEN_PATH = path.join(TEST_HOME, '.wmux-auth-token');

let appProc;
const cleanup = () => new Promise((resolve) => {
  if (appProc && !appProc.killed) {
    try { appProc.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    if (appProc && !appProc.killed) { try { appProc.kill('SIGKILL'); } catch {} }
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
    resolve();
  }, 1500);
});
process.on('exit', () => {
  if (appProc && !appProc.killed) { try { appProc.kill('SIGKILL'); } catch {} }
});
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, fn, timeoutMs = 30000, intervalMs = 200) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
};

function pipeAlive() {
  return new Promise((resolve) => {
    const sock = net.createConnection(PIPE_NAME);
    const done = (val) => { try { sock.destroy(); } catch {} resolve(val); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 300);
  });
}

// === Persistent-socket RPC client ===
//
// The benchmark needs many RPCs without paying a fresh connect per call (and
// without tripping MAX_NEW_CONNECTIONS_PER_SEC=30). So unlike the one-shot
// rpc() in m0-dynamic-verify.mjs, this keeps a long-lived socket, buffers
// incoming data, splits on '\n', and correlates responses by request id.
const BENCH_CLIENT_NAME = 'wmux-bench';

// Exactly the capabilities B1-B4 require (methodCapabilityMap.ts):
// workspace.list -> workspace.read; pane.list -> pane.read;
// pane.getMetadata -> meta.read; pane.setMetadata -> meta.write;
// events.poll -> events.subscribe.
const BENCH_CAPABILITIES = [
  'workspace.read', 'pane.read', 'meta.read', 'meta.write', 'events.subscribe',
];

// Seed <HOME>/.wmux/plugin-trust.json with a trusted row for BENCH_CLIENT_NAME
// BEFORE the app boots, so the first RPC is already past the gate with no
// approval dialog. Same schema PluginTrustStore writes; a bare capability with
// no `:glob` is an unrestricted grant for that capability. Also pins
// mcp.mode=enforce so the bench measures the production gate.
function seedBenchTrust(wmuxDir) {
  fs.mkdirSync(wmuxDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(wmuxDir, 'plugin-trust.json'),
    JSON.stringify({
      schemaVersion: 1,
      plugins: {
        [BENCH_CLIENT_NAME]: {
          name: BENCH_CLIENT_NAME,
          version: '0.0.0-bench',
          status: 'trusted',
          declaredCapabilities: BENCH_CAPABILITIES,
          rationale: 'substrate-bench.mjs sandbox instance (scripts/substrate-bench.mjs)',
          firstSeen: now,
          lastSeen: now,
        },
      },
    }, null, 2),
    'utf8',
  );
  const cfgPath = path.join(wmuxDir, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* fresh sandbox */ }
  cfg.mcp = { ...(cfg.mcp ?? {}), mode: 'enforce' };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

class PipeClient {
  constructor(token) {
    this.token = token;
    this.sock = null;
    this.buf = '';
    this.pending = new Map(); // id -> { resolve, reject, timer, t0 }
  }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(PIPE_NAME);
      let settled = false;
      sock.setEncoding('utf8');
      sock.once('connect', () => { settled = true; this.sock = sock; resolve(); });
      sock.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
      sock.on('data', (chunk) => this._onData(chunk));
      sock.on('close', () => {
        // Fail any in-flight requests; bench scenarios handle reconnect.
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('socket closed'));
        }
        this.pending.clear();
      });
    });
  }
  _onData(chunk) {
    this.buf += chunk.toString('utf-8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      const dtMs = Number(process.hrtime.bigint() - p.t0) / 1e6;
      if (msg.ok === false) {
        const e = new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error));
        e.rpcError = msg.error;
        e.dtMs = dtMs;
        p.reject(e);
      } else {
        p.resolve({ result: msg.result ?? msg, dtMs });
      }
    }
  }
  // Returns { result, dtMs } so callers can record latency.
  call(method, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('not connected'));
      const id = randomUUID();
      const t0 = process.hrtime.bigint();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, t0 });
      this.sock.write(JSON.stringify({ id, method, params, token: this.token, clientName: BENCH_CLIENT_NAME, clientVersion: '0.0.0-bench' }) + '\n');
    });
  }
  close() { try { this.sock?.destroy(); } catch {} }
}

// === Stats helpers ===
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}
function summarize(latencies) {
  const s = [...latencies].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    count: s.length,
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    min: round(s[0] ?? null),
    max: round(s[s.length - 1] ?? null),
    mean: s.length ? round(sum / s.length) : null,
  };
}
const round = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

// A rate-paced loop: issues `fn` back-to-back but never exceeds `maxPerSec`
// requests in any rolling 1s window (so the bench measures the substrate, not
// the rate limiter). Runs for `durationMs`. Returns the per-call latencies it
// collected from fn (fn must return { dtMs } or throw).
async function pacedLoop(fn, maxPerSec, durationMs) {
  const minGapMs = 1000 / maxPerSec;
  const latencies = [];
  const errors = [];
  const start = Date.now();
  let nextAt = process.hrtime.bigint();
  while (Date.now() - start < durationMs) {
    const now = process.hrtime.bigint();
    const waitMs = Number(nextAt - now) / 1e6;
    if (waitMs > 0) await sleep(waitMs);
    nextAt = process.hrtime.bigint() + BigInt(Math.round(minGapMs * 1e6));
    try {
      const { dtMs } = await fn();
      latencies.push(dtMs);
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { latencies, errors, elapsedMs: Date.now() - start };
}

// === Result accumulation ===
const RESULTS = {
  meta: {
    tool: 'substrate-bench.mjs',
    startedAt: new Date().toISOString(),
    durationFlagSec: ARGS.duration,
    ringCapacity: RING_CAPACITY,
    pollDefaultMax: POLL_DEFAULT_MAX,
    perSocketRate: PER_SOCKET_RATE,
    globalRate: GLOBAL_RATE,
    platform: process.platform,
    nodeVersion: process.version,
    appExe: APP_EXE,
  },
  scenarios: {},
};
const lines = []; // human-readable table rows collected for the summary
function record(scenario, payload) { RESULTS.scenarios[scenario] = payload; }
function line(s) { lines.push(s); console.log(s); }

(async () => {
  console.log(`pipe: ${PIPE_NAME}`);
  console.log(`temp HOME: ${TEST_HOME}`);
  console.log(`burst duration flag: ${ARGS.duration}s`);

  if (await pipeAlive()) {
    console.error('A wmux pipe already exists for this Windows user — aborting.');
    await cleanup();
    process.exit(3);
  }

  const isolatedEnv = {
    ...process.env,
    USERPROFILE: TEST_HOME,
    HOME: TEST_HOME,
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
    APPDATA: path.join(TEST_HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(TEST_HOME, 'AppData', 'Local'),
    WMUX_DISABLE_CDP: 'true',
  };
  fs.mkdirSync(isolatedEnv.APPDATA, { recursive: true });
  fs.mkdirSync(isolatedEnv.LOCALAPPDATA, { recursive: true });
  // Identity for the enforce-mode permission gate (#1111) — must exist before
  // the app boots, since the first RPC is already gated. This bench sets no
  // WMUX_DATA_SUFFIX, so its data dir is plain <HOME>/.wmux.
  seedBenchTrust(path.join(TEST_HOME, '.wmux'));

  console.log('--- spawning Electron app ---');
  appProc = spawn(APP_EXE, [], {
    cwd: REPO_ROOT,
    env: isolatedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  appProc.stdout.on('data', (b) => process.stderr.write(`[app] ${b}`));
  appProc.stderr.on('data', (b) => process.stderr.write(`[app:err] ${b}`));
  appProc.on('exit', (code) => console.error(`[app] exited with ${code}`));

  await waitFor('auth token file', () => fs.existsSync(AUTH_TOKEN_PATH), 30000);
  const token = fs.readFileSync(AUTH_TOKEN_PATH, 'utf-8').trim();
  console.log(`--- auth token loaded (${token.length} chars) ---`);

  await waitFor('pipe ready', () => pipeAlive(), 15000);
  console.log('--- pipe accepting connections ---');

  // Let the renderer materialize a default workspace + pane.
  await sleep(2500);

  const client = new PipeClient(token);
  await client.connect();

  // Resolve workspace + target pane.
  const { result: wsResult } = await client.call('workspace.list', {});
  const workspaces = wsResult?.workspaces ?? wsResult ?? [];
  if (!workspaces.length) {
    console.error('No workspace materialized — aborting.');
    await cleanup();
    process.exit(1);
  }
  const wsId = workspaces[0].id || workspaces[0].workspaceId;
  const { result: pl0 } = await client.call('pane.list', { workspaceId: wsId });
  const panes = pl0?.panes ?? pl0?.leaves ?? [];
  if (!panes.length) {
    console.error('No pane materialized — aborting.');
    await cleanup();
    process.exit(1);
  }
  const target = panes.find((p) => p.id || p.paneId);
  const paneId = target.id || target.paneId;
  console.log(`--- workspace=${wsId} pane=${paneId} bootId=${pl0?.bootId?.slice(0, 8)}… ---`);

  // Read baseline version so all writes use expectedVersion-free merges (we
  // don't want VERSION_CONFLICT noise; the bench measures throughput/latency,
  // not concurrency). We still track that version stays monotonic.
  const { result: meta0 } = await client.call('pane.getMetadata', { paneId, workspaceId: wsId });
  let lastVersion = meta0?.version ?? 0;
  console.log(`--- baseline metadata version=${lastVersion} ---`);

  line('');
  line('================= wmux substrate bench =================');
  line(`ring=${RING_CAPACITY}  pollMax=${POLL_DEFAULT_MAX}  caps: ${PER_SOCKET_RATE}/s socket, ${GLOBAL_RATE}/s global`);
  line('--------------------------------------------------------');

  // ------------------------------------------------------------------
  // B1 — metadata write throughput (single socket, paced under the cap)
  // ------------------------------------------------------------------
  // A single socket is capped at 50 rpc/s by PipeServer. We pace to just
  // under it (PER_SOCKET_RATE - 2) so the loop measures store+IPC latency,
  // not the rate limiter rejecting us. pacedLoop additionally AWAITS each
  // call before dispatching the next, so the achieved writes/sec is
  // min(pace ceiling, 1/latency): it reflects the wire cap only when the
  // pace ceiling was actually reached; otherwise it is latency-bound and
  // the percentiles are the honest per-write cost.
  {
    const durationMs = ARGS.duration * 1000;
    let writes = 0;
    let monotonic = true;
    const { latencies, errors, elapsedMs } = await pacedLoop(async () => {
      const r = await client.call('pane.setMetadata', {
        paneId, workspaceId: wsId,
        custom: { 'bench.b1.counter': String(++writes) },
        mergeMode: 'merge',
      });
      const v = r.result?.version;
      if (typeof v === 'number') {
        if (v <= lastVersion) monotonic = false;
        lastVersion = v;
      }
      return r;
    }, PER_SOCKET_RATE - 2, durationMs);
    const stats = summarize(latencies);
    const writesPerSec = round((latencies.length / elapsedMs) * 1000);
    const paceCeiling = PER_SOCKET_RATE - 2;
    const capBound = writesPerSec >= paceCeiling * 0.9;
    record('B1', {
      label: 'metadata write throughput (single socket, paced under cap)',
      capBound,
      paceCeiling,
      writesPerSec,
      okWrites: latencies.length,
      errors: errors.length,
      sampleErrors: errors.slice(0, 3),
      latencyMs: stats,
      versionMonotonic: monotonic,
      finalVersion: lastVersion,
    });
    line(`B1 writes/sec     : ${writesPerSec}  (${capBound
      ? `CAP-BOUND: pinned at the ~${paceCeiling}/s pace under the ${PER_SOCKET_RATE}/s wire cap`
      : `BELOW the ~${paceCeiling}/s pace ceiling — dispatch-cadence-bound (sequential await + sleep-timer granularity), not the wire cap; the latency percentiles are the real per-write cost`})`);
    line(`B1 write latency  : p50=${stats.p50}ms p95=${stats.p95}ms p99=${stats.p99}ms (n=${stats.count}, errors=${errors.length})`);
    line(`B1 version monotonic: ${monotonic ? 'PASS' : 'FAIL'} (final version=${lastVersion})`);
  }

  // ------------------------------------------------------------------
  // B2 — events.poll round-trip latency at several page sizes
  // ------------------------------------------------------------------
  // The ring already holds the B1 pane.metadata.changed events. We poll from
  // cursor 0 (replay from oldest) at a few `max` page sizes and measure the
  // wire round-trip. EventBus.poll is O(ring size) per call regardless of how
  // many match, so larger pages mostly cost serialization, not scan.
  {
    const pageSizes = [1, 32, POLL_DEFAULT_MAX, RING_CAPACITY];
    const perSize = {};
    for (const max of pageSizes) {
      const latencies = [];
      let lastEventCount = 0;
      for (let i = 0; i < 30; i++) {
        try {
          const r = await client.call('events.poll', {
            workspaceId: wsId, cursor: 0, max,
            types: ['pane.metadata.changed'],
          });
          latencies.push(r.dtMs);
          lastEventCount = (r.result?.events ?? []).length;
        } catch (e) { /* recorded via empty sample */ }
        // pace: 30 polls well under the per-socket cap
        await sleep(25);
      }
      perSize[String(max)] = { latencyMs: summarize(latencies), eventsReturned: lastEventCount };
      const s = perSize[String(max)].latencyMs;
      line(`B2 poll max=${String(max).padStart(4)} : p50=${s.p50}ms p95=${s.p95}ms (returned ${lastEventCount} events, n=${s.count})`);
    }
    record('B2', { label: 'events.poll round-trip latency by page size', byPageSize: perSize });
  }

  // ------------------------------------------------------------------
  // B3 — ring-overflow point
  // ------------------------------------------------------------------
  // Capture a cursor, then emit > RING_CAPACITY events (each pane.setMetadata
  // emits one pane.metadata.changed), then poll with the STALE cursor and
  // confirm resync:true + droppedCount>0, and that pane.list recovers.
  //
  // We need ~RING_CAPACITY + headroom new events. Each write is one event.
  // To stay under the wire caps we use a SECOND socket too (2 sockets × ~48/s
  // ≈ 96/s, under the 200/s global cap). We also probe at intermediate
  // backlog sizes to find where droppedCount first appears (the ring already
  // holds B1+B2 traffic, so the practical overflow point is reached sooner
  // than a clean 1024).
  {
    // Cursor anchored at "now".
    const { result: anchor } = await client.call('events.poll', {
      workspaceId: wsId, cursor: 0, max: 1, types: ['pane.metadata.changed'],
    });
    const staleCursor = anchor?.nextCursor ?? 0;
    const bootIdBefore = anchor?.bootId;

    // Second socket to roughly double emit throughput while staying under the
    // 200/s global cap.
    const client2 = new PipeClient(token);
    await client2.connect();

    const target = RING_CAPACITY + 200; // comfortably past the window
    let emitted = 0;      // successful writes (each is exactly one ring event)
    let emitErrors = 0;   // failed writes — must NOT count toward the backlog
    let emitSeq = 0;
    let firstDropAtBacklog = null;
    let firstDropCount = null;
    const emitOne = (c, tag) => c.call('pane.setMetadata', {
      paneId, workspaceId: wsId,
      custom: { [`bench.b3.${tag}`]: String(++emitSeq) },
      mergeMode: 'merge',
    }).then(() => { emitted++; }, () => { emitErrors++; });

    // Burst, periodically peeking at droppedCount from the stale cursor.
    const burstStart = Date.now();
    while (emitted < target && Date.now() - burstStart < 60000) {
      // ~10 writes per 120ms slice across two sockets ≈ 80/s, under caps.
      const batch = [];
      for (let i = 0; i < 5; i++) batch.push(emitOne(client, 'a'), emitOne(client2, 'b'));
      await Promise.all(batch);
      await sleep(120);

      if (firstDropAtBacklog === null) {
        try {
          const r = await client.call('events.poll', {
            workspaceId: wsId, cursor: staleCursor, max: 1, types: ['pane.metadata.changed'],
          });
          if (r.result?.droppedCount > 0) {
            firstDropAtBacklog = emitted;
            firstDropCount = r.result.droppedCount;
          }
        } catch {}
      }
    }

    // Final stale poll: must report resync + droppedCount.
    let resync = false, droppedCount = 0, bootIdAfter = null;
    try {
      const r = await client.call('events.poll', {
        workspaceId: wsId, cursor: staleCursor, max: POLL_DEFAULT_MAX, types: ['pane.metadata.changed'],
      });
      resync = r.result?.resync === true;
      droppedCount = r.result?.droppedCount ?? 0;
      bootIdAfter = r.result?.bootId;
    } catch {}

    // Recovery: pane.list snapshot must succeed and carry asOfSeq/bootId so a
    // client can resume events.poll(cursor: asOfSeq).
    let recovered = false, asOfSeq = null;
    try {
      const r = await client.call('pane.list', { workspaceId: wsId });
      asOfSeq = r.result?.asOfSeq;
      recovered = typeof asOfSeq === 'number' && r.result?.bootId === bootIdAfter;
    } catch {}

    client2.close();
    record('B3', {
      label: 'ring-overflow point + resync recovery',
      ringCapacity: RING_CAPACITY,
      eventsEmitted: emitted,
      emitErrors,
      firstDropAtBacklog,
      firstDropCount,
      finalResync: resync,
      finalDroppedCount: droppedCount,
      bootIdStable: bootIdBefore != null && bootIdBefore === bootIdAfter,
      recoveredViaPaneList: recovered,
      recoverAsOfSeq: asOfSeq,
    });
    line(`B3 emitted        : ${emitted} events (ring=${RING_CAPACITY}, emit errors=${emitErrors})`);
    line(`B3 first drop at  : backlog≈${firstDropAtBacklog ?? 'n/a'} events (droppedCount=${firstDropCount ?? 'n/a'})`);
    line(`B3 final stale poll: resync=${resync} droppedCount=${droppedCount} ${(resync && droppedCount > 0) ? 'PASS' : 'FAIL'}`);
    line(`B3 recovery        : pane.list asOfSeq=${asOfSeq} bootId-stable=${bootIdBefore === bootIdAfter} ${recovered ? 'PASS' : 'FAIL'}`);
  }

  // ------------------------------------------------------------------
  // B4 — snapshot / reconcile latency mid-burst  (answers m0 §8 Q5)
  // ------------------------------------------------------------------
  // While a background writer drives pane.setMetadata under the cap on a
  // dedicated socket, a SEPARATE socket times pane.list (the snapshot
  // primitive). If snapshot() blocked the main process, pane.list latency
  // would spike while writes are in flight. We compare pane.list latency
  // idle vs mid-burst. (Single pane in this harness — pane count is the
  // dominant snapshot cost, so we note that one-pane is a floor, not a
  // worst case; see substrate-perf.md for the O(panes) discussion.)
  {
    const snapSock = new PipeClient(token);
    await snapSock.connect();
    const writeSock = new PipeClient(token);
    await writeSock.connect();

    // Idle baseline: 20 snapshots, no concurrent writes.
    const idle = [];
    for (let i = 0; i < 20; i++) {
      try { const r = await snapSock.call('pane.list', { workspaceId: wsId }); idle.push(r.dtMs); } catch {}
      await sleep(30);
    }

    // Mid-burst: start a paced writer on writeSock; concurrently time
    // pane.list on snapSock. Two sockets ≈ under the 200/s global cap.
    const durationMs = Math.min(ARGS.duration, 8) * 1000;
    const writer = pacedLoop(async () => {
      return writeSock.call('pane.setMetadata', {
        paneId, workspaceId: wsId,
        custom: { 'bench.b4.counter': String(Date.now()) },
        mergeMode: 'merge',
      });
    }, PER_SOCKET_RATE - 2, durationMs);

    const midBurst = [];
    const snapEnd = Date.now() + durationMs;
    while (Date.now() < snapEnd) {
      try { const r = await snapSock.call('pane.list', { workspaceId: wsId }); midBurst.push(r.dtMs); } catch {}
      await sleep(30);
    }
    const writerResult = await writer;

    snapSock.close();
    writeSock.close();

    const idleStats = summarize(idle);
    const burstStats = summarize(midBurst);
    // Blocking heuristic: if a synchronous snapshot were stalling behind the
    // write critical section, mid-burst p95 would be many× the idle p95.
    const p95Ratio = (idleStats.p95 && burstStats.p95) ? round(burstStats.p95 / idleStats.p95) : null;
    record('B4', {
      label: 'pane.list (snapshot) latency: idle vs mid-burst — m0 §8 Q5',
      paneCount: panes.length,
      idleLatencyMs: idleStats,
      midBurstLatencyMs: burstStats,
      concurrentWritesOk: writerResult.latencies.length,
      midBurstVsIdleP95Ratio: p95Ratio,
    });
    line(`B4 snapshot idle  : p50=${idleStats.p50}ms p95=${idleStats.p95}ms (n=${idleStats.count})`);
    line(`B4 snapshot burst : p50=${burstStats.p50}ms p95=${burstStats.p95}ms (n=${burstStats.count}, concurrent writes=${writerResult.latencies.length})`);
    line(`B4 p95 burst/idle : ${p95Ratio}x  (≈1x ⇒ snapshot does NOT block the write path; panes=${panes.length})`);
  }

  line('--------------------------------------------------------');
  line('Note: B1 paces a single socket under the per-socket wire cap AND awaits');
  line('each write, so writes/sec = min(pace ceiling, 1/latency) — the B1 line');
  line('above says which bound was hit. Either way the bottleneck is external');
  line('(rate limiter + IPC round-trip): the store itself serializes writes in');
  line('a synchronous critical section well above either bound.');
  line('Numbers are environment-dependent — re-run on the target machine.');
  line('========================================================');

  client.close();

  RESULTS.meta.finishedAt = new Date().toISOString();
  const jsonText = JSON.stringify(RESULTS, null, 2);
  if (ARGS.json) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(ARGS.json)), { recursive: true });
      fs.writeFileSync(ARGS.json, jsonText, 'utf8');
      console.log(`\n[json written] ${path.resolve(ARGS.json)}`);
    } catch (e) {
      console.error(`failed to write --json ${ARGS.json}: ${e.message}`);
    }
  }
  // Always emit machine-readable JSON to stdout, fenced so the leader can lift
  // it even without --json.
  console.log('\n----- BENCH_JSON_BEGIN -----');
  console.log(jsonText);
  console.log('----- BENCH_JSON_END -----');

  // Teardown: SIGTERM→SIGKILL on the spawned wmux.exe in cleanup(). (No RPC
  // teardown — `daemon.shutdown` is only registered on the separate
  // daemon-process pipe, and the client socket is already closed above.)
  await cleanup();
  process.exit(0);
})().catch(async (e) => {
  console.error('FATAL:', e.stack || e.message);
  await cleanup();
  process.exit(2);
});
