import { describe, it, expect } from 'vitest';
import { notifyFanoutCaller, type FanoutCallerEvent } from '../fanoutCallerNotify';
import type { FanoutOrigin } from '../../../shared/fanoutOrigin';

function run(
  stamp: { owner: string; origin?: FanoutOrigin } | undefined,
  kind = 'agent.stop',
  windowUp = true,
): { sent: FanoutCallerEvent[]; ok: boolean } {
  const sent: FanoutCallerEvent[] = [];
  const ok = notifyFanoutCaller('ws-parent', 'ws-task', 'wtask-1', kind, 7, {
    lineageOf: () => stamp,
    send: (ev) => {
      if (!windowUp) return false;
      sent.push(ev);
      return true;
    },
  });
  return { sent, ok };
}

const PANE: FanoutOrigin = { kind: 'pane', paneId: 'pane-a', surfaceId: 'surf-a', label: 'w1 · caller' };

describe('notifyFanoutCaller', () => {
  it('sends the pane origin ids and the task pointer only', () => {
    const { sent, ok } = run({ owner: 'ws-parent', origin: PANE });
    expect(ok).toBe(true);
    expect(sent).toEqual([
      {
        ownerWorkspaceId: 'ws-parent',
        taskWorkspaceId: 'ws-task',
        taskId: 'wtask-1',
        kind: 'agent.stop',
        seq: 7,
        origin: { paneId: 'pane-a', surfaceId: 'surf-a' },
      },
    ]);
  });

  it('includes stop_failure but not a worker awaiting input', () => {
    expect(run({ owner: 'ws-parent', origin: PANE }, 'agent.stop_failure').sent).toHaveLength(1);
    expect(run({ owner: 'ws-parent', origin: PANE }, 'agent.awaiting_input').sent).toHaveLength(0);
  });

  it('sends nothing without a pane origin, or when the stamp names another owner', () => {
    expect(run(undefined).sent).toHaveLength(0);
    expect(run({ owner: 'ws-parent' }).sent).toHaveLength(0);
    expect(run({ owner: 'ws-parent', origin: { kind: 'gui' } }).sent).toHaveLength(0);
    expect(run({ owner: 'ws-parent', origin: { kind: 'orchestrator' } }).sent).toHaveLength(0);
    expect(run({ owner: 'ws-other', origin: PANE }).sent).toHaveLength(0);
  });

  it('reports false with no window (headless) and never throws', () => {
    expect(run({ owner: 'ws-parent', origin: PANE }, 'agent.stop', false).ok).toBe(false);
    expect(
      notifyFanoutCaller('ws-parent', 'ws-task', 'wtask-1', 'agent.stop', 1, {
        lineageOf: () => { throw new Error('torn'); },
        send: () => true,
      }),
    ).toBe(false);
  });
});
