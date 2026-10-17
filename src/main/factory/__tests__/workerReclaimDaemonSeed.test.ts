// A reported bot task's idle stop looks at and stops only its own worker
// panes (a pane of its workspace whose agent runs), never a shell there. After
// an app restart main has no turn evidence for them (it lived only in
// memory): the daemon's view of each worker pane's turn is read, so a worker
// whose turn the daemon reports closed is stopped on the normal window
// counted from its last result (never before the report); anything the
// daemon cannot vouch for stays not idle, and evidence main sees itself
// always wins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import {
  RECLAIM_ATTEMPTS_MAX,
  REPORTED_IDLE_MS,
  ReclaimedWorkers,
  TURN_SEED_OPEN_RECHECK_MS,
  TURN_SEED_RETRY_MAX_MS,
  TURN_SEED_RETRY_MS,
  createDaemonTurnSeed,
  installWorkerReclaim,
  isReclaimedSince,
  mergePaneActivity,
  reclaimWorker,
  reportedWorkerPanes,
  taskWorkerPanes,
  workerPanesIdle,
  type DaemonTurnState,
  type PaneActivity,
  type WorkerReclaimPorts,
  type WorkerSessionInfo,
} from '../workerReclaim';

const BOT = 'bot-0000000a';
const UUID = '2eca904b-b4cc-4243-81d3-67a121351892';
const MIN = 60_000;
/** When the task was reported for review. */
const REPORT = 10 * MIN;
/** When main started again (the restart). */
const RESTART = REPORT + 4 * MIN;
const WORKER = 'daemon-1';
const SHELL = 'daemon-2';
/** The daemon's answer for a worker pane whose turn is over. */
const CLOSED: DaemonTurnState = { agentStatus: 'idle', turnOpen: false, hookReports: true };

function reported(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id: 'wtask-abc-12345678', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'delta',
    status: 'review_requested', rev: 3, updatedAt: REPORT, updatedBy: { kind: 'brain', workspaceId: 'ws-owner' },
    dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default' },
    ...over,
  };
}

let dir: string;
let wt: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-seed-'));
  wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

/** The worker's pane: its claude runs. */
function workerSession(): WorkerSessionInfo {
  return { id: WORKER, pid: 10, spawnCwd: wt, agentProcessAlive: true, resumeBinding: { agent: 'claude', sessionId: UUID, cwd: wt, permissionMode: 'bypassPermissions' } };
}
/** A plain shell opened in the same workspace and folder (the owner's). */
function shellSession(): WorkerSessionInfo {
  return { id: SHELL, pid: 11, spawnCwd: wt, agentProcessAlive: false, commandRunning: false };
}

interface MainOpts {
  ready?: () => boolean;
  /** The task workspace's panes (null: the tree is not known yet). */
  panes?: () => string[] | null;
  sessions?: () => WorkerSessionInfo[];
  recorded?: string[];
  /** The panes the task's own launch created (default: the worker's). */
  launched?: string[];
}

/** main after a restart, wired as workerLifecycleHost wires it: main's own
 *  turn evidence (empty until a broadcast), the seed, and the same pure
 *  pieces the host uses (mergePaneActivity, reportedWorkerPanes). */
function restartedMain(read: (id: string) => Promise<DaemonTurnState | null>, opts: MainOpts = {}) {
  const clock = { now: RESTART };
  const live = { status: new Map<string, string>(), turnStart: new Map<string, number>(), turnEnd: new Map<string, number>(), input: new Map<string, number>() };
  const panes = opts.panes ?? (() => [WORKER, SHELL]);
  const sessions = opts.sessions ?? (() => [workerSession(), shellSession()]);
  const readState = vi.fn(read);
  const seed = createDaemonTurnSeed({
    tasks: () => {
      const p = panes();
      return p ? [{ taskId: reported().id, reportedAt: REPORT, panes: p, recorded: opts.recorded ?? [], launched: opts.launched ?? [WORKER] }] : null;
    },
    ready: opts.ready ?? (() => true),
    listSessions: async () => sessions(),
    readState,
    liveEvidence: (id) => live.turnEnd.has(id) || live.turnStart.has(id),
    now: () => clock.now,
  });
  const activity = (id: string): PaneActivity => {
    const status = live.status.get(id);
    const turnStartAt = live.turnStart.get(id);
    const turnEndAt = live.turnEnd.get(id);
    const inputAt = live.input.get(id);
    return mergePaneActivity({
      ...(status !== undefined ? { status } : {}),
      ...(turnStartAt !== undefined ? { turnStartAt } : {}),
      ...(turnEndAt !== undefined ? { turnEndAt } : {}),
      ...(inputAt !== undefined ? { inputAt } : {}),
    }, seed.activity(id));
  };
  const ownPanes = (entry: LedgerEntry): string[] | null => reportedWorkerPanes(seed.workerPanes(entry.id), panes());
  const idleAt = (at: number, entry: LedgerEntry = reported()): boolean => {
    const own = ownPanes(entry);
    return !!own && workerPanesIdle(own.map(activity), entry.updatedAt, at, REPORTED_IDLE_MS);
  };
  return { clock, live, seed, readState, activity, idleAt, ownPanes, sessions };
}

/** One reclaim look at `at` (the install catch-up), wired as the host wires
 *  it (confirmIdle: the daemon read again, then the window again): the
 *  panes it stopped. */
async function reclaimLook(
  main: ReturnType<typeof restartedMain>,
  at: number,
  over: { worktreeOf?: () => Promise<string | null>; stopAgent?: (id: string, opts?: { ifTurnClosed?: boolean }) => Promise<{ ok: boolean; stopped?: boolean; code?: string }> } = {},
): Promise<string[]> {
  main.clock.now = at;
  const store = ReclaimedWorkers.at(path.join(dir, `store-${at}-${Math.random()}`));
  const entry = reported();
  type Stop = (id: string, opts?: { ifTurnClosed?: boolean }) => Promise<{ ok: boolean; stopped?: boolean; code?: string }>;
  const stopAgent = vi.fn<Stop>(over.stopAgent ?? (async () => ({ ok: true, stopped: true })));
  const off = installWorkerReclaim({
    onTransition: () => () => undefined,
    allRows: () => [entry],
    row: () => entry,
    store,
    worktreeOf: over.worktreeOf ?? (async () => wt),
    listSessions: async () => main.sessions(),
    stopAgent,
    now: () => at,
    log: () => undefined,
    turnEnded: (e) => main.idleAt(at, e),
    reportedPanes: main.ownPanes,
    confirmIdle: async (e) => (await main.seed.confirmIdle(main.ownPanes(e) ?? [])) && main.idleAt(at, e),
    workspacePanes: () => [WORKER, SHELL],
  });
  await new Promise((r) => setTimeout(r, 50));
  await vi.waitFor(() => expect(store.get(entry.id)?.state ?? 'none').not.toBe('stopping'), { timeout: 10_000 });
  off();
  const rec = store.get(entry.id);
  if (rec) await store.put(rec);
  // Only the stops that went through (a `turn_open` refusal signalled nothing).
  const results = await Promise.all(stopAgent.mock.results.map((r) => r.value as Promise<{ code?: string }>));
  return stopAgent.mock.calls.filter((_c, i) => results[i]?.code !== 'turn_open').map((c) => c[0]);
}

describe('a reported task\'s own worker pane', () => {
  it('taskWorkerPanes: the recorded pane only; else the one agent pane the task launched; never a plain shell', () => {
    const owners: WorkerSessionInfo = { ...workerSession(), id: 'daemon-3' };
    // The pane the task's launch created, the only agent pane: the worker.
    expect(taskWorkerPanes([WORKER, SHELL], [], [WORKER], [workerSession(), shellSession()])).toEqual([WORKER]);
    // An agent pane the task did not launch: none.
    expect(taskWorkerPanes([WORKER, SHELL], [], [], [workerSession(), shellSession()])).toEqual([]);
    // Two agent panes (the owner's own Claude beside the worker): none.
    expect(taskWorkerPanes([WORKER, 'daemon-3'], [], [WORKER], [workerSession(), owners])).toEqual([]);
    // Recorded: that pane only, never another agent pane.
    expect(taskWorkerPanes([WORKER, 'daemon-3'], ['daemon-3'], [WORKER], [workerSession(), owners])).toEqual(['daemon-3']);
    // A recorded worker that exited beside the owner's agent: none.
    expect(taskWorkerPanes([WORKER, 'daemon-3'], [WORKER], [WORKER], [{ ...workerSession(), agentProcessAlive: false }, owners])).toEqual([]);
    expect(taskWorkerPanes([SHELL], [], [SHELL], [shellSession()])).toEqual([]);
    // Not a session the daemon knows.
    expect(taskWorkerPanes([WORKER], [], [WORKER], [])).toEqual([]);
    expect(reportedWorkerPanes(null, [WORKER])).toEqual([]);
    expect(reportedWorkerPanes([WORKER], null)).toBeNull();
    expect(reportedWorkerPanes([WORKER, 'gone'], [WORKER, SHELL])).toEqual([WORKER]);
  });

  it('a worker pane (closed turn) beside a plain shell: stopped on the 5-minute path from its own pane; the shell never counted, never stopped', async () => {
    const main = restartedMain(async () => CLOSED);
    await main.seed.pass();
    expect(main.seed.workerPanes(reported().id)).toEqual([WORKER]);
    // Only the worker pane is read.
    expect(main.readState.mock.calls.map((c) => c[0])).toEqual([WORKER]);
    expect(main.seed.activity(SHELL)).toBeNull();
    expect(await reclaimLook(main, REPORT + 4 * MIN)).toEqual([]);
    expect(await reclaimLook(main, REPORT + 5 * MIN + 1)).toEqual([WORKER]);
  });

  it('a worker pane that cannot be identified (no agent runs in any pane) is not idle and nothing is stopped', async () => {
    const main = restartedMain(async () => CLOSED, { sessions: () => [{ ...workerSession(), agentProcessAlive: false }, shellSession()] });
    await main.seed.pass();
    expect(main.seed.workerPanes(reported().id)).toBeNull();
    expect(main.readState).not.toHaveBeenCalled();
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
    expect(await reclaimLook(main, REPORT + 60 * MIN)).toEqual([]);
    // Before any pass (the daemon not read yet) the same.
    const fresh = restartedMain(async () => CLOSED);
    expect(fresh.idleAt(REPORT + 60 * MIN)).toBe(false);
  });

  it('the owner\'s agent beside a dead worker: nothing is stopped, recorded or not', async () => {
    const owners: WorkerSessionInfo = { ...workerSession(), id: 'daemon-3' };
    const dead = { ...workerSession(), agentProcessAlive: false };
    for (const recorded of [[WORKER], []]) {
      const main = restartedMain(async () => CLOSED, { panes: () => [WORKER, 'daemon-3'], sessions: () => [dead, owners], recorded });
      await main.seed.pass();
      expect(main.seed.workerPanes(reported().id)).toBeNull();
      expect(main.readState).not.toHaveBeenCalled();
      expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
      expect(await reclaimLook(main, REPORT + 60 * MIN)).toEqual([]);
    }
    // The owner's idle Claude beside the live worker, no record: two agents, none identified.
    const both = restartedMain(async () => CLOSED, { panes: () => [WORKER, 'daemon-3'], sessions: () => [workerSession(), owners] });
    await both.seed.pass();
    expect(both.seed.workerPanes(reported().id)).toBeNull();
    expect(await reclaimLook(both, REPORT + 60 * MIN)).toEqual([]);
    // The only agent pane, but not one the task launched: none.
    const foreign = restartedMain(async () => CLOSED, { launched: [] });
    await foreign.seed.pass();
    expect(foreign.seed.workerPanes(reported().id)).toBeNull();
    expect(await reclaimLook(foreign, REPORT + 60 * MIN)).toEqual([]);
  });

  it('live, the shell pane never holds the worker either: only the worker pane\'s own turn end counts', async () => {
    const main = restartedMain(async () => CLOSED);
    main.live.turnEnd.set(WORKER, RESTART);
    main.live.status.set(WORKER, 'complete');
    await main.seed.pass();
    expect(main.readState).not.toHaveBeenCalled();
    expect(main.idleAt(RESTART + 5 * MIN)).toBe(true);
    expect(await reclaimLook(main, RESTART + 5 * MIN)).toEqual([WORKER]);
  });
});

describe('after a restart: the daemon reports the worker\'s turn closed', () => {
  it('is stopped once 5 minutes passed since the report, not 30', async () => {
    const main = restartedMain(async () => CLOSED, { panes: () => [WORKER] });
    // Before the read main knows nothing of the pane: not idle.
    expect(main.idleAt(REPORT + 6 * MIN)).toBe(false);
    await main.seed.pass();
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
    expect(await reclaimLook(main, REPORT + 4 * MIN)).toEqual([]);
    expect(await reclaimLook(main, REPORT + 5 * MIN + 1)).toEqual([WORKER]);
  });

  it('a result that settled after the report (the worker kept working) counts its window from that result', async () => {
    // The owner prompted the worker after its report; that turn ended 30 s before the restart.
    const main = restartedMain(async () => ({ ...CLOSED, settledAgoMs: 30_000 }));
    await main.seed.pass();
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: RESTART - 30_000 });
    expect(main.idleAt(RESTART + 4 * MIN)).toBe(false);
    expect(main.idleAt(RESTART - 30_000 + 5 * MIN)).toBe(true);
    // A result older than the report: the report is the floor.
    const older = restartedMain(async () => ({ ...CLOSED, settledAgoMs: 60 * MIN }));
    await older.seed.pass();
    expect(older.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
  });

  it('a settled result (complete, waiting, error) counts as closed too', async () => {
    for (const agentStatus of ['complete', 'waiting', 'error']) {
      const main = restartedMain(async () => ({ ...CLOSED, agentStatus }));
      await main.seed.pass();
      expect(main.idleAt(REPORT + 5 * MIN)).toBe(true);
    }
  });

  it('a pane typed into before the restart counts its window from that input', async () => {
    const main = restartedMain(async () => ({ ...CLOSED, keyInputIdleMs: MIN }));
    await main.seed.pass();
    // Typed at RESTART - 1 min = report + 3 min.
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT, inputAt: RESTART - MIN });
    expect(main.idleAt(REPORT + 7 * MIN)).toBe(false);
    expect(main.idleAt(REPORT + 8 * MIN)).toBe(true);
  });
});

describe('after a restart: the daemon reports the worker\'s turn open', () => {
  it('turnOpen true, a running turn, a prompt waiting or no hook seen is never idle, and is read again later', async () => {
    const states: DaemonTurnState[] = [
      { agentStatus: 'idle', turnOpen: true, hookReports: true },
      { agentStatus: 'running', turnOpen: true, hookReports: true },
      { agentStatus: 'running', turnOpen: false, hookReports: true },
      { agentStatus: 'awaiting_input', turnOpen: false, hookReports: true },
      { agentStatus: 'idle', turnOpen: false, hookReports: false },
      { agentStatus: 'idle', turnOpen: false },
    ];
    for (const state of states) {
      const main = restartedMain(async () => state);
      await main.seed.pass();
      expect(main.seed.activity(WORKER)).toBeNull();
      expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
      expect(await reclaimLook(main, REPORT + 60 * MIN)).toEqual([]);
    }
    // Read again on the slower cadence, never given up on.
    let answer: DaemonTurnState = { agentStatus: 'running', turnOpen: true, hookReports: true };
    const main = restartedMain(async () => answer);
    for (let i = 0; i < 5; i++) await main.seed.pass();
    expect(main.readState).toHaveBeenCalledTimes(1);
    answer = CLOSED;
    main.clock.now += TURN_SEED_OPEN_RECHECK_MS;
    await main.seed.pass();
    expect(main.readState).toHaveBeenCalledTimes(2);
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
  });
});

describe('after a restart: the daemon cannot say', () => {
  it('no state (no session, a failed or timed-out read) and an older daemon without turnOpen stay not idle, as before', async () => {
    const reads: Array<() => Promise<DaemonTurnState | null>> = [
      async () => null,
      async () => { throw new Error('timeout'); },
      async () => ({ agentStatus: 'idle', hookReports: true }),
      async () => ({ agentStatus: 'complete' }),
    ];
    for (const read of reads) {
      const main = restartedMain(read);
      await main.seed.pass();
      expect(main.seed.activity(WORKER)).toBeNull();
      expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
      expect(await reclaimLook(main, REPORT + 60 * MIN)).toEqual([]);
    }
  });

  it('a read that came back empty is read again with a growing delay, never given up on', async () => {
    let answer: DaemonTurnState | null = null;
    const main = restartedMain(async () => answer);
    await main.seed.pass();
    expect(main.readState).toHaveBeenCalledTimes(1);
    // Not again before its delay.
    await main.seed.pass();
    expect(main.readState).toHaveBeenCalledTimes(1);
    // The delay doubles per failure up to its cap; reads go on past any count.
    let delay = TURN_SEED_RETRY_MS;
    for (let i = 2; i <= 12; i++) {
      main.clock.now += delay - 1;
      await main.seed.pass();
      expect(main.readState).toHaveBeenCalledTimes(i - 1);
      main.clock.now += 1;
      await main.seed.pass();
      expect(main.readState).toHaveBeenCalledTimes(i);
      delay = Math.min(delay * 2, TURN_SEED_RETRY_MAX_MS);
    }
    expect(delay).toBe(TURN_SEED_RETRY_MAX_MS);
    // The daemon answers at last: seeded, and not read again.
    answer = CLOSED;
    main.clock.now += delay;
    await main.seed.pass();
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
    await main.seed.pass();
    expect(main.readState).toHaveBeenCalledTimes(13);
  });

  it('a read lost to a disconnect is not counted, and a reconnect reads again at once', async () => {
    let ready = true;
    const main = restartedMain(async () => {
      ready = false;
      return null;
    }, { ready: () => ready });
    // Every read drops the connection: none waits out a delay.
    for (let i = 0; i < 4; i++) {
      ready = true;
      await main.seed.pass();
    }
    expect(main.readState).toHaveBeenCalledTimes(4);
    // A read that came back empty while connected waits its delay...
    const flaky = restartedMain(async () => null, { ready: () => ready });
    ready = true;
    await flaky.seed.pass();
    await flaky.seed.pass();
    expect(flaky.readState).toHaveBeenCalledTimes(1);
    // ...unless the daemon disconnects and connects again.
    ready = false;
    await flaky.seed.pass();
    ready = true;
    await flaky.seed.pass();
    expect(flaky.readState).toHaveBeenCalledTimes(2);
  });

  it('reads nothing while the daemon is not connected or the workspace tree is not known', async () => {
    let ready = false;
    let tree: string[] | null = null;
    const main = restartedMain(async () => CLOSED, { ready: () => ready, panes: () => tree });
    await main.seed.pass();
    tree = [WORKER, SHELL];
    for (let i = 0; i < 4; i++) await main.seed.pass();
    expect(main.readState).not.toHaveBeenCalled();
    ready = true;
    await main.seed.pass();
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
    // A pane that is no longer a reported worker's keeps no seed.
    tree = [];
    await main.seed.pass();
    expect(main.seed.activity(WORKER)).toBeNull();
    expect(main.seed.workerPanes(reported().id)).toBeNull();
  });
});

describe('after a restart: live evidence wins over the daemon read', () => {
  it('mergePaneActivity: the later turn end and the later input count', () => {
    const seeded = { turnEndAt: REPORT, inputAt: RESTART - MIN };
    expect(mergePaneActivity({}, seeded)).toEqual({ turnEndAt: REPORT, inputAt: RESTART - MIN });
    expect(mergePaneActivity({ turnEndAt: RESTART + MIN, inputAt: RESTART + 2 * MIN, status: 'complete' }, seeded))
      .toEqual({ turnEndAt: RESTART + MIN, inputAt: RESTART + 2 * MIN, status: 'complete' });
    // A result the daemon saw settle after main's own last turn end (its hooks missed).
    expect(mergePaneActivity({ turnEndAt: REPORT - MIN, inputAt: REPORT - 2 * MIN }, seeded)).toEqual({ turnEndAt: REPORT, inputAt: RESTART - MIN });
    expect(mergePaneActivity({ turnStartAt: RESTART }, null)).toEqual({ turnStartAt: RESTART });
  });

  it('live input after the restart beats the seeded input', async () => {
    const main = restartedMain(async () => ({ ...CLOSED, keyInputIdleMs: 2 * MIN }));
    await main.seed.pass();
    main.live.input.set(WORKER, RESTART + 3 * MIN);
    expect(main.activity(WORKER).inputAt).toBe(RESTART + 3 * MIN);
    expect(main.idleAt(RESTART + 7 * MIN)).toBe(false);
    expect(main.idleAt(RESTART + 8 * MIN)).toBe(true);
  });

  it('a live hook turn start after the read keeps the worker until its own turn end, counted from that end', async () => {
    const main = restartedMain(async () => CLOSED);
    await main.seed.pass();
    // The owner prompts the worker after the restart.
    main.live.turnStart.set(WORKER, RESTART + MIN);
    main.live.status.set(WORKER, 'running');
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
    expect(await reclaimLook(main, REPORT + 60 * MIN)).toEqual([]);
    // Its turn ends live: the window runs from that end.
    main.live.turnEnd.set(WORKER, RESTART + 2 * MIN);
    main.live.status.set(WORKER, 'complete');
    expect(main.idleAt(RESTART + 6 * MIN)).toBe(false);
    expect(main.idleAt(RESTART + 7 * MIN)).toBe(true);
  });

  it('live evidence that arrives while the read is out leaves the pane unseeded', async () => {
    let release: (s: DaemonTurnState) => void = () => undefined;
    const main = restartedMain(() => new Promise<DaemonTurnState>((resolve) => { release = resolve; }));
    const pass = main.seed.pass();
    await vi.waitFor(() => expect(main.readState).toHaveBeenCalled(), { timeout: 10_000 });
    // A hook turn start lands before the daemon's answer.
    main.live.turnStart.set(WORKER, RESTART + 1);
    main.live.status.set(WORKER, 'running');
    release(CLOSED);
    await pass;
    expect(main.seed.activity(WORKER)).toBeNull();
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
  });

  it('a seed made stale by a missed turn start stops nothing: the daemon is read again right before the stop', async () => {
    let answer: DaemonTurnState = CLOSED;
    const main = restartedMain(async () => answer);
    await main.seed.pass();
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(true);
    // A turn starts and main misses its hook: the daemon now shows it open.
    for (const open of [
      { agentStatus: 'idle', turnOpen: true, hookReports: true },
      { agentStatus: 'running', turnOpen: false, hookReports: true },
      { agentStatus: 'awaiting_input', turnOpen: false, hookReports: true },
    ] as DaemonTurnState[]) {
      answer = open;
      expect(await main.seed.confirmIdle([WORKER])).toBe(false);
    }
    answer = { agentStatus: 'running', turnOpen: true, hookReports: true };
    expect(await reclaimLook(main, REPORT + 60 * MIN)).toEqual([]);
    // Its stale seed is gone: not idle until it is read closed again.
    expect(main.seed.activity(WORKER)).toBeNull();
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
    // No answer, or an older daemon that does not say, confirms nothing either.
    for (const unsure of [null, { agentStatus: 'idle' }] as Array<DaemonTurnState | null>) {
      const fresh = restartedMain(async () => CLOSED);
      await fresh.seed.pass();
      fresh.readState.mockImplementation(async () => unsure);
      expect(await reclaimLook(fresh, REPORT + 60 * MIN)).toEqual([]);
      expect(fresh.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
    }
    // Read closed again later (its turn just ended): stopped from that end.
    answer = { ...CLOSED, settledAgoMs: 0 };
    main.clock.now = RESTART + TURN_SEED_OPEN_RECHECK_MS;
    await main.seed.pass();
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: RESTART + TURN_SEED_OPEN_RECHECK_MS });
    // Five minutes on, the re-read before the stop shows that same end.
    answer = { ...CLOSED, settledAgoMs: 5 * MIN };
    expect(await reclaimLook(main, RESTART + TURN_SEED_OPEN_RECHECK_MS + 5 * MIN)).toEqual([WORKER]);
  });

  it('a turn that opens while the reclaim awaits its lookups stops nothing: the daemon is read again as the last step', async () => {
    let answer: DaemonTurnState = CLOSED;
    const main = restartedMain(async () => answer);
    await main.seed.pass();
    // The task folder lookup is out when the worker's turn starts; main misses its hook.
    const worktreeOf = async (): Promise<string> => {
      answer = { agentStatus: 'idle', turnOpen: true, hookReports: true };
      return wt;
    };
    expect(await reclaimLook(main, REPORT + 60 * MIN, { worktreeOf })).toEqual([]);
    // The same while the session listing is out.
    const listing = restartedMain(async () => answer);
    answer = CLOSED;
    await listing.seed.pass();
    const sessions = listing.sessions;
    const lateOpen = { ...listing, sessions: () => {
      // The reclaim's own session listing is out: the turn opens now.
      answer = { agentStatus: 'running', turnOpen: true, hookReports: true };
      return sessions();
    } };
    expect(await reclaimLook(lateOpen, REPORT + 60 * MIN)).toEqual([]);
  });

  it('the stop itself is conditional: a daemon that finds the turn open refuses it, and no attempt is spent', async () => {
    const main = restartedMain(async () => CLOSED);
    await main.seed.pass();
    const seen: Array<{ ifTurnClosed?: boolean } | undefined> = [];
    const stopAgent = async (...args: [string, { ifTurnClosed?: boolean }?]) => {
      const opts = args[1];
      seen.push(opts);
      return { ok: false, code: 'turn_open' };
    };
    expect(await reclaimLook(main, REPORT + 60 * MIN, { stopAgent })).toEqual([]);
    expect(seen).toEqual([{ ifTurnClosed: true }]);
    // Refused every time: the reclaim keeps looking, never giving up.
    const store = ReclaimedWorkers.at(path.join(dir, 'refused'));
    const entry = reported();
    let open = true;
    const stop = vi.fn<(id: string, opts?: { ifTurnClosed?: boolean }) => Promise<{ ok: boolean; stopped?: boolean; code?: string }>>(async () => (open ? { ok: false, code: 'turn_open' } : { ok: true, stopped: true }));
    const off = installWorkerReclaim({
      onTransition: () => () => undefined,
      allRows: () => [entry],
      row: () => entry,
      store,
      worktreeOf: async () => wt,
      listSessions: async () => [workerSession()],
      stopAgent: stop,
      now: () => REPORT + 60 * MIN,
      log: () => undefined,
      retryMs: 5,
      turnEnded: () => true,
      reportedPanes: () => [WORKER],
      workspacePanes: () => [WORKER],
    });
    try {
      await vi.waitFor(() => expect(stop.mock.calls.length).toBeGreaterThan(RECLAIM_ATTEMPTS_MAX + 1), { timeout: 10_000 });
      expect(store.get(entry.id)?.state ?? 'none').not.toBe('stopped');
      open = false;
      await vi.waitFor(() => expect(store.get(entry.id)?.state).toBe('stopped'), { timeout: 10_000 });
    } finally {
      off();
    }
    const rec = store.get(entry.id);
    if (rec) await store.put(rec);
  });

  it('the re-read\'s fresh times count: a result that just settled or a key just typed holds the stop', async () => {
    let answer: DaemonTurnState = CLOSED;
    const main = restartedMain(async () => answer);
    await main.seed.pass();
    const at = REPORT + 60 * MIN;
    expect(main.idleAt(at)).toBe(true);
    // A turn ran and ended 1 minute ago, its hooks missed.
    answer = { ...CLOSED, settledAgoMs: MIN };
    expect(await reclaimLook(main, at)).toEqual([]);
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: at - MIN });
    expect(main.idleAt(at)).toBe(false);
    expect(main.idleAt(at + 4 * MIN)).toBe(true);
    // Someone typed into it 30 seconds ago.
    const typed = restartedMain(async () => answer);
    answer = CLOSED;
    await typed.seed.pass();
    answer = { ...CLOSED, keyInputIdleMs: 30_000 };
    expect(await reclaimLook(typed, at)).toEqual([]);
    expect(typed.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT, inputAt: at - 30_000 });
    // Once the window has run from those times, it is stopped.
    answer = { ...CLOSED, settledAgoMs: 5 * MIN, keyInputIdleMs: 5 * MIN };
    expect(await reclaimLook(main, at + 4 * MIN)).toEqual([WORKER]);
  });

  it('a stop the re-read refuses spends no attempt: once the turn is over the worker is stopped', async () => {
    const store = ReclaimedWorkers.at(path.join(dir, 'confirm'));
    const entry = reported();
    let closed = false;
    const confirmIdle = vi.fn(async () => closed);
    const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
    const off = installWorkerReclaim({
      onTransition: () => () => undefined,
      allRows: () => [entry],
      row: () => entry,
      store,
      worktreeOf: async () => wt,
      listSessions: async () => [workerSession()],
      stopAgent,
      now: () => REPORT + 60 * MIN,
      log: () => undefined,
      retryMs: 5,
      turnEnded: () => true,
      reportedPanes: () => [WORKER],
      confirmIdle,
      workspacePanes: () => [WORKER],
    });
    try {
      await vi.waitFor(() => expect(confirmIdle.mock.calls.length).toBeGreaterThan(RECLAIM_ATTEMPTS_MAX + 1), { timeout: 10_000 });
      expect(stopAgent).not.toHaveBeenCalled();
      closed = true;
      await vi.waitFor(() => expect(store.get(entry.id)?.state).toBe('stopped'), { timeout: 10_000 });
      expect(stopAgent).toHaveBeenCalledWith(WORKER, { ifTurnClosed: true });
    } finally {
      off();
    }
    const rec = store.get(entry.id);
    if (rec) await store.put(rec);
  });

  it('a live byte-rate running status keeps a seeded pane', async () => {
    const main = restartedMain(async () => CLOSED);
    await main.seed.pass();
    main.live.status.set(WORKER, 'running');
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
  });
});

describe('the last step before a reported worker\'s stop', () => {
  const SECOND = 'daemon-3';
  function twoPanes(over: Partial<WorkerReclaimPorts> = {}) {
    const store = ReclaimedWorkers.at(path.join(dir, `two-${Math.random()}`));
    let current = reported();
    const stopAgent = vi.fn<(id: string, opts?: { ifTurnClosed?: boolean }) => Promise<{ ok: boolean; stopped?: boolean; code?: string }>>(async () => ({ ok: true, stopped: true }));
    const ports: WorkerReclaimPorts = {
      onTransition: () => () => undefined,
      row: () => current,
      store,
      worktreeOf: async () => wt,
      listSessions: async () => [workerSession(), { ...workerSession(), id: SECOND }],
      stopAgent,
      now: () => REPORT + 60 * MIN,
      log: () => undefined,
      turnEnded: () => true,
      reportedPanes: () => [WORKER, SECOND],
      workspacePanes: () => [WORKER, SECOND],
      ...over,
    };
    return { ports, store, stopAgent, setRow: (r: LedgerEntry) => { current = r; } };
  }

  it('a row that moved on while the daemon was read again has nothing stopped', async () => {
    const t = twoPanes({ reportedPanes: () => [WORKER], workspacePanes: () => [WORKER] });
    t.ports.confirmIdle = async () => {
      // The task is sent back to working while the read is out.
      t.setRow(reported({ status: 'working', rev: 4 }));
      return true;
    };
    const out: { deferred?: boolean } = {};
    expect(await reclaimWorker(t.ports, reported(), 'reported', out)).toBeNull();
    expect(t.stopAgent).not.toHaveBeenCalled();
    expect(t.store.get(reported().id)).toBeNull();
    expect(out.deferred).toBeUndefined();
  });

  it('a second pane the daemon refuses (turn_open) leaves the record stopping, and the next look stops it', async () => {
    const t = twoPanes();
    t.stopAgent.mockImplementation(async (id) => (id === SECOND ? { ok: false, code: 'turn_open' } : { ok: true, stopped: true }));
    const out: { deferred?: boolean } = {};
    const rec = await reclaimWorker(t.ports, reported(), 'reported', out);
    expect(t.stopAgent.mock.calls.map((c) => c[0])).toEqual([WORKER, SECOND]);
    expect(rec?.state).toBe('stopping');
    expect(out.deferred).toBe(true);
    // Not covered: a later sweep looks again and stops the surviving agent.
    expect(isReclaimedSince(t.store.get(reported().id), reported())).toBe(false);
    t.stopAgent.mockImplementation(async () => ({ ok: true, stopped: true }));
    t.ports.listSessions = async () => [{ ...workerSession(), agentProcessAlive: false }, { ...workerSession(), id: SECOND }];
    t.ports.reportedPanes = () => [SECOND];
    expect((await reclaimWorker(t.ports, reported(), 'reported'))?.state).toBe('stopped');
    expect(t.stopAgent.mock.calls.at(-1)?.[0]).toBe(SECOND);
    const last = t.store.get(reported().id);
    if (last) await t.store.put(last);
  });

  it('a turn that opens in the second pane after the first is stopped leaves the record stopping; the next sweep stops it', async () => {
    let turnOver = true;
    const t = twoPanes({ turnEnded: () => turnOver });
    t.stopAgent.mockImplementation(async (id) => {
      // Pane B starts a turn while pane A is being stopped; the row is unchanged.
      if (id === WORKER) turnOver = false;
      return { ok: true, stopped: true };
    });
    const out: { deferred?: boolean } = {};
    const rec = await reclaimWorker(t.ports, reported(), 'reported', out);
    expect(t.stopAgent.mock.calls.map((c) => c[0])).toEqual([WORKER]);
    expect(rec?.state).toBe('stopping');
    expect(out.deferred).toBe(true);
    expect(isReclaimedSince(t.store.get(reported().id), reported())).toBe(false);
    // B's turn ends and it sits idle: the next sweep stops it.
    turnOver = true;
    t.stopAgent.mockImplementation(async () => ({ ok: true, stopped: true }));
    t.ports.listSessions = async () => [{ ...workerSession(), agentProcessAlive: false }, { ...workerSession(), id: SECOND }];
    t.ports.reportedPanes = () => [SECOND];
    expect((await reclaimWorker(t.ports, reported(), 'reported'))?.state).toBe('stopped');
    expect(t.stopAgent.mock.calls.at(-1)?.[0]).toBe(SECOND);
    const last = t.store.get(reported().id);
    if (last) await t.store.put(last);
  });

  it('a row sent back to working after the first stop: the open row counts what still runs', async () => {
    const t = twoPanes();
    t.stopAgent.mockImplementation(async (id) => {
      if (id === WORKER) t.setRow(reported({ status: 'working', rev: 4 }));
      return { ok: true, stopped: true };
    });
    const out: { deferred?: boolean } = {};
    const rec = await reclaimWorker(t.ports, reported(), 'reported', out);
    expect(t.stopAgent.mock.calls.map((c) => c[0])).toEqual([WORKER]);
    // Recorded for that report (the open row is the worker's now), no card, no deferral.
    expect(rec?.state).toBe('stopped');
    expect(out.deferred).toBeUndefined();
    const last = t.store.get(reported().id);
    if (last) await t.store.put(last);
  });

  it('a confirmation that turns false after the first stop leaves the record stopping', async () => {
    const t = twoPanes();
    let reads = 0;
    t.ports.confirmIdle = async () => {
      reads += 1;
      return reads === 1;
    };
    const out: { deferred?: boolean } = {};
    const rec = await reclaimWorker(t.ports, reported(), 'reported', out);
    expect(t.stopAgent.mock.calls.map((c) => c[0])).toEqual([WORKER]);
    expect(rec?.state).toBe('stopping');
    expect(rec?.sessions.map((x) => x.sessionId)).toEqual([WORKER, SECOND]);
    expect(out.deferred).toBe(true);
    expect(isReclaimedSince(t.store.get(reported().id), reported())).toBe(false);
    const last = t.store.get(reported().id);
    if (last) await t.store.put(last);
  });
});
