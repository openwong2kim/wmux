// The broker's handshake ack (src/mcp/broker.ts), against a real broker
// process bundled from source with esbuild (the build-mcp.js options), so the
// test follows the source rather than a stale dist/ build.
//
// A shim that sends `ack: 1` reads one `{"wmuxBroker":1,"ok":…}` line as the
// first bytes of the connection: ok:true once the session is hosted, before any
// MCP traffic; ok:false on a wrong token. A session the broker cannot tie to
// the connecting process is closed with no bytes at all, which every shim
// generation reads as "closed before ack" and answers with the full bundle. A
// client that does not ask gets the stream exactly as before. The node shim
// (shim.ts) asks, and runs the full server beside it on such a close.
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
async function startBroker(
  dir: string,
  suffix: string,
  withKoffi: boolean,
  onLog: (text: string) => void,
  envToken: string | null = TOKEN,
): Promise<ChildProcess> {
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
  const env: NodeJS.ProcessEnv = { HOME: dir, USERPROFILE: dir, WMUX_DATA_SUFFIX: suffix };
  if (envToken !== null) env.WMUX_AUTH_TOKEN = envToken;
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

/** Build the node shim from source into `dir`, beside a stand-in full server
 *  (index.js) that names the process it runs in. */
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
  fs.writeFileSync(path.join(dir, 'index.js'), "process.stdout.write('FULL SERVER pid=' + process.pid + '\\n');\n");
  return outfile;
}

/** Run the node shim against the broker on `suffix` in `dir`; `input` goes to its
 *  stdin once `ready` is in its stdout (or at once), then stdin ends. */
function runShim(shim: string, dir: string, suffix: string, token: string, input = '', ready = ''):
  Promise<{ pid: number; code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { HOME: dir, USERPROFILE: dir, WMUX_DATA_SUFFIX: suffix, WMUX_AUTH_TOKEN: token };
  for (const keep of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[keep] !== undefined) env[keep] = process.env[keep];
  }
  const child = spawn(process.execPath, [shim], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let sent = false;
  const send = () => { if (!sent) { sent = true; child.stdin?.write(input); } };
  child.stdout?.on('data', (d) => {
    stdout += d;
    if (ready && stdout.includes(ready)) child.stdin?.end();
  });
  child.stderr?.on('data', (d) => { stderr += d; });
  send();
  if (!ready) child.stdin?.end();
  const timer = setTimeout(() => child.kill(), 20_000);
  return new Promise((resolve) => child.once('exit', (code) => {
    clearTimeout(timer);
    resolve({ pid: child.pid ?? -1, code, stdout, stderr });
  }));
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

  it.runIf(hostable)('a client with the token that names another pid is closed with no bytes, with or without ack', async () => {
    const asked = await open(handshake({ ack: 1, callerPid: process.ppid }));
    expect(await asked.closed).toBe('');
    await logged(`peer refused (peer): claimed pid ${process.ppid}, peer ${process.pid}`);
    const silent = await open(handshake({ callerPid: process.ppid }));
    expect(await silent.closed).toBe('');
  });

  it.runIf(hostable)('a hosted session takes its parent pid from the OS, not the handshake', async () => {
    // Only what the broker logs for this connection counts.
    const from = brokerLog.length;
    const since = () => brokerLog.slice(from);
    const s = await open(handshake({ ack: 1, callerPpid: 1 }));
    const [first] = await s.lines(1);
    expect(first).toBe('{"wmuxBroker":1,"ok":true}');
    await logged(`callerPpid 1 differs from the OS parent ${process.ppid}`, since);
    await logged(`shim connected pid=${process.pid} ppid=${process.ppid} `, since);
    expect(since()).not.toContain('ppid=1 ');
    s.socket.destroy();
  });

  it.runIf(hostable)('the node shim is hosted by a broker that reads its pid', async () => {
    const dir = fs.mkdtempSync(path.join('/tmp', 'nsh-'));
    try {
      const run = await runShim(buildShim(dir), home, SUFFIX, TOKEN, INITIALIZE + '\n', '"serverInfo"');
      expect(JSON.parse(run.stdout.split('\n')[0])).toMatchObject({ id: 1, result: { serverInfo: { name: 'wmux' } } });
      expect(run.stdout).not.toContain('FULL SERVER');
      expect(run.code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the node shim ends on a wrong token and runs no full server', async () => {
    const dir = fs.mkdtempSync(path.join(isWin ? os.tmpdir() : '/tmp', 'nsh-'));
    try {
      const run = await runShim(buildShim(dir), home, SUFFIX, 'wrong-token');
      expect(run.stderr).toContain('[wmux-mcp-shim] broker refused the session: auth');
      expect(run.stdout).not.toContain('FULL SERVER');
      expect(run.code).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(isWin)('refuses every session where the OS names no peer (Windows named pipes)', async () => {
    const s = await open(handshake({ ack: 1 }));
    expect(await s.closed).toBe('');
    await logged('peer refused (peer-unverified)');
  });
});

describe('the node shim with no token file', () => {
  it('runs the full server beside it, in the same process, without dialling', async () => {
    const dir = fs.mkdtempSync(path.join(isWin ? os.tmpdir() : '/tmp', 'nst-'));
    try {
      const shim = buildShim(dir);
      // A home where wmux never ran: no token file, no WMUX_AUTH_TOKEN.
      const env: NodeJS.ProcessEnv = { HOME: dir, USERPROFILE: dir, WMUX_DATA_SUFFIX: `-notok-${process.pid}` };
      for (const keep of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']) {
        if (process.env[keep] !== undefined) env[keep] = process.env[keep];
      }
      const child = spawn(process.execPath, [shim], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => { stdout += d; });
      child.stderr?.on('data', (d) => { stderr += d; });
      await new Promise((r) => child.once('exit', r));
      expect(stderr).toBe('[wmux-mcp-shim] no auth token file; running the full server\n');
      expect(stdout).toBe(`FULL SERVER pid=${child.pid}\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Something at the path that gives no token is not a missing file.
  it.skipIf(isWin)('a dangling link at the token path keeps the refusal', async () => {
    const dir = fs.mkdtempSync(path.join('/tmp', 'nst-'));
    try {
      const shim = buildShim(dir);
      const suffix = `-danglink-${process.pid}`;
      fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, `.wmux${suffix}-auth-token`));
      const env: NodeJS.ProcessEnv = { HOME: dir, USERPROFILE: dir, WMUX_DATA_SUFFIX: suffix, PATH: process.env.PATH };
      const child = spawn(process.execPath, [shim], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => { stdout += d; });
      child.stderr?.on('data', (d) => { stderr += d; });
      const code = await new Promise((r) => child.once('exit', r));
      expect(code).toBe(1);
      expect(stderr).toBe('[wmux-mcp-shim] auth token not found. Is wmux running?\n');
      expect(stdout).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    expect(await s.closed).toBe('');
    await logged('peer refused (peer-unverified): peer pids cannot be read in this process', () => log);
  });

  it('the node shim it refuses runs the full server beside it, in the same process', async () => {
    const shimDir = fs.mkdtempSync(path.join('/tmp', 'nsh-'));
    try {
      const run = await runShim(buildShim(shimDir), dir, suffix, TOKEN);
      expect(run.stderr).toContain('[wmux-mcp-shim] the broker closed the connection before its ack; running the full server');
      expect(run.stdout).toBe(`FULL SERVER pid=${run.pid}\n`);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

// The broker reads the token file again at every handshake (brokerToken.ts):
// a new token takes effect for the next session with no restart, and a file it
// cannot use refuses the session before the ack (closed with no bytes, so the
// shim runs its own full server) while the broker keeps serving.
describe.runIf(hostable)('a broker that reads its token from the file', () => {
  const suffix = `-brokertokfile-${process.pid}`;
  const first = `first-token-${process.pid}`;
  const second = `second-token-${process.pid}`;
  const canMakeUnreadable = process.getuid?.() !== 0;
  let dir = '';
  let tokenFile = '';
  let child: ChildProcess | null = null;
  let log = '';

  const writeToken = (content: string, mode = 0o600) => {
    fs.writeFileSync(tokenFile, content, { mode });
    fs.chmodSync(tokenFile, mode);
  };
  const ack = async (token: string) => {
    const s = await open(handshake({ ack: 1 }, token), pipeName(suffix, dir));
    const all = s.data().length > 0 ? s.data() : await Promise.race([s.closed, s.lines(1).then((l) => `${l[0]}\n`)]);
    s.socket.destroy();
    return all;
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join('/tmp', 'btf-'));
    tokenFile = path.join(dir, `.wmux${suffix}-auth-token`);
    writeToken(first);
    child = await startBroker(dir, suffix, true, (text) => { log += text; }, null);
    await logged('peer-pid: available', () => log);
  }, 60_000);

  afterAll(async () => {
    await stopBroker(child);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a token replaced mid-run: the next handshake takes the new one, the old one is refused', async () => {
    expect(await ack(first)).toBe('{"wmuxBroker":1,"ok":true}\n');
    writeToken(second);
    expect(await ack(first)).toBe('{"wmuxBroker":1,"ok":false,"error":"auth"}\n');
    expect(await ack(second)).toBe('{"wmuxBroker":1,"ok":true}\n');
  });

  it('a file missing, empty, too open, unreadable or not a file: refused before the ack, and the broker keeps serving', async () => {
    const states: [string, () => void][] = [
      ['missing', () => fs.unlinkSync(tokenFile)],
      ['empty', () => writeToken('')],
      ['mode', () => writeToken(second, 0o644)],
      ['not-a-file', () => { fs.unlinkSync(tokenFile); fs.mkdirSync(tokenFile); }],
    ];
    if (canMakeUnreadable) states.push(['unreadable', () => writeToken(second, 0o000)]);
    for (const [problem, arrange] of states) {
      arrange();
      const s = await open(handshake({ ack: 1 }, second), pipeName(suffix, dir));
      expect(await s.closed, problem).toBe('');
      await logged(`auth token file not usable (${problem}); session refused`, () => log);
      expect(child?.exitCode, problem).toBeNull();
      fs.rmSync(tokenFile, { recursive: true, force: true });
      writeToken(second);
      expect(await ack(second), `${problem}, restored`).toBe('{"wmuxBroker":1,"ok":true}\n');
    }
  });

  it('logs no token text', () => {
    expect(log).not.toContain(first);
    expect(log).not.toContain(second);
  });
});
