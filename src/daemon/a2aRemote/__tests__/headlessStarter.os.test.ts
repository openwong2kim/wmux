// The daemon's own start of a remote spawn on a host without the app, on fake
// ports: what each step makes, what each failure takes back, and what a
// reconcile does with every record it finds (a start cut short, one whose
// agent or link is gone, one of an earlier daemon run).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { A2aLinkRecordV1, HostId } from '../../../shared/a2aRemote';
import type { A2aSpawnClaimResult, A2aSpawnStepResult } from '../../../shared/a2aSpawn';
import { toolRuleCovers, workerLaunchFlags } from '../../../shared/workerLaunch';
import type { SpawnWorktreeResult } from '../../../main/a2aRemote/spawnWorktree';
import { HeadlessStartStore, type HeadlessSurvivor } from '../headlessStartStore';
import { A2aHeadlessStarter, HEADLESS_EXTRA_DISALLOWED_TOOLS, headlessTreeId, type HeadlessSessionInput, type HeadlessSessionPort, type HeadlessStarterDeps } from '../headlessStarter';
import type { SpawnRequestRecordV1 } from '../spawnRequestStore';

const HOST = '11111111-1111-4111-8111-111111111111' as HostId;
const SPAWN = 'sp-0123abcd-4567-89ab-cdef-0123456789ab';
const LINK = '22222222-2222-4222-8222-222222222222';
const PROMPT = 'fix the build';
const TREE = headlessTreeId(HOST, SPAWN);

let dir: string;
let starts: HeadlessStartStore;
let active: boolean;
let claimResult: A2aSpawnClaimResult;
let startedResult: A2aSpawnStepResult;
let request: Partial<SpawnRequestRecordV1> | undefined;
let link: A2aLinkRecordV1 | undefined;
let calls: string[];
let created: HeadlessSessionInput[];
let live: Set<string>;
let failed: string[];
let gone: Array<{ workspaceId: string; paneId: string }>;
let removedTrees: string[];
let worktree: SpawnWorktreeResult;
let sessionPort: HeadlessSessionPort | null;
let createThrows: boolean;
let agentBin: string | null;
let owed: boolean;
/** Processes the next destroy reports as not exited, and those a recheck still finds. */
let survivors: HeadlessSurvivor[];
let stillRunning: HeadlessSurvivor[];
let onDisk: Set<string>;
let checkedIn: Array<string | undefined>;
let earlierSurvivors: HeadlessSurvivor[];
let pristine: boolean;
let released: Set<string>;
let allLinks: A2aLinkRecordV1[];

function makeSessions(): HeadlessSessionPort {
  return {
    resolveAgent: async () => agentBin,
    create: async (input) => {
      calls.push('create');
      if (createThrows) throw new Error('pty refused');
      created.push(input);
      live.add(input.sessionId);
      return { rootPid: 777, rootStart: 'Thu Nov 12 10:00:00 2026' };
    },
    alive: (id) => live.has(id),
    destroy: async (id) => {
      calls.push(`destroy:${id}`);
      live.delete(id);
      return survivors.length > 0 ? { ok: false, survivors } : { ok: true };
    },
    killEarlier: async (pid) => {
      calls.push(`killEarlier:${pid}`);
      return earlierSurvivors.length > 0 ? { ok: false, survivors: earlierSurvivors } : { ok: true };
    },
    stillRunning: async (_s, worktreePath) => {
      checkedIn.push(worktreePath);
      return stillRunning;
    },
  };
}

function makeStarter(over: Partial<HeadlessStarterDeps> = {}): A2aHeadlessStarter {
  return new A2aHeadlessStarter({
    mode: { active: () => active },
    receiver: {
      claim: async () => {
        calls.push('claim');
        if (claimResult.ok) request = { state: 'starting' };
        return claimResult;
      },
      started: async (_h, _s, end) => {
        calls.push(`started:${end.workspaceId}:${end.paneId}`);
        if (startedResult.ok) request = { state: 'decided', code: 'started', linkId: LINK };
        return startedResult;
      },
      failed: (_h, _s, code) => {
        failed.push(code);
        return { ok: true };
      },
    },
    requests: { get: () => request as SpawnRequestRecordV1 | undefined },
    links: { get: (id) => (link && link.linkId === id ? link : undefined), list: () => allLinks },
    activationOwed: () => owed,
    starts,
    sessions: () => sessionPort,
    worktrees: {
      create: async () => {
        calls.push('worktree');
        return worktree;
      },
      remove: async (input) => void removedTrees.push(input.spawnId),
      exists: (p) => onDisk.has(p),
      pathFor: (spawnId) => `/wt/remote-${spawnId}`,
      baseOf: async () => 'a'.repeat(40),
      pristine: async () => pristine,
    },
    releases: { requested: (id) => released.has(id), clear: (id) => void released.delete(id) },
    paneGone: async (workspaceId, paneId) => void gone.push({ workspaceId, paneId }),
    abandon: () => void calls.push('abandon'),
    runId: 'run-1',
    log: () => undefined,
    retryMs: 60_000,
    ...over,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-start-'));
  starts = new HeadlessStartStore({ dir, scheduleHarden: () => undefined });
  active = true;
  claimResult = { ok: true, claim: { hostId: HOST, hostName: 'PC-A', spawnId: SPAWN, agent: 'claude', repoPath: '/repo', sub: 'apps', permissionMode: 'auto' } };
  startedResult = { ok: true };
  request = { state: 'approved' };
  link = { linkId: LINK, state: 'active' } as A2aLinkRecordV1;
  calls = [];
  created = [];
  live = new Set();
  failed = [];
  gone = [];
  removedTrees = [];
  worktree = { ok: true, worktreePath: '/wt/remote-x', cwd: '/wt/remote-x/apps', branch: `wmux/remote/${TREE}` };
  sessionPort = makeSessions();
  createThrows = false;
  agentBin = '/home/u/.local/bin/claude';
  owed = false;
  survivors = [];
  stillRunning = [];
  onDisk = new Set(['/wt/remote-x']);
  checkedIn = [];
  earlierSurvivors = [];
  pristine = false;
  released = new Set();
  allLinks = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('headless start', () => {
  it('claims, records, makes the worktree and the session, then reports the session it made', async () => {
    await makeStarter().start(HOST, SPAWN);
    expect(calls).toEqual(['claim', 'worktree', 'create', `started:hl-${TREE.slice(3)}:${starts.get(HOST, SPAWN)?.sessionId}`]);
    const rec = starts.get(HOST, SPAWN)!;
    expect(rec).toMatchObject({ phase: 'started', linkId: LINK, lineage: `remote-spawn:${HOST}`, runId: 'run-1', worktreePath: '/wt/remote-x', cwd: '/wt/remote-x/apps' });
    expect(created).toHaveLength(1);
    const [input] = created;
    expect(input.sessionId).toBe(rec.sessionId);
    expect(input.cwd).toBe('/wt/remote-x/apps');
    expect(input.agentBin).toBe('/home/u/.local/bin/claude');
    // The worker flags and the pinned conversation id; never the prompt.
    expect(input.command).toBe(`claude --session-id ${rec.agentSessionId} ${workerLaunchFlags('auto', HEADLESS_EXTRA_DISALLOWED_TOOLS)}`);
    for (const tool of ['remote_spawn', 'hand_out', 'a2a_broadcast', 'pane_close', 'automation_propose', 'computer', 'repl_run', 'terminal_send']) {
      expect(input.command).toContain(`mcp__wmux__${tool}`);
    }
    expect(input.command).toContain('mcp__wmux__fanout_start');
    // No tool is both allowed and denied on the line (task_push was, in both lists).
    const list = (flag: string): string[] => (input.command.match(new RegExp(`${flag} "([^"]*)"`))?.[1] ?? '').split(',');
    const allowed = list('--allowedTools');
    const denied = list('--disallowedTools');
    expect(denied).toContain('mcp__wmux__task_push');
    expect(allowed.filter((tool) => denied.some((rule) => toolRuleCovers(rule, tool)))).toEqual([]);
    expect(JSON.stringify(input)).not.toContain(PROMPT);
    expect(failed).toEqual([]);
  });

  it('starts nothing while headless mode is off', async () => {
    active = false;
    await makeStarter().start(HOST, SPAWN);
    expect(calls).toEqual([]);
    expect(starts.list()).toEqual([]);
  });

  it('a claim the receiver refused (and answered) is left alone', async () => {
    claimResult = { ok: false, error: 'not-allowed', code: 'not-allowed' };
    await makeStarter().start(HOST, SPAWN);
    expect(calls).toEqual(['claim']);
    expect(failed).toEqual([]);
    expect(starts.list()).toEqual([]);
  });

  for (const [name, set] of [
    ['an agent other than Claude Code', () => { claimResult = { ...claimResult, claim: { ...(claimResult as { claim: object }).claim, agent: 'codex' } } as A2aSpawnClaimResult; }],
    ['the manual permission mode', () => { claimResult = { ...claimResult, claim: { ...(claimResult as { claim: object }).claim, permissionMode: 'manual' } } as A2aSpawnClaimResult; }],
    ['a launcher that is not found', () => { agentBin = null; }],
  ] as const) {
    it(`${name} is refused before anything is made`, async () => {
      set();
      await makeStarter().start(HOST, SPAWN);
      expect(calls).toEqual(['claim']);
      expect(failed).toEqual(['failed']);
      expect(starts.list()).toEqual([]);
    });
  }

  it('a worktree that cannot be made answers its code and keeps no record; a folder of that name that was there is not touched', async () => {
    worktree = { ok: false, code: 'failed', detail: 'remote-x already exists' };
    await makeStarter().start(HOST, SPAWN);
    expect(failed).toEqual(['failed']);
    expect(calls.filter((c) => c === 'create')).toEqual([]);
    expect(removedTrees).toEqual([]);
    expect(starts.list()).toEqual([]);
  });

  it('a request that is no longer approved is not claimed (nor retried)', async () => {
    request = { state: 'decided', code: 'expired' };
    await makeStarter().start(HOST, SPAWN);
    expect(calls).toEqual([]);
  });

  it('a session that does not start takes the worktree back', async () => {
    createThrows = true;
    await makeStarter().start(HOST, SPAWN);
    expect(failed).toEqual(['failed']);
    expect(removedTrees).toEqual([TREE]);
    expect(live.size).toBe(0);
    expect(starts.list()).toEqual([]);
  });

  it('a `started` the receiver refuses ends the session and takes the worktree back', async () => {
    startedResult = { ok: false, error: 'expired' };
    await makeStarter().start(HOST, SPAWN);
    expect(live.size).toBe(0);
    expect(calls.some((c) => c.startsWith('destroy:hl-'))).toBe(true);
    expect(removedTrees).toEqual([TREE]);
    expect(failed).toEqual(['failed']);
    expect(starts.list()).toEqual([]);
  });

  it('headless mode turned off during the start takes back what it made', async () => {
    const starter = makeStarter({
      worktrees: {
        create: async () => {
          active = false;
          return worktree;
        },
        remove: async (input) => void removedTrees.push(input.spawnId),
        exists: () => false,
        pathFor: (spawnId: string) => `/wt/remote-${spawnId}`,
        baseOf: async () => null,
        pristine: async () => false,
      },
    });
    await starter.start(HOST, SPAWN);
    expect(created).toEqual([]);
    expect(removedTrees).toEqual([TREE]);
    expect(failed).toEqual(['failed']);
  });

  it('a take-back that fails keeps the record for the next reconcile', async () => {
    createThrows = true;
    let removes = 0;
    const starter = makeStarter({
      worktrees: {
        create: async () => worktree,
        remove: async () => {
          removes += 1;
          if (removes === 1) throw new Error('busy');
        },
        exists: () => false,
        pathFor: (spawnId: string) => `/wt/remote-${spawnId}`,
        baseOf: async () => null,
        pristine: async () => false,
      },
    });
    await starter.start(HOST, SPAWN);
    expect(starts.get(HOST, SPAWN)?.phase).toBe('prepared');
    request = { state: 'decided', code: 'failed' };
    await starter.reconcile();
    expect(removes).toBe(2);
    expect(starts.list()).toEqual([]);
  });

  it('waits for the session service instead of refusing', async () => {
    sessionPort = null;
    const starter = makeStarter();
    await starter.start(HOST, SPAWN);
    expect(calls).toEqual([]);
    starter.stop();
  });
});

describe('headless reconcile', () => {
  const record = (over: Partial<Parameters<HeadlessStartStore['add']>[0]> = {}): void => starts.add({
    v: 1, hostId: HOST, spawnId: SPAWN, treeId: TREE, agent: 'claude', repoPath: '/repo', sessionId: 'hl-11111111-2222-4333-8444-555555555555', workspaceId: 'hl-w1',
    agentSessionId: '33333333-3333-4333-8333-333333333333', lineage: `remote-spawn:${HOST}`, runId: 'run-1',
    phase: 'started', worktreePath: '/wt/remote-x', linkId: LINK, startedAt: new Date().toISOString(), ...over,
  });

  it('a start cut between the worktree and the session (then a restart) leaves no worktree, session or record', async () => {
    record({ phase: 'prepared', linkId: undefined, runId: 'run-0' });
    request = { state: 'decided', code: 'failed' };
    await makeStarter().reconcile();
    expect(removedTrees).toEqual([TREE]);
    expect(calls).toContain('destroy:hl-11111111-2222-4333-8444-555555555555');
    expect(starts.list()).toEqual([]);
  });

  it('a created start whose request is still starting is refused and taken back', async () => {
    record({ phase: 'created', linkId: undefined });
    live.add('hl-11111111-2222-4333-8444-555555555555');
    request = { state: 'starting' };
    await makeStarter().reconcile();
    expect(live.size).toBe(0);
    expect(failed).toEqual(['failed']);
    expect(starts.list()).toEqual([]);
  });

  it('a live start stays', async () => {
    record();
    live.add('hl-11111111-2222-4333-8444-555555555555');
    request = { state: 'decided', code: 'started', linkId: LINK };
    await makeStarter().reconcile();
    expect(starts.get(HOST, SPAWN)?.phase).toBe('started');
    expect(calls).toEqual([]);
  });

  it('an agent of an earlier daemon run (relaunched by recovery) is ended, its link broken, its worktree kept', async () => {
    record({ runId: 'run-0' });
    live.add('hl-11111111-2222-4333-8444-555555555555');
    request = { state: 'decided', code: 'started', linkId: LINK };
    await makeStarter().reconcile();
    expect(live.has('hl-11111111-2222-4333-8444-555555555555')).toBe(false);
    expect(gone).toEqual([{ workspaceId: 'hl-w1', paneId: 'hl-11111111-2222-4333-8444-555555555555' }]);
    expect(calls).toContain('abandon');
    expect(removedTrees).toEqual([]);
    expect(starts.get(HOST, SPAWN)).toMatchObject({ phase: 'ended', worktreePath: '/wt/remote-x', endedAt: expect.any(String) });
  });

  it('a session that died ends its start', async () => {
    record();
    request = { state: 'decided', code: 'started', linkId: LINK };
    const starter = makeStarter();
    starter.onSessionGone('hl-11111111-2222-4333-8444-555555555555');
    await starter.reconcile();
    expect(gone).toEqual([{ workspaceId: 'hl-w1', paneId: 'hl-11111111-2222-4333-8444-555555555555' }]);
    expect(starts.get(HOST, SPAWN)?.phase).toBe('ended');
  });

  it('a link that ended ends its session', async () => {
    record();
    live.add('hl-11111111-2222-4333-8444-555555555555');
    request = { state: 'decided', code: 'started', linkId: LINK };
    link = { linkId: LINK, state: 'revoked' } as A2aLinkRecordV1;
    const starter = makeStarter();
    starter.onLinkTransition(link);
    await starter.reconcile();
    expect(live.has('hl-11111111-2222-4333-8444-555555555555')).toBe(false);
    expect(gone).toEqual([]);
    expect(starts.get(HOST, SPAWN)?.phase).toBe('ended');
  });

  it('the app attaching (headless off) ends every start', async () => {
    record();
    live.add('hl-11111111-2222-4333-8444-555555555555');
    request = { state: 'decided', code: 'started', linkId: LINK };
    active = false;
    await makeStarter().reconcile();
    expect(live.has('hl-11111111-2222-4333-8444-555555555555')).toBe(false);
    expect(starts.get(HOST, SPAWN)?.phase).toBe('ended');
  });

  it('a start stored `started` whose record was not updated is finished, not taken back', async () => {
    record({ phase: 'created', linkId: undefined });
    live.add('hl-11111111-2222-4333-8444-555555555555');
    request = { state: 'decided', code: 'started', linkId: LINK };
    await makeStarter().reconcile();
    expect(starts.get(HOST, SPAWN)).toMatchObject({ phase: 'started', linkId: LINK });
    expect(removedTrees).toEqual([]);
  });

  it('a start whose link is gone (its PC removed) is ended', async () => {
    record();
    live.add('hl-11111111-2222-4333-8444-555555555555');
    request = undefined;
    link = undefined;
    await makeStarter().reconcile();
    expect(live.has('hl-11111111-2222-4333-8444-555555555555')).toBe(false);
    expect(starts.get(HOST, SPAWN)?.phase).toBe('ended');
  });

  it('a start whose link is still being made stays', async () => {
    record();
    live.add('hl-11111111-2222-4333-8444-555555555555');
    request = { state: 'decided', code: 'started', linkId: LINK };
    link = undefined;
    owed = true;
    await makeStarter().reconcile();
    expect(live.has('hl-11111111-2222-4333-8444-555555555555')).toBe(true);
    expect(starts.get(HOST, SPAWN)?.phase).toBe('started');
  });

  it('an agent that exits as soon as it starts is not reported started', async () => {
    const starter = makeStarter({
      sessions: () => ({ ...makeSessions(), alive: () => false }),
    });
    await starter.start(HOST, SPAWN);
    expect(calls.some((c) => c.startsWith('started:'))).toBe(false);
    expect(failed).toEqual(['failed']);
    expect(removedTrees).toEqual([TREE]);
    expect(starts.list()).toEqual([]);
  });

  it('an ended start whose session is somehow back is ended again', async () => {
    record({ phase: 'ended', endedAt: new Date().toISOString() });
    live.add('hl-11111111-2222-4333-8444-555555555555');
    await makeStarter().reconcile();
    expect(live.has('hl-11111111-2222-4333-8444-555555555555')).toBe(false);
    expect(starts.get(HOST, SPAWN)?.phase).toBe('ended');
  });
});

describe('headless cleanup that waits for the agent to exit', () => {
  const record = (over: Partial<Parameters<HeadlessStartStore['add']>[0]> = {}): void => starts.add({
    v: 1, hostId: HOST, spawnId: SPAWN, treeId: TREE, agent: 'claude', repoPath: '/repo', sessionId: 'hl-11111111-2222-4333-8444-555555555555', workspaceId: 'hl-w1',
    agentSessionId: '33333333-3333-4333-8333-333333333333', lineage: `remote-spawn:${HOST}`, runId: 'run-1',
    phase: 'started', worktreePath: '/wt/remote-x', linkId: LINK, startedAt: new Date().toISOString(), ...over,
  });
  const SURVIVOR: HeadlessSurvivor = { pid: 4242, reason: 'still running', startTime: 'Thu Nov 12 10:00:00 2026' };

  it('an end whose agent processes do not all exit breaks the link but is not marked ended until they are gone', async () => {
    record();
    live.add('hl-11111111-2222-4333-8444-555555555555');
    request = { state: 'decided', code: 'started', linkId: LINK };
    active = false;
    survivors = [SURVIVOR];
    stillRunning = [SURVIVOR];
    const starter = makeStarter();
    await starter.reconcile();
    expect(gone).toEqual([{ workspaceId: 'hl-w1', paneId: 'hl-11111111-2222-4333-8444-555555555555' }]);
    expect(starts.get(HOST, SPAWN)).toMatchObject({ phase: 'started', survivors: [SURVIVOR] });
    // Still running at the next sweep: nothing changes. The check is told the worktree (for an unverified tree).
    await starter.reconcile();
    expect(starts.get(HOST, SPAWN)).toMatchObject({ phase: 'started', survivors: [SURVIVOR] });
    expect(checkedIn).toEqual(['/wt/remote-x']);
    // Gone: the start ends, its worktree kept.
    survivors = [];
    stillRunning = [];
    link = { linkId: LINK, state: 'broken' } as A2aLinkRecordV1;
    await starter.reconcile();
    expect(starts.get(HOST, SPAWN)?.phase).toBe('ended');
    expect(starts.get(HOST, SPAWN)?.survivors).toBeUndefined();
    expect(removedTrees).toEqual([]);
  });

  it('a take-back whose agent processes do not exit keeps the worktree and the record', async () => {
    record({ phase: 'created', linkId: undefined });
    live.add('hl-11111111-2222-4333-8444-555555555555');
    request = { state: 'starting' };
    survivors = [SURVIVOR];
    stillRunning = [SURVIVOR];
    const starter = makeStarter();
    await starter.reconcile();
    expect(removedTrees).toEqual([]);
    expect(starts.get(HOST, SPAWN)).toMatchObject({ phase: 'created', survivors: [SURVIVOR] });
    survivors = [];
    stillRunning = [];
    request = { state: 'decided', code: 'failed' };
    await starter.reconcile();
    expect(removedTrees).toEqual([TREE]);
    expect(starts.list()).toEqual([]);
  });

  it('an ended start whose worktree the owner removed is dropped; one still on disk stays listed', async () => {
    record({ phase: 'ended', endedAt: new Date().toISOString() });
    await makeStarter().reconcile();
    expect(starts.get(HOST, SPAWN)?.phase).toBe('ended');
    onDisk.clear();
    await makeStarter().reconcile();
    expect(starts.list()).toEqual([]);
  });

  it('headless mode turned off while `started` was answered ends the start right after, not at the next sweep', async () => {
    const starter = makeStarter({
      receiver: {
        claim: async () => {
          request = { state: 'starting' };
          return claimResult;
        },
        started: async () => {
          request = { state: 'decided', code: 'started', linkId: LINK };
          active = false;
          return { ok: true };
        },
        failed: (_h, _s, code) => {
          failed.push(code);
          return { ok: true };
        },
      },
    });
    await starter.start(HOST, SPAWN);
    await starter.reconcile();
    expect(live.size).toBe(0);
    expect(starts.get(HOST, SPAWN)?.phase).toBe('ended');
  });
});

describe('headless starts across a crash, a restart, and an unchanged worktree', () => {
  const INTENDED = `/wt/remote-${TREE}`;
  const record = (over: Partial<Parameters<HeadlessStartStore['add']>[0]> = {}): void => starts.add({
    v: 1, hostId: HOST, spawnId: SPAWN, treeId: TREE, agent: 'claude', repoPath: '/repo', sessionId: 'hl-11111111-2222-4333-8444-555555555555', workspaceId: 'hl-w1',
    agentSessionId: '33333333-3333-4333-8333-333333333333', lineage: `remote-spawn:${HOST}`, runId: 'run-1',
    phase: 'started', worktreePath: '/wt/remote-x', linkId: LINK, startedAt: new Date().toISOString(), ...over,
  });

  it('records the worktree path before making it, and the agent process once started', async () => {
    const seen: Array<string | undefined> = [];
    const starter = makeStarter({
      worktrees: {
        create: async () => {
          seen.push(starts.get(HOST, SPAWN)?.worktreeIntended);
          return worktree;
        },
        remove: async (input) => void removedTrees.push(input.spawnId),
        exists: () => false,
        pathFor: (spawnId) => `/wt/remote-${spawnId}`,
        baseOf: async () => 'b'.repeat(40),
        pristine: async () => false,
      },
    });
    await starter.start(HOST, SPAWN);
    expect(seen).toEqual([INTENDED]);
    expect(starts.get(HOST, SPAWN)).toMatchObject({ phase: 'started', rootPid: 777, rootStart: 'Thu Nov 12 10:00:00 2026', baseCommit: 'b'.repeat(40), branch: `wmux/remote/${TREE}` });
  });

  it('a daemon that died between `worktree add` and recording it: the next run takes the path back', async () => {
    record({ phase: 'prepared', worktreePath: undefined, linkId: undefined, worktreeIntended: INTENDED, runId: 'run-0' });
    request = { state: 'decided', code: 'failed' };
    await makeStarter().reconcile();
    expect(removedTrees).toEqual([TREE]);
    expect(starts.list()).toEqual([]);
  });

  it('a path that is there already is never recorded nor touched', async () => {
    onDisk.add(INTENDED);
    await makeStarter().start(HOST, SPAWN);
    expect(removedTrees).toEqual([]);
    expect(failed).toEqual(['failed']);
    expect(starts.list()).toEqual([]);
  });

  it('a worktree step that fails leaves its path alone, now and at later reconciles', async () => {
    worktree = { ok: false, code: 'failed', detail: 'branch already exists' };
    await makeStarter().start(HOST, SPAWN);
    expect(removedTrees).toEqual([]);
    expect(starts.list()).toEqual([]);
  });

  it('after a restart, the agent of the earlier run is ended by its recorded pid; one that does not exit holds the start', async () => {
    record({ runId: 'run-0', rootPid: 4242, rootStart: 'Thu Nov 12 10:00:00 2026' });
    request = { state: 'decided', code: 'started', linkId: LINK };
    earlierSurvivors = [{ pid: 4242, reason: 'still running', startTime: 'Thu Nov 12 10:00:00 2026' }];
    stillRunning = earlierSurvivors;
    await makeStarter().reconcile();
    expect(calls).toContain('killEarlier:4242');
    expect(starts.get(HOST, SPAWN)).toMatchObject({ phase: 'started', survivors: earlierSurvivors });
    // The owner checked it and released the hold: the start ends.
    released.add(SPAWN);
    earlierSurvivors = [];
    link = { linkId: LINK, state: 'broken' } as A2aLinkRecordV1;
    await makeStarter().reconcile();
    expect(starts.get(HOST, SPAWN)?.phase).toBe('ended');
    expect(released.size).toBe(0);
  });

  it('an ended start whose worktree is unchanged (no commit, clean) has it removed with its branch; a changed one is kept', async () => {
    record({ baseCommit: 'a'.repeat(40) });
    live.add('hl-11111111-2222-4333-8444-555555555555');
    request = { state: 'decided', code: 'started', linkId: LINK };
    active = false;
    await makeStarter().reconcile();
    expect(starts.get(HOST, SPAWN)?.phase).toBe('ended');
    expect(removedTrees).toEqual([]);
    // Unchanged, but a record that does not name its branch (written before it was recorded): kept.
    starts.remove(HOST, SPAWN);
    record({ baseCommit: 'a'.repeat(40) });
    live.add('hl-11111111-2222-4333-8444-555555555555');
    pristine = true;
    await makeStarter().reconcile();
    expect(removedTrees).toEqual([]);
    starts.remove(HOST, SPAWN);
    record({ baseCommit: 'a'.repeat(40), branch: `wmux/remote/${TREE}` });
    live.add('hl-11111111-2222-4333-8444-555555555555');
    await makeStarter().reconcile();
    expect(removedTrees).toEqual([TREE]);
    expect(starts.list()).toEqual([]);
  });

  it('a start cut after its session was made (then a restart) ends the earlier run\'s agent before its worktree goes', async () => {
    record({ phase: 'created', linkId: undefined, runId: 'run-0', rootPid: 4242, rootStart: 'Thu Nov 12 10:00:00 2026' });
    request = { state: 'decided', code: 'failed' };
    earlierSurvivors = [{ pid: 4242, reason: 'still running', startTime: 'Thu Nov 12 10:00:00 2026' }];
    await makeStarter().reconcile();
    expect(calls).toContain('killEarlier:4242');
    // It did not exit: the worktree and the record stay, held by it.
    expect(removedTrees).toEqual([]);
    expect(starts.get(HOST, SPAWN)?.survivors).toEqual(earlierSurvivors);
    earlierSurvivors = [];
    stillRunning = [];
    await makeStarter().reconcile();
    expect(removedTrees).toEqual([TREE]);
    expect(starts.list()).toEqual([]);
  });
});

describe('links a lost start record left behind', () => {
  it('a live link whose local pane is a headless session no record knows: its session ends and the link breaks', async () => {
    const orphan = 'hl-99999999-2222-4333-8444-555555555555';
    allLinks = [
      { linkId: LINK, state: 'active', local: { kind: 'pane', workspaceId: 'hl-w9', paneId: orphan } } as A2aLinkRecordV1,
      // Not a headless session, or already ended: left alone.
      { linkId: '33333333-3333-4333-8333-333333333333', state: 'active', local: { kind: 'pane', workspaceId: 'ws-1', paneId: 'pane-1' } } as A2aLinkRecordV1,
      { linkId: '44444444-3333-4333-8333-333333333333', state: 'broken', local: { kind: 'pane', workspaceId: 'hl-w8', paneId: 'hl-88888888-2222-4333-8444-555555555555' } } as A2aLinkRecordV1,
    ];
    live.add(orphan);
    await makeStarter().reconcile();
    expect(live.has(orphan)).toBe(false);
    expect(gone).toEqual([{ workspaceId: 'hl-w9', paneId: orphan }]);
  });

  it('an orphan whose processes did not exit: the link breaks, and they are ended by pid at the next reconciles', async () => {
    const orphan = 'hl-99999999-2222-4333-8444-555555555555';
    allLinks = [{ linkId: LINK, state: 'active', local: { kind: 'pane', workspaceId: 'hl-w9', paneId: orphan } } as A2aLinkRecordV1];
    live.add(orphan);
    survivors = [
      { pid: 4343, reason: 'in the agent process tree when it was ended', startTime: 'Thu Nov 12 10:00:00 2026' },
      { pid: 4344, reason: 'tree unknown', unverified: true },
    ];
    const starter = makeStarter();
    await starter.reconcile();
    expect(gone).toEqual([{ workspaceId: 'hl-w9', paneId: orphan }]);
    // The verified one is ended again by its pid and start time; the unverified one never by pid alone.
    allLinks = [];
    earlierSurvivors = [survivors[0]];
    await starter.reconcile();
    expect(calls.filter((c) => c.startsWith('killEarlier:'))).toEqual(['killEarlier:4343']);
    earlierSurvivors = [];
    await starter.reconcile();
    await starter.reconcile();
    expect(calls.filter((c) => c.startsWith('killEarlier:'))).toEqual(['killEarlier:4343', 'killEarlier:4343']);
  });

  it('with the session service not up, an orphan link is left for a later reconcile', async () => {
    const orphan = 'hl-99999999-2222-4333-8444-555555555555';
    allLinks = [{ linkId: LINK, state: 'active', local: { kind: 'pane', workspaceId: 'hl-w9', paneId: orphan } } as A2aLinkRecordV1];
    sessionPort = null;
    await makeStarter().reconcile();
    expect(gone).toEqual([]);
  });

  it('a record whose session id is not a headless one is not read back', () => {
    fs.writeFileSync(path.join(dir, 'headless-starts.json'), JSON.stringify({ v: 1, starts: [{
      v: 1, hostId: HOST, spawnId: SPAWN, treeId: TREE, agent: 'claude', repoPath: '/repo', sessionId: '../../etc', workspaceId: 'hl-w1',
      agentSessionId: '33333333-3333-4333-8333-333333333333', lineage: 'x', runId: 'r', phase: 'started', startedAt: new Date().toISOString(),
    }] }));
    expect(new HeadlessStartStore({ dir, scheduleHarden: () => undefined }).list()).toEqual([]);
  });
});

describe('headless worktree names', () => {
  it('two PCs that send the same spawn id get different worktrees, branches and workspaces', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    expect(headlessTreeId(HOST, SPAWN)).not.toBe(headlessTreeId(other, SPAWN));
    expect(headlessTreeId(HOST, SPAWN)).toBe(headlessTreeId(HOST, SPAWN));
    expect(headlessTreeId(HOST, SPAWN)).toMatch(/^sp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('headless start store', () => {
  it('when full, the oldest ended start makes room; with none ended, a new start is refused', () => {
    const small = new HeadlessStartStore({ dir, scheduleHarden: () => undefined });
    const add = (i: number, phase: 'started' | 'ended'): void => small.add({
      v: 1, hostId: HOST, spawnId: `sp-${String(i).padStart(8, '0')}-4567-89ab-cdef-0123456789ab`, agent: 'claude', repoPath: '/repo',
      sessionId: `hl-00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, workspaceId: `hl-w${i}`, agentSessionId: '33333333-3333-4333-8333-333333333333', lineage: 'remote-spawn:x', runId: 'r',
      phase, startedAt: new Date(1_000 + i).toISOString(), ...(phase === 'ended' ? { endedAt: new Date(2_000 + i).toISOString() } : {}),
    });
    for (let i = 0; i < 1000; i++) add(i, i < 2 ? 'ended' : 'started');
    add(1000, 'started');
    expect(small.list()).toHaveLength(1000);
    expect(small.phaseOfSession('hl-00000000-0000-4000-8000-000000000000')).toBeUndefined();
    expect(small.phaseOfSession('hl-00000000-0000-4000-8000-000000000001')).toBe('ended');
    add(1001, 'started');
    expect(() => add(1002, 'started')).toThrow(/1000 are recorded/);
  });
});
