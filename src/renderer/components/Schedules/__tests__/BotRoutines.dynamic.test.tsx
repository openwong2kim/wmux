// @vitest-environment jsdom
//
// The bots' own routines on the Schedules page: read-only rows (title, bot,
// schedule, next run or why paused), re-read on a bot event, not drawn when
// there are none.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotRoutine } from '../../../../shared/botRoutine';
import { useStore } from '../../../stores';
import SchedulesView from '../SchedulesView';
import { routineScheduleText, routineStateText } from '../BotRoutines';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NOW = new Date(2026, 9, 13, 8, 0).getTime();

function routine(id: string, over: Partial<BotRoutine> = {}): BotRoutine {
  return {
    id, botId: 'bot-0000000a', workspaceId: 'ws-1', title: `Routine ${id}`, prompt: 'p',
    schedule: { kind: 'interval', everyMs: 60 * 60_000 }, state: 'active', createdAt: 1, updatedAt: 1, nextDueAt: NOW + 60 * 60_000, ...over,
  };
}

describe('routine text', () => {
  it('says the schedule and the state in words', () => {
    expect(routineScheduleText({ kind: 'interval', everyMs: 15 * 60_000 })).toBe('Every 15 min');
    expect(routineScheduleText({ kind: 'interval', everyMs: 2 * 60 * 60_000 })).toBe('Every 2 h');
    expect(routineScheduleText({ kind: 'daily', hour: 9, minute: 5 })).toMatch(/09:05$/);
    expect(routineStateText(routine('r-1'), NOW)).toMatch(/09:00/);
    expect(routineStateText(routine('r-2', { state: 'paused', paused: { reason: 'stop', at: 1 } }))).toBe('Paused (stopped)');
    expect(routineStateText(routine('r-3', { state: 'paused', paused: { reason: 'park', at: 1 } }))).toBe('Paused (bot parked)');
    const nine = new Date(2026, 9, 13, 9, 5).getTime();
    expect(routineScheduleText({ kind: 'once', at: nine }, NOW)).toMatch(/^Once .*09:05/);
    expect(routineStateText(routine('r-4', { schedule: { kind: 'once', at: nine }, nextDueAt: nine }), NOW)).toBe('Active');
    expect(routineStateText(routine('r-5', { schedule: { kind: 'once', at: nine }, state: 'done', done: { reason: 'fired', at: nine } }))).toBe('Done');
    expect(routineStateText(routine('r-6', { schedule: { kind: 'once', at: nine }, state: 'done', done: { reason: 'missed', at: nine } }))).toBe('Missed (not run)');
  });
});

describe('Schedules › Bot routines', () => {
  async function mount(routines: BotRoutine[]) {
    let onEvent: (() => void) | null = null;
    const listRoutines = vi.fn(async () => routines);
    vi.stubGlobal('electronAPI', {
      factory: {
        listRoutines,
        listBots: async () => ({ bots: [{ bot: { id: 'bot-0000000a', name: 'Wmux Issue' } }] }),
        onBotEvent: (cb: () => void) => { onEvent = cb; return () => { onEvent = null; }; },
      },
    });
    useStore.setState({ automations: [], automationRuns: [], schedulesSelectedId: null });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<SchedulesView />));
    return { container, root, listRoutines, fire: () => onEvent?.() };
  }

  it('lists each routine read-only with its bot and state; a bot event re-reads them', async () => {
    const { container, root, listRoutines, fire } = await mount([routine('r-a'), routine('r-b', { state: 'paused', paused: { reason: 'bot', at: 1 } })]);
    const rows = [...container.querySelectorAll('[data-bot-routine]')];
    expect(rows.map((r) => r.getAttribute('data-bot-routine'))).toEqual(['r-a', 'r-b']);
    expect(rows[0].textContent).toContain('Routine r-a');
    expect(rows[0].textContent).toContain('Wmux Issue · Every 1 h');
    expect(rows[1].querySelector('[data-off="true"]')).not.toBeNull();
    expect(rows[1].textContent).toContain('Paused by the bot');
    expect(container.querySelectorAll('[data-bot-routines] button')).toHaveLength(0);
    vi.useFakeTimers();
    act(() => fire());
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(listRoutines).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    container.remove();
  });

  it('draws nothing without routines', async () => {
    const { container, root } = await mount([]);
    expect(container.querySelector('[data-bot-routines]')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
