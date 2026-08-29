import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  advanceSessionPromptSchedule,
  claimDueSessionPromptSchedule,
  createSessionPromptSchedule,
  dueSessionPromptSchedules,
  getSessionPromptSchedulesPath,
  loadSessionPromptSchedules,
  mutateSessionPromptSchedules,
  removeSessionPromptSchedulesForPty,
  saveSessionPromptSchedules,
  type SessionPromptSchedule,
} from '../sessionPromptScheduleStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-session-schedule-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function schedule(overrides: Partial<SessionPromptSchedule> = {}): SessionPromptSchedule {
  return {
    id: 'schedule-1',
    ptyId: 'pty-1',
    agentSlug: 'codex',
    prompt: 'continue the milestone',
    nextRunAt: 1_000,
    enabled: true,
    createdAt: 10,
    ...overrides,
  };
}

describe('sessionPromptScheduleStore', () => {
  it('round-trips a validated session schedule', async () => {
    const created = createSessionPromptSchedule({
      ptyId: 'pty-1',
      agentSlug: 'codex',
      prompt: '  run the next milestone  ',
      nextRunAt: 123,
      intervalMinutes: 60,
      now: 7,
    });
    if (!created) throw new Error('Expected a valid schedule');
    await saveSessionPromptSchedules([created], dir);

    expect(loadSessionPromptSchedules(dir)).toEqual([
      expect.objectContaining({
        ptyId: 'pty-1',
        agentSlug: 'codex',
        prompt: 'run the next milestone',
        nextRunAt: 123,
        intervalMinutes: 60,
        enabled: true,
        createdAt: 7,
      }),
    ]);
  });

  it('rejects invalid targets, agents, prompts, and times', () => {
    const base = { agentSlug: 'codex' as const, prompt: 'x', nextRunAt: 100, now: 1 };
    expect(createSessionPromptSchedule({ ...base, ptyId: '' })).toBeNull();
    expect(createSessionPromptSchedule({ ...base, ptyId: 'pty\n1' })).toBeNull();
    expect(createSessionPromptSchedule({ ...base, ptyId: 'pty-1', agentSlug: 'bogus' as 'codex' })).toBeNull();
    expect(createSessionPromptSchedule({ ...base, ptyId: 'pty-1', prompt: '  ' })).toBeNull();
    expect(createSessionPromptSchedule({ ...base, ptyId: 'pty-1', nextRunAt: NaN })).toBeNull();
    expect(createSessionPromptSchedule({ ...base, ptyId: 'pty-1', nextRunAt: 1 })).toBeNull();
    expect(createSessionPromptSchedule({ ...base, ptyId: 'pty-1', intervalMinutes: 0.5 })).toBeNull();
    expect(createSessionPromptSchedule({ ...base, ptyId: 'pty-1', prompt: 'x'.repeat(16_001) })).toBeNull();
  });

  it('loads a missing or corrupt store as empty and drops malformed rows', async () => {
    expect(loadSessionPromptSchedules(dir)).toEqual([]);
    fs.writeFileSync(getSessionPromptSchedulesPath(dir), 'broken{', 'utf8');
    expect(loadSessionPromptSchedules(dir)).toEqual([]);

    await saveSessionPromptSchedules([
      schedule(),
      { ...schedule({ id: 'bad' }), agentSlug: 'unknown' as 'codex' },
    ], dir);
    expect(loadSessionPromptSchedules(dir).map((s) => s.id)).toEqual(['schedule-1']);
  });

  it('returns due schedules in chronological order', () => {
    const rows = [
      schedule({ id: 'later', nextRunAt: 900 }),
      schedule({ id: 'future', nextRunAt: 2_000 }),
      schedule({ id: 'first', nextRunAt: 500 }),
      schedule({ id: 'off', nextRunAt: 100, enabled: false }),
    ];
    expect(dueSessionPromptSchedules(rows, 1_000).map((s) => s.id)).toEqual(['first', 'later']);
  });

  it('keeps busy/unavailable schedules due for retry', () => {
    for (const result of ['busy', 'unavailable'] as const) {
      const advanced = advanceSessionPromptSchedule(schedule(), result, 5_000);
      expect(advanced.enabled).toBe(true);
      expect(advanced.nextRunAt).toBe(1_000);
      expect(advanced.lastAttemptAt).toBe(5_000);
      expect(advanced.lastRunAt).toBeUndefined();
    }
  });

  it('consumes one-shots and advances repeats past a sleep gap', () => {
    const oneShot = advanceSessionPromptSchedule(schedule(), 'sent', 5_000);
    expect(oneShot.enabled).toBe(false);
    expect(oneShot.lastRunAt).toBe(5_000);

    const repeating = advanceSessionPromptSchedule(
      schedule({ intervalMinutes: 1 }),
      'sent',
      181_000,
    );
    expect(repeating.enabled).toBe(true);
    expect(repeating.nextRunAt).toBe(241_000);

    const longGap = advanceSessionPromptSchedule(
      schedule({ intervalMinutes: 1 }),
      'sent',
      365 * 24 * 60 * 60_000,
    );
    expect(longGap.nextRunAt).toBeGreaterThan(365 * 24 * 60 * 60_000);
  });

  it('consumes a partial-write error to avoid duplicate prompt injection', () => {
    const advanced = advanceSessionPromptSchedule(schedule(), 'error', 5_000);
    expect(advanced.enabled).toBe(false);
    expect(advanced.lastResult).toBe('error');
  });

  it('serializes concurrent read-modify-write operations', async () => {
    await saveSessionPromptSchedules([], dir);
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });

    const first = mutateSessionPromptSchedules(async (items) => {
      firstStarted();
      await firstGate;
      return { schedules: [...items, schedule({ id: 'first' })], result: 'first' };
    }, dir);
    await started;
    const second = mutateSessionPromptSchedules((items) => ({
      schedules: [...items, schedule({ id: 'second' })],
      result: 'second',
    }), dir);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(loadSessionPromptSchedules(dir).map((item) => item.id)).toEqual(['first', 'second']);
  });

  it('re-checks pause/delete state before claiming a due occurrence', async () => {
    await saveSessionPromptSchedules([schedule()], dir);
    await mutateSessionPromptSchedules(() => ({ schedules: [], result: undefined }), dir);
    await expect(claimDueSessionPromptSchedule('schedule-1', 5_000, dir)).resolves.toBeNull();
  });

  it('removes every schedule for an explicitly destroyed PTY only', async () => {
    await saveSessionPromptSchedules([
      schedule({ id: 'one', ptyId: 'pty-1' }),
      schedule({ id: 'two', ptyId: 'pty-2' }),
    ], dir);
    await expect(removeSessionPromptSchedulesForPty('pty-1', dir)).resolves.toBe(1);
    expect(loadSessionPromptSchedules(dir).map((item) => item.id)).toEqual(['two']);
  });
});
