// The pane port a headless remote start runs its agent in, driven for real: a
// real DaemonSessionManager and PTY, the real launcher lookup and
// process-table reads, and a stub `claude` (a script that records what it was
// given and sleeps) in ~/.local/bin of a sandbox HOME. The PATH agents run
// with is the sandbox's only (the login shell's would find a real `claude`).
// What index.ts hands the port (createSession/destroySession) is stood in for
// by the same manager calls its handlers make.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DaemonSessionManager } from '../../DaemonSessionManager';
import { captureProcessTree, matchesRecordedStart, recordedStartOf, treeKillRefusal } from '../../automation/verifiedTreeKill';
import { buildWebPaneEnv } from '../../web/webPaneEnv';
import { isCredentialEnvKey } from '../../../shared/envFilter';
import { toResumeCommand } from '../../../shared/agentResume';
import { waitFor } from '../../../test-utils/waitFor';
import { snapshotTree } from '../headlessProcs';
import { createHeadlessSessions, HEADLESS_REPLAY_LINE } from '../headlessSessions';
import type { HeadlessSessionPort } from '../headlessStarter';

const posix = process.platform !== 'win32' && fs.existsSync('/bin/sh');
const WAIT_MS = 20_000;
const TEST_MS = 60_000;
/** A credential-class name planted in the daemon's own environment. */
const PLANTED = 'ANTHROPIC_API_KEY';

function alive(pid: number): boolean {
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch {
    return false;
  }
}

describe.skipIf(!posix)('the headless pane port, for real', () => {
  const saved: Record<string, string | undefined> = {};
  const managers: DaemonSessionManager[] = [];
  const pids: number[] = [];
  let root: string;
  let home: string;
  let out: string;
  let worktree: string;
  let stub: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hl-port-')));
    home = path.join(root, 'home');
    out = path.join(root, 'out');
    worktree = path.join(root, 'wt');
    for (const dir of [path.join(home, '.local', 'bin'), out, worktree]) fs.mkdirSync(dir, { recursive: true });
    stub = path.join(home, '.local', 'bin', 'claude');
    // Records its arguments, environment and folder, starts a child that ignores a hangup, and sleeps.
    fs.writeFileSync(stub, [
      '#!/bin/sh',
      `o='${out}'`,
      'echo $$ >> "$o/starts"',
      'printf "%s\\n" "$@" > "$o/args"',
      'env > "$o/env"',
      'pwd -P > "$o/cwd"',
      // The child names itself once it ignores a hangup, so a destroy cannot land before that.
      'sh -c \'trap "" HUP; echo $$ > "$0/child"; exec sleep 300\' "$o" &',
      'exec sleep 300',
      '',
    ].join('\n'), { mode: 0o755 });
    for (const key of ['HOME', 'PATH', 'WMUX_TERMINAL_CORE', PLANTED]) saved[key] = process.env[key];
    process.env.HOME = home;
    process.env.PATH = '/usr/bin:/bin';
    process.env.WMUX_TERMINAL_CORE = 'node';
    process.env[PLANTED] = 'planted-not-a-real-key';
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const m of managers.splice(0)) m.disposeAll();
    for (const pid of pids.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f));
  });

  const read = (name: string): string => fs.readFileSync(path.join(out, name), 'utf8');
  const has = (name: string): boolean => fs.existsSync(path.join(out, name)) && read(name).trim() !== '';

  /** The port over a real manager, as index.ts wires it; `refuseTreeKill` makes the tree kill refuse as the daemon's does for an unknown root. */
  function port(opts: { refuseTreeKill?: boolean } = {}): { port: HeadlessSessionPort; mgr: DaemonSessionManager } {
    const mgr = new DaemonSessionManager();
    managers.push(mgr);
    const p = createHeadlessSessions({
      paneEnv: (id, workspaceId) => buildWebPaneEnv({ id, parentEnv: process.env, workspaceId }),
      createSession: async (params, local) => {
        const p2 = params as { id: string; cwd: string; env: Record<string, string>; exec: { command: string } };
        return mgr.createSessionAsync({ id: p2.id, cwd: p2.cwd, env: p2.env, exec: p2.exec, cols: 80, rows: 24, ...local });
      },
      // destroySessionNow's tree handling (index.ts): refuse an unprovable root, capture, destroy, kill.
      destroySession: async ({ id, killTree }) => {
        const meta = mgr.getSession(id)?.meta;
        if (killTree) {
          const refusal = opts.refuseTreeKill ? 'the pane\'s start time is unknown' : meta ? treeKillRefusal(meta) : null;
          if (refusal) throw new Error(refusal);
        }
        const captured = killTree && meta && meta.pid > 0
          ? await captureProcessTree(meta.pid, { rootIsOurs: (start) => matchesRecordedStart(recordedStartOf(meta), start) })
          : null;
        mgr.destroySession(id);
        if (!killTree) return { ok: true };
        return { ok: true, tree: captured ? await captured.kill() : { ok: true, killed: [] } };
      },
      meta: (id) => mgr.getSession(id)?.meta,
      agentPath: async () => `${path.dirname(stub)}:/usr/bin:/bin`,
    });
    return { port: p, mgr };
  }

  async function start(p: HeadlessSessionPort): Promise<{ id: string; uuid: string; rootPid: number; rootStart: string; child: number }> {
    const uuid = crypto.randomUUID();
    const id = `hl-${uuid}`;
    const agentBin = await p.resolveAgent('claude');
    expect(agentBin).toBe(stub);
    const res = await p.create({
      sessionId: id,
      workspaceId: `hl-${crypto.randomUUID()}`,
      cwd: worktree,
      agentBin: agentBin as string,
      command: `claude --session-id ${uuid} --permission-mode acceptEdits --disallowedTools mcp__wmux__remote_spawn`,
      env: { CLAUDE_CODE_EXTRA: 'from-the-start' },
    });
    await waitFor(() => has('child'), WAIT_MS, 'the stub agent to start');
    const child = Number(read('child').trim());
    pids.push(child);
    expect(res.rootPid).toBeGreaterThan(1);
    expect(res.rootStart).toBeTruthy();
    pids.push(res.rootPid as number);
    return { id, uuid, rootPid: res.rootPid as number, rootStart: res.rootStart as string, child };
  }

  it('runs the launcher it found, pinned to its PATH, with the line\'s flags, in the worktree, without credential-class names', async () => {
    const { port: p, mgr } = port();
    const { id, uuid } = await start(p);
    expect(read('args').trim().split('\n')).toEqual(['--session-id', uuid, '--permission-mode', 'acceptEdits', '--disallowedTools', 'mcp__wmux__remote_spawn']);
    expect(read('cwd').trim()).toBe(worktree);
    const env = new Map(read('env').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const));
    expect(env.get('HOME')).toBe(home);
    expect(env.get('PATH')).toBe(`${path.dirname(stub)}:/usr/bin:/bin`);
    expect(env.get('CLAUDE_CODE_EXTRA')).toBe('from-the-start');
    expect(env.has(PLANTED)).toBe(false);
    expect([...env.keys()].filter((k) => isCredentialEnvKey(k))).toEqual([]);
    // What is persisted (and what a recovery would run) is the replay line, never the agent's.
    expect(mgr.getSession(id)?.meta.exec?.command).toBe(HEADLESS_REPLAY_LINE);
    expect(p.alive(id)).toBe(true);
  }, TEST_MS);

  it('ends the whole tree, and what it had then holds nothing', async () => {
    const { port: p } = port();
    const { id, rootPid, child } = await start(p);
    const before = await snapshotTree(rootPid);
    expect(before?.map((s) => s.pid)).toEqual(expect.arrayContaining([rootPid, child]));
    expect(await p.destroy(id)).toEqual({ ok: true });
    await waitFor(() => !alive(child) && !alive(rootPid), WAIT_MS, 'the agent tree to exit');
    expect(p.alive(id)).toBe(false);
    expect(await p.stillRunning(before ?? [], worktree)).toEqual([]);
  }, TEST_MS);

  it('a tree it cannot check closes the pane and is held by the processes it had, until they are gone', async () => {
    const { port: p } = port({ refuseTreeKill: true });
    const { id, rootPid, child } = await start(p);
    const res = await p.destroy(id);
    expect(res.ok).toBe(false);
    const survivors = res.ok ? [] : res.survivors;
    expect(survivors.map((s) => s.pid)).toEqual(expect.arrayContaining([rootPid, child]));
    expect(survivors.every((s) => s.startTime && !s.unverified)).toBe(true);
    expect(p.alive(id)).toBe(false);
    // The child ignored the hangup: it still runs, and the start stays held.
    await waitFor(() => !alive(rootPid), WAIT_MS, 'the pane process to end');
    expect(alive(child)).toBe(true);
    expect(await p.stillRunning(survivors, worktree)).toHaveLength(survivors.length);
    process.kill(child, 'SIGKILL');
    await waitFor(() => !alive(child), WAIT_MS, 'the child to exit');
    expect(await p.stillRunning(survivors, worktree)).toEqual([]);
  }, TEST_MS);

  it('a live pid with another start time does not hold', async () => {
    const { port: p } = port();
    const self = await snapshotTree(process.pid);
    expect(self?.[0]?.startTime).toBeTruthy();
    expect(await p.stillRunning([{ pid: process.pid, startTime: 'Thu Jan  1 00:00:00 1970', reason: 'test' }], worktree)).toEqual([]);
    expect(await p.stillRunning([{ pid: process.pid, startTime: self?.[0]?.startTime, reason: 'test' }], worktree)).toHaveLength(1);
  }, TEST_MS);

  it('an earlier run\'s agent is ended only by the start time recorded for it', async () => {
    const { port: p } = port();
    const { rootPid, rootStart, child } = await start(p);
    expect(await p.killEarlier(rootPid, 'Thu Jan  1 00:00:00 1970')).toEqual({ ok: true });
    expect(alive(rootPid)).toBe(true);
    expect(await p.killEarlier(rootPid, rootStart)).toEqual({ ok: true });
    await waitFor(() => !alive(rootPid) && !alive(child), WAIT_MS, 'the earlier agent tree to exit');
  }, TEST_MS);

  it('a daemon restart runs the persisted line, which does not start the agent again', async () => {
    const { port: p, mgr } = port();
    const { id, uuid } = await start(p);
    const persisted = mgr.getSession(id)?.meta;
    expect(persisted?.exec?.command).toBe(HEADLESS_REPLAY_LINE);
    expect(await p.destroy(id)).toEqual({ ok: true });
    // The next run replays the session from what was persisted, through the resume rewrite every
    // replay site applies (index.ts resumeLaunchCommand): the agent's conversation may be bound to
    // the pane by then, and still the line is not an agent launcher, so nothing resumes it.
    const binding = { agent: 'claude', sessionId: uuid, cwd: worktree, ts: Date.now() };
    const rewritten = toResumeCommand(HEADLESS_REPLAY_LINE, binding, worktree, { restorePermissionMode: true });
    expect(rewritten).toBe(HEADLESS_REPLAY_LINE);
    const next = new DaemonSessionManager();
    managers.push(next);
    await next.createSessionAsync({
      id, cwd: persisted?.cwd ?? worktree, env: persisted?.env, exec: persisted?.exec, cols: 80, rows: 24,
      ...(rewritten === persisted?.exec?.command ? {} : { execLaunchCommand: rewritten }),
    });
    await waitFor(() => next.getSession(id)?.meta.state === 'dead', WAIT_MS, 'the replayed line to finish');
    expect(read('starts').trim().split('\n')).toHaveLength(1);
  }, TEST_MS);
});
