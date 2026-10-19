import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { deliberateSleep } from '../../../test-utils/waitFor';

// Teardown, archive and race logic is what these cases check, not crash
// durability. deckWorkStore writes with `durable: true`; on windows-latest each
// fsync+rename cost 100-800 ms in the CI timeline, and the cases here ran past
// their timeouts (5 s, and 30 s for the 205-write archive cap). Same writes,
// same files and format, minus the fsync.
vi.mock('../../../daemon/util/atomicWrite', async (importOriginal) => {
  const { withoutFsync } = await import('../../../test-utils/nonDurableAtomicWrite');
  return withoutFsync(await importOriginal());
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teardownWorkspaceDeckState, surfaceStrandedWork } from '../deckWorkspaceTeardown';
import { setWorkspaceMode, loadDeckAutonomy, getDeckAutonomyPath } from '../deckAutonomyStore';
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
import * as deckDecisionStore from '../deckDecisionStore';


let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-teardown-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckWorkspaceTeardown — teardownWorkspaceDeckState', () => {
  it('tears down all Deck state for target workspace, leaves other workspace untouched', async () => {
    await setWorkspaceMode('ws-x', 'danger', dir);
    await setWorkspaceMode('ws-y', 'assist', dir);
    beginOrContinueDeckWork('ws-x', 'request x', dir);
    recordDeckWorkA2aTask('ws-x', { taskId: 'task-1', to: 'worker', state: 'working', ts: Date.now() }, dir);
    beginOrContinueDeckWork('ws-y', 'request y', dir);
    await raiseDecision('ws-x', { question: 'question x?' }, dir);
    await raiseDecision('ws-y', { question: 'question y?' }, dir);
    // A retired brain store an earlier version wrote: left on disk, unread.
    const loopFile = path.join(dir, 'deck-loop-state.json');
    fs.writeFileSync(loopFile, JSON.stringify({ 'ws-x': { objective: 'old loop' } }));

    const strandedReports: ActiveDeckWork[] = [];
    const logLines: string[] = [];

    const report = await teardownWorkspaceDeckState('ws-x', {
      dir,
      onStrandedWork: (work) => strandedReports.push(work),
      log: (line) => logLines.push(line),
    });

    expect(report.workspaceId).toBe('ws-x');
    expect(report.workCleared).toBe(true);
    expect(report.strandedWork?.objective).toBe('request x');
    expect(report.autonomyDeleted).toBe(true);
    expect(report.decisionCleared).toBe(true);
    expect(strandedReports).toHaveLength(1);
    expect(strandedReports[0].id).toBe(report.strandedWork?.id);

    // Exactly one log line per store (3 stores)
    expect(logLines).toHaveLength(3);
    expect(logLines.some((l) => l.startsWith('[work]'))).toBe(true);
    expect(logLines.some((l) => l.startsWith('[autonomy]'))).toBe(true);
    expect(logLines.some((l) => l.startsWith('[decision]'))).toBe(true);

    expect(loadActiveDeckWork('ws-x', dir)).toBeNull();
    expect(loadDeckAutonomy(dir)['ws-x']).toBeUndefined();
    expect(loadWorkspaceDecision('ws-x', dir)).toBeNull();
    expect(loadActiveDeckWork('ws-y', dir)?.objective).toBe('request y');
    expect(loadDeckAutonomy(dir)['ws-y']?.mode).toBe('assist');
    expect(loadWorkspaceDecision('ws-y', dir)?.question).toBe('question y?');

    const autonomyJson = JSON.parse(fs.readFileSync(getDeckAutonomyPath(dir), 'utf8'));
    expect(autonomyJson['ws-x']).toBeUndefined();
    expect(autonomyJson['ws-y']).toBeDefined();
    const workJson = JSON.parse(fs.readFileSync(getDeckWorkPath(dir), 'utf8'));
    expect(workJson.active['ws-x']).toBeUndefined();
    expect(workJson.active['ws-y']).toBeDefined();
    const decisionsJson = JSON.parse(fs.readFileSync(getDeckDecisionPath(dir), 'utf8'));
    expect(decisionsJson['ws-x']).toBeUndefined();
    expect(decisionsJson['ws-y']).toBeDefined();
    expect(JSON.parse(fs.readFileSync(loopFile, 'utf8'))).toHaveProperty('ws-x');

    // Second call is a no-op without error (idempotent)
    const logLines2: string[] = [];
    const report2 = await teardownWorkspaceDeckState('ws-x', { dir, log: (line) => logLines2.push(line) });
    expect(report2).toMatchObject({ workspaceId: 'ws-x', workCleared: false, autonomyDeleted: false, decisionCleared: false });
    expect(logLines2).toHaveLength(3);
    expect(loadActiveDeckWork('ws-y', dir)?.objective).toBe('request y');
  });

  it('refuses an empty or non-string workspace id and returns a report with nothing done', async () => {
    await setWorkspaceMode('ws-keep', 'danger', dir);
    const nothing = { workCleared: false, autonomyDeleted: false, decisionCleared: false };
    const r1 = await teardownWorkspaceDeckState('', { dir });
    expect(r1).toMatchObject({ workspaceId: '', ...nothing });
    for (const bad of ['   ', null, undefined]) {
      expect(await teardownWorkspaceDeckState(bad as unknown as string, { dir })).toMatchObject(nothing);
    }
    expect(loadDeckAutonomy(dir)['ws-keep']?.mode).toBe('danger');
  });

  it('continues remaining store steps when one store step fails (corrupt / unwritable file)', async () => {
    await setWorkspaceMode('ws-fail', 'danger', dir);
    beginOrContinueDeckWork('ws-fail', 'work', dir);
    await raiseDecision('ws-fail', { question: 'will it survive?' }, dir);

    // Mock the decision clear failing (e.g. unwritable / locked file)
    vi.spyOn(deckDecisionStore, 'clearWorkspaceDecisions').mockRejectedValueOnce(
      new Error('EACCES: permission denied, unwritable file'),
    );

    const logLines: string[] = [];
    const report = await teardownWorkspaceDeckState('ws-fail', { dir, log: (line) => logLines.push(line) });

    // The decision step failed, but work and autonomy succeeded
    expect(report.decisionCleared).toBe(false);
    expect(report.workCleared).toBe(true);
    expect(report.autonomyDeleted).toBe(true);
    expect(loadDeckAutonomy(dir)['ws-fail']).toBeUndefined();
    expect(loadActiveDeckWork('ws-fail', dir)).toBeNull();
    expect(logLines).toHaveLength(3);
    expect(logLines.some((l) => l.startsWith('[decision]') && l.includes('failed'))).toBe(true);
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
    // raiseDecision is fire-and-forget and writes the decision file; a fixed
    // 20 ms sleep lost that race once on the loaded Windows shard.
    const decision = await vi.waitFor(() => {
      const d = loadWorkspaceDecision('ws-test', dir);
      expect(d).not.toBeNull();
      return d;
    }, { timeout: 10_000 });
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
    await deliberateSleep(20, 'negative: no decision is raised');

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
    // 205 atomic writes, each re-reading the growing archive: the fsync is
    // mocked out above, but a loaded Windows runner still needs headroom.
  }, 30_000);
});

describe('deckWorkspaceTeardown — concurrent writers', () => {
  it('a teardown racing a setter for another workspace drops neither side', async () => {
    await setWorkspaceMode('ws-a', 'assist', dir);
    await setWorkspaceMode('ws-b', 'danger', dir);

    // Unserialized, each writer read the same snapshot and the later write won:
    // the teardown would resurrect ws-b's old danger mode.
    await Promise.all([
      teardownWorkspaceDeckState('ws-a', { dir, log: () => undefined }),
      setWorkspaceMode('ws-b', 'off', dir),
    ]);

    const autonomy = loadDeckAutonomy(dir);
    expect(autonomy['ws-a']).toBeUndefined();
    expect(autonomy['ws-b']?.mode).toBe('off');
  });
});

describe('deckWorkspaceTeardown — an earlier version\'s HQ workspace', () => {
  it('is torn down like any other; deck-hq.json is not read', async () => {
    fs.writeFileSync(path.join(dir, 'deck-hq.json'), JSON.stringify({ hqWorkspaceId: 'ws-hq' }));
    await setWorkspaceMode('ws-hq', 'danger', dir);
    beginOrContinueDeckWork('ws-hq', 'hq work', dir);
    const report = await teardownWorkspaceDeckState('ws-hq', { dir, log: () => undefined });
    expect(report).toMatchObject({ workspaceId: 'ws-hq', workCleared: true, autonomyDeleted: true });
    expect(fs.readFileSync(path.join(dir, 'deck-hq.json'), 'utf8')).toContain('ws-hq');
  });
});
