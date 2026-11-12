// `wmux daemon headless on | off | status` on a sandbox data dir: `on` only
// for a person at a terminal outside wmux, on a host the app never used, and
// after a typed yes; `off` and `status` without a question; `status` says why
// headless mode is not in effect and lists the worktrees ended starts left.
// The environment the test runs in (maybe a wmux pane) is replaced per case.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { headlessIo, headlessStatus, runHeadless } from '../../cli/commands/daemon';
import { policyIo } from '../../cli/commands/remote';
import { headlessFlagPath, headlessReleasePath } from '../a2aRemote/headlessMode';
import { HEADLESS_STARTS_FILE } from '../a2aRemote/headlessStartStore';
import { APP_ATTACHED_FILE } from '../appHostMarker';

let dir: string;
let savedEnv: NodeJS.ProcessEnv;
let out: string[];
const flag = (): string => headlessFlagPath(path.join(dir, 'a2a'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-cli-'));
  savedEnv = process.env;
  // A terminal outside wmux: no pane id, no agent nesting marker.
  process.env = { PATH: savedEnv.PATH, HOME: dir };
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.spyOn(policyIo, 'stdinIsTty').mockReturnValue(true);
  // No daemon answers unless a case says so (never the real one of whoever runs the tests).
  vi.spyOn(headlessIo, 'daemonView').mockResolvedValue(null);
});
afterEach(() => {
  process.env = savedEnv;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('wmux daemon headless', () => {
  it('on: states what it turns on, and writes the flag only after a typed yes', async () => {
    const ask = vi.spyOn(policyIo, 'ask').mockResolvedValue('no');
    await expect(runHeadless('on', false, dir)).rejects.toThrow('exit 1');
    expect(fs.existsSync(flag())).toBe(false);
    expect(out.join('\n')).toContain('with no person approving each start');
    ask.mockResolvedValue('yes');
    await runHeadless('on', false, dir);
    expect(fs.existsSync(flag())).toBe(true);
    expect(headlessStatus(dir)).toMatchObject({ inEffect: true, optedIn: true, appAttached: false });
  });

  for (const [name, env] of [
    ['a wmux pane', { WMUX_PTY_ID: 'pane-1' }],
    ['an agent session', { CLAUDECODE: '1' }],
  ] as const) {
    it(`on: refused from ${name}`, async () => {
      process.env = { ...process.env, ...env };
      const ask = vi.spyOn(policyIo, 'ask').mockResolvedValue('yes');
      await expect(runHeadless('on', false, dir)).rejects.toThrow('exit 1');
      expect(ask).not.toHaveBeenCalled();
      expect(fs.existsSync(flag())).toBe(false);
    });
  }

  it('on: refused where the desktop app has used this install', async () => {
    fs.writeFileSync(path.join(dir, APP_ATTACHED_FILE), 'x\n');
    vi.spyOn(policyIo, 'ask').mockResolvedValue('yes');
    await expect(runHeadless('on', false, dir)).rejects.toThrow('exit 1');
    expect(fs.existsSync(flag())).toBe(false);
  });

  it('on: refused without a terminal', async () => {
    vi.spyOn(policyIo, 'stdinIsTty').mockReturnValue(false);
    await expect(runHeadless('on', false, dir)).rejects.toThrow('exit 1');
    expect(fs.existsSync(flag())).toBe(false);
  });

  it('off: removes the flag without a question', async () => {
    fs.mkdirSync(path.join(dir, 'a2a'));
    fs.writeFileSync(flag(), 'on\n');
    const ask = vi.spyOn(policyIo, 'ask');
    await runHeadless('off', false, dir);
    expect(ask).not.toHaveBeenCalled();
    expect(fs.existsSync(flag())).toBe(false);
  });

  it('status: why it is not in effect, what runs, and the worktrees ended starts left', async () => {
    expect(headlessStatus(dir)).toMatchObject({ inEffect: false, reason: 'not turned on (wmux daemon headless on)', running: 0, leftovers: [] });
    fs.mkdirSync(path.join(dir, 'a2a'));
    fs.writeFileSync(flag(), 'on\n');
    const kept = path.join(dir, 'wt', 'remote-2');
    fs.mkdirSync(kept, { recursive: true });
    const base = {
      v: 1, hostId: '11111111-1111-4111-8111-111111111111', agent: 'claude', repoPath: '/repo', workspaceId: 'hl-w',
      agentSessionId: '33333333-3333-4333-8333-333333333333', lineage: 'remote-spawn:x', runId: 'r', startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'a2a', HEADLESS_STARTS_FILE), JSON.stringify({
      v: 1,
      starts: [
        { ...base, spawnId: 'sp-0123abcd-4567-89ab-cdef-0123456789ab', sessionId: 'hl-1', phase: 'started', worktreePath: '/wt/remote-1' },
        { ...base, spawnId: 'sp-1123abcd-4567-89ab-cdef-0123456789ab', sessionId: 'hl-2', phase: 'ended', worktreePath: kept, endedAt: new Date().toISOString() },
        // Removed by the owner already: not listed.
        { ...base, spawnId: 'sp-2123abcd-4567-89ab-cdef-0123456789ab', sessionId: 'hl-3', phase: 'ended', worktreePath: path.join(dir, 'gone'), endedAt: new Date().toISOString() },
      ],
    }));
    expect(headlessStatus(dir)).toEqual({ inEffect: true, optedIn: true, appAttached: false, running: 1, leftovers: [kept], heldUp: [], from: 'files',
      perPc: { '11111111-1111-4111-8111-111111111111': { running: 1, kept: 1 } } });
    fs.writeFileSync(path.join(dir, APP_ATTACHED_FILE), 'x\n');
    expect(headlessStatus(dir)).toMatchObject({ inEffect: false, reason: expect.stringContaining('desktop app') });
    await runHeadless('status', false, dir);
    expect(out.join('\n')).toContain(kept);
  });

  it('status and on follow the running daemon: an app it knows of (launcher marker, attach it could not record) counts', async () => {
    fs.mkdirSync(path.join(dir, 'a2a'));
    fs.writeFileSync(flag(), 'on\n');
    const view = { appAttached: true, optedIn: true, inEffect: false };
    expect(headlessStatus(dir, view)).toMatchObject({ inEffect: false, appAttached: true, from: 'daemon', reason: expect.stringContaining('desktop app') });
    fs.unlinkSync(flag());
    vi.spyOn(headlessIo, 'daemonView').mockResolvedValue(view);
    const ask = vi.spyOn(policyIo, 'ask').mockResolvedValue('yes');
    await expect(runHeadless('on', false, dir)).rejects.toThrow('exit 1');
    expect(ask).not.toHaveBeenCalled();
    expect(fs.existsSync(flag())).toBe(false);
  });

  it('on: the app attaching while the question waits leaves the flag unwritten', async () => {
    const free = { appAttached: false, optedIn: false, inEffect: false };
    vi.spyOn(headlessIo, 'daemonView').mockResolvedValueOnce(free).mockResolvedValue({ ...free, appAttached: true });
    vi.spyOn(policyIo, 'ask').mockResolvedValue('yes');
    await expect(runHeadless('on', false, dir)).rejects.toThrow('exit 1');
    expect(fs.existsSync(flag())).toBe(false);
  });

  it('status lists the starts still waiting for their agent processes to exit', () => {
    fs.mkdirSync(path.join(dir, 'a2a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a2a', HEADLESS_STARTS_FILE), JSON.stringify({
      v: 1,
      starts: [{
        v: 1, hostId: '11111111-1111-4111-8111-111111111111', spawnId: 'sp-0123abcd-4567-89ab-cdef-0123456789ab', agent: 'claude',
        repoPath: '/repo', sessionId: 'hl-1', workspaceId: 'hl-w', agentSessionId: '33333333-3333-4333-8333-333333333333',
        lineage: 'remote-spawn:x', runId: 'r', phase: 'started', worktreePath: '/wt/remote-1', startedAt: new Date().toISOString(),
        survivors: [{ pid: 4242, reason: 'still running' }],
      }],
    }));
    expect(headlessStatus(dir)).toMatchObject({ heldUp: ['sp-0123abcd-4567-89ab-cdef-0123456789ab: /wt/remote-1 (pid 4242)'], leftovers: [], running: 0 });
  });

  it('status takes the daemon\'s own answer: opted in but the starter not built (no task ledger) is not in effect, with the reason', async () => {
    fs.mkdirSync(path.join(dir, 'a2a'));
    fs.writeFileSync(flag(), 'on\n');
    const view = { appAttached: false, optedIn: true, inEffect: false };
    expect(headlessStatus(dir, view)).toMatchObject({ inEffect: false, optedIn: true, from: 'daemon', reason: expect.stringContaining('task ledger') });
    vi.spyOn(headlessIo, 'daemonView').mockResolvedValue(view);
    await runHeadless('status', false, dir);
    expect(out.join('\n')).toContain('not in effect');
    expect(headlessStatus(dir, { ...view, inEffect: true })).toMatchObject({ inEffect: true });
  });

  it('release: drops the hold on a listed start after a typed yes (person only), and nothing else', async () => {
    const ID = 'sp-0123abcd-4567-89ab-cdef-0123456789ab';
    fs.mkdirSync(path.join(dir, 'a2a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a2a', HEADLESS_STARTS_FILE), JSON.stringify({
      v: 1,
      starts: [{
        v: 1, hostId: '11111111-1111-4111-8111-111111111111', spawnId: ID, agent: 'claude',
        repoPath: '/repo', sessionId: 'hl-1', workspaceId: 'hl-w', agentSessionId: '33333333-3333-4333-8333-333333333333',
        lineage: 'remote-spawn:x', runId: 'r', phase: 'started', worktreePath: '/wt/remote-1', startedAt: new Date().toISOString(),
        survivors: [{ pid: 4242, reason: 'still running' }],
      }],
    }));
    const marker = headlessReleasePath(path.join(dir, 'a2a'), ID);
    // Not from a pane.
    process.env = { ...process.env, WMUX_PTY_ID: 'pane-1' };
    await expect(runHeadless('release', false, dir, ID)).rejects.toThrow('exit 1');
    process.env = { PATH: savedEnv.PATH, HOME: dir };
    // Not for a start that is not held.
    await expect(runHeadless('release', false, dir, 'sp-9999abcd-4567-89ab-cdef-0123456789ab')).rejects.toThrow('exit 1');
    const ask = vi.spyOn(policyIo, 'ask').mockResolvedValue('no');
    await expect(runHeadless('release', false, dir, ID)).rejects.toThrow('exit 1');
    expect(fs.existsSync(marker)).toBe(false);
    ask.mockResolvedValue('yes');
    await runHeadless('release', false, dir, ID);
    expect(fs.existsSync(marker)).toBe(true);
  });
});
