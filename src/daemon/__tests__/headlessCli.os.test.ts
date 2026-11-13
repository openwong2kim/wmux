// `wmux daemon headless on | off | status` on a sandbox data dir: `on` only
// for a person at a terminal outside wmux, on a host the app never used, and
// after a typed yes; `off` and `status` without a question; `status` says why
// headless mode is not in effect and lists the worktrees ended starts left.
// The environment the test runs in (maybe a wmux pane) is replaced per case.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEADLESS_STAYS_UP, headlessIo, headlessStatus, runHeadless } from '../../cli/commands/daemon';
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
    expect(out).not.toContain(HEADLESS_STAYS_UP);
    ask.mockResolvedValue('yes');
    await runHeadless('on', false, dir);
    expect(fs.existsSync(flag())).toBe(true);
    // Turned on: it says the daemon now stays up, and how it comes back after a reboot.
    expect(out).toContain(HEADLESS_STAYS_UP);
    // Run again on a box already on (one turned on before this line existed): said too.
    out.length = 0;
    await runHeadless('on', false, dir);
    // No daemon answers here: how to start one is said too.
    expect(out).toEqual(['Headless mode is on already.', HEADLESS_STAYS_UP, 'No daemon answered: start it with `wmux daemon start` (or check `wmux daemon status` if one should be running).']);
    out.length = 0;
    vi.spyOn(headlessIo, 'daemonView').mockResolvedValue({ appAttached: false, optedIn: true, inEffect: true });
    await runHeadless('on', false, dir);
    expect(out).toEqual(['Headless mode is on already.', HEADLESS_STAYS_UP]);
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
        { ...base, spawnId: 'sp-0123abcd-4567-89ab-cdef-0123456789ab', sessionId: 'hl-00000001-0000-4000-8000-000000000000', phase: 'started', worktreePath: '/wt/remote-1' },
        { ...base, spawnId: 'sp-1123abcd-4567-89ab-cdef-0123456789ab', sessionId: 'hl-00000002-0000-4000-8000-000000000000', phase: 'ended', worktreePath: kept, endedAt: new Date().toISOString() },
        // Removed by the owner already: not listed.
        { ...base, spawnId: 'sp-2123abcd-4567-89ab-cdef-0123456789ab', sessionId: 'hl-00000003-0000-4000-8000-000000000000', phase: 'ended', worktreePath: path.join(dir, 'gone'), endedAt: new Date().toISOString() },
      ],
    }));
    const running = { spawnId: 'sp-0123abcd-4567-89ab-cdef-0123456789ab', hostId: base.hostId, worktreePath: '/wt/remote-1', since: base.startedAt };
    expect(headlessStatus(dir)).toEqual({ inEffect: true, optedIn: true, appAttached: false, running: 1, runningStarts: [running], leftovers: [kept], heldUp: [], from: 'files',
      perPc: { '11111111-1111-4111-8111-111111111111': { running: 1, kept: 1 } } });
    // What runs is named in the text too: the start, its PC, since when and where.
    await runHeadless('status', false, dir);
    expect(out.join('\n')).toContain(`  ${running.spawnId} from ${running.hostId}, since ${running.since}, in /wt/remote-1`);
    // No daemon answered: nothing is known to be up, so it is not said to stay up.
    expect(out).not.toContain(HEADLESS_STAYS_UP);
    out.length = 0;
    vi.spyOn(headlessIo, 'daemonView').mockResolvedValueOnce({ appAttached: false, optedIn: true, inEffect: true });
    await runHeadless('status', false, dir);
    expect(out).toContain(HEADLESS_STAYS_UP);
    out.length = 0;
    const marker = path.join(dir, APP_ATTACHED_FILE);
    fs.writeFileSync(marker, 'x\n');
    const written = new Date('2026-11-01T08:00:00.000Z');
    fs.utimesSync(marker, written, written);
    // A marker left from an earlier run is the reason: named, with when it was written and how to clear it.
    expect(headlessStatus(dir)).toMatchObject({ inEffect: false, reason: expect.stringContaining(`recorded in ${marker} at ${written.toISOString()}`) });
    await runHeadless('status', false, dir);
    const line = out.find((l) => l.startsWith('Headless mode: not in effect:'));
    expect(line).toContain('delete that file and restart the daemon');
    expect(line).not.toContain('\n');
    expect(out.join('\n')).toContain(kept);
    // Not in effect: the daemon exits when idle as before, so the line is not said.
    expect(out).not.toContain(HEADLESS_STAYS_UP);
  });

  it('a start file set aside as corrupt is said, with the remote-start worktrees no record names', async () => {
    const a2a = path.join(dir, 'a2a');
    fs.mkdirSync(a2a, { recursive: true });
    const lost = path.join(dir, 'worktrees', 'remote-sp-0123abcd-4567-89ab-cdef-0123456789ab');
    fs.mkdirSync(lost, { recursive: true });
    fs.mkdirSync(path.join(dir, 'worktrees', 'task-other'), { recursive: true });
    expect(headlessStatus(dir).setAside).toBeUndefined();
    fs.writeFileSync(path.join(a2a, `${HEADLESS_STARTS_FILE}.corrupt-1794516000000`), '{broken');
    // Listed by their resolved path (Windows temp dirs come as 8.3 short names).
    const lostReal = fs.realpathSync.native(lost);
    expect(headlessStatus(dir).setAside).toEqual({ files: [`${HEADLESS_STARTS_FILE}.corrupt-1794516000000`], unrecordedWorktrees: [lostReal] });
    await runHeadless('status', false, dir);
    const text = out.join('\n');
    expect(text).toContain('set aside');
    expect(text).toContain(`  ${lostReal}`);
    expect(text).not.toContain('task-other');
    expect(text).toContain('git worktree list');
    // A worktree a record names, reached through a symlinked data dir, is not listed as unrecorded.
    const linked = `${dir}-link`;
    // A junction on Windows (no privilege needed); the type is ignored elsewhere.
    fs.symlinkSync(dir, linked, 'junction');
    try {
      fs.writeFileSync(path.join(a2a, HEADLESS_STARTS_FILE), JSON.stringify({ v: 1, starts: [{
        v: 1, hostId: '11111111-1111-4111-8111-111111111111', spawnId: 'sp-0123abcd-4567-89ab-cdef-0123456789ab', agent: 'claude', repoPath: '/repo',
        sessionId: 'hl-00000001-0000-4000-8000-000000000000', workspaceId: 'hl-w', agentSessionId: '33333333-3333-4333-8333-333333333333',
        lineage: 'remote-spawn:x', runId: 'r', phase: 'ended', worktreePath: lostReal, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      }] }));
      expect(headlessStatus(linked).setAside?.unrecordedWorktrees).toEqual([]);
    } finally {
      fs.unlinkSync(linked);
    }
  });

  it('status and on follow the running daemon: an app it knows of (launcher marker, attach it could not record) counts', async () => {
    fs.mkdirSync(path.join(dir, 'a2a'));
    fs.writeFileSync(flag(), 'on\n');
    const view = { appAttached: true, optedIn: true, inEffect: false };
    // No marker on disk: the daemon knows of the app in this run, which a restart without it clears.
    expect(headlessStatus(dir, view)).toMatchObject({ inEffect: false, appAttached: true, from: 'daemon', reason: expect.stringMatching(/attached to the running daemon.*Restart the daemon without the app/) });
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
        repoPath: '/repo', sessionId: 'hl-00000001-0000-4000-8000-000000000000', workspaceId: 'hl-w', agentSessionId: '33333333-3333-4333-8333-333333333333',
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
    // The daemon does not hold itself up then (no starter built), so the line is not said.
    expect(out).not.toContain(HEADLESS_STAYS_UP);
    expect(headlessStatus(dir, { ...view, inEffect: true })).toMatchObject({ inEffect: true });
  });

  it('release: drops the hold on a listed start after a typed yes (person only), and nothing else', async () => {
    const ID = 'sp-0123abcd-4567-89ab-cdef-0123456789ab';
    fs.mkdirSync(path.join(dir, 'a2a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a2a', HEADLESS_STARTS_FILE), JSON.stringify({
      v: 1,
      starts: [{
        v: 1, hostId: '11111111-1111-4111-8111-111111111111', spawnId: ID, agent: 'claude',
        repoPath: '/repo', sessionId: 'hl-00000001-0000-4000-8000-000000000000', workspaceId: 'hl-w', agentSessionId: '33333333-3333-4333-8333-333333333333',
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
