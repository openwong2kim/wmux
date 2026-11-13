// Parity: `wmux-native mcp-shim` against src/mcp/shim.ts, the source of truth.
//
// Each case runs both shims with the same environment and argv against one stub
// broker bound at the endpoint they both derive. The stub takes the handshake
// line, then drops the connection. The test compares the line byte for byte
// (callerPid masked: each shim reports its own pid), the parsed values and
// their key order, and the exit code, stdout and stderr that follow. After a
// drop past the ack each shim answers the calls in flight and looks for a full
// server to take the session over; neither has one here, so both exit 1 after
// saying so, each in its own words (expectLossWithoutServer). Cases with
// no token or no broker compare the refusal instead: shim.ts prints node's
// err.message for the connect, the native shim its fallback reason (`no
// broker`) and the places it looked for a full bundle (the binary under test
// runs from a directory of its own, so there is none, and it then exits 1 as
// shim.ts does). DIVERGENCES records where the native shim differs on purpose:
// each runs both and asserts both outcomes, so the difference stays recorded
// rather than ignored. Both handshakes end with `"ack":1` (the broker ack),
// checked in place, and the stub answers a handshake that asks for the ack, as
// the broker does.
//
// shim.ts is bundled from source with esbuild, so the test follows the source
// rather than a stale build. The binary is WMUX_NATIVE_HOOKS_BIN, else the
// newest cargo build under core/wmux-native/target (or the staged
// dist/native-hooks copy). Without one the suite skips, unless
// WMUX_REQUIRE_NATIVE_HOOKS=1.
//
// Isolation: a throwaway home (HOME and USERPROFILE), a data suffix per case,
// and no inherited WMUX_* variable, so nothing here can reach a live wmux.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { mayHaveRun } from '../shimHandover';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const isWin = process.platform === 'win32';
const EXE = isWin ? 'wmux-native.exe' : 'wmux-native';

/** The named binary, else the newest build: a stale release build must not
 *  stand in for the debug build just made from the source under test. */
function findNative(): string | null {
  if (process.env.WMUX_NATIVE_HOOKS_BIN) return process.env.WMUX_NATIVE_HOOKS_BIN;
  const builds = [
    path.join(REPO_ROOT, 'dist', 'native-hooks', EXE),
    path.join(REPO_ROOT, 'core', 'wmux-native', 'target', 'release', EXE),
    path.join(REPO_ROOT, 'core', 'wmux-native', 'target', 'debug', EXE),
  ].filter((p) => fs.existsSync(p));
  builds.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return builds[0] ?? null;
}

const NATIVE = findNative();
const REQUIRED = process.env.WMUX_REQUIRE_NATIVE_HOOKS === '1';

interface Run {
  line: string | null;
  pid: number;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** What the stub broker does: take the handshake and hang up, take it and
 *  keep writing until the shim goes, take it and close with bytes from the
 *  shim still unread (a reset on Linux), answer the host's initialize and hang
 *  up on its next call, or not be there at all. */
type Broker = 'hangup' | 'flood' | 'reset' | 'inflight' | 'none';

const INIT_LINE = '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n';
const INIT_REPLY = '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18","capabilities":{}}}\n';
const INITIALIZED_AND_CALL =
  '{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
  + '{"jsonrpc":"2.0","id":"c","method":"tools/call","params":{"name":"workspace_list","arguments":{}}}\n';

interface Case {
  name: string;
  tokenFile?: string;
  env?: Record<string, string>;
  args?: string[];
  broker?: Broker;
  /** The host closes its end of the shim's stdout right after the spawn. */
  closeStdout?: boolean;
}

const CASES: Case[] = [
  { name: 'a token file and nothing else', tokenFile: ' ﻿tok-π \r\n' },
  {
    name: 'every hint, both flags, the last role wins',
    tokenFile: 'tok',
    env: { WMUX_WORKSPACE_ID: 'ws-1', WMUX_PTY_ID: 'pty-2', WMUX_COMMANDER_TOKEN: 'ct' },
    args: ['--commander', '--core', '--role=a', '--port', '1', '--role=b'],
  },
  { name: 'a set but empty commander token, an empty role', tokenFile: 'tok', env: { WMUX_COMMANDER_TOKEN: '' }, args: ['--role='] },
  {
    name: 'the env token behind a blank file, with escapes',
    tokenFile: ' \n\t',
    env: { WMUX_AUTH_TOKEN: ' a"b\\c\u0001 é ' },
  },
  { name: 'empty hints count as absent', tokenFile: 'tok', env: { WMUX_WORKSPACE_ID: '', WMUX_PTY_ID: '' } },
  { name: 'flags that only look alike', tokenFile: 'tok', args: ['--commander=1', '--cored', '-core', '--role'] },
];

let home = '';
let jsShim = '';
/** A copy of the binary alone in a directory, so it finds no full bundle to
 *  fall back to wherever the build under test sits. */
let loneNative = '';
let seq = 0;

function pipeName(suffix: string): string {
  return isWin
    ? `\\\\.\\pipe\\wmux-mcpb${suffix}-${os.userInfo().username || 'default'}`
    : `${home}/.wmux-mcpb${suffix}.sock`;
}

function childEnv(suffix: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, WMUX_DATA_SUFFIX: suffix };
  for (const keep of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[keep] !== undefined) env[keep] = process.env[keep];
  }
  return { ...env, ...extra };
}

/** One shim run against the stub broker the case names. */
async function run(runtime: 'js' | 'native', suffix: string, c: Case): Promise<Run> {
  let server: net.Server | null = null;
  let line: string | null = null;
  const broker = c.broker ?? 'hangup';
  const flooding = new Set<ReturnType<typeof setInterval>>();
  let child: ReturnType<typeof spawn> | null = null;
  if (broker !== 'none') {
    // For 'reset', a one-byte high-water mark: node keeps reading a paused
    // socket from the kernel until its buffer reaches that mark, so with the
    // default (64 KiB) the stub would drain the shim's bytes and close with an
    // empty receive queue, a plain EOF. At 1 byte it stops after one chunk.
    const srv = net.createServer({ highWaterMark: broker === 'reset' ? 1 : undefined }, (sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (line !== null) {
          if (broker === 'inflight') hostLines();
          return;
        }
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return;
        line = buf.subarray(0, nl + 1).toString('utf8');
        buf = buf.subarray(nl + 1);
        // Answer a shim that asks for the ack, as the broker does once it has
        // hosted the session (the native shim waits for it; shim.ts never asks).
        if (JSON.parse(line).ack === 1) sock.write('{"wmuxBroker":1,"ok":true}\n');
        if (broker === 'hangup') { sock.destroy(); return; }
        if (broker === 'inflight') {
          child?.stdin?.write(INIT_LINE);
          hostLines();
          return;
        }
        if (broker === 'reset') {
          // Stop reading, then have the host send two lines the shim forwards
          // as two writes. The first fills the one-byte buffer (node then stops
          // reading the socket); the second stays unread in the kernel, so the
          // close below resets the shim's end on Linux (af_unix.c,
          // unix_release_sock: ECONNRESET only with a non-empty receive queue).
          sock.pause();
          setTimeout(() => child?.stdin?.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'), 50);
          setTimeout(() => child?.stdin?.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n'), 150);
          setTimeout(() => {
            if (sock.readableLength === 0) throw new Error('the stub never received the first line');
            sock.destroy();
          }, 400);
          return;
        }
        const timer = setInterval(() => sock.write('{"jsonrpc":"2.0","method":"notifications/ping"}\n'), 20);
        flooding.add(timer);
        sock.on('close', () => { clearInterval(timer); flooding.delete(timer); });
      });
      /** The host's lines past the handshake: answer the initialize, then
       *  hang up once the call after it arrives, leaving it unanswered. */
      const hostLines = (): void => {
        let at = buf.indexOf(0x0a);
        while (at !== -1) {
          const msg = JSON.parse(buf.subarray(0, at).toString('utf8')) as { method?: string };
          buf = buf.subarray(at + 1);
          if (msg.method === 'initialize') {
            sock.write(INIT_REPLY);
            child?.stdin?.write(INITIALIZED_AND_CALL);
          } else if (msg.method === 'tools/call') {
            sock.destroy();
            return;
          }
          at = buf.indexOf(0x0a);
        }
      };
      sock.on('error', () => { /* shim gone */ });
    });
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(pipeName(suffix), () => resolve());
    });
    server = srv;
  }
  const [cmd, ...args] = runtime === 'js'
    ? [process.execPath, jsShim, ...(c.args ?? [])]
    : [loneNative, 'mcp-shim', ...(c.args ?? [])];
  const proc = spawn(cmd, args, { env: childEnv(suffix, c.env ?? {}), stdio: ['pipe', 'pipe', 'pipe'] });
  child = proc;
  let stdout = '';
  let stderr = '';
  if (c.closeStdout) proc.stdout.destroy();
  else proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  // 'close', not 'exit': stdout and stderr may still hold data at exit.
  const code = await new Promise<number | null>((resolve) => proc.on('close', (c2) => resolve(c2)));
  for (const timer of flooding) clearInterval(timer);
  proc.stdin.destroy();
  const srv = server;
  if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
  return { line, pid: proc.pid ?? -1, code, stdout, stderr };
}

/** Both shims on one suffix. With a broker they take turns at it; without
 *  one they run side by side (shim.ts tries ten times 300 ms apart; the
 *  native shim three times, or not at all when the endpoint is missing).
 *  `prepare` may plant something at the endpoint first. */
async function both(c: Case, prepare?: (pipe: string) => void): Promise<{ js: Run; native: Run }> {
  const suffix = `-nsp${process.pid}-${++seq}`;
  const tokenPath = path.join(home, `.wmux${suffix}-auth-token`);
  if (c.tokenFile !== undefined) fs.writeFileSync(tokenPath, c.tokenFile);
  prepare?.(pipeName(suffix));
  try {
    if ((c.broker ?? 'hangup') === 'none') {
      const [js, native] = await Promise.all([run('js', suffix, c), run('native', suffix, c)]);
      return { js, native };
    }
    const js = await run('js', suffix, c);
    const native = await run('native', suffix, c);
    return { js, native };
  } finally {
    fs.rmSync(tokenPath, { force: true });
    if (!isWin) fs.rmSync(pipeName(suffix), { force: true });
  }
}

/** A Unix socket file whose listener died without unlinking it. */
function plantStaleSocket(pipe: string): void {
  const script = `require('net').createServer().listen(${JSON.stringify(pipe)}, () => process.kill(process.pid, 'SIGKILL'))`;
  spawnSync(process.execPath, ['-e', script]);
  if (!fs.existsSync(pipe)) throw new Error(`no stale socket at ${pipe}`);
}

/** Where the native shim differs from shim.ts on purpose, and why. */
const DIVERGENCES: { c: Case; js: number; native: number; reason: string }[] = [
  {
    c: { name: 'the host stops reading stdout', tokenFile: 'tok', broker: 'flood', closeStdout: true },
    js: 1,
    native: 0,
    reason:
      'the host stopped reading, which is a normal shutdown; node exits 1 there only because shim.ts '
      + 'has no stdout error listener (an unhandled-error accident, not a contract)',
  },
];

function handshake(r: Run, who: string): string {
  if (r.line === null) throw new Error(`the ${who} shim sent no handshake (exit ${r.code}): ${r.stderr}`);
  return r.line;
}

const maskPid = (line: string) => line.replace(/"callerPid":\d+,/, '"callerPid":0,');

/** A handshake minus its last field, `"ack":1`, which both shims send. */
function withoutAck(line: string): string {
  expect(line, 'the handshake ends with "ack":1').toMatch(/,"ack":1\}\n$/);
  return line.replace(/,"ack":1\}\n$/, '}\n');
}

/** A drop past the ack with no full server to hand the session to: both shims
 *  report the drop with the same line, then that there is no full server, each
 *  in its own words (the native shim lists where it looked). */
function expectLossWithoutServer(js: Run, native: Run, drop: string): void {
  expect(js.stderr).toBe(`${drop}\n[wmux-mcp-shim] no full server beside the shim\n`);
  const [nativeDrop, nativeNoServer, ...more] = native.stderr.split('\n');
  expect(nativeDrop).toBe(drop);
  expect(nativeNoServer).toMatch(/^\[wmux-mcp-shim\] no full bundle to fall back to \(looked at .*index\.js\)$/);
  expect(more).toEqual(['']);
}

/** Native stderr with no broker: its one fallback-reason line in place of
 *  shim.ts's connect error, then the missing-bundle line. A recorded
 *  difference: the native shim falls back where shim.ts gives up. */
function expectNoBrokerThenNoBundle(nativeStderr: string): void {
  expect(nativeStderr).toMatch(/^\[wmux-mcp-shim\] no broker\n\[wmux-mcp-shim\] no full bundle to fall back to \(looked at .*index\.js\)\n$/);
}

describe.skipIf(!NATIVE && !REQUIRED)('wmux-native mcp-shim ↔ shim.ts handshake parity', () => {
  beforeAll(() => {
    if (!NATIVE) throw new Error('WMUX_REQUIRE_NATIVE_HOOKS=1 but no wmux-native binary was found');
    // macOS caps sun_path at 104 bytes; a runner's TMPDIR is already long.
    home = fs.mkdtempSync(path.join(isWin ? os.tmpdir() : '/tmp', 'nsp-'));
    jsShim = path.join(home, 'shim.cjs');
    fs.mkdirSync(path.join(home, 'lone'));
    loneNative = path.join(home, 'lone', EXE);
    fs.copyFileSync(NATIVE, loneNative);
    fs.chmodSync(loneNative, 0o755);
    buildSync({
      entryPoints: [path.join(REPO_ROOT, 'src', 'mcp', 'shim.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: jsShim,
      external: ['electron'],
      logLevel: 'error',
    });
  });

  afterAll(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  for (const c of CASES) {
    it(c.name, async () => {
      const { js, native } = await both(c);
      const jsLine = withoutAck(handshake(js, 'JS'));
      const nativeLine = handshake(native, 'native');
      const j = JSON.parse(jsLine);
      const n = JSON.parse(withoutAck(nativeLine));
      expect(j.callerPid).toBe(js.pid);
      expect(n.callerPid).toBe(native.pid);
      expect(j.callerPpid).toBe(process.pid);
      expect(n.callerPpid).toBe(process.pid);
      expect(Object.keys(n)).toEqual(Object.keys(j));
      expect({ ...n, callerPid: 0 }).toEqual({ ...j, callerPid: 0 });
      expect(maskPid(withoutAck(nativeLine))).toBe(maskPid(jsLine));
      // The broker hung up: both report it the same way.
      expect(native.code).toBe(js.code);
      expect(native.code).toBe(1);
      expect(native.stdout).toBe(js.stdout);
      expectLossWithoutServer(js, native, '[wmux-mcp-shim] broker connection closed');
    });
  }

  // No token file at all (wmux never ran under this home): both hand the
  // session to their full server, as the bundle entry would serve it. Neither
  // has one beside it here, so both then end; each words that its own way.
  it('no token file: both fall back to the full server, nothing dialled', async () => {
    const { js, native } = await both({ name: 'no token file', broker: 'none' });
    expect(native.code).toBe(js.code);
    expect(native.code).toBe(1);
    expect(native.stdout).toBe(js.stdout);
    expect(native.stderr).toMatch(/^\[wmux-mcp-shim\] no auth token file\n\[wmux-mcp-shim\] no full bundle to fall back to \(looked at .*index\.js\)\n$/);
    expect(js.stderr).toBe('[wmux-mcp-shim] no auth token file; running the full server\n[wmux-mcp-shim] no full server beside the shim\n');
  });

  // A token file that is there but gives no token keeps the refusal on both.
  it('a token file with no token: the same refusal, nothing dialled', async () => {
    const { js, native } = await both({ name: 'blank token file', tokenFile: ' \n\t', broker: 'none' });
    expect(native.code).toBe(js.code);
    expect(native.code).toBe(1);
    expect(native.stdout).toBe(js.stdout);
    expect(native.stderr).toBe(js.stderr);
    expect(native.stderr).toBe('[wmux-mcp-shim] auth token not found. Is wmux running?\n');
  });

  it('no broker: the same refusal after the retries, worded as node words the connect error', async () => {
    const { js, native } = await both({ name: 'no broker', tokenFile: 'tok', broker: 'none' });
    expect(native.code).toBe(js.code);
    expect(native.code).toBe(1);
    expect(native.stdout).toBe(js.stdout);
    expectNoBrokerThenNoBundle(native.stderr);
    expect(js.stderr).toMatch(/^\[wmux-mcp-shim\] cannot reach broker at (.+): connect ENOENT \1\n$/);
  }, 20_000);

  it.skipIf(isWin)('a stale socket: the same ECONNREFUSED refusal', async () => {
    const { js, native } = await both({ name: 'stale socket', tokenFile: 'tok', broker: 'none' }, plantStaleSocket);
    expect(native.code).toBe(1);
    expect(native.code).toBe(js.code);
    expectNoBrokerThenNoBundle(native.stderr);
    expect(js.stderr).toMatch(/: connect ECONNREFUSED /);
  }, 20_000);

  // A Unix socket closed with unread bytes resets its peer on Linux only;
  // macOS reports a plain end of stream, and a Windows pipe has no such state.
  it.skipIf(process.platform !== 'linux')('a reset mid-session: the same `read ECONNRESET` error', async () => {
    const { js, native } = await both({ name: 'reset', tokenFile: 'tok', broker: 'reset' });
    expectLossWithoutServer(js, native, '[wmux-mcp-shim] broker connection error: read ECONNRESET');
    // Both pings were in flight: each gets the error, in the order sent.
    expect(js.stdout).toBe(String(mayHaveRun('1')) + String(mayHaveRun('2')));
    expect(native.stdout).toBe(js.stdout);
    expect(native.code).toBe(1);
    expect(native.code).toBe(js.code);
  }, 20_000);

  it('a drop with a call in flight: the same error for that call, nothing sent again', async () => {
    const { js, native } = await both({ name: 'in flight', tokenFile: 'tok', broker: 'inflight' });
    expect(js.stdout).toBe(INIT_REPLY + String(mayHaveRun('"c"')));
    expect(native.stdout).toBe(js.stdout);
    expectLossWithoutServer(js, native, '[wmux-mcp-shim] broker connection closed');
    expect(native.code).toBe(1);
    expect(native.code).toBe(js.code);
  }, 20_000);

  for (const d of DIVERGENCES) {
    it(`recorded divergence: ${d.c.name}`, async () => {
      const { js, native } = await both(d.c);
      expect(js.code, `shim.ts (${d.reason})`).toBe(d.js);
      expect(native.code, `native (${d.reason})`).toBe(d.native);
      expect(native.stdout).toBe('');
    });
  }
});
