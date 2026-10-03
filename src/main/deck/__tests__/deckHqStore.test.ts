import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getHqWorkspaceId,
  hqAllowsBrain,
  isHqMigrationDone,
  isHqWorkspaceMissing,
  loadArchivedHqDecisions,
  runNonHqMigration,
  setHqRuntime,
  setHqWorkspaceId,
} from '../deckHqStore';
import { saveDeckSchedules, loadDeckSchedules, mutateDeckSchedules } from '../deckScheduleStore';
import { startLoop, loadWorkspaceLoopState } from '../deckLoopStateStore';
import { raiseDecision, loadWorkspaceDecision } from '../deckDecisionStore';
import { beginOrContinueDeckWork, loadActiveDeckWork, loadArchivedDeckWorks } from '../deckWorkStore';

let dir: string;
let disposeRuntime: (() => void) | null = null;
const quiet = (): void => undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hq-test-'));
});

afterEach(() => {
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

  it('refuses while a brain runs for the old or the new HQ, and retires every other brain on success', async () => {
    const running = new Set(['ws-hq']);
    const retired: string[] = [];
    disposeRuntime = setHqRuntime({
      isBrainRunning: (ws) => running.has(ws),
      retireBrainsExcept: (hq) => retired.push(hq),
    });
    expect(await setHqWorkspaceId('ws-hq', dir)).toEqual({ ok: false, code: 'brain_running', workspaceId: 'ws-hq' });
    expect(getHqWorkspaceId(dir)).toBeNull();

    running.clear();
    expect((await setHqWorkspaceId('ws-hq', dir)).ok).toBe(true);
    expect(retired).toEqual(['ws-hq']);

    // The OLD HQ's running brain blocks a move too.
    running.add('ws-hq');
    expect(await setHqWorkspaceId('ws-other', dir)).toEqual({ ok: false, code: 'brain_running', workspaceId: 'ws-hq' });
    expect(getHqWorkspaceId(dir)).toBe('ws-hq');
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
});

describe('deckHqStore — hq-missing', () => {
  const mirror = (ids: string[] | null, restored = true, ageMs = 0) => ({
    peek: () => (ids === null ? null : { entries: ids.map((id) => ({ id, name: id })), ageMs }),
    isSessionRestored: () => restored,
  });

  it('is missing only when a trusted mirror does not list the HQ', () => {
    expect(isHqWorkspaceMissing(null, mirror(['ws-a']))).toBe(false);
    expect(isHqWorkspaceMissing('ws-hq', mirror(['ws-hq', 'ws-a']))).toBe(false);
    expect(isHqWorkspaceMissing('ws-hq', mirror(['ws-a']))).toBe(true);
  });

  it('never reads an untrusted mirror as missing', () => {
    expect(isHqWorkspaceMissing('ws-hq', mirror(null))).toBe(false); // no push yet
    expect(isHqWorkspaceMissing('ws-hq', mirror([]))).toBe(false); // empty list
    expect(isHqWorkspaceMissing('ws-hq', mirror(['ws-a'], false))).toBe(false); // session not restored
    expect(isHqWorkspaceMissing('ws-hq', mirror(['ws-a'], true, 60_000), 30_000)).toBe(false); // stale
  });
});

describe('deckHqStore — one-time non-HQ migration', () => {
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
    expect(isHqMigrationDone(dir)).toBe(true);
  });

  it('runs once: a second designation changes nothing', async () => {
    await seed();
    await runNonHqMigration('ws-hq', dir, quiet);
    // The operator re-enables a non-HQ schedule and raises a new decision.
    await mutateDeckSchedules((list) => list.map((s) => ({ ...s, enabled: true })), dir);
    await raiseDecision('ws-a', { question: 'again', options: [], context: '' }, dir);

    const second = await runNonHqMigration('ws-hq', dir, quiet);
    expect(second.ran).toBe(false);
    expect(loadDeckSchedules(dir).every((s) => s.enabled)).toBe(true);
    expect(loadWorkspaceDecision('ws-a', dir)?.question).toBe('again');
    expect(loadArchivedHqDecisions(dir)).toHaveLength(1);
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
