import { describe, it, expect } from 'vitest';
import { evaluateStopGate } from '../stopGate';
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

  it('cannot block on the orchestrator itself — brain ptys are not in the snapshot', () => {
    // The brain pty carries ENV_KEYS.BRAIN_PTY and is filtered out of every
    // pane listing upstream, so the gate only ever sees worker panes. An empty
    // snapshot is what a workspace whose ONLY session is the brain looks like.
    expect(evaluateStopGate({ snapshot: snapshot([]), consecutiveBlocks: 0 }).block).toBe(false);
  });
});
