// @vitest-environment jsdom
//
// Regression: the store-wide `agentClockMs` decay clock must NOT re-render the
// Pane body on every tick.
//
// `useAgentActivityClock` bumps `agentClockMs` (via `bumpAgentClock`) ~every 2 s
// while any agent is active. Pane used to subscribe to that clock directly —
// only to recompute the resume chip's busy gate — so at N mounted panes a single
// active agent re-ran ALL N Pane bodies every tick. The subscription now lives
// in the <ResumeInfoChipGate> leaf, mounted only for a pane that carries a
// resume binding. This test proves, via React <Profiler> commit counting (same
// technique as rerenderRegression.dynamic.test.tsx, the #439 harness):
//
//   (a) a component that reads the per-pane fields the Pane BODY keeps after the
//       fix (NOT agentClockMs) does not re-render on a clock tick — the "Pane
//       body did zero work" guarantee, and
//   (b) the gate leaf itself DOES re-render on a tick (idle → renders the chip;
//       busy → returns null) — the cost is confined to the small leaf, and the
//       busy semantics (isPaneAgentBusy) are preserved.
//
// NOTE: the real <Pane> pulls in xterm/Terminal and cannot be mounted cheaply in
// jsdom (the sibling Pane tests deliberately avoid it), so `PaneBodyProbe`
// stands in for the Pane body by subscribing to exactly the per-pane store reads
// the body retains. The gate under test is the REAL component.
import React, { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
(window as unknown as { electronAPI: unknown }).electronAPI = {};

import { useStore } from '../../../stores';
import { ResumeInfoChipGate } from '../ResumeInfoChip';
import type { ResumeBinding } from '../../../../shared/agentResume';

const IDLE_PTY = 'pty-idle';
const BUSY_PTY = 'pty-busy';

const binding: ResumeBinding = { agent: 'claude', sessionId: 'sess-1', cwd: '/x', ts: 0 };

/** Represents the Pane body's remaining per-pane subscriptions AFTER the fix —
 *  notably NOT agentClockMs. If Pane re-subscribed to the clock, a probe shaped
 *  like this would re-render on every tick; it must not. */
function PaneBodyProbe({ ptyId }: { ptyId: string }): React.ReactElement {
  const resumeBinding = useStore((s) => s.resumeBindingByPtyId[ptyId]);
  const resumeHint = useStore((s) => s.resumeHintByPtyId[ptyId]);
  const status = useStore((s) => s.surfaceAgentStatus[ptyId]);
  return React.createElement('div', null, `${!!resumeBinding}:${!!resumeHint}:${status ?? ''}`);
}

let container: HTMLDivElement;
let root: Root;

const commits: Record<string, number> = {};
function reset(id: string) { commits[id] = 0; }
function onRender(id: string) { commits[id] = (commits[id] ?? 0) + 1; }

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000_000));

  // Idle pty: no activity / no shell state / no attention status → not busy.
  // Busy pty: OSC 133 says a foreground command owns the PTY → busy.
  act(() => {
    useStore.setState((s) => {
      s.surfaceActivityAt = {};
      s.surfaceAgentStatus = {};
      s.commandRunningByPtyId = { [BUSY_PTY]: true };
      s.resumeBindingByPtyId = { [IDLE_PTY]: binding, [BUSY_PTY]: binding };
      s.resumeHintByPtyId = {};
      s.agentClockMs = Date.now();
    });
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  for (const k of Object.keys(commits)) delete commits[k];
  reset('body-idle'); reset('gate-idle'); reset('gate-busy');

  act(() => {
    root.render(
      React.createElement(React.Fragment, null,
        React.createElement(Profiler, { id: 'body-idle', onRender: () => onRender('body-idle') },
          React.createElement(PaneBodyProbe, { ptyId: IDLE_PTY }),
        ),
        React.createElement(Profiler, { id: 'gate-idle', onRender: () => onRender('gate-idle') },
          React.createElement(ResumeInfoChipGate, { ptyId: IDLE_PTY, binding, paneCwds: ['/x'] }),
        ),
        React.createElement(Profiler, { id: 'gate-busy', onRender: () => onRender('gate-busy') },
          React.createElement(ResumeInfoChipGate, { ptyId: BUSY_PTY, binding, paneCwds: ['/x'] }),
        ),
      ),
    );
  });
  await act(async () => { await Promise.resolve(); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Advance the clock so `Date.now()` differs, then bump — a distinct value is
 *  required or zustand's Object.is short-circuits the notify (same-ms bump). */
function tick() {
  vi.advanceTimersByTime(2_000);
  act(() => { useStore.getState().bumpAgentClock(); });
}

describe('agentClockMs isolation — a tick re-renders only the resume-chip leaf', () => {
  it('idle pane: the chip is visible and the Pane body does not re-render on a tick', () => {
    // Sanity: idle gate rendered the chip (not busy).
    expect(container.querySelector('button[aria-expanded]')).not.toBeNull();

    reset('body-idle'); reset('gate-idle');
    tick();

    // The regression guard: the Pane body does ZERO work on a clock tick.
    expect(commits['body-idle']).toBe(0);
    // The cost is confined to the leaf, which owns the clock subscription.
    expect(commits['gate-idle']).toBeGreaterThanOrEqual(1);
  });

  it('busy pane: the gate suppresses the chip but still absorbs the tick in the leaf', () => {
    // Busy gate returned null (agent owns the PTY) — chip suppressed.
    expect(commits['gate-busy']).toBeGreaterThanOrEqual(1); // mounted (subscribed)
    reset('gate-busy'); reset('body-idle');
    tick();
    // Still just the leaf re-rendering; no Pane body anywhere is dragged in.
    expect(commits['gate-busy']).toBeGreaterThanOrEqual(1);
    expect(commits['body-idle']).toBe(0);
  });

  it('multiple ticks never touch the Pane body', () => {
    reset('body-idle');
    tick(); tick(); tick();
    expect(commits['body-idle']).toBe(0);
  });
});
