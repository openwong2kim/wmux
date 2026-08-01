import { describe, it, expect } from 'vitest';
import { evaluateStopGate, DEFAULT_MAX_SNAPSHOT_AGE_MS } from '../stopGate';
import type { FleetSnapshot, FleetSnapshotPane } from '../../../shared/workspaceMirror';

function pane(over: Partial<FleetSnapshotPane> = {}): FleetSnapshotPane {
  return {
    ptyId: 'pane-1',
    agentName: 'Claude Code',
    agentStatus: 'idle',
    isActivePane: false,
    ...over,
  };
}

function snapshot(panes: FleetSnapshotPane[]): FleetSnapshot {
  return { workspaceId: 'ws-1', ts: Date.now(), panes };
}

describe('evaluateStopGate', () => {
  it('blocks while a pane is still running', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([pane({ agentStatus: 'running' })]),
      consecutiveBlocks: 0,
    });
    expect(verdict.block).toBe(true);
  });

  it('blocks while a pane is awaiting input', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([pane({ agentStatus: 'awaiting_input' })]),
      consecutiveBlocks: 0,
    });
    expect(verdict.block).toBe(true);
  });

  it('allows when every pane is quiescent', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([
        pane({ ptyId: 'a', agentStatus: 'idle' }),
        pane({ ptyId: 'b', agentStatus: 'complete' }),
        pane({ ptyId: 'c', agentStatus: 'error' }),
        pane({ ptyId: 'd', agentStatus: 'waiting' }),
      ]),
      consecutiveBlocks: 0,
    });
    expect(verdict.block).toBe(false);
  });

  it('allows on a null snapshot — a derived signal cannot prove absence', () => {
    expect(evaluateStopGate({ snapshot: null, consecutiveBlocks: 0 }).block).toBe(false);
  });

  it('allows once the consecutive-block cap is reached, so the gate cannot trap a turn', () => {
    const busy = snapshot([pane({ agentStatus: 'running' })]);
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 2 }).block).toBe(true);
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 3 }).block).toBe(false);
    expect(
      evaluateStopGate({ snapshot: busy, consecutiveBlocks: 1, maxConsecutiveBlocks: 1 }).block,
    ).toBe(false);
  });

  it('names the blocking panes and their statuses in the reason', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([
        pane({ ptyId: 'pane-a', agentName: 'worker-a', agentStatus: 'running' }),
        pane({ ptyId: 'pane-b', agentName: null, agentStatus: 'awaiting_input' }),
        pane({ ptyId: 'pane-c', agentName: 'worker-c', agentStatus: 'idle' }),
      ]),
      consecutiveBlocks: 0,
    });
    if (!verdict.block) throw new Error('expected a block');
    expect(verdict.reason).toContain('worker-a (running)');
    // A pane with no agent name falls back to its pty id rather than vanishing.
    expect(verdict.reason).toContain('pane-b (awaiting_input)');
    expect(verdict.reason).not.toContain('worker-c');
  });

  it('allows on a STALE snapshot — a renderer that stopped pushing must not wedge the brain', () => {
    const now = 1_000_000;
    const busy: FleetSnapshot = {
      workspaceId: 'ws-1',
      ts: now - DEFAULT_MAX_SNAPSHOT_AGE_MS - 1,
      panes: [pane({ agentStatus: 'running' })],
    };
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 0, now }).block).toBe(false);
  });

  it('still blocks on a snapshot that is exactly at the freshness limit', () => {
    const now = 1_000_000;
    const busy: FleetSnapshot = {
      workspaceId: 'ws-1',
      ts: now - DEFAULT_MAX_SNAPSHOT_AGE_MS,
      panes: [pane({ agentStatus: 'running' })],
    };
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 0, now }).block).toBe(true);
  });

  it('honours an explicit freshness budget', () => {
    const now = 1_000_000;
    const busy: FleetSnapshot = {
      workspaceId: 'ws-1',
      ts: now - 5_000,
      panes: [pane({ agentStatus: 'running' })],
    };
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 0, now, maxSnapshotAgeMs: 1_000 }).block).toBe(false);
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 0, now, maxSnapshotAgeMs: 10_000 }).block).toBe(true);
  });

  it('treats renderer clock skew into the future as fresh, not stale', () => {
    const now = 1_000_000;
    const busy: FleetSnapshot = {
      workspaceId: 'ws-1',
      ts: now + 5_000,
      panes: [pane({ agentStatus: 'running' })],
    };
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 0, now }).block).toBe(true);
  });

  it('cannot block on the orchestrator itself — brain ptys are not in the snapshot', () => {
    // The brain pty carries ENV_KEYS.BRAIN_PTY and is filtered out of every
    // pane listing upstream, so the gate only ever sees worker panes. An empty
    // snapshot is what a workspace whose ONLY session is the brain looks like.
    expect(evaluateStopGate({ snapshot: snapshot([]), consecutiveBlocks: 0 }).block).toBe(false);
  });
});

// Regression: #733 — the brain read "resolve these panes" as "end these panes"
// and ran `exit`, then Ctrl+D, in a live user shell. This string is the only
// thing it reads about a block, so the prohibition has to be in it. Asserted on
// the string the model actually receives, not on a copy.
describe('stop gate refusal names what not to do (#733)', () => {
  it('forbids closing a pane to clear its status, and points at the way out', () => {
    const verdict = evaluateStopGate({
      snapshot: {
        ts: Date.now(),
        panes: [{ ptyId: 'pty-a', agentStatus: 'running' }],
      } as unknown as FleetSnapshot,
      consecutiveBlocks: 0,
    });
    expect(verdict.block).toBe(true);
    const reason = verdict.block ? verdict.reason : '';
    expect(reason).toMatch(/Do NOT close or kill a pane/);
    expect(reason).toMatch(/no exit, no Ctrl\+D, no kill/);
    expect(reason).toMatch(/deck_ask_decision/);
  });
});
