// The broker's Windows wiring (src/mcp/broker.ts) against a real broker
// process bundled from source, over a stand-in native pipe listener
// (fixtures/fakeNativePipeCore.mjs, loaded through WMUX_TERMINAL_CORE_MODULE).
// The stand-in reports the client facts a control file names, so every
// decision path runs here without the built terminal core: the sessions it
// hosts, every refusal closing with no bytes (and the node shim then running
// its full server, which answers a tool call), the cap on connections waiting
// for their handshake, the token read's failure paths, and the exits for a
// name that is taken or a listener that stops. The same broker over the built
// core runs in brokerAck.os.test.ts.
//
// Isolation: a throwaway home and data suffix, and the auth token in that
// home's token file, so nothing here can reach a live wmux.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { deliberateSleep } from '../../test-utils/waitFor';

const isWin = process.platform === 'win32';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FAKE_CORE = path.join(__dirname, 'fixtures', 'fakeNativePipeCore.mjs');
const TOKEN = 'win32-wiring-token';
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'broker-win32-test', version: '0' } },
});
const TOOL_CALL = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'repl_sessions', arguments: {} } });

let work = '';
let bundle = '';
let serial = 0;

interface Control {
  peer?: Record<string, unknown>;
  facts?: Record<string, unknown> | null;
  owner?: string;
  listenError?: string;
  failNow?: boolean;
}

interface Rig {
  suffix: string;
  home: string;
  control: string;
  pipe: string;
  log: () => string;
  child: ChildProcess;
  exited: Promise<number | null>;
}

function setControl(rig: Pick<Rig, 'control'>, control: Control): void {
  fs.writeFileSync(rig.control, JSON.stringify(control));
}

/** The client facts of this test process, as the listener would read them. */
function selfPeer(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { pid: process.pid, ppid: process.ppid, ...extra };
}

/** A broker with its own home, suffix and control file; `ready` waits for its self-check. */
async function startBroker(control: Control, opts: { ready?: boolean; coreModule?: string } = {}): Promise<Rig> {
  const suffix = `-bw32-${process.pid}-${++serial}`;
  const home = fs.mkdtempSync(path.join(work, 'home-'));
  fs.writeFileSync(path.join(home, `.wmux${suffix}-auth-token`), TOKEN);
  const controlPath = path.join(home, 'control.json');
  setControl({ control: controlPath }, control);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    WMUX_DATA_SUFFIX: suffix,
    WMUX_TERMINAL_CORE_MODULE: opts.coreModule ?? FAKE_CORE,
    WMUX_FAKE_PIPE_CONTROL: controlPath,
  };
  for (const keep of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[keep] !== undefined) env[keep] = process.env[keep];
  }
  const child = spawn(process.execPath, [bundle], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr?.on('data', (d) => { log += d; });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const rig: Rig = {
    suffix, home, control: controlPath, child, exited,
    pipe: `\\\\.\\pipe\\wmux-mcpb${suffix}-${os.userInfo().username || 'default'}`,
    log: () => log,
  };
  if (opts.ready !== false) {
    await until(() => log.includes('peer-pid: available'), 20_000, () => `broker not ready: ${log}`);
  }
  return rig;
}

async function stopBroker(rig: Rig | undefined): Promise<void> {
  if (rig && rig.child.exitCode === null) {
    rig.child.kill();
    await rig.exited;
  }
}

async function until(check: () => boolean, ms: number, why: () => string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(why());
    await new Promise((r) => setTimeout(r, 25));
  }
}

function handshake(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    wmuxShim: 1,
    authToken: TOKEN,
    callerPid: process.pid,
    callerPpid: process.ppid,
    envWorkspaceHint: '',
    envPtyHint: '',
    commanderMode: false,
    coreMode: false,
    ack: 1,
    ...extra,
  }) + '\n';
}

interface Session {
  socket: net.Socket;
  closed: Promise<string>;
  lines: (n: number) => Promise<string[]>;
}

function open(pipe: string, line: string | null): Promise<Session> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let buf = '';
    const waiters: (() => void)[] = [];
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      buf += d;
      for (const w of waiters.splice(0)) w();
    });
    const closed = new Promise<string>((r) => socket.on('close', () => {
      for (const w of waiters.splice(0)) w();
      r(buf);
    }));
    socket.on('error', () => { /* closed covers it */ });
    const lines = (n: number) => new Promise<string[]>((r, j) => {
      const check = () => {
        const parts = buf.split('\n');
        if (parts.length > n) return r(parts.slice(0, n));
        if (socket.destroyed) return j(new Error(`connection closed after ${JSON.stringify(buf)}`));
        waiters.push(check);
      };
      check();
    });
    socket.once('connect', () => {
      if (line !== null) socket.write(line);
      resolve({ socket, closed, lines });
    });
    socket.once('error', reject);
  });
}

/** Build the node shim beside a stand-in full server that answers every request it reads. */
function buildShim(dir: string): string {
  const outfile = path.join(dir, 'shim.js');
  buildSync({
    entryPoints: [path.join(REPO_ROOT, 'src', 'mcp', 'shim.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'error',
  });
  fs.writeFileSync(path.join(dir, 'index.js'), [
    "let buf = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (d) => {",
    '  buf += d;',
    '  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {',
    '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
    '    let m; try { m = JSON.parse(line); } catch { continue; }',
    "    if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'FULL SERVER ' + m.method }] } }) + '\\n');",
    '  }',
    '});',
    '',
  ].join('\n'));
  return outfile;
}

/** Run the node shim against `rig`'s broker with one tool call; stdin ends once it is answered. */
function runShim(shim: string, rig: Rig): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { HOME: rig.home, USERPROFILE: rig.home, WMUX_DATA_SUFFIX: rig.suffix };
  for (const keep of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[keep] !== undefined) env[keep] = process.env[keep];
  }
  const child = spawn(process.execPath, [shim], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => {
    stdout += d;
    if (stdout.includes('"id":7')) child.stdin?.end();
  });
  child.stderr?.on('data', (d) => { stderr += d; });
  child.stdin?.write(TOOL_CALL + '\n');
  const timer = setTimeout(() => child.kill(), 20_000);
  return new Promise((resolve) => child.once('exit', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  }));
}

/** What the broker logged after `from`. */
const since = (rig: Rig, from: number) => () => rig.log().slice(from);

if (isWin) {
  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'bw32-'));
    bundle = path.join(work, 'broker.cjs');
    buildSync({
      entryPoints: [path.join(REPO_ROOT, 'src', 'mcp', 'broker.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      external: ['electron', 'chromium-bidi', 'playwright-core', 'koffi'],
      define: { __WMUX_MCP_VERSION__: JSON.stringify('0.0.0-test') },
      logLevel: 'error',
    });
  }, 60_000);
  afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });
}

describe.runIf(isWin)('the broker on Windows over the native pipe listener (stand-in core)', () => {
  let rig: Rig | undefined;
  let shim = '';
  let emptyOpenAt = 0;

  beforeAll(async () => {
    shim = buildShim(fs.mkdtempSync(path.join(work, 'shim-')));
    rig = await startBroker({ peer: selfPeer() });
    // An open that closes before any byte, as the supervisor's owner probe
    // does: it is not a handshake timeout (checked in the last test).
    const probe = await open(rig.pipe, null);
    probe.socket.destroy();
    emptyOpenAt = Date.now();
  }, 90_000);

  afterAll(async () => {
    await stopBroker(rig);
  });

  it('hosts a Medium client of this user: ack, then MCP traffic', async () => {
    setControl(rig!, { peer: selfPeer() });
    const from = rig!.log().length;
    const s = await open(rig!.pipe, handshake({ callerPpid: 1 }));
    const [first] = await s.lines(1);
    expect(first).toBe('{"wmuxBroker":1,"ok":true}');
    s.socket.write(INITIALIZE + '\n');
    const [, reply] = await s.lines(2);
    expect(JSON.parse(reply)).toMatchObject({ id: 1, result: { serverInfo: { name: 'wmux' } } });
    // The parent comes from the listener, never from the handshake.
    await until(() => since(rig!, from)().includes(`shim connected pid=${process.pid} ppid=${process.ppid} `), 5000, since(rig!, from));
    s.socket.destroy();
  });

  it('hosts an elevated client of this user, whose process token the listener could not open', async () => {
    setControl(rig!, {
      peer: selfPeer({ sameUser: null, integrityRid: null, reason: 'token-unreadable' }),
      facts: { ok: true, sameUser: true, integrityRid: 0x3000, elevated: true },
    });
    const s = await open(rig!.pipe, handshake());
    const [first] = await s.lines(1);
    expect(first).toBe('{"wmuxBroker":1,"ok":true}');
    s.socket.destroy();
  });

  const refusals: Array<[string, Control, Record<string, unknown>]> = [
    ['integrity-low', { peer: selfPeer(), facts: { ok: true, sameUser: true, integrityRid: 0x1000, elevated: false } }, {}],
    ['other-user', { peer: selfPeer(), facts: { ok: true, sameUser: false, integrityRid: 0x2000, elevated: false } }, {}],
    ['other-session', { peer: selfPeer({ sameSession: false, sessionId: 7 }) }, {}],
    ['token-unreadable', { peer: selfPeer(), facts: { ok: false, reason: 'impersonation-failed' } }, {}],
    ['process-unreadable', { peer: selfPeer({ reason: 'created-after-accept', sameUser: null, integrityRid: null }) }, {}],
    ['pid-mismatch', { peer: selfPeer() }, { callerPid: process.ppid }],
    ['no-parent', { peer: selfPeer({ ppid: null }) }, {}],
  ];

  it.each(refusals)('refuses %s: closed with no bytes, the reason only in the log', async (reason, control, extra) => {
    setControl(rig!, control);
    const from = rig!.log().length;
    const s = await open(rig!.pipe, handshake(extra));
    expect(await s.closed).toBe('');
    await until(() => since(rig!, from)().includes(`peer refused (${reason})`), 5000, since(rig!, from));
  });

  it('a token read that never answers ends within its bound and refuses (token-unreadable)', async () => {
    setControl(rig!, { peer: selfPeer(), facts: null });
    const from = rig!.log().length;
    const started = Date.now();
    const s = await open(rig!.pipe, handshake());
    expect(await s.closed).toBe('');
    // Within the native shim's 5 s ack deadline.
    expect(Date.now() - started).toBeLessThan(5000);
    await until(() => since(rig!, from)().includes('peer refused (token-unreadable): token facts for peer'), 5000, since(rig!, from));
    expect(since(rig!, from)()).toContain('timed-out');
  });

  it('after the token read failed or timed out, the next session is hosted and reads the token file', async () => {
    // Each session reads the token file again (an fs open in the broker).
    setControl(rig!, { peer: selfPeer(), facts: { ok: false, reason: 'closed' } });
    expect(await (await open(rig!.pipe, handshake())).closed).toBe('');
    setControl(rig!, { peer: selfPeer() });
    const s = await open(rig!.pipe, handshake());
    expect((await s.lines(1))[0]).toBe('{"wmuxBroker":1,"ok":true}');
    s.socket.destroy();
  });

  it('a client that leaves while its token is read is not hosted, and the broker serves on', async () => {
    setControl(rig!, { peer: selfPeer(), facts: null });
    const gone = await open(rig!.pipe, handshake());
    gone.socket.destroy();
    setControl(rig!, { peer: selfPeer() });
    const s = await open(rig!.pipe, handshake());
    expect((await s.lines(1))[0]).toBe('{"wmuxBroker":1,"ok":true}');
    s.socket.destroy();
  });

  it('a wrong token still gets the ok:false auth line', async () => {
    setControl(rig!, { peer: selfPeer() });
    const s = await open(rig!.pipe, handshake({ authToken: 'wrong' }));
    expect(await s.closed).toBe('{"wmuxBroker":1,"ok":false,"error":"auth"}\n');
  });

  // The node shim reads a close before the ack as "no session" and runs the
  // full server beside it, which then answers the host's tool call. Its pid is
  // its own, so the stand-in listener's pid differs (pid-mismatch).
  it.each(refusals.filter(([reason]) => reason !== 'no-parent'))(
    'the node shim falls back to its full server on %s, and a tool answers',
    async (_reason, control) => {
      setControl(rig!, control);
      const run = await runShim(shim, rig!);
      expect(run.stderr).toContain('[wmux-mcp-shim] the broker closed the connection before its ack; running the full server');
      expect(run.stdout).toContain('FULL SERVER tools/call');
      expect(run.code).toBe(0);
    },
    30_000,
  );

  it('past the cap on connections waiting for their handshake, a new one is closed at once; a freed place admits again', async () => {
    setControl(rig!, { peer: selfPeer() });
    const from = rig!.log().length;
    const idle: Session[] = [];
    try {
      for (let i = 0; i < 32; i++) idle.push(await open(rig!.pipe, null));
      const over = await open(rig!.pipe, handshake());
      expect(await over.closed).toBe('');
      await until(() => since(rig!, from)().includes('connections are waiting for their handshake; closing new ones'), 5000, since(rig!, from));
      // The node shim falls back on that close too.
      const run = await runShim(shim, rig!);
      expect(run.stdout).toContain('FULL SERVER tools/call');
      expect(run.code).toBe(0);
      idle.pop()!.socket.destroy();
      let hosted = '';
      for (let i = 0; i < 40 && hosted === ''; i++) {
        const s = await open(rig!.pipe, handshake());
        const all = await Promise.race([s.lines(1).then((l) => l[0]).catch(() => ''), s.closed]);
        if (all.startsWith('{"wmuxBroker":1,"ok":true}')) hosted = all;
        s.socket.destroy();
        if (!hosted) await new Promise((r) => setTimeout(r, 50));
      }
      expect(hosted).toBe('{"wmuxBroker":1,"ok":true}');
    } finally {
      for (const s of idle) s.socket.destroy();
    }
  }, 60_000);

  it('connections that close before any byte free their place, and are not logged as handshake timeouts', async () => {
    setControl(rig!, { peer: selfPeer() });
    for (let i = 0; i < 40; i++) (await open(rig!.pipe, null)).socket.destroy();
    let hosted = false;
    for (let i = 0; i < 40 && !hosted; i++) {
      const s = await open(rig!.pipe, handshake());
      hosted = await s.lines(1).then((l) => l[0] === '{"wmuxBroker":1,"ok":true}', () => false);
      s.socket.destroy();
      if (!hosted) await new Promise((r) => setTimeout(r, 50));
    }
    expect(hosted).toBe(true);
    const wait = emptyOpenAt + 10_500 - Date.now();
    if (wait > 0) await deliberateSleep(wait, 'a negative check: the 10 s handshake deadline of the empty open must pass with no timeout logged');
    expect(rig!.log()).not.toContain('handshake timeout');
  }, 30_000);
});

describe.runIf(isWin)('the broker on Windows: when it cannot listen, or stops listening', () => {
  it.each([
    ['EADDRINUSE', 'foreign', 78],
    ['EACCES', 'foreign', 78],
    ['EADDRINUSE', 'ours', 75],
    ['EADDRINUSE', 'busy', 75],
    ['EADDRINUSE', 'none', 1],
    ['EACCES', 'ours', 1],
  ] as const)('a listen error %s with the name held by %s exits %i', async (listenError, owner, code) => {
    const rig = await startBroker({ listenError, owner }, { ready: false });
    expect(await rig.exited).toBe(code);
  }, 30_000);

  it('a listener that stops accepting ends the broker with a crash exit (the supervisor restarts it)', async () => {
    const rig = await startBroker({ peer: selfPeer() });
    setControl(rig, { peer: selfPeer(), failNow: true });
    const s = await open(rig.pipe, null);
    expect(await rig.exited).toBe(1);
    expect(rig.log()).toContain('the pipe listener stopped accepting (fake listener failure)');
    s.socket.destroy();
  }, 30_000);

  it('a core without pipe-listener-v2 ends the broker with the final exit (79)', async () => {
    const old = path.join(work, 'old-core.cjs');
    fs.writeFileSync(old, "module.exports = { nativeCoreAbiVersion: () => 1, nativeCoreCapabilities: () => ['pipe-listener-v1'] };\n");
    const rig = await startBroker({}, { ready: false, coreModule: old });
    expect(await rig.exited).toBe(79);
    expect(rig.log()).toContain('native pipe listener unavailable');
  }, 30_000);
});
