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
import { evaluateStopGate, DEFAULT_MAX_SNAPSHOT_AGE_MS } from '../stopGate';
import type { FleetSnapshot } from '../../../shared/workspaceMirror';

const NOW = 1_700_000_000_000;

function snapshotAt(ts: number): FleetSnapshot {
  return {
    ts,
    panes: [
      { ptyId: 'pty-running', agentStatus: 'running' },
      { ptyId: 'pty-waiting', agentStatus: 'awaiting_input' },
      { ptyId: 'pty-idle', agentStatus: 'idle' },
    ],
  } as unknown as FleetSnapshot;
}

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
    // The verdict carries the set, so the guard cannot protect a different one
    // than the model was told about.
    const verdict = evaluateStopGate({
      snapshot: snapshotAt(NOW),
      consecutiveBlocks: 0,
      now: NOW,
    });
    expect(verdict.block).toBe(true);

    noteGateVerdict(WS, verdict.block ? verdict.outstandingPtyIds : null);
    expect(isGateHeldOn(WS, 'pty-running')).toBe(true);
    expect(isGateHeldOn(WS, 'pty-waiting')).toBe(true);
    expect(isGateHeldOn(WS, 'pty-idle')).toBe(false);
  });

  // Regression for the review catch on this PR: a stale snapshot blocks on the
  // active-work reason alone and names NO pane. Deriving the protected set from
  // the snapshot instead of the verdict protected panes the model was never
  // told about — the exact drift the verdict field exists to prevent.
  it('protects nothing when the block names no pane (stale snapshot + active work)', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshotAt(NOW - DEFAULT_MAX_SNAPSHOT_AGE_MS - 1),
      activeWork: { id: 'work-1' },
      consecutiveBlocks: 0,
      now: NOW,
    });
    expect(verdict.block).toBe(true);
    // The refusal is about the work record, not about any pane.
    expect(verdict.block && verdict.outstandingPtyIds).toEqual([]);

    noteGateVerdict(WS, verdict.block ? verdict.outstandingPtyIds : null);
    expect(isGateHeldOn(WS, 'pty-running')).toBe(false);
  });

  it('protects nothing when there is no snapshot at all', () => {
    const verdict = evaluateStopGate({
      snapshot: null,
      activeWork: { id: 'work-1' },
      consecutiveBlocks: 0,
      now: NOW,
    });
    expect(verdict.block && verdict.outstandingPtyIds).toEqual([]);
  });
});
