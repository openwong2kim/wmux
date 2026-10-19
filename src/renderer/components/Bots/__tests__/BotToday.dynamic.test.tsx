// @vitest-environment jsdom
// The profile's Today block renders each limit and, on top, the line that
// says what stops the bot (with Resume while it is parked).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactoryBotRow } from '../../Room/factoryPorts';
import { DEFAULT_BOT_BUDGETS, type BotProfile, type BotStatus } from '../../../../shared/bot';
import { en } from '../../../i18n/locales/en';
import { BotToday } from '../BotToday';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>) =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? ''));

function row(over: Partial<BotProfile> = {}, st: Partial<BotStatus> = {}): FactoryBotRow {
  const bot: BotProfile = {
    version: 1, id: 'bot-0000000a', workspaceId: 'ws-1', role: 'verifier', template: 'reviewer', name: 'Reviewer',
    engine: { kind: 'claude-sdk' }, triggers: [], budget: DEFAULT_BOT_BUDGETS.verifier, enabled: true, createdAt: 1, updatedAt: 1, ...over,
  } as BotProfile;
  const status: BotStatus = {
    botId: bot.id, presence: 'idle', queueDepth: 50,
    budgetLeft: { turnsHour: null, turnsDay: 26, workerHoursDay: 0 },
    usage: { turnsHour: null, turnsDay: 174, workerHoursDay: 6, workersRunning: 0, factoryWorkers: 0, slots: { inUse: 1, cap: 5 } },
    ...st,
  };
  return { bot, status };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('BotToday', () => {
  it('shows each limit and says the reviewer is out of worker time, not stuck', () => {
    act(() => root.render(<BotToday row={row()} t={t} />));
    const blocker = host.querySelector('[data-bots-profile-blocker]');
    expect(blocker?.getAttribute('data-bots-profile-blocker')).toBe('workerTime');
    expect(blocker?.textContent).toBe('Reviewer has used its worker hours for today');
    expect(host.querySelector('[data-bots-profile-turns]')?.textContent).toBe('174 used · 26 left');
    const line = (id: string) => host.querySelector(`[data-bots-today-line="${id}"]`);
    expect(line('workerTime')?.textContent).toBe('Worker time6h of 6h');
    expect(line('workerTime')?.getAttribute('data-reached')).toBe('true');
    expect(line('workerTime')?.className).toContain('--accent-yellow');
    expect(line('turnsDay')?.getAttribute('data-reached')).toBeNull();
    expect(line('workers')?.textContent).toBe('Worker slots in use0 of 1');
    expect(line('queue')?.textContent).toBe('Queue50 of 50');
    expect(host.querySelector('[data-testid="bots-resume-bot"]')).toBeNull();
  });

  it('names the slots held by tasks in review, so the cap line agrees with Workers now', () => {
    const base = row({ budget: { ...DEFAULT_BOT_BUDGETS.verifier, maxConcurrentWorkers: 3 } }, { queueDepth: 0, usage: { turnsHour: null, turnsDay: 1, workerHoursDay: 1, workersRunning: 2 } });
    const task = (taskId: string, stage: 'coded' | 'working') => ({ taskId, botId: base.bot.id, title: taskId, stage, taskWorkspaceId: `t-${taskId}`, updatedAt: 1 }) as unknown as NonNullable<FactoryBotRow['tasks']>[number];
    const r = { ...base, tasks: [task('a', 'coded'), task('b', 'coded')] };
    act(() => root.render(<BotToday row={r} liveWorkers={0} t={t} />));
    expect(host.querySelector('[data-bots-today-line="workers"]')?.textContent).toBe('Worker slots in use2 of 3 · 2 held by tasks in review');
    // A worker still starting (no live row yet, no task in review) is not called one.
    act(() => root.render(<BotToday row={{ ...base, tasks: [task('a', 'coded'), task('c', 'working')] }} liveWorkers={0} t={t} />));
    expect(host.querySelector('[data-bots-today-line="workers"]')?.textContent).toBe('Worker slots in use2 of 3 · 1 held by tasks in review');
    act(() => root.render(<BotToday row={r} liveWorkers={2} t={t} />));
    expect(host.querySelector('[data-bots-today-line="workers"]')?.textContent).toBe('Worker slots in use2 of 3');
  });

  it('a parked bot\'s line says why and Resume resumes it', async () => {
    const actFn = vi.fn(async () => ({ ok: true }));
    const r = row({ parked: { reason: 'human', at: 1 } }, { presence: 'parked' });
    act(() => root.render(<BotToday row={r} act={actFn} t={t} />));
    const blocker = host.querySelector('[data-bots-profile-parked="human"]');
    expect(blocker?.textContent).toContain('Paused by you.');
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="bots-resume-bot"]')!.click(); });
    expect(actFn).toHaveBeenCalledWith('resume', 'bot-0000000a');
  });

  it('a bot paused during its running turn offers Resume', () => {
    const r = row({ parked: { reason: 'human', at: 1 } }, { presence: 'running' });
    act(() => root.render(<BotToday row={r} act={vi.fn(async () => ({ ok: true }))} t={t} />));
    expect(host.querySelector('[data-bots-profile-parked="human"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="bots-resume-bot"]')).not.toBeNull();
  });

  it('a parked bot whose status is not reported yet still says why, with Resume', () => {
    const r = { ...row({ parked: { reason: 'error', at: 1 } }), status: null };
    act(() => root.render(<BotToday row={r} act={vi.fn(async () => ({ ok: true }))} t={t} />));
    expect(host.querySelector('[data-bots-profile-parked="error"]')?.textContent).toContain('Stopped after errors');
    expect(host.querySelector('[data-testid="bots-resume-bot"]')).not.toBeNull();
    expect(host.querySelector('[data-bots-today-line]')).toBeNull();
  });

  it('no blocker line when nothing stops the bot', () => {
    const r = row({}, { queueDepth: 0, budgetLeft: { turnsHour: null, turnsDay: 26, workerHoursDay: 4 }, usage: { turnsHour: null, turnsDay: 174, workerHoursDay: 2.25, workersRunning: 0 } });
    act(() => root.render(<BotToday row={r} t={t} />));
    expect(host.querySelector('[data-bots-profile-blocker]')).toBeNull();
    expect(host.querySelector('[data-bots-today-line="workerTime"]')?.textContent).toBe('Worker time2h 15m of 6h');
    expect(host.querySelector('[data-bots-today-line="queue"]')).toBeNull();
  });
});
