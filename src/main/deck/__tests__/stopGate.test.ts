import { describe, it, expect } from 'vitest';
import { evaluateStopGate, isOutstandingWorkerPane, DEFAULT_MAX_SNAPSHOT_AGE_MS } from '../stopGate';
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

  // ── Finding 11 (dogfood 2026-09): a shell is not a worker ──────────────────
  // The operator's own zsh promotes to `running` off byte activity alone. It
  // held the turn open (and refused deck_complete_work) for a pane the brain
  // could never resolve, because it belongs to the human.
  describe('shell panes', () => {
    const shell = pane({
      ptyId: 'daemon-5dac0302',
      agentName: null,
      agentStatus: 'running',
      isAgent: false,
    });

    it('does not block on a running shell pane', () => {
      expect(evaluateStopGate({ snapshot: snapshot([shell]), consecutiveBlocks: 0 }).block).toBe(false);
    });

    it('does not block on a shell pane awaiting input', () => {
      const waiting = pane({ ptyId: 'sh-2', agentName: null, agentStatus: 'awaiting_input', isAgent: false });
      expect(evaluateStopGate({ snapshot: snapshot([waiting]), consecutiveBlocks: 0 }).block).toBe(false);
    });

    it('still blocks on a running AGENT pane beside the shell, naming only the agent', () => {
      const verdict = evaluateStopGate({
        snapshot: snapshot([shell, pane({ ptyId: 'pane-w', agentName: 'worker-a', agentStatus: 'running', isAgent: true })]),
        consecutiveBlocks: 0,
      });
      if (!verdict.block) throw new Error('expected a block');
      expect(verdict.outstandingPtyIds).toEqual(['pane-w']);
      expect(verdict.reason).toContain('worker-a (running)');
      expect(verdict.reason).toContain('1 agent pane');
      // The refusal — and the fingerprint the hysteresis keys on — must not
      // mention the human's shell at all.
      expect(verdict.reason).not.toContain('daemon-5dac0302');
      expect(verdict.fingerprint).not.toContain('daemon-5dac0302');
    });

    it('treats a pane with no isAgent field as an agent (older renderer push)', () => {
      const unknown = pane({ ptyId: 'legacy-1', agentName: null, agentStatus: 'running' });
      expect(evaluateStopGate({ snapshot: snapshot([unknown]), consecutiveBlocks: 0 }).block).toBe(true);
    });

    // #733: releasing a shell from BLOCKING must not release it from kill
    // protection. `protectedPtyIds` is the wider set the caller records, so the
    // pane the gate stopped naming is still one input.rpc refuses `exit` for.
    it('still protects a released shell from being killed', () => {
      const verdict = evaluateStopGate({ snapshot: snapshot([shell]), consecutiveBlocks: 0 });
      expect(verdict.block).toBe(false);
      expect(verdict.protectedPtyIds).toEqual(['daemon-5dac0302']);
    });

    it('protects agents and shells alike while blocking on the agent only', () => {
      const verdict = evaluateStopGate({
        snapshot: snapshot([shell, pane({ ptyId: 'pane-w', agentStatus: 'running', isAgent: true })]),
        consecutiveBlocks: 0,
      });
      if (!verdict.block) throw new Error('expected a block');
      expect(verdict.outstandingPtyIds).toEqual(['pane-w']);
      expect(verdict.protectedPtyIds).toEqual(['daemon-5dac0302', 'pane-w']);
    });

    it('protects nothing when the snapshot is stale — the same fail-open as the block', () => {
      const now = 1_000_000;
      const stale: FleetSnapshot = {
        workspaceId: 'ws-1',
        ts: now - DEFAULT_MAX_SNAPSHOT_AGE_MS - 1,
        panes: [shell],
      };
      expect(evaluateStopGate({ snapshot: stale, consecutiveBlocks: 0, now }).protectedPtyIds).toEqual([]);
    });

    // The active-work branch names no pane, and the brain can see the shell on
    // its own — so the refusal has to say the shell is not its business, or it
    // raises a decision about it (the dogfood failure).
    it('tells the brain the busy shells are human-owned when active work holds the turn', () => {
      const verdict = evaluateStopGate({
        snapshot: snapshot([shell]),
        activeWork: { id: 'work-1' },
        consecutiveBlocks: 0,
      });
      if (!verdict.block) throw new Error('expected a block');
      expect(verdict.reason).toContain('daemon-5dac0302');
      expect(verdict.reason).toMatch(/human's own shell, not yours/);
      expect(verdict.reason).toMatch(/not a blocker/);
      // It is still an active-work hold, not a pane hold.
      expect(verdict.outstandingPtyIds).toEqual([]);
      expect(verdict.protectedPtyIds).toEqual(['daemon-5dac0302']);
    });
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

// Rule 4: deck_ask_decision is the brain saying "only a human can move this
// forward", and the decision block orders it NOT to proceed. Refusing the Stop
// on top of that left the model exactly one move — re-printing its question —
// which is the transcript pathology (2026-08-07) this rule removes.
// ── Hook-driven `running`: a worker counts the instant it starts ────────────
// A worker pane goes `running` on its UserPromptSubmit hook, before it has
// emitted a byte of output. Both gates read that status and nothing else — no
// activity stamp, no byte count, no settling delay — so a brain that delegates
// and immediately tries to stop is held on the worker it just started, not on
// whether that worker has produced enough output to look busy yet.
describe('a worker counts from its turn start, with no byte threshold', () => {
  const justStarted = pane({
    ptyId: 'pane-worker',
    // Freshly spawned: the roster has no name for it yet and it has written
    // nothing. `running` came from the hook, and it is the whole input.
    agentName: null,
    agentStatus: 'running',
    isAgent: true,
  });

  it('holds the stop gate open', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([justStarted]),
      consecutiveBlocks: 0,
    });
    if (!verdict.block) throw new Error('expected a block');
    expect(verdict.outstandingPtyIds).toEqual(['pane-worker']);
  });

  it('counts as outstanding for deck_complete_work too (the shared rule)', () => {
    expect(isOutstandingWorkerPane(justStarted)).toBe(true);
  });

  it('and the same pane at rest does not', () => {
    expect(isOutstandingWorkerPane({ ...justStarted, agentStatus: 'idle' })).toBe(false);
  });
});

describe('a pending decision releases the gate (rule 4)', () => {
  it('allows even with outstanding panes AND active work', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([pane({ agentStatus: 'running' })]),
      activeWork: { id: 'work-1' },
      pendingDecision: true,
      consecutiveBlocks: 0,
    });
    expect(verdict.block).toBe(false);
  });

  it('does not mark the pending-decision allow as a cap-out', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([pane({ agentStatus: 'running' })]),
      activeWork: { id: 'work-1' },
      pendingDecision: true,
      consecutiveBlocks: 99,
    });
    // The busy pane is still reported for kill protection (#733) — only the
    // BLOCK is released here.
    expect(verdict).toEqual({ block: false, protectedPtyIds: ['pane-1'] });
  });

  it('an explicit false keeps the gate armed', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([pane({ agentStatus: 'running' })]),
      pendingDecision: false,
      consecutiveBlocks: 0,
    });
    expect(verdict.block).toBe(true);
  });
});

// Rule 5: the consecutive-block counter is per turn, so a wake loop over
// unchanged fleet state re-bought the same three refusals every cycle. The
// cap-out allow carries a fingerprint; passing it back keeps the gate quiet
// until the state actually changes.
describe('cap-out hysteresis (rule 5)', () => {
  const busy = () => snapshot([pane({ ptyId: 'pty-a', agentStatus: 'running' })]);

  it('every refusal names the state it is holding on', () => {
    const verdict = evaluateStopGate({
      snapshot: busy(),
      activeWork: { id: 'work-1', updatedAt: 500 },
      consecutiveBlocks: 0,
    });
    if (!verdict.block) throw new Error('expected a block');
    expect(verdict.fingerprint).toBe('work-1@500|pty-a:running');
  });

  it('the allow that ends a refusal run at the cap carries the fingerprint', () => {
    const verdict = evaluateStopGate({
      snapshot: busy(),
      activeWork: { id: 'work-1', updatedAt: 500 },
      consecutiveBlocks: 3,
    });
    expect(verdict.block).toBe(false);
    if (verdict.block) throw new Error('expected an allow');
    expect(verdict.cappedOutFingerprint).toBe('work-1@500|pty-a:running');
  });

  it('an allow with nothing held carries no fingerprint', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([pane({ agentStatus: 'idle' })]),
      consecutiveBlocks: 3,
    });
    expect(verdict).toEqual({ block: false, protectedPtyIds: [] });
  });

  it('stays quiet while the suppressed fingerprint matches the current state', () => {
    const capped = evaluateStopGate({
      snapshot: busy(),
      activeWork: { id: 'work-1', updatedAt: 500 },
      consecutiveBlocks: 3,
    });
    if (capped.block) throw new Error('expected a cap-out allow');
    const next = evaluateStopGate({
      snapshot: busy(),
      activeWork: { id: 'work-1', updatedAt: 500 },
      consecutiveBlocks: 0,
      suppressedFingerprint: capped.cappedOutFingerprint,
    });
    expect(next).toEqual({ block: false, protectedPtyIds: ['pty-a'] });
  });

  it('re-arms when the outstanding pane set changes', () => {
    const suppressed = 'work-1@500|pty-a:running';
    const flipped = evaluateStopGate({
      snapshot: snapshot([pane({ ptyId: 'pty-a', agentStatus: 'awaiting_input' })]),
      activeWork: { id: 'work-1', updatedAt: 500 },
      consecutiveBlocks: 0,
      suppressedFingerprint: suppressed,
    });
    expect(flipped.block).toBe(true);
  });

  it('re-arms when the active-work revision advances (a follow-up or A2A touch)', () => {
    const suppressed = 'work-1@500|pty-a:running';
    const touched = evaluateStopGate({
      snapshot: busy(),
      activeWork: { id: 'work-1', updatedAt: 501 },
      consecutiveBlocks: 0,
      suppressedFingerprint: suppressed,
    });
    expect(touched.block).toBe(true);
  });

  it('pane ordering cannot fake a state change', () => {
    const a = pane({ ptyId: 'a', agentStatus: 'running' });
    const b = pane({ ptyId: 'b', agentStatus: 'awaiting_input' });
    const capped = evaluateStopGate({ snapshot: snapshot([a, b]), consecutiveBlocks: 3 });
    if (capped.block) throw new Error('expected a cap-out allow');
    const reordered = evaluateStopGate({
      snapshot: snapshot([b, a]),
      consecutiveBlocks: 0,
      suppressedFingerprint: capped.cappedOutFingerprint,
    });
    expect(reordered).toEqual({ block: false, protectedPtyIds: ['b', 'a'] });
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

  // An active-work hold names NO pane, so `input.rpc` — which protects only the
  // ptyIds a verdict names — cannot cover it. That makes the reason string the
  // ONLY thing standing between a wedged record and the #733 escalation, and it
  // is the branch a record stale across a restart actually lands on. All three
  // active-work-only exits shipped without the prohibition; assert each one.
  const activeWork = { id: 'work-1', workspaceId: 'ws-1' };
  const cases: Array<[string, Parameters<typeof evaluateStopGate>[0]]> = [
    ['no snapshot', { snapshot: null as unknown as FleetSnapshot, activeWork, consecutiveBlocks: 0 }],
    [
      'stale snapshot',
      {
        snapshot: { ts: Date.now() - 120_000, panes: [] } as unknown as FleetSnapshot,
        activeWork,
        consecutiveBlocks: 0,
      },
    ],
    [
      'fresh snapshot with every pane quiescent',
      {
        snapshot: { ts: Date.now(), panes: [{ ptyId: 'pty-a', agentStatus: 'idle' }] } as unknown as FleetSnapshot,
        activeWork,
        consecutiveBlocks: 0,
      },
    ],
  ];

  for (const [label, input] of cases) {
    it(`forbids killing a pane on an active-work-only hold (${label})`, () => {
      const verdict = evaluateStopGate(input);
      expect(verdict.block).toBe(true);
      const reason = verdict.block ? verdict.reason : '';
      expect(reason).toMatch(/is still ACTIVE/);
      expect(reason).toMatch(/Do NOT close or kill a pane/);
      expect(reason).toMatch(/no exit, no Ctrl\+D, no kill/);
    });
  }

  it('does not repeat the prohibition when panes are also outstanding', () => {
    const verdict = evaluateStopGate({
      snapshot: {
        ts: Date.now(),
        panes: [{ ptyId: 'pty-a', agentStatus: 'running' }],
      } as unknown as FleetSnapshot,
      activeWork,
      consecutiveBlocks: 0,
    });
    const reason = verdict.block ? verdict.reason : '';
    expect(reason.match(/Do NOT close or kill a pane/g)).toHaveLength(1);
  });
});

// The observed stall (transcript, 2026-08-07): a refused model's cheapest move
// is re-printing its previous message, so every refusal must forbid exactly
// that — and name the legitimate way to wait (deck_ask_decision releases the
// gate, rule 4). Asserted on both block shapes, once each.
describe('stop gate refusal forbids repeating and names the wait state', () => {
  const cases: Array<[string, Parameters<typeof evaluateStopGate>[0]]> = [
    [
      'pane block',
      {
        snapshot: {
          ts: Date.now(),
          panes: [{ ptyId: 'pty-a', agentStatus: 'running' }],
        } as unknown as FleetSnapshot,
        consecutiveBlocks: 0,
      },
    ],
    [
      'active-work-only block',
      { snapshot: null, activeWork: { id: 'work-1' }, consecutiveBlocks: 0 },
    ],
  ];

  for (const [label, input] of cases) {
    it(`names both on a ${label}`, () => {
      const verdict = evaluateStopGate(input);
      expect(verdict.block).toBe(true);
      const reason = verdict.block ? verdict.reason : '';
      expect(reason.match(/Do NOT re-send or restate your previous message/g)).toHaveLength(1);
      expect(reason).toMatch(/a pending decision releases this gate/);
    });
  }
});
