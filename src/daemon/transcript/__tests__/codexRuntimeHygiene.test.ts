import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexRuntimeHygiene, parseDaemonVersion, type CodexRuntimeHygieneDeps } from '../codexRuntimeHygiene';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function fixture(opts: { running: boolean; live?: number; socketId?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-hyg-')); dirs.push(dir);
  const state = { running: opts.running, socketId: opts.socketId ?? 'ino:1', live: opts.live ?? 0 };
  const calls: Array<{ sub: string; env: NodeJS.ProcessEnv }> = [];
  const deps: CodexRuntimeHygieneDeps = {
    runDaemon: vi.fn(async (sub, env) => {
      calls.push({ sub, env });
      if (sub === 'version') return JSON.stringify({ status: state.running ? 'running' : 'stopped', socketPath: '/sock' });
      if (sub === 'stop') state.running = false;
      if (sub === 'start') { if (!state.running) state.socketId = `ino:${Math.random()}`; state.running = true; }
      return '';
    }),
    liveCodexPanes: () => state.live,
    recordPath: path.join(dir, 'codex-runtime-clean.json'),
    socketIdentity: () => (state.running ? state.socketId : undefined),
    notice: vi.fn(),
    log: vi.fn(),
  };
  return { hygiene: createCodexRuntimeHygiene(deps), deps, state, calls, subs: () => calls.map((c) => c.sub).filter((s) => s !== 'version') };
}

const ENV = { HOME: '/home/u', WMUX_PTY_ID: 'pty-a', WMUX_DATA_SUFFIX: '-demo' };

describe('codex runtime hygiene', () => {
  it('starts a stopped server clean, with no WMUX_* key', async () => {
    const f = fixture({ running: false });
    await f.hygiene.ensureClean('pane', ENV);
    expect(f.subs()).toEqual(['start']);
    for (const c of f.calls) expect(Object.keys(c.env).filter((k) => k.startsWith('WMUX_'))).toEqual([]);
  });

  it('restarts a server it did not start clean when no Codex pane is live, then leaves it alone', async () => {
    const f = fixture({ running: true });
    await f.hygiene.ensureClean('pane', ENV);
    expect(f.subs()).toEqual(['stop', 'start']);
    await f.hygiene.ensureClean('pane', ENV);
    expect(f.subs()).toEqual(['stop', 'start']);
    expect(f.deps.notice).not.toHaveBeenCalled();
  });

  it('never stops a server while a Codex pane is live: one notice, no restart', async () => {
    const f = fixture({ running: true, live: 2 });
    await f.hygiene.ensureClean('pane', ENV);
    await f.hygiene.ensureClean('pane', ENV);
    expect(f.subs()).toEqual([]);
    expect(f.deps.notice).toHaveBeenCalledTimes(1);
    expect(f.deps.notice).toHaveBeenCalledWith('pane', expect.any(String), expect.stringContaining('codex app-server daemon stop'));
  });

  it('treats a server restarted by something else as not clean again', async () => {
    const f = fixture({ running: false });
    await f.hygiene.ensureClean('pane', ENV);
    f.state.socketId = 'ino:someone-else';
    await f.hygiene.ensureClean('pane', ENV);
    expect(f.subs()).toEqual(['start', 'stop', 'start']);
  });

  it('never throws when the codex CLI fails', async () => {
    const f = fixture({ running: false });
    f.deps.runDaemon = vi.fn(async () => { throw new Error('no codex'); });
    const hygiene = createCodexRuntimeHygiene(f.deps);
    await expect(hygiene.ensureClean('pane', ENV)).resolves.toBeUndefined();
  });

  it('parses the daemon version report', () => {
    expect(parseDaemonVersion('{"status":"running","socketPath":"/s"}')).toEqual({ running: true, socketPath: '/s' });
    expect(parseDaemonVersion('garbage')).toEqual({ running: false });
  });
});
