import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  brainEligible,
  DEFAULT_HQ_MAX_TURNS_PER_HOUR,
  getDeckHqPath,
  getHqMaxTurnsPerHour,
  getHqWorkspaceId,
  hqAllowsBrain,
  hqPresence,
  isHqMigrationDone,
  isHqStoreCorrupt,
  isMoaEnabled,
  loadArchivedHqDecisions,
  runNonHqMigration,
  setHqRuntime,
  setHqWorkspaceId,
  setMoaEnabled,
  ensureMoaDefault,
  getMoaConfig,
  setMoaAutoRules,
  isHqApprovalPressEnabled,
  setMoaConfig,
  addMoaIgnoredRepo,
  countUnackedArchivedDecisions,
  ackArchivedDecisions,
  resetCorruptHqStore,
  __resetHqMemoryForTest,
  __setHqWritersForTest,
} from '../deckHqStore';
import { setWorkspaceMode } from '../deckAutonomyStore';
import { saveCommanderSession } from '../commanderSessionStore';
import { saveDeckSchedules, loadDeckSchedules, mutateDeckSchedules } from '../deckScheduleStore';
import { startLoop, loadWorkspaceLoopState } from '../deckLoopStateStore';
import * as decisionStore from '../deckDecisionStore';
import { raiseDecision, loadWorkspaceDecision, resolveDecision } from '../deckDecisionStore';
import { beginOrContinueDeckWork, loadActiveDeckWork, loadArchivedDeckWorks } from '../deckWorkStore';
import { getWorkspaceMirror, __resetWorkspaceMirrorForTest } from '../../workspace/WorkspaceMirror';

let dir: string;
let disposeRuntime: (() => void) | null = null;
const quiet = (): void => undefined;

const pushMirror = (ids: string[], sessionRestored = true): void =>
  getWorkspaceMirror().setSnapshot({
    ts: Date.now(),
    entries: ids.map((id) => ({ id, name: id })),
    fleets: [],
    sessionRestored,
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hq-test-'));
  __resetHqMemoryForTest();
  __resetWorkspaceMirrorForTest();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  disposeRuntime?.();
  disposeRuntime = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckHqStore — get/set', () => {
  it('defaults to unset and persists a designation', async () => {
    expect(getHqWorkspaceId(dir)).toBeNull();
    const r = await setHqWorkspaceId('ws-hq', dir);
    expect(r).toMatchObject({ ok: true, hqWorkspaceId: 'ws-hq' });
    expect(getHqWorkspaceId(dir)).toBe('ws-hq');
    expect(await setHqWorkspaceId(null, dir)).toMatchObject({ ok: true, hqWorkspaceId: null });
    expect(getHqWorkspaceId(dir)).toBeNull();
  });

  it('refuses an invalid workspace id', async () => {
    expect(await setHqWorkspaceId('../etc', dir)).toEqual({ ok: false, code: 'invalid_workspace' });
    expect(getHqWorkspaceId(dir)).toBeNull();
  });

  it('refuses only while the old or new HQ is mid-turn; an idle brain does not block it', async () => {
    const busy = new Set(['ws-hq']);
    const retired: string[] = [];
    const changed: number[] = [];
    disposeRuntime = setHqRuntime({
      isBrainBusy: (ws) => busy.has(ws),
      retireBrainsExcept: (hq) => retired.push(hq),
      onHqChanged: () => changed.push(1),
    });
    expect(await setHqWorkspaceId('ws-hq', dir)).toEqual({ ok: false, code: 'brain_running', workspaceId: 'ws-hq' });
    expect(getHqWorkspaceId(dir)).toBeNull();
    expect(changed).toEqual([]);

    busy.clear(); // the brain exists but is idle
    expect((await setHqWorkspaceId('ws-hq', dir)).ok).toBe(true);
    expect(retired).toEqual(['ws-hq']);
    expect(changed).toEqual([1]);

    busy.add('ws-hq'); // the OLD HQ mid-turn blocks a move too
    expect(await setHqWorkspaceId('ws-other', dir)).toEqual({ ok: false, code: 'brain_running', workspaceId: 'ws-hq' });
    expect(getHqWorkspaceId(dir)).toBe('ws-hq');
  });

  it('serves repeated reads from the cache and sees an external edit', async () => {
    await setHqWorkspaceId('ws-hq', dir);
    getHqWorkspaceId(dir);
    const read = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < 20; i++) getHqWorkspaceId(dir);
    expect(read.mock.calls.filter((c) => String(c[0]).endsWith('deck-hq.json'))).toHaveLength(0);
    read.mockRestore();
    // An edit by something else changes size/mtime → re-read.
    fs.writeFileSync(getDeckHqPath(dir), JSON.stringify({ hqWorkspaceId: 'ws-other-hq' }));
    expect(getHqWorkspaceId(dir)).toBe('ws-other-hq');
  });
});

describe('deckHqStore — eligibility matrix', () => {
  it.each([
    // [workspace, hq, allowed]
    ['ws-a', null, true],
    ['ws-hq', null, true],
    ['ws-hq', 'ws-hq', true],
    ['ws-a', 'ws-hq', false],
  ] as const)('hqAllowsBrain(%s, hq=%s) = %s', (ws, hq, allowed) => {
    expect(hqAllowsBrain(ws, hq)).toBe(allowed);
  });

  it('brainEligible: unset → everyone; HQ → only the HQ, and only once it is observed', async () => {
    expect(brainEligible('ws-a', dir)).toBe(true);
    await setHqWorkspaceId('ws-hq', dir);
    expect([brainEligible('ws-hq', dir), brainEligible('ws-a', dir)]).toEqual([false, false]); // unknown
    pushMirror(['ws-hq', 'ws-a']);
    expect([brainEligible('ws-hq', dir), brainEligible('ws-a', dir)]).toEqual([true, false]);
  });
});

describe('deckHqStore — master switch', () => {
  it('defaults to on with the default HQ turn cap', () => {
    expect(isMoaEnabled(dir)).toBe(true);
    expect(getHqMaxTurnsPerHour(dir)).toBe(DEFAULT_HQ_MAX_TURNS_PER_HOUR);
    expect(DEFAULT_HQ_MAX_TURNS_PER_HOUR).toBe(12);
  });

  it('brainEligible is false for every workspace while off, and comes back unchanged when on', async () => {
    pushMirror(['ws-hq', 'ws-a']);
    await setHqWorkspaceId('ws-hq', dir);
    expect([brainEligible('ws-hq', dir), brainEligible('ws-a', dir)]).toEqual([true, false]);
    await setMoaEnabled(false, dir);
    expect([brainEligible('ws-hq', dir), brainEligible('ws-a', dir)]).toEqual([false, false]);
    await setHqWorkspaceId(null, dir);
    expect(brainEligible('ws-a', dir)).toBe(false);
    await setMoaEnabled(true, dir);
    expect(brainEligible('ws-a', dir)).toBe(true);
  });

  it('keeps the HQ designation across a switch round-trip', async () => {
    await setHqWorkspaceId('ws-hq', dir);
    await setMoaEnabled(false, dir);
    await setMoaEnabled(true, dir);
    expect(getHqWorkspaceId(dir)).toBe('ws-hq');
  });
});

describe('deckHqStore — corrupt store fails closed', () => {
  it('reads as corrupt: switch off, nothing eligible, every write refused, the file untouched', async () => {
    fs.writeFileSync(getDeckHqPath(dir), '{ not json');
    fs.writeFileSync(`${getDeckHqPath(dir)}.bak`, '{"hqWorkspaceId": 42}'); // invalid shape
    expect(isHqStoreCorrupt(dir)).toBe(true);
    expect(isMoaEnabled(dir)).toBe(false);
    expect(brainEligible('ws-a', dir)).toBe(false);
    expect(await setHqWorkspaceId('ws-hq', dir)).toEqual({ ok: false, code: 'store_corrupt' });
    expect(await setMoaEnabled(true, dir)).toBe(false);
    expect((await runNonHqMigration('ws-hq', dir, quiet)).ran).toBe(false);
    expect(fs.readFileSync(getDeckHqPath(dir), 'utf8')).toBe('{ not json');
  });

  it('falls back to a valid backup copy', async () => {
    await setHqWorkspaceId('ws-hq', dir);
    fs.copyFileSync(getDeckHqPath(dir), `${getDeckHqPath(dir)}.bak`);
    fs.writeFileSync(getDeckHqPath(dir), '{ torn');
    expect(isHqStoreCorrupt(dir)).toBe(false);
    expect(getHqWorkspaceId(dir)).toBe('ws-hq');
  });

  it('a missing file is not corrupt (today\'s default)', () => {
    expect(isHqStoreCorrupt(dir)).toBe(false);
    expect(isMoaEnabled(dir)).toBe(true);
  });
});

describe('deckHqStore — HQ presence', () => {
  const mirror = (ids: string[] | null, restored = true, ageMs = 0) => ({
    peek: () => (ids === null ? null : { entries: ids.map((id) => ({ id, name: id })), ageMs }),
    isSessionRestored: () => restored,
  });

  it('present when listed, missing when a restored session does not list it', () => {
    expect(hqPresence(null, mirror(['ws-a']))).toBe('unset');
    expect(hqPresence('ws-hq', mirror(['ws-hq', 'ws-a']))).toBe('present');
    expect(hqPresence('ws-hq', mirror(['ws-a']))).toBe('missing');
  });

  it('stays unknown until something trustworthy is observed', () => {
    expect(hqPresence('ws-hq', mirror(null))).toBe('unknown'); // no push yet
    expect(hqPresence('ws-hq', mirror([]))).toBe('unknown'); // empty list
    expect(hqPresence('ws-hq', mirror(['ws-a'], false))).toBe('unknown'); // nothing restored
    expect(hqPresence('ws-hq', mirror(['ws-a'], true, 120_000))).toBe('unknown'); // stale
  });

  it('latches missing until the HQ is listed again (stale or empty mirrors do not clear it)', () => {
    expect(hqPresence('ws-hq', mirror(['ws-hq'], false))).toBe('present');
    expect(hqPresence('ws-hq', mirror(['ws-a'], false))).toBe('missing'); // seen before → trustworthy
    expect(hqPresence('ws-hq', mirror(['ws-a'], false, 120_000))).toBe('missing'); // stale: still missing
    expect(hqPresence('ws-hq', mirror([]))).toBe('missing');
    expect(hqPresence('ws-hq', mirror(null))).toBe('missing');
    expect(hqPresence('ws-hq', mirror(['ws-hq']))).toBe('present');
    // Another HQ id is not covered by what was observed for the first.
    expect(hqPresence('ws-other', mirror(['ws-a'], false))).toBe('unknown');
  });
});

describe('deckHqStore — non-HQ migration', () => {
  async function seed(): Promise<void> {
    const now = Date.now();
    await saveDeckSchedules(
      [
        { id: 's-hq', workspaceId: 'ws-hq', prompt: 'hq', nextRunAt: now + 1000, enabled: true, createdAt: now },
        { id: 's-a', workspaceId: 'ws-a', prompt: 'a', nextRunAt: now + 1000, enabled: true, createdAt: now },
      ],
      dir,
    );
    await startLoop('ws-hq', { objective: 'hq loop', steps: [] }, dir);
    await startLoop('ws-a', { objective: 'a loop', steps: [] }, dir);
    await raiseDecision('ws-hq', { question: 'hq q', options: [], context: '' }, dir);
    await raiseDecision('ws-a', { question: 'a q', options: [], context: '' }, dir);
    beginOrContinueDeckWork('ws-hq', 'hq work', dir);
    beginOrContinueDeckWork('ws-a', 'a work', dir);
  }

  it('parks non-HQ automation, archives its decisions and live work, and leaves the HQ alone', async () => {
    await seed();
    const report = await runNonHqMigration('ws-hq', dir, quiet);

    expect(report.ran).toBe(true);
    const schedules = Object.fromEntries(loadDeckSchedules(dir).map((s) => [s.id, s.enabled]));
    expect(schedules).toEqual({ 's-hq': true, 's-a': false });
    expect(loadWorkspaceLoopState('ws-a', dir)?.status).toBe('paused');
    expect(loadWorkspaceLoopState('ws-hq', dir)?.status).toBe('running');
    expect(loadWorkspaceDecision('ws-a', dir)).toBeNull();
    expect(loadWorkspaceDecision('ws-hq', dir)?.status).toBe('pending');
    expect(report.decisionsArchived.map((d) => [d.workspaceId, d.decision.question])).toEqual([['ws-a', 'a q']]);
    expect(loadArchivedHqDecisions(dir).map((d) => d.workspaceId)).toEqual(['ws-a']);
    expect(loadActiveDeckWork('ws-a', dir)).toBeNull();
    expect(loadActiveDeckWork('ws-hq', dir)).not.toBeNull();
    expect(loadArchivedDeckWorks(dir).map((w) => w.objective)).toEqual(['a work']);
  });

  it('runs once per HQ: the same HQ changes nothing again, a different HQ re-runs', async () => {
    await seed();
    await runNonHqMigration('ws-hq', dir, quiet);
    // The operator re-enables the non-HQ schedule and raises a new decision.
    await mutateDeckSchedules((list) => list.map((s) => ({ ...s, enabled: true })), dir);
    await raiseDecision('ws-a', { question: 'again', options: [], context: '' }, dir);

    const second = await runNonHqMigration('ws-hq', dir, quiet);
    expect(second.ran).toBe(false);
    expect(loadDeckSchedules(dir).every((s) => s.enabled)).toBe(true);
    expect(loadWorkspaceDecision('ws-a', dir)?.question).toBe('again');

    // A new HQ: everything that is not it gets parked, the old HQ included.
    const moved = await runNonHqMigration('ws-a', dir, quiet);
    expect(moved.ran).toBe(true);
    expect(Object.fromEntries(loadDeckSchedules(dir).map((s) => [s.id, s.enabled]))).toEqual({ 's-hq': false, 's-a': true });
    expect(loadWorkspaceDecision('ws-a', dir)?.question).toBe('again');
    expect(loadWorkspaceDecision('ws-hq', dir)).toBeNull();
  });

  it('keeps a decision answered while it was being archived, and re-runs later', async () => {
    await raiseDecision('ws-a', { question: 'a q', options: [], context: '' }, dir);
    const real = decisionStore.clearPendingDecisionIfUnchanged;
    // The human answers between the archive write and the clear.
    vi.spyOn(decisionStore, 'clearPendingDecisionIfUnchanged').mockImplementationOnce(async (ws, expected, d) => {
      await resolveDecision(ws, expected.id, 'yes', d);
      return real(ws, expected, d);
    });
    const report = await runNonHqMigration('ws-hq', dir, quiet);
    expect(report.decisionsArchived).toEqual([]);
    expect(loadWorkspaceDecision('ws-a', dir)).toMatchObject({ status: 'resolved', resolution: 'yes' });
    // Not marked done: the next run goes again (and finds nothing pending).
    const again = await runNonHqMigration('ws-hq', dir, quiet);
    expect(again.ran).toBe(true);
    expect(loadWorkspaceDecision('ws-a', dir)).toMatchObject({ status: 'resolved' });
  });

  it('does not archive the same decision twice after a crash between archive and clear', async () => {
    await raiseDecision('ws-a', { question: 'a q', options: [], context: '' }, dir);
    vi.spyOn(decisionStore, 'clearPendingDecisionIfUnchanged').mockRejectedValueOnce(new Error('crash'));
    await runNonHqMigration('ws-hq', dir, quiet);
    expect(loadArchivedHqDecisions(dir)).toHaveLength(1);
    expect(loadWorkspaceDecision('ws-a', dir)?.status).toBe('pending');

    const rerun = await runNonHqMigration('ws-hq', dir, quiet);
    expect(rerun.decisionsArchived).toHaveLength(1);
    expect(loadArchivedHqDecisions(dir)).toHaveLength(1);
    expect(loadWorkspaceDecision('ws-a', dir)).toBeNull();
  });

  it('is triggered by the first designation and returns the archived decisions', async () => {
    await seed();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = await setHqWorkspaceId('ws-hq', dir);
    log.mockRestore();
    expect(r.ok && r.migration?.decisionsArchived.map((d) => d.workspaceId)).toEqual(['ws-a']);
    expect(isHqMigrationDone(dir)).toBe(true);
  });
});

describe('deckHqStore — Moa defaults (once per install)', () => {
  it('a new install starts with Moa off, on disk once the chain writes it', async () => {
    const decided = ensureMoaDefault(dir)!;
    expect(decided.reason).toBe('new-install');
    // In memory at once, before the write lands.
    expect(isMoaEnabled(dir)).toBe(false);
    expect(await decided.persisted).toBe(true);
    expect(JSON.parse(fs.readFileSync(getDeckHqPath(dir), 'utf8'))).toMatchObject({ moaEnabled: false, moaDefault: 'new-install' });
    expect(getMoaConfig(dir)).toMatchObject({ enabled: false, onboarded: false, defaultReason: 'new-install' });
  });

  it('a new install whose default cannot be saved stays off until Moa is turned on', async () => {
    __setHqWritersForTest({ async: async () => { throw new Error('ENOSPC'); } });
    try {
      const decided = ensureMoaDefault(dir)!;
      expect(await decided.persisted).toBe(false);
      expect(isMoaEnabled(dir)).toBe(false);
      expect(brainEligible('ws-a', dir)).toBe(false);
    } finally {
      __setHqWritersForTest(null);
    }
    expect(await setMoaEnabled(true, dir)).toBe(true);
    expect(isMoaEnabled(dir)).toBe(true);
  });

  it('an install already using a deck brain keeps today\'s behaviour (on, no HQ)', async () => {
    await setWorkspaceMode('ws-a', 'assist', dir);
    const decided = ensureMoaDefault(dir)!;
    expect(decided.reason).toBe('existing-brain');
    await decided.persisted;
    expect(isMoaEnabled(dir)).toBe(true);
    expect(getHqWorkspaceId(dir)).toBeNull();
    expect(getMoaConfig(dir).onboarded).toBe(false);
  });

  it.each([
    ['a persisted brain conversation', async () => { await saveCommanderSession('ws-a::claude-pty', 'sess-1', dir); }],
    ['an HQ designated by an earlier version', async () => { fs.writeFileSync(getDeckHqPath(dir), JSON.stringify({ hqWorkspaceId: 'ws-hq' })); }],
    ['a migration marker', async () => { fs.writeFileSync(getDeckHqPath(dir), JSON.stringify({ hqWorkspaceId: null, migration: { doneAt: 1, hqWorkspaceId: 'ws-old' } })); }],
    ['archived decisions', async () => {
      fs.writeFileSync(getDeckHqPath(dir), JSON.stringify({
        hqWorkspaceId: null,
        archivedDecisions: [{ workspaceId: 'ws-a', archivedAt: 1, decision: { id: 'd', question: 'q', options: [], context: '', status: 'pending', raisedAt: 1 } }],
      }));
    }],
  ])('%s counts as an existing install', async (_label, seed) => {
    await seed();
    expect(ensureMoaDefault(dir)!.reason).toBe('existing-brain');
    expect(isMoaEnabled(dir)).toBe(true);
  });

  it('never changes a value already on disk, and leaves a corrupt store alone', async () => {
    await setMoaEnabled(true, dir);
    expect(ensureMoaDefault(dir)).toBeNull();
    expect(isMoaEnabled(dir)).toBe(true);
    fs.writeFileSync(getDeckHqPath(dir), '{ torn');
    expect(ensureMoaDefault(dir)).toBeNull();
    expect(fs.readFileSync(getDeckHqPath(dir), 'utf8')).toBe('{ torn');
  });
});

describe('deckHqStore — Moa settings', () => {
  it('the delegate is off by default; unknown values read as off, never corrupt', async () => {
    expect(getMoaConfig(dir)).toMatchObject({ askMode: 'off', autoRules: [], autoDailyCap: 10, autoPaused: false });
    expect(await setMoaConfig({ askMode: 'suggest', autoDailyCap: 3, autoPaused: true }, dir)).toBe(true);
    expect(await setMoaAutoRules(['R-b', 'not a rule', 'R-a', 'R-b'], dir)).toBe(true);
    expect(getMoaConfig(dir)).toMatchObject({ askMode: 'suggest', autoRules: ['R-a', 'R-b'], autoDailyCap: 3, autoPaused: true });
    await setMoaConfig({ askMode: 'yolo' as 'auto', autoDailyCap: 999 }, dir);
    expect(getMoaConfig(dir)).toMatchObject({ askMode: 'suggest', autoDailyCap: 3 });
    const raw = JSON.parse(fs.readFileSync(getDeckHqPath(dir), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(getDeckHqPath(dir), JSON.stringify({ ...raw, moaAskMode: 'yolo', moaAutoRules: [1, 'R-c'] }));
    __resetHqMemoryForTest();
    expect(getMoaConfig(dir)).toMatchObject({ enabled: true, askMode: 'off', autoRules: ['R-c'] });
  });

  it('has defaults and keeps only valid patches', async () => {
    expect(getMoaConfig(dir)).toMatchObject({ level: 1, maxTurnsPerHour: 12, bubbles: true, reduceMotion: false });
    expect(await setMoaConfig({ level: 2, maxTurnsPerHour: 30, bubbles: false, reduceMotion: true, onboarded: true }, dir)).toBe(true);
    expect(getMoaConfig(dir)).toMatchObject({ level: 2, maxTurnsPerHour: 30, bubbles: false, reduceMotion: true, onboarded: true });
    await setMoaConfig({ level: 7 as 1, maxTurnsPerHour: 0 }, dir);
    await setMoaConfig({ maxTurnsPerHour: 1.5 }, dir);
    expect(getMoaConfig(dir)).toMatchObject({ level: 2, maxTurnsPerHour: 30 });
    expect(getHqMaxTurnsPerHour(dir)).toBe(30);
  });

  it('stores level 0 in its own field, so an older build still reads a valid level', async () => {
    expect(await setMoaConfig({ level: 0 }, dir)).toBe(true);
    expect(getMoaConfig(dir).level).toBe(0);
    const raw = JSON.parse(fs.readFileSync(getDeckHqPath(dir), 'utf8'));
    expect(raw).toMatchObject({ moaAutonomyLevel: 0, moaLevel: 1 });
    await setMoaConfig({ level: 3 }, dir);
    expect(JSON.parse(fs.readFileSync(getDeckHqPath(dir), 'utf8'))).toMatchObject({ moaAutonomyLevel: 3, moaLevel: 3 });
  });

  it('a bad autonomy level falls back to the legacy level without marking the file corrupt', async () => {
    await setMoaConfig({ level: 2, onboarded: true }, dir);
    const raw = JSON.parse(fs.readFileSync(getDeckHqPath(dir), 'utf8'));
    fs.writeFileSync(getDeckHqPath(dir), JSON.stringify({ ...raw, moaAutonomyLevel: 9 }));
    __resetHqMemoryForTest();
    expect(getMoaConfig(dir)).toMatchObject({ level: 2, onboarded: true });
  });

  it('keeps proposals off by default and stores only valid lists and intervals', async () => {
    expect(getMoaConfig(dir)).toMatchObject({ issueProposals: false, trustedAuthors: [], issuePollMinutes: 10, ignoredRepos: [] });
    expect(await setMoaConfig({
      issueProposals: true,
      trustedAuthors: ['@Alice', 'bob', 'not a login!', 'bob'],
      issuePollMinutes: 30,
      ignoredRepos: ['GitHub.com/O/R', 'nonsense'],
    }, dir)).toBe(true);
    expect(getMoaConfig(dir)).toMatchObject({
      issueProposals: true, trustedAuthors: ['alice', 'bob'], issuePollMinutes: 30, ignoredRepos: ['github.com/o/r'],
    });
    // Stored under its own keys, apart from the memory proposals' switch.
    const raw = JSON.parse(fs.readFileSync(getDeckHqPath(dir), 'utf8'));
    expect(raw).toMatchObject({ moaIssueProposals: true, moaIssuePollMinutes: 30 });
    expect(raw.moaProposals).toBeUndefined();
    await setMoaConfig({ issuePollMinutes: 1 }, dir);
    await setMoaConfig({ issuePollMinutes: 5.5 }, dir);
    expect(getMoaConfig(dir).issuePollMinutes).toBe(30);
    expect(await addMoaIgnoredRepo('github.com/a/b', dir)).toBe(true);
    expect(await addMoaIgnoredRepo('github.com/a/b', dir)).toBe(true);
    expect(getMoaConfig(dir).ignoredRepos).toEqual(['github.com/o/r', 'github.com/a/b']);
    // A full list drops its oldest entry; the new key always lands.
    await setMoaConfig({ ignoredRepos: Array.from({ length: 50 }, (_, i) => `github.com/o/r${i}`) }, dir);
    expect(await addMoaIgnoredRepo('github.com/new/one', dir)).toBe(true);
    const ignored = getMoaConfig(dir).ignoredRepos!;
    expect(ignored).toHaveLength(50);
    expect(ignored[0]).toBe('github.com/o/r1');
    expect(ignored.at(-1)).toBe('github.com/new/one');
    // Another setting's write keeps them (sanitize must carry the fields).
    await setMoaConfig({ bubbles: false }, dir);
    expect(getMoaConfig(dir)).toMatchObject({ issueProposals: true, trustedAuthors: ['alice', 'bob'] });
  });

  it('keeps the HQ approval lane off until the operator turns it on', async () => {
    expect(getMoaConfig(dir).approvalPress).toBe(false);
    expect(isHqApprovalPressEnabled(dir)).toBe(false);
    expect(await setMoaConfig({ approvalPress: true }, dir)).toBe(true);
    expect(getMoaConfig(dir).approvalPress).toBe(true);
    expect(isHqApprovalPressEnabled(dir)).toBe(true);
    await setMoaConfig({ approvalPress: 'yes' as unknown as boolean }, dir);
    expect(isHqApprovalPressEnabled(dir)).toBe(true);
    expect(await setMoaConfig({ approvalPress: false }, dir)).toBe(true);
    expect(isHqApprovalPressEnabled(dir)).toBe(false);
  });

  it('acknowledging the archive clears the one-time notice until something new is archived', async () => {
    await raiseDecision('ws-a', { question: 'a q', options: [], context: '' }, dir);
    await runNonHqMigration('ws-hq', dir, quiet, () => 1000);
    expect(countUnackedArchivedDecisions(dir)).toBe(1);
    expect(await ackArchivedDecisions(dir)).toBe(true);
    expect(countUnackedArchivedDecisions(dir)).toBe(0);
    await raiseDecision('ws-b', { question: 'b q', options: [], context: '' }, dir);
    await runNonHqMigration('ws-b2', dir, quiet, () => 2000);
    expect(countUnackedArchivedDecisions(dir)).toBe(1);
  });

  it('resetting a corrupt store moves it aside and starts over with Moa off', () => {
    fs.writeFileSync(getDeckHqPath(dir), '{ torn');
    expect(resetCorruptHqStore(dir)).toBe(true);
    expect(isHqStoreCorrupt(dir)).toBe(false);
    expect(getMoaConfig(dir).enabled).toBe(false);
    expect(getHqWorkspaceId(dir)).toBeNull();
    // A readable store is not reset.
    expect(resetCorruptHqStore(dir)).toBe(false);
  });

  it('a reset whose fresh file cannot be written leaves the store corrupt (fail closed), nothing moved', () => {
    fs.writeFileSync(getDeckHqPath(dir), '{ torn');
    fs.writeFileSync(`${getDeckHqPath(dir)}.bak`, '{ torn');
    __setHqWritersForTest({ sync: () => { throw new Error('ENOSPC'); } });
    try {
      expect(resetCorruptHqStore(dir)).toBe(false);
    } finally {
      __setHqWritersForTest(null);
    }
    expect(isHqStoreCorrupt(dir)).toBe(true);
    expect(isMoaEnabled(dir)).toBe(false);
    expect(fs.readFileSync(getDeckHqPath(dir), 'utf8')).toBe('{ torn');
    expect(fs.existsSync(`${getDeckHqPath(dir)}.bak`)).toBe(true);
  });

  it('refuses settings writes while corrupt', async () => {
    fs.writeFileSync(getDeckHqPath(dir), '{ torn');
    expect(await setMoaConfig({ bubbles: false }, dir)).toBe(false);
    expect(await ackArchivedDecisions(dir)).toBe(false);
  });
});
