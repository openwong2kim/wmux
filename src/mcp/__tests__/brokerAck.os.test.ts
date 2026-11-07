// The broker's handshake ack (src/mcp/broker.ts), against a real broker
// process bundled from source with esbuild (the build-mcp.js options), so the
// test follows the source rather than a stale dist/ build.
//
// A shim that sends `ack: 1` reads one `{"wmuxBroker":1,"ok":…}` line as the
// first bytes of the connection: ok:true once the session is hosted, before any
// MCP traffic; ok:false on a refusal. A shim that does not ask (shim.ts) gets
// the stream exactly as before.
//
// Isolation: a throwaway home, a data suffix, and the token from
// WMUX_AUTH_TOKEN (no token file), so nothing here can reach a live wmux.
//
// The broker hosts a session only for the peer the OS names (brokerPeer.ts):
// this test process connects, so its own pid and parent are the true ones.
// koffi resolves through NODE_PATH, as it does beside the packaged bundle.
// Windows named pipes give no peer pid, so there every session is refused.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const isWin = process.platform === 'win32';
const TOKEN = 'ack-test-token';
const SUFFIX = `-brokerack-${process.pid}`;
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'broker-ack-test', version: '0' } },
});

let home = '';
let broker: ChildProcess | null = null;
let brokerLog = '';
const hostable = !isWin;

function pipeName(suffix = SUFFIX, dir = home): string {
  return isWin
    ? `\\\\.\\pipe\\wmux-mcpb${suffix}-${os.userInfo().username || 'default'}`
    : `${dir}/.wmux-mcpb${suffix}.sock`;
}

function handshake(extra: Record<string, unknown>, token = TOKEN): string {
  return JSON.stringify({
    wmuxShim: 1,
    authToken: token,
    callerPid: process.pid,
    callerPpid: process.ppid,
    envWorkspaceHint: '',
    envPtyHint: '',
    commanderMode: false,
    coreMode: false,
    ...extra,
  }) + '\n';
}

interface Session {
  /** Everything received so far. */
  data: () => string;
  /** Resolves with all bytes once the broker closes the connection. */
  closed: Promise<string>;
  /** Resolves once `n` complete lines have arrived. */
  lines: (n: number) => Promise<string[]>;
  socket: net.Socket;
}

function open(line: string, pipe = pipeName()): Promise<Session> {
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
      socket.write(line);
      resolve({ data: () => buf, closed, lines, socket });
    });
    socket.once('error', reject);
  });
}

/** Build the broker from source into `dir` and start it on `suffix`; resolves once it listens. */
async function startBroker(dir: string, suffix: string, withKoffi: boolean, onLog: (text: string) => void): Promise<ChildProcess> {
  const outfile = path.join(dir, 'broker.cjs');
  buildSync({
    entryPoints: [path.join(REPO_ROOT, 'src', 'mcp', 'broker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['electron', 'chromium-bidi', 'playwright-core', 'koffi'],
    define: { __WMUX_MCP_VERSION__: JSON.stringify('0.0.0-test') },
    logLevel: 'error',
  });
  const env: NodeJS.ProcessEnv = { HOME: dir, USERPROFILE: dir, WMUX_DATA_SUFFIX: suffix, WMUX_AUTH_TOKEN: TOKEN };
  for (const keep of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[keep] !== undefined) env[keep] = process.env[keep];
  }
  // The bundle sits outside the repository: koffi is found only through NODE_PATH.
  if (withKoffi) env.NODE_PATH = path.join(REPO_ROOT, 'node_modules');
  const child = spawn(process.execPath, [outfile], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`broker did not listen: ${log}`)), 20_000);
    child.stderr?.on('data', (d) => {
      log += d;
      onLog(String(d));
      if (log.includes('listening on')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`broker exited ${code}: ${log}`)); });
  });
  return child;
}

async function stopBroker(child: ChildProcess | null): Promise<void> {
  if (child && child.exitCode === null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill();
    await gone;
  }
}

/** Wait until the broker's log holds `text`. */
async function logged(text: string, read: () => string = () => brokerLog): Promise<void> {
  for (let i = 0; i < 100 && !read().includes(text); i++) await new Promise((r) => setTimeout(r, 50));
  expect(read()).toContain(text);
}

describe('broker handshake ack', () => {
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(isWin ? os.tmpdir() : '/tmp', 'bak-'));
    broker = await startBroker(home, SUFFIX, true, (text) => { brokerLog += text; });
    if (hostable) await logged('peer-pid: available');
  }, 60_000);

  afterAll(async () => {
    await stopBroker(broker);
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it.runIf(hostable)('ack: 1 gets {"wmuxBroker":1,"ok":true} first, then MCP traffic', async () => {
    const s = await open(handshake({ ack: 1 }));
    const [first] = await s.lines(1);
    expect(first).toBe('{"wmuxBroker":1,"ok":true}');
    s.socket.write(INITIALIZE + '\n');
    const [, reply] = await s.lines(2);
    expect(JSON.parse(reply)).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'wmux' } } });
    s.socket.destroy();
  });

  it.runIf(hostable)('writes no MCP bytes before the ack, even for a request sent with the handshake', async () => {
    const s = await open(handshake({ ack: 1 }) + INITIALIZE + '\n');
    const [first, reply] = await s.lines(2);
    expect(first).toBe('{"wmuxBroker":1,"ok":true}');
    expect(JSON.parse(reply)).toMatchObject({ id: 1, result: { serverInfo: { name: 'wmux' } } });
    s.socket.destroy();
  });

  // The ack goes out before server.connect; the socket stays paused until the
  // connection's scope wrappers are in place. Requests sent the moment the ack
  // arrives must all be served, in order, and inside the connection scope:
  // repl_sessions fails ("no MCP connection scope is active") when a request
  // is handled outside it.
  it.runIf(hostable)('requests sent on the ack are all served, inside the connection scope', async () => {
    const s = await open(handshake({ ack: 1 }));
    const [first] = await s.lines(1);
    expect(first).toBe('{"wmuxBroker":1,"ok":true}');
    s.socket.write(
      INITIALIZE + '\n'
      + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'repl_sessions', arguments: {} } }) + '\n',
    );
    const [, init, list, call] = await s.lines(4);
    expect(JSON.parse(init)).toMatchObject({ id: 1, result: { serverInfo: { name: 'wmux' } } });
    expect(JSON.parse(list)).toMatchObject({ id: 2, result: { tools: expect.any(Array) } });
    expect(JSON.parse(call)).toMatchObject({ id: 3, result: expect.any(Object) });
    expect(call).not.toContain('no MCP connection scope');
    s.socket.destroy();
  });

  it.runIf(hostable)('no ack field: the stream is MCP traffic from the first byte', async () => {
    const s = await open(handshake({}));
    s.socket.write(INITIALIZE + '\n');
    const [first] = await s.lines(1);
    expect(JSON.parse(first)).toMatchObject({ id: 1, result: { serverInfo: { name: 'wmux' } } });
    expect(s.data()).not.toContain('wmuxBroker');
    s.socket.destroy();
  });

  it.runIf(hostable)('only ack: 1 asks for it (true or 2 do not)', async () => {
    for (const ack of [true, 2]) {
      const s = await open(handshake({ ack }));
      s.socket.write(INITIALIZE + '\n');
      const [first] = await s.lines(1);
      expect(JSON.parse(first), String(ack)).toMatchObject({ id: 1 });
      s.socket.destroy();
    }
  });

  it('a wrong token with ack: 1 gets ok:false and the connection closes', async () => {
    const s = await open(handshake({ ack: 1 }, 'wrong-token'));
    expect(await s.closed).toBe('{"wmuxBroker":1,"ok":false,"error":"auth"}\n');
  });

  it('a wrong token without ack is dropped with no bytes, as before', async () => {
    const s = await open(handshake({}, 'wrong-token'));
    expect(await s.closed).toBe('');
  });

  it.runIf(hostable)('a client with the token that names another pid is refused, with or without ack', async () => {
    const asked = await open(handshake({ ack: 1, callerPid: process.ppid }));
    expect(await asked.closed).toBe('{"wmuxBroker":1,"ok":false,"error":"peer"}\n');
    await logged(`peer refused (peer): claimed pid ${process.ppid}, peer ${process.pid}`);
    const silent = await open(handshake({ callerPid: process.ppid }));
    expect(await silent.closed).toBe('');
  });

  it.runIf(hostable)('a hosted session takes its parent pid from the OS, not the handshake', async () => {
    const s = await open(handshake({ ack: 1, callerPpid: 1 }));
    const [first] = await s.lines(1);
    expect(first).toBe('{"wmuxBroker":1,"ok":true}');
    await logged(`callerPpid 1 differs from the OS parent ${process.ppid}`);
    await logged(`shim connected pid=${process.pid} ppid=${process.ppid} `);
    s.socket.destroy();
  });

  it.runIf(isWin)('refuses every session where the OS names no peer (Windows named pipes)', async () => {
    const s = await open(handshake({ ack: 1 }));
    expect(await s.closed).toBe('{"wmuxBroker":1,"ok":false,"error":"peer-unverified"}\n');
  });
});

describe.runIf(hostable)('a broker that cannot read peer pids', () => {
  const suffix = `-brokernokoffi-${process.pid}`;
  let dir = '';
  let child: ChildProcess | null = null;
  let log = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join('/tmp', 'bnk-'));
    child = await startBroker(dir, suffix, false, (text) => { log += text; });
  }, 60_000);

  afterAll(async () => {
    await stopBroker(child);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses every session, even a true one', async () => {
    await logged('every session is refused', () => log);
    const s = await open(handshake({ ack: 1 }), pipeName(suffix, dir));
    expect(await s.closed).toBe('{"wmuxBroker":1,"ok":false,"error":"peer-unverified"}\n');
  });
});
