import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SessionPromptScheduler,
} from '../SessionPromptScheduler';
import {
  createSessionPromptSchedule,
  loadSessionPromptSchedules,
  saveSessionPromptSchedules,
  type SessionPromptSchedule,
} from '../sessionPromptScheduleStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-session-scheduler-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function schedule(overrides: Partial<SessionPromptSchedule> = {}): SessionPromptSchedule {
  const created = createSessionPromptSchedule({
    ptyId: 'pty-1',
    agentSlug: 'codex',
    prompt: 'line one\nline two',
    nextRunAt: 1_000,
    now: 1,
  });
  if (!created) throw new Error('Expected a valid schedule');
  return {
    ...created,
    ...overrides,
  };
}

describe('SessionPromptScheduler', () => {
  it('fires a due schedule once and persists the result', async () => {
    await saveSessionPromptSchedules([schedule()], dir);
    const deliver = vi.fn(async () => 'sent' as const);
    const scheduler = new SessionPromptScheduler({ deliver, now: () => 2_000, dir });

    await scheduler.tick();
    await scheduler.tick();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(loadSessionPromptSchedules(dir)[0]).toMatchObject({
      enabled: false,
      lastResult: 'sent',
      lastRunAt: 2_000,
    });
  });

  it('retries a temporarily unavailable session on a later tick', async () => {
    await saveSessionPromptSchedules([schedule()], dir);
    const deliver = vi
      .fn<() => Promise<'sent' | 'unavailable'>>()
      .mockResolvedValueOnce('unavailable')
      .mockResolvedValueOnce('sent');
    const scheduler = new SessionPromptScheduler({ deliver, now: () => 2_000, dir });

    await scheduler.tick();
    expect(loadSessionPromptSchedules(dir)[0].enabled).toBe(true);
    await scheduler.tick();

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(loadSessionPromptSchedules(dir)[0].enabled).toBe(false);
  });

  it('respects deletion during an in-flight delivery and guards re-entrancy', async () => {
    await saveSessionPromptSchedules([schedule()], dir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deliver = vi.fn(async () => {
      await saveSessionPromptSchedules([], dir);
      await gate;
      return 'sent' as const;
    });
    const scheduler = new SessionPromptScheduler({ deliver, now: () => 2_000, dir });

    const first = scheduler.tick();
    await scheduler.tick();
    release();
    await first;

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(loadSessionPromptSchedules(dir)).toEqual([]);
  });

  it('consumes an interrupted persisted claim instead of replaying it', async () => {
    await saveSessionPromptSchedules([schedule({
      deliveryClaim: { token: 'attempt-1', occurrenceAt: 1_000, startedAt: 1_500 },
    })], dir);
    const deliver = vi.fn(async () => 'sent' as const);
    const scheduler = new SessionPromptScheduler({ deliver, now: () => 100_000, dir });

    await scheduler.tick();

    expect(deliver).not.toHaveBeenCalled();
    expect(loadSessionPromptSchedules(dir)[0]).toMatchObject({
      enabled: false,
      lastResult: 'error',
      lastRunAt: 100_000,
    });
  });

  it('does not steal a live claim from another scheduler generation', async () => {
    await saveSessionPromptSchedules([schedule()], dir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deliver = vi.fn(async () => {
      await gate;
      return 'sent' as const;
    });
    const first = new SessionPromptScheduler({ deliver, now: () => 2_000, dir });
    const second = new SessionPromptScheduler({ deliver, now: () => 2_000, dir });

    const firstTick = first.tick();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await second.tick();
    release();
    await firstTick;

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(loadSessionPromptSchedules(dir)[0]).toMatchObject({ enabled: false, lastResult: 'sent' });
  });
});
