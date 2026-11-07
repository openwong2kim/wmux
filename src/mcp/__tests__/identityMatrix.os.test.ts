// Who the MCP server says its caller is, along every chain an agent can run it
// through, against a stub main that records what the server sends:
//   bundle    host → `node index.js`                 (broker off, today)
//   shim      host → wmux-native mcp-shim → broker   (the broker hosts it)
//   fallback  host → wmux-native mcp-shim → full bundle in place (the broker
//             refused the session: this world's broker cannot read peer pids)
// The stub main plants the host's pid as a pane; the server must find that
// pane by walking from its caller's parent, and every chain must find the same
// one, send the same hints, offer the same tools and get the same code-tool
// answer. A client that names a false parent to the broker still gets its own.
//
// Hosts are processes named claude, codex, gemini and opencode (node under
// those names), so a parent chain reads as it does under a real agent.
// The broker and bundle are built from source with esbuild, as brokerAck does;
// the native binary comes from WMUX_NATIVE_HOOKS_BIN or a local cargo build.
// Windows named pipes give the broker no peer pid, so there every broker
// session falls back; the fallback chain is the bundle's, and this file runs on
// macOS and Linux.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const isWin = process.platform === 'win32';
const TOKEN = 'identity-matrix-token';

function nativeBinary(): string | null {
  const candidates = [
    process.env.WMUX_NATIVE_HOOKS_BIN,
    path.join(REPO_ROOT, 'core', 'wmux-native', 'target', 'release', 'wmux-native'),
    path.join(REPO_ROOT, 'core', 'wmux-native', 'target', 'debug', 'wmux-native'),
  ];
  return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null;
}
const NATIVE = isWin ? null : nativeBinary();
if (!NATIVE && process.env.WMUX_REQUIRE_NATIVE_HOOKS) throw new Error('identity matrix: no wmux-native binary (set WMUX_NATIVE_HOOKS_BIN)');

interface Recorded { method: string; params: Record<string, unknown>; commanderToken?: unknown; callerPtyId?: unknown }

/** A stub main: plants panes for pids, answers what the server asks, records it. */
class StubMain {
  readonly calls: Recorded[] = [];
  panes = new Map<number, { ws: string; pty: string }>();
  protectedPane = false;
  private server: net.Server;
  constructor(readonly pipe: string) {
    this.server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          let m: { id?: unknown; method?: string; params?: Record<string, unknown>; commanderToken?: unknown; callerPtyId?: unknown };
          try { m = JSON.parse(line); } catch { continue; }
          const params = m.params ?? {};
          this.calls.push({ method: String(m.method), params, commanderToken: m.commanderToken, callerPtyId: m.callerPtyId });
          sock.write(JSON.stringify({ id: m.id, ok: true, result: this.answer(String(m.method), params) }) + '\n');
        }
      });
      sock.on('error', () => undefined);
    });
  }
  listen(): Promise<void> { return new Promise((r) => this.server.listen(this.pipe, () => r())); }
  close(): void { this.server.close(); }
  private answer(method: string, params: Record<string, unknown>): unknown {
    const entries = [...this.panes].map(([pid, p]) => ({ pid: String(pid), workspaceId: p.ws, ptyId: p.pty }));
    switch (method) {
      case 'a2a.resolve.identity':
        return { mappings: Object.fromEntries(entries.map((e) => [e.pid, e.workspaceId])), entries };
      case 'workspace.list':
        return { workspaces: [...new Set(entries.map((e) => e.workspaceId))].map((id) => ({ id, name: id })) };
      case 'a2a.whoami':
        return { workspaceId: params.workspaceId, senderPtyId: params.senderPtyId ?? null };
      case 'browser.lease.acquire':
        return { policy: { protected: this.protectedPane } };
      default:
        return {};
    }
  }
}

interface World { home: string; suffix: string; main: StubMain; broker: ChildProcess; log: () => string }

const HOST_SOURCE = String.raw`
// A stand-in agent host: runs the MCP command (or, with spec.forge, talks to
// a forging shim), initializes, lists tools, then on "go" asks a2a_whoami
// and repl_run, prints what it got, and on "done" ends.
const { spawn } = require('child_process');
const net = require('net');
const readline = require('readline');
const spec = JSON.parse(process.argv[2]);
if (spec.forgeShim) {
  // A shim that names a false parent: handshake, drop the ack line, then pump.
  const sock = net.connect(spec.forgeShim.pipe);
  sock.write(JSON.stringify({ wmuxShim: 1, authToken: spec.forgeShim.token, callerPid: process.pid, callerPpid: spec.forgeShim.ppid, ack: 1 }) + '\n');
  let head = Buffer.alloc(0);
  const onHead = (d) => {
    head = Buffer.concat([head, d]);
    const n = head.indexOf(10);
    if (n < 0) return;
    sock.removeListener('data', onHead);
    const rest = head.subarray(n + 1);
    if (rest.length) process.stdout.write(rest);
    sock.pipe(process.stdout);
    process.stdin.pipe(sock);
  };
  sock.on('data', onHead);
  process.stdin.on('end', () => process.exit(0));
  return;
}
const lines = readline.createInterface({ input: process.stdin });
const nextLine = () => new Promise((r) => lines.once('line', r));
const child = spawn(spec.cmd, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write(d));
const write = (s) => child.stdin.write(s);
const onLine = (f) => { let b = ''; child.stdout.on('data', (d) => { b += d; let n; while ((n = b.indexOf('\n')) >= 0) { f(b.slice(0, n)); b = b.slice(n + 1); } }); };
const waiting = new Map(); let id = 0;
onLine((line) => { let m; try { m = JSON.parse(line); } catch { return; } if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const req = (method, params) => new Promise((r) => { const mid = ++id; waiting.set(mid, r); write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n'); });
const text = (m) => (m.result && m.result.content || []).map((c) => c.text || '').join(' ') || JSON.stringify(m.error || '');
(async () => {
  await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: spec.clientName, version: '1' } });
  write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await req('tools/list', {});
  const tools = (list.result && list.result.tools || []).map((t) => t.name).sort();
  console.log(JSON.stringify({ ready: true, pid: process.pid, mcpPid: child.pid }));
  await nextLine();
  const whoami = await req('tools/call', { name: 'a2a_whoami', arguments: {} });
  const repl = await req('tools/call', { name: 'repl_run', arguments: { code: '1' } });
  console.log(JSON.stringify({ tools, whoami: text(whoami), replRefused: Boolean(repl.result && repl.result.isError), replText: text(repl).slice(0, 160) }));
  await nextLine();
  child.stdin.end(); setTimeout(() => { try { child.kill(); } catch {} process.exit(0); }, 500);
})();
`;

describe.skipIf(isWin || !NATIVE)('identity across the bundle, shim and fallback chains', () => {
  let root = '';
  let res = '';
  let bin = '';
  let hostScript = '';
  let peerWorld: World;
  let blindWorld: World;
  const owned: ChildProcess[] = [];

  async function makeWorld(name: string, koffi: boolean): Promise<World> {
    const home = fs.mkdtempSync(path.join('/tmp', `idm-${name}-`));
    const suffix = `-idm${name}${process.pid}`;
    fs.writeFileSync(path.join(home, `.wmux${suffix}-auth-token`), TOKEN + '\n');
    const main = new StubMain(path.join(home, `.wmux${suffix}.sock`));
    await main.listen();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, WMUX_DATA_SUFFIX: suffix, TMPDIR: process.env.TMPDIR };
    if (koffi) env.NODE_PATH = path.join(REPO_ROOT, 'node_modules');
    const broker = spawn(process.execPath, [path.join(res, 'mcp-bundle', 'broker.js')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    owned.push(broker);
    let log = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`broker did not start: ${log}`)), 20_000);
      broker.stderr?.on('data', (d) => {
        log += d;
        if (log.includes('listening on') && log.includes('peer-pid:')) { clearTimeout(timer); resolve(); }
      });
      broker.once('exit', (c) => { clearTimeout(timer); reject(new Error(`broker exited ${c}: ${log}`)); });
    });
    return { home, suffix, main, broker, log: () => log };
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join('/tmp', 'idm-'));
    res = path.join(root, 'res');
    fs.mkdirSync(path.join(res, 'mcp-bundle'), { recursive: true });
    fs.mkdirSync(path.join(res, 'native-hooks'), { recursive: true });
    const common = { bundle: true, platform: 'node' as const, format: 'cjs' as const, logLevel: 'error' as const,
      external: ['electron', 'chromium-bidi', 'playwright-core', 'koffi'], define: { __WMUX_MCP_VERSION__: JSON.stringify('0.0.0-test') } };
    buildSync({ ...common, entryPoints: [path.join(REPO_ROOT, 'src', 'mcp', 'entry.ts')], outfile: path.join(res, 'mcp-bundle', 'index.js') });
    buildSync({ ...common, entryPoints: [path.join(REPO_ROOT, 'src', 'mcp', 'broker.ts')], outfile: path.join(res, 'mcp-bundle', 'broker.js') });
    fs.copyFileSync(NATIVE as string, path.join(res, 'native-hooks', 'wmux-native'));
    fs.chmodSync(path.join(res, 'native-hooks', 'wmux-native'), 0o755);
    bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    for (const host of ['claude', 'codex', 'gemini', 'opencode']) fs.symlinkSync(process.execPath, path.join(bin, host));
    hostScript = path.join(root, 'host.cjs');
    fs.writeFileSync(hostScript, HOST_SOURCE);
    peerWorld = await makeWorld('peer', true);
    blindWorld = await makeWorld('blind', false);
    expect(peerWorld.log()).toContain('peer-pid: available');
    expect(blindWorld.log()).toContain('every session is refused');
  }, 120_000);

  afterAll(() => {
    for (const c of owned) { try { c.kill(); } catch { /* gone */ } }
    peerWorld?.main.close();
    blindWorld?.main.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    for (const w of [peerWorld, blindWorld]) if (w) fs.rmSync(w.home, { recursive: true, force: true });
  });

  type Chain = 'bundle' | 'shim' | 'fallback';
  interface Case { host: string; clientName: string; env?: Record<string, string>; args?: string[]; protectedPane?: boolean }
  interface Outcome { tools: string[]; whoami: string; replRefused: boolean; callerParentIsHost: boolean; mcpPid: number; callerPid: unknown; calls: Recorded[]; stderr: string }

  /** Run one host through one chain; the host's own pid is planted as pane pty-host in ws-host. */
  async function run(chain: Chain, c: Case, forge?: { ppid: number }): Promise<Outcome> {
    const world = chain === 'fallback' ? blindWorld : peerWorld;
    world.main.calls.length = 0;
    world.main.panes.clear();
    world.main.protectedPane = c.protectedPane === true;
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: world.home, WMUX_DATA_SUFFIX: world.suffix, NODE_PATH: path.join(REPO_ROOT, 'node_modules'), ...(c.env ?? {}) };
    const spec = forge
      ? { clientName: c.clientName, cmd: process.execPath, env,
        args: [hostScript, JSON.stringify({ forgeShim: { pipe: path.join(world.home, `.wmux-mcpb${world.suffix}.sock`), token: TOKEN, ppid: forge.ppid } })] }
      : chain === 'bundle'
        ? { clientName: c.clientName, cmd: process.execPath, args: [path.join(res, 'mcp-bundle', 'index.js'), ...(c.args ?? [])], env }
        : { clientName: c.clientName, cmd: path.join(res, 'native-hooks', 'wmux-native'), args: ['mcp-shim', ...(c.args ?? [])], env };
    const host = spawn(path.join(bin, c.host), [hostScript, JSON.stringify(spec)], { stdio: ['pipe', 'pipe', 'pipe'] });
    owned.push(host);
    let stderr = '';
    host.stderr?.on('data', (d) => { stderr += d; });
    const outLines: string[] = [];
    let wake: () => void = () => undefined;
    let buf = '';
    host.stdout?.on('data', (d) => { buf += d; let n; while ((n = buf.indexOf('\n')) >= 0) { outLines.push(buf.slice(0, n)); buf = buf.slice(n + 1); wake(); } });
    const line = async (i: number): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 30_000;
      while (outLines.length <= i) {
        if (Date.now() > deadline || host.exitCode !== null) throw new Error(`host ${c.host}/${chain} gave no line ${i}; stderr: ${stderr.slice(-800)}`);
        await new Promise<void>((r) => { wake = r; setTimeout(r, 200); });
      }
      return JSON.parse(outLines[i]) as Record<string, unknown>;
    };
    const ready = await line(0);
    world.main.panes.set(host.pid as number, { ws: 'ws-host', pty: 'pty-host' });
    host.stdin?.write('go\n');
    const done = await line(1);
    const resolveCall = world.main.calls.find((x) => x.method === 'a2a.resolve.identity');
    const callerPid = resolveCall?.params.callerPid;
    let callerParentIsHost = false;
    if (typeof callerPid === 'number') {
      try { callerParentIsHost = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(callerPid)]).toString().trim()) === host.pid; } catch { /* gone */ }
    }
    host.stdin?.write('done\n');
    await new Promise((r) => { if (host.exitCode !== null) r(null); else host.once('exit', r); });
    return {
      tools: done.tools as string[], whoami: String(done.whoami), replRefused: Boolean(done.replRefused),
      callerParentIsHost, mcpPid: Number(ready.mcpPid), callerPid, calls: [...world.main.calls], stderr,
    };
  }

  /** What every chain must agree on. */
  const agreed = (o: Outcome) => ({
    tools: o.tools,
    pane: JSON.parse(o.whoami) as unknown,
    replRefused: o.replRefused,
    callerParentIsHost: o.callerParentIsHost,
    hintedPtyId: o.calls.find((x) => x.method === 'a2a.resolve.identity')?.params.hintedPtyId ?? null,
    commanderTokens: [...new Set(o.calls.map((x) => x.commanderToken ?? null))],
  });

  const CASES: Array<[string, Case]> = [
    ['Claude with pane hints', { host: 'claude', clientName: 'claude-code', env: { WMUX_PTY_ID: 'pty-host', WMUX_WORKSPACE_ID: 'ws-host' } }],
    ['Codex, env stripped', { host: 'codex', clientName: 'codex-mcp-client' }],
    ['Gemini', { host: 'gemini', clientName: 'gemini-cli-mcp-client' }],
    ['OpenCode', { host: 'opencode', clientName: 'opencode' }],
    ['a remote pane hint', { host: 'claude', clientName: 'claude-code', env: { WMUX_PTY_ID: 'remote-peer-pty' } }],
    ['commander mode', { host: 'claude', clientName: 'claude-code', env: { WMUX_COMMANDER_TOKEN: 'commander-token' }, args: ['--commander'] }],
    ['a protected browser pane', { host: 'claude', clientName: 'claude-code', protectedPane: true }],
  ];

  it.each(CASES)('%s: every chain names the host\'s pane and agrees', async (_name, c) => {
    const bundle = await run('bundle', c);
    const shim = await run('shim', c);
    const fallback = await run('fallback', c);
    expect(JSON.parse(bundle.whoami)).toMatchObject({ workspaceId: 'ws-host', senderPtyId: 'pty-host' });
    expect(bundle.callerParentIsHost).toBe(true);
    // The broker hosted the shim's session, with the shim's own pid.
    expect(shim.callerPid).toBe(shim.mcpPid);
    expect(shim.stderr).not.toContain('[wmux-mcp-shim]');
    // The refusal handed the session to the full bundle, under the shim's pid.
    expect(fallback.stderr).toContain('[wmux-mcp-shim] broker refused the session: peer-unverified');
    expect(fallback.callerPid).toBe(fallback.mcpPid);
    expect(agreed(shim)).toEqual(agreed(bundle));
    expect(agreed(fallback)).toEqual(agreed(bundle));
  }, 120_000);

  it('a client that names a false parent to the broker is still walked from its own', async () => {
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    owned.push(decoy);
    peerWorld.main.panes.clear();
    const c: Case = { host: 'claude', clientName: 'claude-code' };
    // Plant the decoy as another pane before the walk; the host plants itself.
    const run1 = run('shim', c, { ppid: decoy.pid as number });
    peerWorld.main.panes.set(decoy.pid as number, { ws: 'ws-decoy', pty: 'pty-decoy' });
    const o = await run1;
    expect(JSON.parse(o.whoami)).toMatchObject({ workspaceId: 'ws-host', senderPtyId: 'pty-host' });
    expect(peerWorld.log()).toContain(`callerPpid ${decoy.pid} differs from the OS parent`);
    decoy.kill();
  }, 60_000);
});
