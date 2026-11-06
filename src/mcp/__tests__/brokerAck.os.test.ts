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

function pipeName(): string {
  return isWin
    ? `\\\\.\\pipe\\wmux-mcpb${SUFFIX}-${os.userInfo().username || 'default'}`
    : `${home}/.wmux-mcpb${SUFFIX}.sock`;
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

function open(line: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName());
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

describe('broker handshake ack', () => {
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(isWin ? os.tmpdir() : '/tmp', 'bak-'));
    const outfile = path.join(home, 'broker.cjs');
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
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, WMUX_DATA_SUFFIX: SUFFIX, WMUX_AUTH_TOKEN: TOKEN };
    for (const keep of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']) {
      if (process.env[keep] !== undefined) env[keep] = process.env[keep];
    }
    const child = spawn(process.execPath, [outfile], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    broker = child;
    await new Promise<void>((resolve, reject) => {
      let log = '';
      const timer = setTimeout(() => reject(new Error(`broker did not listen: ${log}`)), 20_000);
      child.stderr?.on('data', (d) => {
        log += d;
        if (log.includes('listening on')) { clearTimeout(timer); resolve(); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`broker exited ${code}: ${log}`)); });
    });
  }, 60_000);

  afterAll(async () => {
    if (broker && broker.exitCode === null) {
      const gone = new Promise((r) => broker?.once('exit', r));
      broker.kill();
      await gone;
    }
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it('ack: 1 gets {"wmuxBroker":1,"ok":true} first, then MCP traffic', async () => {
    const s = await open(handshake({ ack: 1 }));
    const [first] = await s.lines(1);
    expect(first).toBe('{"wmuxBroker":1,"ok":true}');
    s.socket.write(INITIALIZE + '\n');
    const [, reply] = await s.lines(2);
    expect(JSON.parse(reply)).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'wmux' } } });
    s.socket.destroy();
  });

  it('writes no MCP bytes before the ack, even for a request sent with the handshake', async () => {
    const s = await open(handshake({ ack: 1 }) + INITIALIZE + '\n');
    const [first, reply] = await s.lines(2);
    expect(first).toBe('{"wmuxBroker":1,"ok":true}');
    expect(JSON.parse(reply)).toMatchObject({ id: 1, result: { serverInfo: { name: 'wmux' } } });
    s.socket.destroy();
  });

  it('no ack field: the stream is MCP traffic from the first byte', async () => {
    const s = await open(handshake({}));
    s.socket.write(INITIALIZE + '\n');
    const [first] = await s.lines(1);
    expect(JSON.parse(first)).toMatchObject({ id: 1, result: { serverInfo: { name: 'wmux' } } });
    expect(s.data()).not.toContain('wmuxBroker');
    s.socket.destroy();
  });

  it('only ack: 1 asks for it (true or 2 do not)', async () => {
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
});
