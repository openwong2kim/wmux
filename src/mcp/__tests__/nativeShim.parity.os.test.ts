// Parity: `wmux-native mcp-shim` against src/mcp/shim.ts, the source of truth.
//
// Each case runs both shims with the same environment and argv against one stub
// broker bound at the endpoint they both derive. The stub takes the handshake
// line, then drops the connection. The test compares the line byte for byte
// (callerPid masked: each shim reports its own pid), the parsed values and
// their key order, and the exit code, stdout and stderr that follow. A case
// with no token compares the refusal instead.
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
import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

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

interface Case {
  name: string;
  tokenFile?: string;
  env?: Record<string, string>;
  args?: string[];
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

/** One shim run against a stub broker that takes the handshake and hangs up. */
async function run(runtime: 'js' | 'native', suffix: string, c: Case, listen: boolean): Promise<Run> {
  let server: net.Server | null = null;
  let line: string | null = null;
  if (listen) {
    const srv = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const nl = buf.indexOf(0x0a);
        if (nl === -1 || line !== null) return;
        line = buf.subarray(0, nl + 1).toString('utf8');
        sock.destroy();
      });
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
    : [NATIVE ?? EXE, 'mcp-shim', ...(c.args ?? [])];
  const child = spawn(cmd, args, { env: childEnv(suffix, c.env ?? {}), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c2) => resolve(c2)));
  child.stdin.destroy();
  const srv = server;
  if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
  return { line, pid: child.pid ?? -1, code, stdout, stderr };
}

async function both(c: Case, listen = true): Promise<{ js: Run; native: Run }> {
  const suffix = `-nsp${process.pid}-${++seq}`;
  const tokenPath = path.join(home, `.wmux${suffix}-auth-token`);
  if (c.tokenFile !== undefined) fs.writeFileSync(tokenPath, c.tokenFile);
  try {
    const js = await run('js', suffix, c, listen);
    const native = await run('native', suffix, c, listen);
    return { js, native };
  } finally {
    fs.rmSync(tokenPath, { force: true });
  }
}

function handshake(r: Run, who: string): string {
  if (r.line === null) throw new Error(`the ${who} shim sent no handshake (exit ${r.code}): ${r.stderr}`);
  return r.line;
}

const maskPid = (line: string) => line.replace(/"callerPid":\d+,/, '"callerPid":0,');

describe.skipIf(!NATIVE && !REQUIRED)('wmux-native mcp-shim ↔ shim.ts handshake parity', () => {
  beforeAll(() => {
    if (!NATIVE) throw new Error('WMUX_REQUIRE_NATIVE_HOOKS=1 but no wmux-native binary was found');
    // macOS caps sun_path at 104 bytes; a runner's TMPDIR is already long.
    home = fs.mkdtempSync(path.join(isWin ? os.tmpdir() : '/tmp', 'nsp-'));
    jsShim = path.join(home, 'shim.cjs');
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
      const jsLine = handshake(js, 'JS');
      const nativeLine = handshake(native, 'native');
      const j = JSON.parse(jsLine);
      const n = JSON.parse(nativeLine);
      expect(j.callerPid).toBe(js.pid);
      expect(n.callerPid).toBe(native.pid);
      expect(j.callerPpid).toBe(process.pid);
      expect(n.callerPpid).toBe(process.pid);
      expect(Object.keys(n)).toEqual(Object.keys(j));
      expect({ ...n, callerPid: 0 }).toEqual({ ...j, callerPid: 0 });
      expect(maskPid(nativeLine)).toBe(maskPid(jsLine));
      // The broker hung up: both report it the same way.
      expect(native.code).toBe(js.code);
      expect(native.code).toBe(1);
      expect(native.stdout).toBe(js.stdout);
      expect(native.stderr).toBe(js.stderr);
    });
  }

  it('no token: the same refusal, nothing dialled', async () => {
    const { js, native } = await both({ name: 'no token' }, false);
    expect(native.code).toBe(js.code);
    expect(native.code).toBe(1);
    expect(native.stdout).toBe(js.stdout);
    expect(native.stderr).toBe(js.stderr);
    expect(native.stderr).toBe('[wmux-mcp-shim] auth token not found. Is wmux running?\n');
  });
});
