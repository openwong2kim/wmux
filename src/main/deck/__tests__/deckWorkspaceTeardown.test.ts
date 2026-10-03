import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teardownWorkspaceDeckState, surfaceStrandedWork } from '../deckWorkspaceTeardown';
import { setWorkspaceMode, loadDeckAutonomy, getDeckAutonomyPath } from '../deckAutonomyStore';
import * as deckLoopStateStore from '../deckLoopStateStore';
import { startLoop, loadWorkspaceLoopState, getDeckLoopStatePath } from '../deckLoopStateStore';
import { saveDeckSchedules, loadDeckSchedules, getDeckSchedulesPath, mutateDeckSchedules } from '../deckScheduleStore';
import {
  beginOrContinueDeckWork,
  recordDeckWorkA2aTask,
  loadActiveDeckWork,
  getDeckWorkPath,
  archiveDeckWork,
  getDeckWorkArchivePath,
  loadArchivedDeckWorks,
  MAX_ARCHIVED_DECK_WORKS,
  type ActiveDeckWork,
} from '../deckWorkStore';
import { raiseDecision, loadWorkspaceDecision, getDeckDecisionPath } from '../deckDecisionStore';
import {
  saveCommanderSession,
  loadCommanderSession,
  getCommanderSessionPath,
} from '../commanderSessionStore';
import { setHqWorkspaceId } from '../deckHqStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-teardown-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckWorkspaceTeardown — teardownWorkspaceDeckState', () => {
  it('tears down all Deck state for target workspace, leaves other workspace untouched', async () => {
    // 1. Autonomy
    await setWorkspaceMode('ws-x', 'danger', dir);
    await setWorkspaceMode('ws-y', 'assist', dir);

    // 2. Schedule
    await saveDeckSchedules(
      [
        {
          id: 'sched-loop-x',
          workspaceId: 'ws-x',
          prompt: 'loop prompt x',
          nextRunAt: Date.now() + 10000,
          enabled: true,
          createdAt: Date.now(),
        },
        {
          id: 'sched-extra-x',
          workspaceId: 'ws-x',
          prompt: 'extra prompt x',
          nextRunAt: Date.now() + 20000,
          enabled: true,
          createdAt: Date.now(),
        },
        {
          id: 'sched-y',
          workspaceId: 'ws-y',
          prompt: 'prompt y',
          nextRunAt: Date.now() + 30000,
          enabled: true,
          createdAt: Date.now(),
        },
      ],
      dir,
    );

    // 3. Loop
    await startLoop(
      'ws-x',
      {
        objective: 'loop objective x',
        taskTexts: ['task 1'],
        tier: 'continue',
        iterations: 5,
        scheduleId: 'sched-loop-x',
      },
      dir,
    );
    await startLoop(
      'ws-y',
      {
        objective: 'loop objective y',
        taskTexts: ['task 2'],
        tier: 'continue',
        iterations: 5,
      },
      dir,
    );

    // 4. Work
    beginOrContinueDeckWork('ws-x', 'request x', dir);
    recordDeckWorkA2aTask('ws-x', { taskId: 'task-1', to: 'worker', state: 'working', ts: Date.now() }, dir);
    beginOrContinueDeckWork('ws-y', 'request y', dir);

    // 5. Decision
    await raiseDecision('ws-x', { question: 'question x?' }, dir);
    await raiseDecision('ws-y', { question: 'question y?' }, dir);

    // 6. Commander sessions
    await saveCommanderSession('ws-x', 'sess-claude-x', dir);
    await saveCommanderSession('ws-x::claude-pty', 'sess-pty-x', dir);
    await saveCommanderSession('ws-y', 'sess-y', dir);
    await saveCommanderSession('ws-y::hermes', 'sess-hermes-y', dir);

    const strandedReports: ActiveDeckWork[] = [];
    const logLines: string[] = [];

    const report = await teardownWorkspaceDeckState('ws-x', {
      dir,
      onStrandedWork: (work) => strandedReports.push(work),
      log: (line) => logLines.push(line),
    });

    // Report asserts
    expect(report.workspaceId).toBe('ws-x');
    expect(report.scheduleDeleted).toBe(true);
    expect(report.scheduleIds).toContain('sched-loop-x');
    expect(report.scheduleIds).toContain('sched-extra-x');
    expect(report.loopCleared).toBe(true);
    expect(report.workCleared).toBe(true);
    expect(report.strandedWork).not.toBeNull();
    expect(report.strandedWork?.objective).toBe('request x');
    expect(report.autonomyDeleted).toBe(true);
    expect(report.decisionCleared).toBe(true);
    expect(report.commanderSessionsCleared).toContain('ws-x');
    expect(report.commanderSessionsCleared).toContain('ws-x::claude-pty');

    // onStrandedWork received the removed work
    expect(strandedReports).toHaveLength(1);
    expect(strandedReports[0].id).toBe(report.strandedWork?.id);

    // Log lines assert: exactly one line per store (6 stores)
    expect(logLines).toHaveLength(6);
    expect(logLines.some((l) => l.startsWith('[schedule]'))).toBe(true);
    expect(logLines.some((l) => l.startsWith('[loop]'))).toBe(true);
    expect(logLines.some((l) => l.startsWith('[work]'))).toBe(true);
    expect(logLines.some((l) => l.startsWith('[autonomy]'))).toBe(true);
    expect(logLines.some((l) => l.startsWith('[decision]'))).toBe(true);
    expect(logLines.some((l) => l.startsWith('[commander]'))).toBe(true);

    // Verify all 6 stores via their getters
    expect(loadWorkspaceLoopState('ws-x', dir)).toBeNull();
    expect(loadActiveDeckWork('ws-x', dir)).toBeNull();
    expect(loadDeckAutonomy(dir)['ws-x']).toBeUndefined();
    expect(loadWorkspaceDecision('ws-x', dir)).toBeNull();
    expect(loadCommanderSession('ws-x', dir)).toBeNull();
    expect(loadCommanderSession('ws-x::claude-pty', dir)).toBeNull();
    const schedulesAfter = loadDeckSchedules(dir);
    expect(schedulesAfter.some((s) => s.workspaceId === 'ws-x')).toBe(false);

    // Verify ws-y is untouched in all stores
    expect(loadWorkspaceLoopState('ws-y', dir)?.objective).toBe('loop objective y');
    expect(loadActiveDeckWork('ws-y', dir)?.objective).toBe('request y');
    expect(loadDeckAutonomy(dir)['ws-y']?.mode).toBe('assist');
    expect(loadWorkspaceDecision('ws-y', dir)?.question).toBe('question y?');
    expect(loadCommanderSession('ws-y', dir)?.sessionId).toBe('sess-y');
    expect(loadCommanderSession('ws-y::hermes', dir)?.sessionId).toBe('sess-hermes-y');
    expect(schedulesAfter.some((s) => s.workspaceId === 'ws-y')).toBe(true);

    // Direct JSON file inspections: ws-x has no key in any of the six files
    const autonomyJson = JSON.parse(fs.readFileSync(getDeckAutonomyPath(dir), 'utf8'));
    expect(autonomyJson['ws-x']).toBeUndefined();
    expect(autonomyJson['ws-y']).toBeDefined();

    const loopJson = JSON.parse(fs.readFileSync(getDeckLoopStatePath(dir), 'utf8'));
    expect(loopJson['ws-x']).toBeUndefined();
    expect(loopJson['ws-y']).toBeDefined();

    const schedulesJson = JSON.parse(fs.readFileSync(getDeckSchedulesPath(dir), 'utf8'));
    expect(schedulesJson.find((s: { workspaceId?: string }) => s.workspaceId === 'ws-x')).toBeUndefined();
    expect(schedulesJson.find((s: { workspaceId?: string }) => s.workspaceId === 'ws-y')).toBeDefined();

    const workJson = JSON.parse(fs.readFileSync(getDeckWorkPath(dir), 'utf8'));
    expect(workJson.active['ws-x']).toBeUndefined();
    expect(workJson.active['ws-y']).toBeDefined();

    const decisionsJson = JSON.parse(fs.readFileSync(getDeckDecisionPath(dir), 'utf8'));
    expect(decisionsJson['ws-x']).toBeUndefined();
    expect(decisionsJson['ws-y']).toBeDefined();

    const commanderJson = JSON.parse(fs.readFileSync(getCommanderSessionPath(dir), 'utf8'));
    expect(commanderJson.sessions['ws-x']).toBeUndefined();
    expect(commanderJson.sessions['ws-x::claude-pty']).toBeUndefined();
    expect(commanderJson.sessions['ws-y']).toBeDefined();
    expect(commanderJson.sessions['ws-y::hermes']).toBeDefined();

    // Second call is a no-op without error (idempotent)
    const logLines2: string[] = [];
    const report2 = await teardownWorkspaceDeckState('ws-x', {
      dir,
      log: (line) => logLines2.push(line),
    });
    expect(report2.workspaceId).toBe('ws-x');
    expect(report2.scheduleDeleted).toBe(false);
    expect(report2.loopCleared).toBe(false);
    expect(report2.workCleared).toBe(false);
    expect(report2.autonomyDeleted).toBe(false);
    expect(report2.decisionCleared).toBe(false);
    expect(report2.commanderSessionsCleared).toEqual([]);
    expect(logLines2).toHaveLength(6);

    // ws-y is still intact after second call
    expect(loadWorkspaceLoopState('ws-y', dir)?.objective).toBe('loop objective y');
    expect(loadActiveDeckWork('ws-y', dir)?.objective).toBe('request y');
  });

  it('refuses an empty or non-string workspace id and returns a report with nothing done', async () => {
    const r1 = await teardownWorkspaceDeckState('', { dir });
    expect(r1.workspaceId).toBe('');
    expect(r1.scheduleDeleted).toBe(false);
    expect(r1.loopCleared).toBe(false);
    expect(r1.workCleared).toBe(false);

    const r2 = await teardownWorkspaceDeckState('   ', { dir });
    expect(r2.scheduleDeleted).toBe(false);

    const r3 = await teardownWorkspaceDeckState(null as unknown as string, { dir });
    expect(r3.scheduleDeleted).toBe(false);

    const r4 = await teardownWorkspaceDeckState(undefined as unknown as string, { dir });
    expect(r4.scheduleDeleted).toBe(false);
  });

  it('continues remaining store steps when one store step fails (corrupt / unwritable file)', async () => {
    // Write valid state in autonomy and decision
    await setWorkspaceMode('ws-fail', 'danger', dir);
    await raiseDecision('ws-fail', { question: 'will it survive?' }, dir);

    // Mock loop clear failure (e.g. unwritable / locked file)
    vi.spyOn(deckLoopStateStore, 'clearLoop').mockRejectedValueOnce(
      new Error('EACCES: permission denied, unwritable file'),
    );

    const logLines: string[] = [];
    const report = await teardownWorkspaceDeckState('ws-fail', {
      dir,
      log: (line) => logLines.push(line),
    });

    // Loop store failed, but autonomy and decision succeeded!
    expect(report.loopCleared).toBe(false);
    expect(report.autonomyDeleted).toBe(true);
    expect(report.decisionCleared).toBe(true);
    expect(loadDeckAutonomy(dir)['ws-fail']).toBeUndefined();
    expect(loadWorkspaceDecision('ws-fail', dir)).toBeNull();

    // Exactly 6 log lines recorded, with loop logging failure
    expect(logLines).toHaveLength(6);
    expect(logLines.some((l) => l.startsWith('[loop]') && l.includes('failed'))).toBe(true);
    expect(logLines.some((l) => l.startsWith('[autonomy]') && l.includes('deleted'))).toBe(true);
  });
});

describe('surfaceStrandedWork shared function', () => {
  it('raises a decision when dropped work has pending A2A tasks', async () => {
    const work: ActiveDeckWork = {
      id: 'work-1',
      workspaceId: 'ws-test',
      objective: 'do research',
      followUps: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
      a2aTasks: {
        'task-1': {
          taskId: 'task-1',
          to: 'agent-1',
          state: 'working',
          updatedAt: Date.now(),
        },
      },
    };

    surfaceStrandedWork('ws-test', work, 'cleared', dir);
    // Yield for promise resolution of raiseDecision
    await new Promise((r) => setTimeout(r, 20));

    const decision = loadWorkspaceDecision('ws-test', dir);
    expect(decision).not.toBeNull();
    expect(decision?.question).toContain('Cancel those tasks, or leave them running?');
    expect(decision?.options).toEqual(['Cancel the old tasks', 'Leave them running']);
  });

  it('does not raise a decision when work has no pending A2A tasks', async () => {
    const work: ActiveDeckWork = {
      id: 'work-2',
      workspaceId: 'ws-test-2',
      objective: 'clean work',
      followUps: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
      a2aTasks: {},
    };

    surfaceStrandedWork('ws-test-2', work, 'cleared', dir);
    await new Promise((r) => setTimeout(r, 20));

    expect(loadWorkspaceDecision('ws-test-2', dir)).toBeNull();
  });
});

describe('deckWorkspaceTeardown — archive before clearing (workspace removal)', () => {
  it('archives the active work record before clearing it', async () => {
    beginOrContinueDeckWork('ws-a', 'request a', dir);
    const before = loadActiveDeckWork('ws-a', dir);
    expect(before).not.toBeNull();

    const report = await teardownWorkspaceDeckState('ws-a', { dir, log: () => undefined });

    expect(report.workArchived).toBe(true);
    expect(report.workCleared).toBe(true);
    expect(loadActiveDeckWork('ws-a', dir)).toBeNull();
    expect(loadArchivedDeckWorks(dir).map((w) => w.id)).toEqual([before?.id]);
  });

  it('moves an unreadable archive aside instead of overwriting it, then archives', async () => {
    fs.writeFileSync(getDeckWorkArchivePath(dir), 'CORRUPT{ old history');
    beginOrContinueDeckWork('ws-b', 'request b', dir);

    const report = await teardownWorkspaceDeckState('ws-b', { dir, log: () => undefined });

    expect(report.workArchived).toBe(true);
    expect(loadArchivedDeckWorks(dir).map((w) => w.workspaceId)).toEqual(['ws-b']);
    // The old bytes survive in the atomicWrite quarantine folder.
    const quarantine = path.join(dir, 'corrupted');
    const kept = fs.readdirSync(quarantine).filter((f) => f.startsWith('deck-work.archive.json'));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(quarantine, kept[0]), 'utf8')).toBe('CORRUPT{ old history');
  });

  it('recovers the archive from its backup when the primary is valid JSON but not a list', async () => {
    const old = { id: 'w-old', workspaceId: 'ws-old' } as ActiveDeckWork;
    fs.writeFileSync(`${getDeckWorkArchivePath(dir)}.bak`, JSON.stringify([old]));
    fs.writeFileSync(getDeckWorkArchivePath(dir), JSON.stringify({ not: 'a list' }));
    beginOrContinueDeckWork('ws-c', 'request c', dir);

    const report = await teardownWorkspaceDeckState('ws-c', { dir, log: () => undefined });

    expect(report.workArchived).toBe(true);
    expect(loadArchivedDeckWorks(dir).map((w) => w.workspaceId)).toEqual(['ws-old', 'ws-c']);
  });

  it('keeps the work record when the archive cannot be written', async () => {
    fs.writeFileSync(getDeckWorkArchivePath(dir), 'CORRUPT{');
    // A FILE where the quarantine folder should go makes moving the corrupt
    // archive aside fail, so archiving throws.
    fs.writeFileSync(path.join(dir, 'corrupted'), 'not a folder');
    beginOrContinueDeckWork('ws-c', 'request c', dir);
    const lines: string[] = [];

    const report = await teardownWorkspaceDeckState('ws-c', { dir, log: (l) => lines.push(l) });

    expect(report.workArchived).toBe(false);
    expect(report.workCleared).toBe(false);
    expect(loadActiveDeckWork('ws-c', dir)).not.toBeNull();
    expect(fs.readFileSync(getDeckWorkArchivePath(dir), 'utf8')).toBe('CORRUPT{');
    expect(lines.join('\n')).toMatch(/kept active work .* archiving it failed/);
  });

  it('caps the archive, dropping the oldest records first', () => {
    const extra = 5;
    for (let i = 0; i < MAX_ARCHIVED_DECK_WORKS + extra; i++) {
      archiveDeckWork({ id: `w-${i}`, workspaceId: 'ws-cap' } as ActiveDeckWork, dir);
    }
    const ids = loadArchivedDeckWorks(dir).map((w) => w.id);
    expect(ids).toHaveLength(MAX_ARCHIVED_DECK_WORKS);
    expect(ids[0]).toBe(`w-${extra}`);
    expect(ids[ids.length - 1]).toBe(`w-${MAX_ARCHIVED_DECK_WORKS + extra - 1}`);
    // 200+ fsync'd atomic writes: ~0.3 s locally, but a loaded Windows CI
    // runner has gone past vitest's 5 s default.
  }, 30_000);
});

describe('deckWorkspaceTeardown — concurrent writers', () => {
  it('a teardown racing setters for another workspace drops neither side', async () => {
    await setWorkspaceMode('ws-a', 'assist', dir);
    await setWorkspaceMode('ws-b', 'danger', dir);
    await saveCommanderSession('ws-a', 'sess-a', dir);
    const sched = (id: string, workspaceId: string) => ({
      id, workspaceId, prompt: 'p', nextRunAt: Date.now() + 10_000, enabled: true, createdAt: Date.now(),
    });
    await saveDeckSchedules([sched('s-a', 'ws-a')], dir);

    // Unserialized, each writer read the same snapshot and the later write won:
    // the teardown would resurrect ws-b's old danger mode, or drop s-b / sess-b.
    await Promise.all([
      teardownWorkspaceDeckState('ws-a', { dir, log: () => undefined }),
      setWorkspaceMode('ws-b', 'off', dir),
      mutateDeckSchedules((list) => [...list, sched('s-b', 'ws-b')], dir),
      saveCommanderSession('ws-b', 'sess-b', dir),
    ]);

    const autonomy = loadDeckAutonomy(dir);
    expect(autonomy['ws-a']).toBeUndefined();
    expect(autonomy['ws-b']?.mode).toBe('off');
    expect(loadDeckSchedules(dir).map((s) => s.id)).toEqual(['s-b']);
    expect(loadCommanderSession('ws-a', dir)).toBeNull();
    expect(loadCommanderSession('ws-b', dir)?.sessionId).toBe('sess-b');
  });
});

describe('deckWorkspaceTeardown — the HQ workspace', () => {
  it('refuses to tear down the HQ (purge path) and still tears down others', async () => {
    await setHqWorkspaceId('ws-hq', dir);
    for (const ws of ['ws-hq', 'ws-a']) {
      await setWorkspaceMode(ws, 'danger', dir);
      beginOrContinueDeckWork(ws, `${ws} work`, dir);
      await raiseDecision(ws, { question: 'q', options: [], context: '' }, dir);
    }
    const lines: string[] = [];

    const hq = await teardownWorkspaceDeckState('ws-hq', { dir, log: (l) => lines.push(l) });
    expect(hq).toMatchObject({ workspaceId: 'ws-hq', workCleared: false, autonomyDeleted: false, decisionCleared: false });
    expect(lines).toEqual(['refused teardown of ws-hq: it is the HQ workspace']);
    expect(loadDeckAutonomy(dir)['ws-hq']?.mode).toBe('danger');
    expect(loadActiveDeckWork('ws-hq', dir)).not.toBeNull();
    expect(loadWorkspaceDecision('ws-hq', dir)).not.toBeNull();

    const other = await teardownWorkspaceDeckState('ws-a', { dir, log: () => undefined });
    expect(other).toMatchObject({ autonomyDeleted: true, decisionCleared: true, workCleared: true });
  });
});
