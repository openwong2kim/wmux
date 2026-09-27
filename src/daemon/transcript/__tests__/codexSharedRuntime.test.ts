import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexSharedRuntime, parseDaemonReport, type CodexSharedRuntimeDeps } from '../codexSharedRuntime';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function fixture(opts: { running: boolean; versionFails?: boolean; startStatus?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-rt-')); dirs.push(dir);
  const server = { running: opts.running, socket: opts.running ? 'sock:outside' : undefined as string | undefined, n: 0 };
  const calls: Array<{ sub: string; env: NodeJS.ProcessEnv }> = [];
  const deps: CodexSharedRuntimeDeps = {
    runDaemon: vi.fn(async (sub, env) => {
      calls.push({ sub, env });
      if (sub === 'version') {
        if (opts.versionFails) throw new Error('failed to connect');
        return JSON.stringify({ status: server.running ? 'running' : 'stopped', socketPath: '/s.sock' });
      }
      if (server.running) return JSON.stringify({ status: 'alreadyRunning', socketPath: '/s.sock' });
      server.running = true; server.socket = `sock:${++server.n}`;
      return `Installing daemon...\n${JSON.stringify({ status: opts.startStatus ?? 'started', socketPath: '/s.sock' })}`;
    }),
    stateDir: dir,
    socketIdentity: () => server.socket,
    notice: vi.fn(),
    log: vi.fn(),
  };
  return { rt: createCodexSharedRuntime(deps), deps, server, calls, dir };
}

const ENV = { HOME: '/home/u', CODEX_HOME: '/home/u/.codex', WMUX_PTY_ID: 'pty-a', WMUX_DATA_SUFFIX: '-demo', PATH: '/bin' };

describe('codex shared runtime', () => {
  it('starts a stopped server with no WMUX_* key and proves it clean', async () => {
    const f = fixture({ running: false });
    expect(await f.rt.ensureStarted('pane', ENV)).toEqual({ kind: 'clean' });
    expect(f.calls.map((c) => c.sub)).toEqual(['version', 'start']);
    for (const c of f.calls) expect(Object.keys(c.env).filter((k) => k.startsWith('WMUX_'))).toEqual([]);
    expect(f.deps.notice).not.toHaveBeenCalled();
  });

  it('never stops a running server; one it did not start is unproven, with one notice', async () => {
    const f = fixture({ running: true });
    expect(await f.rt.ensureStarted('pane', ENV)).toEqual({ kind: 'unproven' });
    expect(await f.rt.ensureStarted('pane', ENV)).toEqual({ kind: 'unproven' });
    expect(f.calls.map((c) => c.sub)).toEqual(['version', 'version']);
    expect(f.deps.notice).toHaveBeenCalledTimes(1);
    expect(f.rt.state('/home/u/.codex')).toEqual({ kind: 'unproven' });
  });

  it('stays clean across calls and instances, and turns unproven once something else restarts it', async () => {
    const f = fixture({ running: false });
    await f.rt.ensureStarted('pane', ENV);
    // A second wmux instance shares the record.
    const other = createCodexSharedRuntime({ ...f.deps, notice: vi.fn() });
    expect(await other.ensureStarted('pane', ENV)).toEqual({ kind: 'clean' });
    f.server.socket = 'sock:restarted-outside';
    expect(await f.rt.ensureStarted('pane', ENV)).toEqual({ kind: 'unproven' });
  });

  it('a start that did not create the server (lost a race) is unproven', async () => {
    const f = fixture({ running: false, startStatus: 'alreadyRunning' });
    expect(await f.rt.ensureStarted('pane', ENV)).toEqual({ kind: 'unproven' });
  });

  it('a failed version query still starts (first run on an account)', async () => {
    const f = fixture({ running: false, versionFails: true });
    expect(await f.rt.ensureStarted('pane', ENV)).toEqual({ kind: 'clean' });
  });

  it('returns failed, not throw, when start fails, and logs a record-write failure', async () => {
    const f = fixture({ running: false });
    f.deps.runDaemon = vi.fn(async (sub) => { if (sub === 'start') throw new Error('codex missing'); return '{}'; });
    const rt = createCodexSharedRuntime(f.deps);
    expect(await rt.ensureStarted('pane', ENV)).toEqual({ kind: 'failed', reason: 'codex missing' });

    const g = fixture({ running: false });
    const blocked = path.join(g.dir, 'not-a-dir');
    fs.writeFileSync(blocked, '');
    const rt2 = createCodexSharedRuntime({ ...g.deps, stateDir: blocked });
    expect((await rt2.ensureStarted('pane', ENV)).kind).toBe('failed');
  });

  it('serializes starts across instances with a lock, and takes over a stale lock', async () => {
    const f = fixture({ running: false });
    const a = createCodexSharedRuntime(f.deps);
    const b = createCodexSharedRuntime({ ...f.deps, notice: vi.fn() });
    const [x, y] = await Promise.all([a.ensureStarted('p1', ENV), b.ensureStarted('p2', ENV)]);
    expect([x.kind, y.kind].sort()).toEqual(['clean', 'clean']);
    expect(f.calls.filter((c) => c.sub === 'start')).toHaveLength(1);
    // A stale lock left by a crashed instance does not block forever.
    const lock = fs.readdirSync(f.dir).find((n) => n.endsWith('.json'))!.replace(/\.json$/, '.lock');
    fs.writeFileSync(path.join(f.dir, lock), '1');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(path.join(f.dir, lock), old, old);
    expect((await a.ensureStarted('p1', ENV)).kind).toBe('clean');
  });

  it('parses the report from the last JSON line', () => {
    expect(parseDaemonReport('Installing...\n{"status":"started","socketPath":"/s"}\n')).toEqual({ status: 'started', socketPath: '/s' });
    expect(parseDaemonReport('garbage')).toEqual({});
  });
});
