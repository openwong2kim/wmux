// Byte-for-byte parity: `wmux-native hook` against the shared Node bridge.
//
// Every fixture runs twice, once per runtime, against the same fake wmux pipes
// in the same throwaway home. The test compares the exact bytes of each request
// line the pipes receive (method, envelope, token, clientName; only the random
// request-id suffix and the envelope timestamp are masked), the log outcome
// each run writes, stdout (always empty) and the exit code (always 0).
//
// The binary is WMUX_NATIVE_HOOKS_BIN, else the newest of the staged
// dist/native-hooks copy and the cargo builds under core/wmux-native/target.
// Without one the suite
// skips, unless WMUX_REQUIRE_NATIVE_HOOKS=1 (the native-hooks workflow sets it).
//
// Isolation: a throwaway home (HOME and USERPROFILE), a data suffix, and every
// inherited WMUX_* variable removed, so nothing here can reach a live wmux.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { FLAVOURS } from '../bin/wmux-hooks-bridge.mjs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BRIDGE = path.join(REPO_ROOT, 'integrations', 'shared', 'bin', 'wmux-hooks-bridge.mjs');
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
const SUFFIX = '-native-parity';
const MAIN_TOKEN = 'main-token-π';
const DAEMON_TOKEN = 'daemon-token';

type Reply = 'ok' | 'rejected' | 'refused' | 'hangup' | 'stall' | 'deep';

/** A fake wmux pipe that records each request line as raw bytes. */
class FakePipe {
  readonly name: string;
  readonly lines: string[] = [];
  reply: Reply = 'ok';
  private server!: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(name: string) {
    this.name = name;
  }

  async start(): Promise<void> {
    this.server = net.createServer((sock) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      // Accept, then never read: a large request fills the socket buffers and
      // the client's write blocks until its time slice runs out.
      if (this.reply === 'stall') { sock.pause(); sock.on('error', () => { /* client gone */ }); return; }
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return;
        const line = buf.subarray(0, nl).toString('utf8');
        this.lines.push(line);
        const id = JSON.parse(line).id;
        // A broadcast frame first: replies are matched by id, not position.
        sock.write(JSON.stringify({ type: 'session.output', sessionId: 'x' }) + '\n');
        if (this.reply === 'hangup') { sock.destroy(); return; }
        if (this.reply === 'deep') {
          // Nested past any stack (written by hand: JSON.stringify cannot):
          // logging it must end in `uncaught`, not a crash.
          const reason = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
          sock.end(`{"id":${JSON.stringify(id)},"ok":true,"result":{"ok":false,"reason":${reason}}}\n`);
          return;
        }
        const body = this.reply === 'ok' ? { id, ok: true, result: { ok: true } }
          : this.reply === 'rejected' ? { id, ok: true, result: { ok: false, reason: 'no-workspace-match' } }
          : { id, ok: false, error: 'refused', detail: { code: 7 } };
        sock.end(JSON.stringify(body) + '\n');
      });
      sock.on('error', () => { /* client gone */ });
    });
    await new Promise<void>((resolve) => this.server.listen(this.name, resolve));
  }

  stop(): Promise<void> {
    // A stalled connection never ends on its own.
    for (const sock of this.sockets) sock.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

interface Fixture {
  name: string;
  argv: string[];
  stdin: string;
  env?: Record<string, string>;
}

interface RunResult { status: number | null; stdout: string; lines: string[]; log: Record<string, unknown>[] }

let home: string;
let cwd: string;
let wmuxDir: string;
let daemon: FakePipe;
let main: FakePipe;

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('WMUX_')) env[k] = v;
  return { ...env, HOME: home, USERPROFILE: home, WMUX_DATA_SUFFIX: SUFFIX, WMUX_PTY_ID: 'pty-7', ...extra };
}

function readLog(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const f of fs.readdirSync(wmuxDir).filter((n) => n.endsWith('.log')).sort()) {
    for (const line of fs.readFileSync(path.join(wmuxDir, f), 'utf8').split('\n').filter(Boolean)) {
      out.push({ file: f, ...JSON.parse(line) });
    }
    fs.unlinkSync(path.join(wmuxDir, f));
  }
  return out;
}

async function run(cmd: string, args: string[], fx: Fixture): Promise<RunResult> {
  daemon.lines.length = 0;
  main.lines.length = 0;
  const child = spawn(cmd, args, { cwd, env: baseEnv(fx.env), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stdin.on('error', () => { /* an unknown flavour exits without reading stdin */ });
  child.stdin.end(fx.stdin);
  const status = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { status, stdout, lines: [...daemon.lines.map((l) => `daemon ${l}`), ...main.lines.map((l) => `main ${l}`)], log: readLog() };
}

/** Mask what legitimately differs between two runs: the request id's UUID and the envelope timestamp. */
function mask(line: string): string {
  return line
    .replace(/"id":"([a-z]+-hook)-[0-9a-f-]{36}"/, '"id":"$1-<uuid>"')
    .replace(/,"ts":\d+\},"token"/, ',"ts":<ts>},"token"');
}

function maskLog(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const varying = new Set(['ts', 'pid', 'runtime']);
  return entries.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !varying.has(k))));
}

const PAYLOAD_EXTRAS = {
  prompt: 'never forwarded',
  transcript_path: '/home/u/.x/t.jsonl',
  tool_input: { command: 'rm -rf /' },
};

function fixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const [flavour, row] of Object.entries(FLAVOURS as Record<string, { events: Record<string, unknown> }>)) {
    for (const event of Object.keys(row.events)) {
      const full = {
        hook_event_name: event, session_id: 'sess-1', sessionId: 'camel-2', cwd: '/w/repo',
        source: 'resume', notification_type: 'ToolPermission', ...PAYLOAD_EXTRAS,
      };
      out.push({ name: `${flavour} ${event} argv`, argv: [flavour, event], stdin: JSON.stringify(full) });
      out.push({ name: `${flavour} ${event} payload-named`, argv: [flavour], stdin: JSON.stringify(full) });
      out.push({ name: `${flavour} ${event} minimal`, argv: [flavour, event], stdin: '{}', env: { WMUX_WORKSPACE_ID: 'ws-1', WMUX_SURFACE_ID: 'sf-1' } });
      out.push({ name: `${flavour} ${event} camel id, startup`, argv: [flavour, event], stdin: JSON.stringify({ sessionId: 'camel-2', source: 'startup', cwd: '' }) });
    }
    out.push({ name: `${flavour} unmapped event`, argv: [flavour, 'PreToolUse'], stdin: JSON.stringify({ session_id: 's' }) });
    out.push({ name: `${flavour} no pane`, argv: [flavour, Object.keys(row.events)[0]], stdin: '{}', env: { WMUX_PTY_ID: '' } });
    out.push({ name: `${flavour} malformed stdin`, argv: [flavour, Object.keys(row.events)[0]], stdin: '{"session_id": ' });
    out.push({ name: `${flavour} empty stdin`, argv: [flavour, Object.keys(row.events)[0]], stdin: ' \n\t' });
    out.push({ name: `${flavour} no event at all`, argv: [flavour], stdin: '{"session_id":"x"}' });
  }
  const weird = '﻿ {"hook_event_name":"Stop","session_id":"a b","cwd":"/w/\\u00e9\\ud83d\\ude00\\ud800\\u0001\\"q\\"\\\\","source":"new","hook_event_name":"Stop"}  ';
  out.push(
    { name: 'gemini Notification of another type', argv: ['gemini', 'Notification'], stdin: JSON.stringify({ notification_type: 'Other' }) },
    { name: 'qwen odd payload: BOM, lone surrogate, duplicate key, bad id', argv: ['qwen'], stdin: weird },
    { name: 'qwen array payload', argv: ['qwen', 'Stop'], stdin: '[{"session_id":"x"}]' },
    { name: 'qwen deep nesting', argv: ['qwen', 'Stop'], stdin: `${'['.repeat(5000)}${']'.repeat(5000)}` },
    { name: 'qwen oversized payload', argv: ['qwen', 'Stop'], stdin: JSON.stringify({ session_id: 's', blob: 'x'.repeat(300 * 1024) }) },
    { name: 'qwen session id at the length cap', argv: ['qwen', 'Stop'], stdin: JSON.stringify({ session_id: `a${'b'.repeat(127)}` }) },
    { name: 'qwen session id over the cap', argv: ['qwen', 'Stop'], stdin: JSON.stringify({ session_id: `a${'b'.repeat(128)}` }) },
    { name: 'unknown flavour', argv: ['claude', 'Stop'], stdin: '{}' },
    { name: 'prototype flavour', argv: ['constructor', 'Stop'], stdin: '{}' },
    { name: 'long unknown flavour', argv: ['x'.repeat(40) + '😀', 'Stop'], stdin: '{}' },
    { name: 'no flavour', argv: [], stdin: '{}' },
  );
  return out;
}

async function bothRuntimes(fx: Fixture): Promise<[RunResult, RunResult]> {
  const node = await run(process.execPath, [BRIDGE, ...fx.argv], fx);
  const native = await run(NATIVE as string, ['hook', ...fx.argv], fx);
  return [node, native];
}

function expectParity(fx: Fixture, node: RunResult, native: RunResult): void {
  expect(node.status, `${fx.name}: node exit`).toBe(0);
  expect(native.status, `${fx.name}: native exit`).toBe(0);
  expect(native.stdout, `${fx.name}: native stdout`).toBe('');
  expect(node.stdout).toBe('');
  expect(native.lines.map(mask), `${fx.name}: request bytes`).toEqual(node.lines.map(mask));
  expect(maskLog(native.log), `${fx.name}: log outcome`).toEqual(maskLog(node.log));
  for (const entry of native.log) expect(entry.runtime).toBe('native');
}

describe.skipIf(!NATIVE && !REQUIRED)('wmux-native hook ↔ wmux-hooks-bridge.mjs parity', () => {
  beforeAll(async () => {
    if (!NATIVE) throw new Error('WMUX_REQUIRE_NATIVE_HOOKS=1 but no wmux-native binary was found');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux native parity-'));
    cwd = fs.mkdtempSync(path.join(home, 'cwd é-'));
    wmuxDir = path.join(home, `.wmux${SUFFIX}`);
    fs.mkdirSync(wmuxDir, { recursive: true });
    // The daemon is found through its hint file; main by the name both bridges
    // derive from the home directory and suffix, so a fall-through really lands.
    daemon = new FakePipe(isWin ? `\\\\.\\pipe\\wmux-native-parity-daemon-${randomUUID()}` : path.join(wmuxDir, 'daemon.sock'));
    main = new FakePipe(isWin ? `\\\\.\\pipe\\wmux${SUFFIX}-${os.userInfo().username || 'default'}` : path.join(home, `.wmux${SUFFIX}.sock`));
    await daemon.start();
    await main.start();
  });

  afterAll(async () => {
    await daemon?.stop();
    await main?.stop();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  // Endpoint discovery by the daemon's hint file and the two token files.
  function useEndpoints({ daemonToken, mainToken }: { daemonToken: boolean; mainToken: boolean }): void {
    fs.writeFileSync(path.join(wmuxDir, 'daemon-pipe'), `${daemon.name}\n`);
    const daemonTokenPath = path.join(wmuxDir, 'daemon-auth-token');
    const mainTokenPath = path.join(home, `.wmux${SUFFIX}-auth-token`);
    if (daemonToken) fs.writeFileSync(daemonTokenPath, ` ${DAEMON_TOKEN}\n`); else fs.rmSync(daemonTokenPath, { force: true });
    if (mainToken) fs.writeFileSync(mainTokenPath, MAIN_TOKEN); else fs.rmSync(mainTokenPath, { force: true });
  }

  it('sends identical envelopes and logs identical outcomes for every flavour/event fixture', async () => {
    useEndpoints({ daemonToken: true, mainToken: true });
    daemon.reply = 'ok';
    let delivered = 0;
    for (const fx of fixtures()) {
      const [node, native] = await bothRuntimes(fx);
      expectParity(fx, node, native);
      delivered += node.lines.length;
    }
    // The fixtures exercise delivery, not only the drop paths.
    expect(delivered).toBeGreaterThan(30);
  }, 120_000);

  it.each([
    ['daemon rejects the signal', 'rejected' as Reply, 'Stop'],
    ['daemon refuses: falls through to main', 'refused' as Reply, 'UserPromptSubmit'],
    ['daemon hangs up after the write: an idempotent kind goes on to main', 'hangup' as Reply, 'Stop'],
    ['daemon hangs up after the write: a non-idempotent kind does not', 'hangup' as Reply, 'PermissionRequest'],
    ['daemon stops reading: its slice times out, an idempotent kind goes on to main', 'stall' as Reply, 'Stop'],
    ['daemon replies with a value nested past the stack', 'deep' as Reply, 'Stop'],
  ])('%s', async (_name, reply, event) => {
    useEndpoints({ daemonToken: true, mainToken: true });
    daemon.reply = reply;
    // A request large enough to fill the socket buffers of a peer that stops reading.
    const cwd = reply === 'stall' ? `/w/${'x'.repeat(200 * 1024)}` : '/w';
    const fx: Fixture = { name: `${reply} ${event}`, argv: ['qwen', event], stdin: JSON.stringify({ session_id: 's-1', cwd }) };
    const [node, native] = await bothRuntimes(fx);
    daemon.reply = 'ok';
    expectParity(fx, node, native);
    expect(node.lines.length).toBeGreaterThan(0);
  });

  it.each([
    ['main only (WMUX_HOOKS_TO_MAIN=1)', { daemonToken: true, mainToken: true }, { WMUX_HOOKS_TO_MAIN: '1' }],
    ['main only (no daemon token)', { daemonToken: false, mainToken: true }, {}],
    ['no token anywhere', { daemonToken: false, mainToken: false }, {}],
    ['daemon only, no hint file falls back to the derived name', { daemonToken: true, mainToken: false }, {}],
  ])('%s', async (name, tokens, env) => {
    useEndpoints(tokens);
    if (name.includes('no hint')) fs.rmSync(path.join(wmuxDir, 'daemon-pipe'));
    const fx: Fixture = { name, argv: ['copilot', 'Stop'], stdin: '{"session_id":"s-1"}', env };
    const [node, native] = await bothRuntimes(fx);
    expectParity(fx, node, native);
  });

  // The request carries the token: a pipe name that is a plain file must be
  // refused, never written to.
  it('writes nothing to a pipe name that is a plain file', async () => {
    useEndpoints({ daemonToken: false, mainToken: true });
    const decoy = path.join(home, 'not-a-pipe');
    fs.writeFileSync(decoy, 'untouched');
    const fx: Fixture = { name: 'plain-file pipe', argv: ['copilot', 'Stop'], stdin: '{}', env: { WMUX_PIPE_NAME: decoy } };
    const [node, native] = await bothRuntimes(fx);
    expect(native.status).toBe(0);
    expect(native.stdout).toBe('');
    expect(fs.readFileSync(decoy, 'utf8')).toBe('untouched');
    expect(maskLog(native.log).map((e) => e.outcome)).toEqual(maskLog(node.log).map((e) => e.outcome));
  });

  it('honours WMUX_PIPE_NAME as the only endpoint', async () => {
    useEndpoints({ daemonToken: true, mainToken: true });
    const fx: Fixture = { name: 'pipe override', argv: ['kiro', 'stop'], stdin: '{"cwd":"/k"}', env: { WMUX_PIPE_NAME: main.name } };
    const [node, native] = await bothRuntimes(fx);
    expectParity(fx, node, native);
    expect(node.lines).toHaveLength(1);
    expect(node.lines[0]).toMatch(/^main /);
  });
});
