// Regression: #733 — the brain killed a live user shell to clear its status.
//
// The Stop gate told it "resolve these panes"; it read that as "end these
// panes" and ran `exit`, then Ctrl+D. The refusal text now forbids that, but
// the brain is a separate process and prose is not a control. This module is
// the enforcement half: it remembers which panes are holding a workspace's
// gate so `input.rpc` can refuse exactly that intersection.
//
// The scope matters as much as the block. Refusing every `exit` would make the
// orchestrator unable to close shells at all, so these tests pin both edges:
// the pane the gate named is protected, and nothing else is.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteGateVerdict,
  isGateHeldOn,
  clearGateVerdict,
  resetGateVerdicts,
  GATE_VERDICT_TTL_MS,
} from '../stopGateState';
import { outstandingPtyIds } from '../stopGate';
import type { FleetSnapshot } from '../../../shared/workspaceMirror';

const WS = 'ws-1';

describe('stopGateState (#733)', () => {
  beforeEach(() => resetGateVerdicts());

  it('protects a pane the gate is blocked on', () => {
    noteGateVerdict(WS, ['pty-a']);
    expect(isGateHeldOn(WS, 'pty-a')).toBe(true);
  });

  it('leaves other panes alone while the gate is held', () => {
    // The orchestrator is blocked on pty-a. Closing an unrelated shell is
    // still its business.
    noteGateVerdict(WS, ['pty-a']);
    expect(isGateHeldOn(WS, 'pty-b')).toBe(false);
  });

  it('releases every pane once the gate lets a turn end', () => {
    noteGateVerdict(WS, ['pty-a']);
    noteGateVerdict(WS, null);
    expect(isGateHeldOn(WS, 'pty-a')).toBe(false);
  });

  it('does not touch other workspaces', () => {
    noteGateVerdict(WS, ['pty-a']);
    expect(isGateHeldOn('ws-2', 'pty-a')).toBe(false);
  });

  it('expires on its own so an abandoned turn cannot protect panes forever', () => {
    // The bug being fixed here came from state that outlived its meaning.
    // This record must not repeat that.
    const t0 = 1_000_000;
    noteGateVerdict(WS, ['pty-a'], t0);
    expect(isGateHeldOn(WS, 'pty-a', t0 + GATE_VERDICT_TTL_MS - 1)).toBe(true);
    expect(isGateHeldOn(WS, 'pty-a', t0 + GATE_VERDICT_TTL_MS + 1)).toBe(false);
  });

  it('clears on demand when a commander session is replaced', () => {
    noteGateVerdict(WS, ['pty-a']);
    clearGateVerdict(WS);
    expect(isGateHeldOn(WS, 'pty-a')).toBe(false);
  });

  it('records exactly the panes the refusal names', () => {
    // One definition of "outstanding", shared with the reason string, so the
    // guard can never protect a different set than the model was told about.
    const snapshot = {
      ts: Date.now(),
      panes: [
        { ptyId: 'pty-running', agentStatus: 'running' },
        { ptyId: 'pty-waiting', agentStatus: 'awaiting_input' },
        { ptyId: 'pty-idle', agentStatus: 'idle' },
      ],
    } as unknown as FleetSnapshot;

    noteGateVerdict(WS, outstandingPtyIds(snapshot));
    expect(isGateHeldOn(WS, 'pty-running')).toBe(true);
    expect(isGateHeldOn(WS, 'pty-waiting')).toBe(true);
    expect(isGateHeldOn(WS, 'pty-idle')).toBe(false);
  });
});
