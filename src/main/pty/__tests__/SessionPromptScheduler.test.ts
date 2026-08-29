import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deliverSessionPrompt,
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

describe('deliverSessionPrompt', () => {
  it('re-verifies the agent family, bracket-pastes, then submits multiline input', async () => {
    const writes: string[] = [];
    const result = await deliverSessionPrompt(schedule(), {
      getAgentState: async () => ({ slug: 'codex', status: 'waiting' }),
      write: (_ptyId, data) => { writes.push(data); return true; },
      delay: async () => undefined,
    });

    expect(result).toBe('sent');
    expect(writes).toEqual([
      '\x1b[200~line one\nline two\x1b[201~',
      '\r\r',
    ]);
  });

  it('writes only at an explicit ready boundary', async () => {
    for (const status of ['running', 'awaiting_input', 'idle', 'error'] as const) {
      const write = vi.fn(() => true);
      expect(await deliverSessionPrompt(schedule(), {
        getAgentState: async () => ({ slug: 'codex', status }),
        write,
      })).toBe('busy');
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('does not turn a Codex prompt into a shell/other-agent command', async () => {
    for (const state of [null, { slug: 'claude' as const, status: 'waiting' as const }]) {
      const write = vi.fn(() => true);
      expect(await deliverSessionPrompt(schedule(), {
        getAgentState: async () => state,
        write,
      })).toBe('unavailable');
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('reports unavailable before paste and error after a partial paste', async () => {
    const state = async () => ({ slug: 'codex' as const, status: 'waiting' as const });
    expect(await deliverSessionPrompt(schedule(), {
      getAgentState: state,
      write: () => false,
    })).toBe('unavailable');

    let call = 0;
    expect(await deliverSessionPrompt(schedule(), {
      getAgentState: state,
      write: () => ++call === 1,
      delay: async () => undefined,
    })).toBe('error');
  });
});

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
});
