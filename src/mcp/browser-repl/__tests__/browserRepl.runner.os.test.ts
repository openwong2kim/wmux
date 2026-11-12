// The browser_repl runtime runs in a process of its own (runnerProcess.ts):
// what a snippet reaches is that process, its connections carry that
// process's pid, it gets no wmux variable, and it ends, with everything it
// started, on a timeout, on dispose, and when its parent dies.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { buildSync } from 'esbuild';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserReplSession } from '../BrowserReplSession';
import { BROWSER_REPL_TOOLS, type BridgeCall } from '../bridge';
import { setBrowserReplRunnerCapForTest, type RunnerProcess } from '../runnerProcess';
import { peerPidOf } from '../../../shared/peerPid';

const bridge: BridgeCall = async () => ({ ok: false, error: 'no browser in this test', ledger: 'refused' });
const sessions: BrowserReplSession[] = [];

function newSession(): BrowserReplSession {
  const s = new BrowserReplSession(BROWSER_REPL_TOOLS);
  sessions.push(s);
  return s;
}

function runnerPid(session: BrowserReplSession): number | undefined {
  return (session as unknown as { worker: RunnerProcess | null }).worker?.pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

/** A snippet that starts a long-lived grandchild and returns its pid. */
const START_GRANDCHILD = [
  "const cp = process.getBuiltinModule('child_process');",
  "globalThis.grandchild = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  'grandchild.pid',
].join('\n');

afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  setBrowserReplRunnerCapForTest(null);
});

describe('browser_repl runner process', () => {
  it('starts no runner until the first run', async () => {
    const session = newSession();
    expect(runnerPid(session)).toBeUndefined();
    const out = await session.run('process.pid', 10_000, bridge);
    expect(out.ok).toBe(true);
    expect(Number(out.result?.text)).toBe(runnerPid(session));
    expect(Number(out.result?.text)).not.toBe(process.pid);
  });

  it("lets the inspector's main thread route reach the runner only, never this process", async () => {
    const session = newSession();
    const out = await session.run(
      [
        "const inspector = process.getBuiltinModule('inspector');",
        'const s = new inspector.Session();',
        's.connectToMainThread();',
        "await new Promise((res, rej) => s.post('Runtime.evaluate', { expression: 'process.pid' }, (e, v) => (e ? rej(e) : res(v.result.value))))",
      ].join('\n'),
      10_000,
      bridge,
    );
    expect(out.ok).toBe(true);
    expect(Number(out.result?.text)).toBe(runnerPid(session));
    expect(Number(out.result?.text)).not.toBe(process.pid);
  });

  it.skipIf(process.platform === 'win32')('connects as its own pid: a server reads the runner, not this process, as the peer', async () => {
    const sock = path.join('/tmp', `brr-${process.pid}-${Date.now()}.sock`);
    const peers: Array<number | null> = [];
    const server = net.createServer((socket) => {
      peers.push(peerPidOf(socket).pid);
      socket.end();
    });
    await new Promise<void>((resolve) => server.listen(sock, () => resolve()));
    try {
      const session = newSession();
      const out = await session.run(
        [
          "const net = process.getBuiltinModule('net');",
          `await new Promise((res, rej) => { const c = net.connect(${JSON.stringify(sock)}, () => res(1)); c.on('error', rej); c.on('data', () => {}); })`,
        ].join('\n'),
        10_000,
        bridge,
      );
      expect(out.ok).toBe(true);
      expect(peers).toHaveLength(1);
      expect(peers[0]).toBe(runnerPid(session));
      expect(peers[0]).not.toBe(process.pid);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(sock, { force: true });
    }
  });

  it('gets no wmux variable, the auth token and pipe name included', async () => {
    const saved = { ...process.env };
    process.env.WMUX_AUTH_TOKEN = 'secret-token';
    process.env.WMUX_PIPE_NAME = '/tmp/some.sock';
    process.env.WMUX_PTY_ID = 'daemon-x';
    try {
      const session = newSession();
      const out = await session.run("Object.keys(process.env).filter((k) => /^wmux_/i.test(k)).join(',') || 'none'", 10_000, bridge);
      expect(out.result?.text).toBe('none');
    } finally {
      for (const key of ['WMUX_AUTH_TOKEN', 'WMUX_PIPE_NAME', 'WMUX_PTY_ID']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it('a timeout kills the runner and every process it started', async () => {
    const session = newSession();
    const first = await session.run(START_GRANDCHILD, 10_000, bridge);
    const grandchild = Number(first.result?.text);
    const runner = runnerPid(session) as number;
    expect(alive(grandchild)).toBe(true);
    const out = await session.run('while (true) {}', 500, bridge);
    expect(out.timedOut).toBe(true);
    expect(await goneWithin(runner, 5000)).toBe(true);
    expect(await goneWithin(grandchild, 5000)).toBe(true);
  });

  it('a runtime that ends on its own takes what it started with it', async () => {
    const session = newSession();
    const first = await session.run(START_GRANDCHILD, 10_000, bridge);
    const grandchild = Number(first.result?.text);
    const out = await session.run('process.exit(4)', 10_000, bridge);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('code 4');
    expect(await goneWithin(grandchild, 5000)).toBe(true);
  });

  it('a runner that cannot start frees its slot', async () => {
    setBrowserReplRunnerCapForTest(1);
    const back = process.cwd();
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'brr-gone-'));
    process.chdir(gone);
    // Read once, so the deleted directory is still what process.cwd() answers.
    expect(process.cwd()).toBe(fs.realpathSync(gone));
    fs.rmSync(gone, { recursive: true, force: true });
    try {
      const failed = await newSession().run('1', 10_000, bridge);
      expect(failed.ok).toBe(false);
      expect(failed.error).not.toContain('already running');
    } finally {
      process.chdir(back);
    }
    const again = await newSession().run('1', 10_000, bridge);
    expect(again.error).toBeUndefined();
    expect(again.ok).toBe(true);
  });

  it('dispose ends the runner', async () => {
    const session = newSession();
    await session.run('1', 10_000, bridge);
    const runner = runnerPid(session) as number;
    session.dispose();
    expect(await goneWithin(runner, 5000)).toBe(true);
  });

  it('refuses a runner past the cap, readably, and starts one once another ends', async () => {
    setBrowserReplRunnerCapForTest(1);
    const a = newSession();
    expect((await a.run('1', 10_000, bridge)).ok).toBe(true);
    const b = newSession();
    const refused = await b.run('1', 10_000, bridge);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('already running 1 browser_repl runtimes');
    const runner = runnerPid(a) as number;
    a.dispose();
    expect(await goneWithin(runner, 5000)).toBe(true);
    // The exit is counted once the parent sees it.
    await vi.waitFor(async () => expect((await b.run('1', 10_000, bridge)).ok).toBe(true), { timeout: 10_000 });
  });

  it('leaves nothing behind when its parent is killed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brr-host-'));
    try {
      const entry = path.join(dir, 'host.ts');
      fs.writeFileSync(
        entry,
        [
          `import { BrowserReplSession } from ${JSON.stringify(path.resolve(__dirname, '..', 'BrowserReplSession'))};`,
          `import { BROWSER_REPL_TOOLS } from ${JSON.stringify(path.resolve(__dirname, '..', 'bridge'))};`,
          'const session = new BrowserReplSession(BROWSER_REPL_TOOLS);',
          `void session.run(${JSON.stringify(START_GRANDCHILD)}, 10000, async () => ({ ok: false, error: 'none', ledger: 'x' })).then((out) => {`,
          '  const runner = (session as unknown as { worker: { pid: number } }).worker.pid;',
          '  process.stdout.write(JSON.stringify({ runner, grandchild: Number(out.result?.text) }) + "\\n");',
          '});',
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      );
      const bundle = path.join(dir, 'host.cjs');
      buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['electron', 'koffi'], logLevel: 'error' });
      const host = spawn(process.execPath, [bundle], { stdio: ['ignore', 'pipe', 'inherit'] });
      const line = await new Promise<string>((resolve, reject) => {
        let buf = '';
        host.stdout.on('data', (d: Buffer) => {
          buf += d.toString();
          const nl = buf.indexOf('\n');
          if (nl >= 0) resolve(buf.slice(0, nl));
        });
        host.once('exit', () => reject(new Error('the host exited before it reported')));
      });
      const { runner, grandchild } = JSON.parse(line) as { runner: number; grandchild: number };
      expect(alive(runner) && alive(grandchild)).toBe(true);
      host.kill('SIGKILL');
      expect(await goneWithin(runner, 10_000)).toBe(true);
      expect(await goneWithin(grandchild, 10_000)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
