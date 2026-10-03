import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  reconcileOrphanDeckState,
  collectDeckWorkspaceIds,
  collectDeckWorkspaceFiles,
  tryStartupDeckReconcile,
  __resetStartupDeckReconcileForTest,
  PARKED_WORK_TTL_HOURS,
} from '../deckOrphanReconcile';
import {
  beginOrContinueDeckWork,
  loadActiveDeckWork,
  loadArchivedDeckWorks,
  setDeckWorkBootId,
} from '../deckWorkStore';
import {
  startLoop,
  loadWorkspaceLoopState,
} from '../deckLoopStateStore';
import {
  setWorkspaceMode,
  getDeckAutonomyPath,
} from '../deckAutonomyStore';
import {
  saveCommanderSession,
  loadCommanderSession,
} from '../commanderSessionStore';
import {
  raiseDecision,
  loadWorkspaceDecision,
} from '../deckDecisionStore';
import {
  saveDeckSchedules,
  loadDeckSchedules,
} from '../deckScheduleStore';
import { setHqWorkspaceId } from '../deckHqStore';
import {
  getWorkspaceMirror,
  __resetWorkspaceMirrorForTest,
} from '../../workspace/WorkspaceMirror';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-orphan-test-'));
  setDeckWorkBootId('initial-test-boot');
  __resetStartupDeckReconcileForTest();
  __resetWorkspaceMirrorForTest();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckOrphanReconcile', () => {
  it('reconciles three orphan ids and one live id across all six files -> only live id remains, archive holds orphan work', async () => {
    // 3 orphans: 'ws-orphan1', 'ws-orphan2', 'ws-orphan3'
    // 1 live: 'ws-live'

    // 1. deck-work.json: ws-orphan1, ws-orphan2, ws-live
    // Use an old timestamp so parked work has passed the 72h TTL
    const oldTimestamp = Date.now() - 100 * 3600 * 1000;
    beginOrContinueDeckWork('ws-orphan1', 'work orphan 1', dir, oldTimestamp);
    beginOrContinueDeckWork('ws-orphan2', 'work orphan 2', dir, oldTimestamp);
    beginOrContinueDeckWork('ws-live', 'work live', dir, oldTimestamp);

    // Make ws-orphan1 and ws-orphan2 parked by switching boot ID
    setDeckWorkBootId('fresh-boot-id');

    // 2. deck-loop-state.json: ws-orphan1, ws-orphan3, ws-live
    await startLoop('ws-orphan1', { objective: 'loop 1', steps: [] }, dir);
    await startLoop('ws-orphan3', { objective: 'loop 3', steps: [] }, dir);
    await startLoop('ws-live', { objective: 'loop live', steps: [] }, dir);

    // 3. deck-autonomy.json: ws-orphan2, ws-orphan3, ws-live
    await setWorkspaceMode('ws-orphan2', 'danger', dir);
    await setWorkspaceMode('ws-orphan3', 'assist', dir);
    await setWorkspaceMode('ws-live', 'danger', dir);

    // 4. deck-commander.json: ws-orphan1, ws-orphan2::subrole, ws-live
    await saveCommanderSession('ws-orphan1', 'sess-1', dir);
    await saveCommanderSession('ws-orphan2::roleA', 'sess-2', dir);
    await saveCommanderSession('ws-live', 'sess-live', dir);

    // 5. deck-decisions.json: ws-orphan1, ws-live
    await raiseDecision('ws-orphan1', { question: 'q1', options: ['yes', 'no'], context: 'c1' }, dir);
    await raiseDecision('ws-live', { question: 'q live', options: ['a', 'b'], context: 'c live' }, dir);

    // 6. deck-schedules.json: ws-orphan3, ws-live
    await saveDeckSchedules(
      [
        {
          id: 'sched-orphan3',
          workspaceId: 'ws-orphan3',
          prompt: 'prompt 3',
          nextRunAt: Date.now() + 10000,
          enabled: true,
          createdAt: Date.now(),
        },
        {
          id: 'sched-live',
          workspaceId: 'ws-live',
          prompt: 'prompt live',
          nextRunAt: Date.now() + 20000,
          enabled: true,
          createdAt: Date.now(),
        },
      ],
      dir,
    );

    // Verify all IDs are detected
    const collected = collectDeckWorkspaceIds(dir);
    expect(collected.has('ws-orphan1')).toBe(true);
    expect(collected.has('ws-orphan2')).toBe(true);
    expect(collected.has('ws-orphan3')).toBe(true);
    expect(collected.has('ws-live')).toBe(true);

    const fileMap = collectDeckWorkspaceFiles(dir);
    expect(fileMap.get('ws-orphan1')).toEqual([
      'deck-commander.json',
      'deck-decisions.json',
      'deck-loop-state.json',
      'deck-work.json',
    ]);
    expect(fileMap.get('ws-orphan2')).toEqual([
      'deck-autonomy.json',
      'deck-commander.json',
      'deck-work.json',
    ]);
    expect(fileMap.get('ws-orphan3')).toEqual([
      'deck-autonomy.json',
      'deck-loop-state.json',
      'deck-schedules.json',
    ]);
    expect(fileMap.get('ws-live')).toEqual([
      'deck-autonomy.json',
      'deck-commander.json',
      'deck-decisions.json',
      'deck-loop-state.json',
      'deck-schedules.json',
      'deck-work.json',
    ]);

    // Run reconcile with only 'ws-live' as live
    const report = await reconcileOrphanDeckState(['ws-live'], { dir });

    expect(report.orphans).toEqual(['ws-orphan1', 'ws-orphan2', 'ws-orphan3']);
    expect(report.archived.sort()).toEqual(['ws-orphan1', 'ws-orphan2']);
    expect(report.tornDown?.sort()).toEqual(['ws-orphan1', 'ws-orphan2', 'ws-orphan3']);

    // Check archive holds orphan work records
    const archived = loadArchivedDeckWorks(dir);
    expect(archived).toHaveLength(2);
    const archivedWsIds = archived.map((w) => w.workspaceId).sort();
    expect(archivedWsIds).toEqual(['ws-orphan1', 'ws-orphan2']);

    // Check all 6 files: only ws-live remains!
    // 1. Work
    expect(loadActiveDeckWork('ws-orphan1', dir)).toBeNull();
    expect(loadActiveDeckWork('ws-orphan2', dir)).toBeNull();
    expect(loadActiveDeckWork('ws-live', dir)).not.toBeNull();

    // 2. Loop
    expect(loadWorkspaceLoopState('ws-orphan1', dir)).toBeNull();
    expect(loadWorkspaceLoopState('ws-orphan3', dir)).toBeNull();
    expect(loadWorkspaceLoopState('ws-live', dir)).not.toBeNull();

    // 3. Autonomy
    const rawAutonomy = JSON.parse(fs.readFileSync(getDeckAutonomyPath(dir), 'utf8'));
    expect('ws-orphan2' in rawAutonomy).toBe(false);
    expect('ws-orphan3' in rawAutonomy).toBe(false);
    expect('ws-live' in rawAutonomy).toBe(true);

    // 4. Commander session
    expect(loadCommanderSession('ws-orphan1', dir)).toBeNull();
    expect(loadCommanderSession('ws-orphan2::roleA', dir)).toBeNull();
    expect(loadCommanderSession('ws-live', dir)).not.toBeNull();

    // 5. Decision
    expect(loadWorkspaceDecision('ws-orphan1', dir)).toBeNull();
    expect(loadWorkspaceDecision('ws-live', dir)).not.toBeNull();

    // 6. Schedule
    const schedules = loadDeckSchedules(dir);
    expect(schedules.find((s) => s.workspaceId === 'ws-orphan3')).toBeUndefined();
    expect(schedules.find((s) => s.workspaceId === 'ws-live')).toBeDefined();
  });

  it('fails closed on null or empty array -> nothing changes', async () => {
    beginOrContinueDeckWork('ws-1', 'work 1', dir);
    await setWorkspaceMode('ws-1', 'danger', dir);

    const logs: string[] = [];
    const reportNull = await reconcileOrphanDeckState(null, { dir, log: (l) => logs.push(l) });
    expect(reportNull.orphans).toEqual([]);
    expect(reportNull.archived).toEqual([]);
    expect(reportNull.skipped).toBe('skipped: workspace list not loaded');
    expect(loadActiveDeckWork('ws-1', dir)).not.toBeNull();

    const reportEmpty = await reconcileOrphanDeckState([], { dir, log: (l) => logs.push(l) });
    expect(reportEmpty.orphans).toEqual([]);
    expect(reportEmpty.archived).toEqual([]);
    expect(reportEmpty.skipped).toBe('skipped: workspace list not loaded');
    expect(loadActiveDeckWork('ws-1', dir)).not.toBeNull();
  });

  it('dryRun reports the same orphans and changes nothing', async () => {
    beginOrContinueDeckWork('ws-orphan', 'work orphan', dir, Date.now() - 100 * 3600 * 1000);
    setDeckWorkBootId('fresh-boot-id');
    await setWorkspaceMode('ws-orphan', 'danger', dir);
    await saveCommanderSession('ws-orphan', 'sess-orphan', dir);

    const report = await reconcileOrphanDeckState(['ws-live'], { dir, dryRun: true });
    expect(report.orphans).toEqual(['ws-orphan']);
    expect(report.archived).toEqual([]);

    // Nothing was deleted or archived
    expect(loadActiveDeckWork('ws-orphan', dir)).not.toBeNull();
    expect(loadArchivedDeckWorks(dir)).toHaveLength(0);
    expect(loadCommanderSession('ws-orphan', dir)).not.toBeNull();
  });

  it('preserves a parked record of a live workspace', async () => {
    // Record for ws-live written in an earlier boot (> 100 hours ago)
    const oldTimestamp = Date.now() - 100 * 3600 * 1000;
    beginOrContinueDeckWork('ws-live', 'live work parked from previous boot', dir, oldTimestamp);
    setDeckWorkBootId('fresh-boot-id');

    // Run reconcile where ws-live is in liveWorkspaceIds
    const report = await reconcileOrphanDeckState(['ws-live'], { dir });
    expect(report.orphans).toEqual([]);
    expect(report.archived).toEqual([]);

    // ws-live parked record must survive!
    const surviving = loadActiveDeckWork('ws-live', dir);
    expect(surviving).not.toBeNull();
    expect(surviving?.objective).toBe('live work parked from previous boot');
  });

  it('applies parked-work TTL: orphan parked work younger than TTL survives, older than TTL is purged', async () => {
    setDeckWorkBootId('boot-past');
    const now = Date.now();
    // ws-recent: parked 10 hours ago (< 72h TTL)
    const recentTs = now - 10 * 3600 * 1000;
    beginOrContinueDeckWork('ws-recent', 'recent work', dir, recentTs);

    // ws-old: parked 80 hours ago (> 72h TTL)
    const oldTs = now - 80 * 3600 * 1000;
    beginOrContinueDeckWork('ws-old', 'old work', dir, oldTs);

    setDeckWorkBootId('boot-current');

    // Run reconcile with no live workspaces matching either
    const report = await reconcileOrphanDeckState(['ws-other'], {
      dir,
      now,
      parkedWorkTtlHours: PARKED_WORK_TTL_HOURS,
    });

    expect(report.orphans).toEqual(['ws-old', 'ws-recent']);
    // Only ws-old was archived and torn down!
    expect(report.archived).toEqual(['ws-old']);

    // ws-recent survives
    expect(loadActiveDeckWork('ws-recent', dir)).not.toBeNull();
    // ws-old is gone from active, present in archive
    expect(loadActiveDeckWork('ws-old', dir)).toBeNull();
    const archived = loadArchivedDeckWorks(dir);
    expect(archived.map((w) => w.workspaceId)).toEqual(['ws-old']);
  });

  it('tryStartupDeckReconcile waits for fresh mirror snapshot and runs once', async () => {
    beginOrContinueDeckWork('ws-orphan', 'orphan work', dir, Date.now() - 100 * 3600 * 1000);
    setDeckWorkBootId('fresh-boot-id');

    const mirror = getWorkspaceMirror();

    // Mirror empty -> returns false, does nothing
    const done1 = await tryStartupDeckReconcile({ dir });
    expect(done1).toBe(false);
    expect(loadActiveDeckWork('ws-orphan', dir)).not.toBeNull();

    // Push snapshot into mirror with ws-live
    mirror.setSnapshot({
      ts: Date.now(),
      entries: [{ id: 'ws-live', name: 'Live Workspace' }],
      fleets: [],
      sessionRestored: true,
    });

    // Now mirror is ready -> runs reconcile, returns true
    const done2 = await tryStartupDeckReconcile({ dir });
    expect(done2).toBe(true);
    expect(loadActiveDeckWork('ws-orphan', dir)).toBeNull();

    // Subsequent calls return true immediately (runs at most once per process)
    const done3 = await tryStartupDeckReconcile({ dir });
    expect(done3).toBe(true);
  });

  it('does not tear down an orphan whose work cannot be archived', async () => {
    beginOrContinueDeckWork('ws-orphan', 'orphan work', dir, Date.now() - 100 * 3600 * 1000);
    setDeckWorkBootId('fresh-boot-id');
    await setWorkspaceMode('ws-orphan', 'danger', dir);
    // Unreadable archive + a FILE where the quarantine folder goes: archiving throws.
    fs.writeFileSync(path.join(dir, 'deck-work.archive.json'), 'CORRUPT{');
    fs.writeFileSync(path.join(dir, 'corrupted'), 'not a folder');

    const report = await reconcileOrphanDeckState(['ws-live'], { dir, log: () => undefined });

    expect(report.skippedIds).toEqual(['ws-orphan']);
    expect(report.tornDown).toEqual([]);
    expect(loadActiveDeckWork('ws-orphan', dir)).not.toBeNull();
    expect(collectDeckWorkspaceFiles(dir).get('ws-orphan')?.length).toBeGreaterThan(1);
  });

  // P1 data loss: a failed / null / empty session.load() still flips the pane
  // gate, and the mirror then holds ONE freshly generated default workspace.
  // Every real workspace on disk must keep its Deck state.
  it.each([
    ['session load failed or returned nothing (flag false)', false],
    ['an old renderer that does not send the flag', undefined],
  ])('tryStartupDeckReconcile deletes nothing when %s', async (_label, sessionRestored) => {
    const old = Date.now() - 100 * 3600 * 1000;
    beginOrContinueDeckWork('ws-real', 'real work', dir, old);
    setDeckWorkBootId('fresh-boot-id');
    await startLoop('ws-real', { objective: 'loop', steps: [] }, dir);
    await setWorkspaceMode('ws-real', 'danger', dir);
    await saveCommanderSession('ws-real', 'sess-real', dir);
    await raiseDecision('ws-real', { question: 'q', options: ['a', 'b'], context: 'c' }, dir);
    const filesBefore = collectDeckWorkspaceFiles(dir);

    getWorkspaceMirror().setSnapshot({
      ts: Date.now(),
      entries: [{ id: 'ws-fresh-default', name: 'Workspace 1' }],
      fleets: [],
      ...(sessionRestored === undefined ? {} : { sessionRestored }),
    });

    const lines: string[] = [];
    const done = await tryStartupDeckReconcile({ dir, log: (l) => lines.push(l) });

    // Settled for this process (no retry loop), but nothing was touched.
    expect(done).toBe(true);
    expect(lines.join(' ')).toMatch(/did not restore a saved session/);
    expect(loadActiveDeckWork('ws-real', dir)).not.toBeNull();
    expect(loadArchivedDeckWorks(dir)).toEqual([]);
    expect(collectDeckWorkspaceIds(dir).has('ws-real')).toBe(true);
    expect(collectDeckWorkspaceFiles(dir)).toEqual(filesBefore);

    // A later push (same process) does not resurrect the pass.
    getWorkspaceMirror().setSnapshot({
      ts: Date.now(),
      entries: [{ id: 'ws-fresh-default', name: 'Workspace 1' }],
      fleets: [],
      sessionRestored: true,
    });
    await tryStartupDeckReconcile({ dir });
    expect(loadActiveDeckWork('ws-real', dir)).not.toBeNull();
  });
});

describe('deckOrphanReconcile — the HQ workspace', () => {
  it('never sweeps the HQ, even when its workspace is gone', async () => {
    await setHqWorkspaceId('ws-hq', dir);
    beginOrContinueDeckWork('ws-hq', 'hq work', dir);
    await setWorkspaceMode('ws-hq', 'danger', dir);
    await raiseDecision('ws-hq', { question: 'q', options: [], context: '' }, dir);
    await setWorkspaceMode('ws-gone', 'danger', dir);

    const lines: string[] = [];
    const report = await reconcileOrphanDeckState(['ws-live'], { dir, log: (l) => lines.push(l) });

    expect(report.orphans).toEqual(['ws-gone', 'ws-hq']);
    expect(report.tornDown).toEqual(['ws-gone']);
    expect(report.skippedIds).toEqual(['ws-hq']);
    expect(lines.join(' ')).toMatch(/skipping orphan ws-hq: it is the HQ workspace/);
    expect(loadActiveDeckWork('ws-hq', dir)).not.toBeNull();
    expect(loadArchivedDeckWorks(dir)).toEqual([]);
    expect(loadWorkspaceDecision('ws-hq', dir)).not.toBeNull();
    expect(collectDeckWorkspaceIds(dir)).toEqual(new Set(['ws-hq']));
  });
});
