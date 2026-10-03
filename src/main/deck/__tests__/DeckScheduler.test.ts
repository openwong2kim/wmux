// Unit tests for the P3d tick loop: due schedules fire as turns, busy retries,
// deletion mid-turn is respected, and one-shots don't double-fire.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeckScheduler, scheduledPrompt } from '../DeckScheduler';
import {
  saveDeckSchedules,
  loadDeckSchedules,
  createSchedule,
  type DeckSchedule,
} from '../deckScheduleStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-tick-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const seed = async (over: Partial<DeckSchedule> = {}): Promise<DeckSchedule> => {
  const s = {
    ...createSchedule({ workspaceId: 'ws-1', prompt: 'run the checks', nextRunAt: 1_000 })!,
    ...over,
  };
  await saveDeckSchedules([s], dir);
  return s;
};

describe('DeckScheduler', () => {
  it('fires a due schedule on ITS workspace with the [Scheduled task] prompt and consumes a one-shot', async () => {
    await seed();
    const runTurn = vi.fn(async () => ({ ok: true }));
    const sched = new DeckScheduler({ runTurn, now: () => 2_000, dir });
    await sched.tick();
    expect(runTurn).toHaveBeenCalledWith('[Scheduled task] run the checks', 'ws-1');
    const after = loadDeckSchedules(dir);
    expect(after[0].enabled).toBe(false);
    expect(after[0].lastResult).toBe('ok');
    // Second tick: nothing due anymore.
    await sched.tick();
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('does not fire future or disabled schedules', async () => {
    const s = await seed({ nextRunAt: 10_000 });
    await saveDeckSchedules([s, { ...s, id: 'off', enabled: false, nextRunAt: 1 }], dir);
    const runTurn = vi.fn(async () => ({ ok: true }));
    await new DeckScheduler({ runTurn, now: () => 2_000, dir }).tick();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('busy leaves the schedule due — the next tick retries', async () => {
    await seed();
    const runTurn = vi
      .fn(async (): Promise<{ ok: boolean; code?: string }> => ({ ok: false, code: 'busy' }))
      .mockResolvedValueOnce({ ok: false, code: 'busy' })
      .mockResolvedValueOnce({ ok: true });
    const sched = new DeckScheduler({ runTurn, now: () => 2_000, dir });
    await sched.tick();
    expect(loadDeckSchedules(dir)[0].lastResult).toBe('busy');
    expect(loadDeckSchedules(dir)[0].enabled).toBe(true);
    await sched.tick();
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(loadDeckSchedules(dir)[0].lastResult).toBe('ok');
  });

  it.each(['rate_limited', 'hq_unknown', 'hq_missing'])(
    'a one-shot refused with %s stays due instead of being consumed',
    async (code) => {
      await seed();
      const runTurn = vi.fn(async () => ({ ok: false, code }));
      await new DeckScheduler({ runTurn, now: () => 2_000, dir }).tick();
      expect(loadDeckSchedules(dir)[0]).toMatchObject({ enabled: true, lastResult: 'busy' });
    },
  );

  it('a repeating schedule advances and stays enabled', async () => {
    await seed({ intervalMinutes: 60 });
    const runTurn = vi.fn(async () => ({ ok: true }));
    await new DeckScheduler({ runTurn, now: () => 2_000, dir }).tick();
    const after = loadDeckSchedules(dir)[0];
    expect(after.enabled).toBe(true);
    expect(after.nextRunAt).toBeGreaterThan(2_000);
  });

  it('a schedule deleted while its turn ran is not resurrected', async () => {
    await seed();
    const runTurn = vi.fn(async () => {
      // Simulate the user deleting the schedule mid-turn.
      await saveDeckSchedules([], dir);
      return { ok: true };
    });
    await new DeckScheduler({ runTurn, now: () => 2_000, dir }).tick();
    expect(loadDeckSchedules(dir)).toEqual([]);
  });

  it('re-entrancy guard: a tick during a slow turn does not double-fire', async () => {
    await seed();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runTurn = vi.fn(async () => { await gate; return { ok: true }; });
    const sched = new DeckScheduler({ runTurn, now: () => 2_000, dir });
    const first = sched.tick();
    await sched.tick(); // overlapping tick — must be a no-op
    release();
    await first;
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('scheduledPrompt prefixes the stored prompt', () => {
    const s = createSchedule({ workspaceId: 'ws-1', prompt: 'p', nextRunAt: 1 })!;
    expect(scheduledPrompt(s)).toBe('[Scheduled task] p');
  });

  it('a busy workspace does not starve another workspace\'s due schedule (M1.5)', async () => {
    const a = createSchedule({ workspaceId: 'ws-a', prompt: 'a', nextRunAt: 100 })!;
    const b = createSchedule({ workspaceId: 'ws-b', prompt: 'b', nextRunAt: 200 })!;
    await saveDeckSchedules([a, b], dir);
    const runTurn = vi.fn(async (_prompt: string, workspaceId: string) =>
      workspaceId === 'ws-a' ? { ok: false, code: 'busy' } : { ok: true },
    );
    await new DeckScheduler({ runTurn, now: () => 2_000, dir }).tick();
    // Both fired this tick — ws-a stayed due (busy), ws-b consumed.
    expect(runTurn).toHaveBeenCalledTimes(2);
    const after = loadDeckSchedules(dir);
    expect(after.find((s) => s.workspaceId === 'ws-a')?.lastResult).toBe('busy');
    expect(after.find((s) => s.workspaceId === 'ws-a')?.enabled).toBe(true);
    expect(after.find((s) => s.workspaceId === 'ws-b')?.lastResult).toBe('ok');
  });
});
