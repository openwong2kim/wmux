// Unit tests for the pure briefing builder: priority ordering, the
// delta-vs-prior-snapshot computation (null prior ⇒ no delta), the structured
// headline counts (prose lives in the renderer), the content guard, auto-expand
// + rising-edge rules, payload caps, and never-throw on null/empty feeds.

import { describe, it, expect } from 'vitest';
import {
  BRIEFING_LIMITS,
  buildBriefingPanes,
  buildWorkspaceBriefing,
  briefingHasContent,
  briefingSignal,
  isNewlyActionable,
  summarizeBriefingCounts,
  hasBriefingDelta,
  shouldAutoExpandBriefing,
  toBriefedSnapshot,
  type BriefedSnapshot,
} from '../deckBriefing';
import type { FleetSnapshot } from '../../workspace/WorkspaceMirror';
import type { WorkspaceDecision } from '../deckDecisionStore';
import type { WorkspaceLoopState } from '../deckLoopStateStore';
import type { AgentStatus } from '../../../shared/types';

const snap = (panes: { ptyId: string; agentStatus: AgentStatus; agentName?: string }[]): FleetSnapshot => ({
  workspaceId: 'ws-1',
  ts: 1,
  panes: panes.map((p) => ({
    ptyId: p.ptyId,
    agentName: p.agentName ?? null,
    agentStatus: p.agentStatus,
    isActivePane: false,
  })),
});

/** BRIEFING_LIMITS.MAX_BLOCKED_IDS is exercised directly below. */
const blockedIdCap = BRIEFING_LIMITS.MAX_BLOCKED_IDS;

const decision = (over: Partial<WorkspaceDecision> = {}): WorkspaceDecision => ({
  id: 'dec-1',
  question: 'Ship it?',
  options: [],
  context: '',
  status: 'pending',
  raisedAt: 1,
  ...over,
});

const baseInputs = {
  workspaceId: 'ws-1',
  entry: { id: 'ws-1', name: 'My Project' },
  snapshot: null as FleetSnapshot | null,
  decision: null as WorkspaceDecision | null,
  mode: 'assist' as const,
  loop: null as WorkspaceLoopState | null,
  prior: null as BriefedSnapshot | null,
  coldStart: false,
  now: 1000,
};

describe('buildWorkspaceBriefing — priority ordering', () => {
  it('sorts panes: awaiting_input → error → complete → running → idle', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([
        { ptyId: 'p-idle', agentStatus: 'idle' },
        { ptyId: 'p-run', agentStatus: 'running' },
        { ptyId: 'p-done', agentStatus: 'complete' },
        { ptyId: 'p-err', agentStatus: 'error' },
        { ptyId: 'p-block', agentStatus: 'awaiting_input' },
      ]),
    });
    // The ladder still runs in full — it decides which single pane the card
    // names — even though the sorted list is no longer part of the payload.
    const sorted = buildBriefingPanes(
      snap([
        { ptyId: 'p-idle', agentStatus: 'idle' },
        { ptyId: 'p-run', agentStatus: 'running' },
        { ptyId: 'p-done', agentStatus: 'complete' },
        { ptyId: 'p-err', agentStatus: 'error' },
        { ptyId: 'p-block', agentStatus: 'awaiting_input' },
      ]),
    );
    expect(sorted.map((p) => p.ptyId)).toEqual(['p-block', 'p-err', 'p-done', 'p-run', 'p-idle']);
    expect(sorted[0].reason).toBe('blocked');
    expect(sorted[1].reason).toBe('error');
    // ...and the briefing ships only its conclusion.
    expect(b.topPane?.ptyId).toBe('p-block');
    expect(b).not.toHaveProperty('panes');
  });

  it('waiting is treated as blocked (same priority as awaiting_input)', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([
        { ptyId: 'p-run', agentStatus: 'running' },
        { ptyId: 'p-wait', agentStatus: 'waiting' },
      ]),
    });
    expect(b.topPane?.ptyId).toBe('p-wait');
    expect(b.topPane?.reason).toBe('blocked');
  });

  it('equal-priority panes break ties by ptyId so the named pane never flickers', () => {
    const build = () =>
      buildWorkspaceBriefing({
        ...baseInputs,
        snapshot: snap([
          { ptyId: 'p-b', agentStatus: 'awaiting_input' },
          { ptyId: 'p-a', agentStatus: 'awaiting_input' },
        ]),
      });
    expect(build().topPane?.ptyId).toBe('p-a');
    expect(build().topPane?.ptyId).toBe('p-a');
  });

  it('an empty fleet has no top pane', () => {
    expect(buildWorkspaceBriefing({ ...baseInputs, snapshot: null }).topPane).toBeNull();
  });
});

describe('buildWorkspaceBriefing — delta vs prior snapshot', () => {
  it('null prior ⇒ changed is null (no "everything is new" on first-ever view)', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([{ ptyId: 'p1', agentStatus: 'complete' }]),
      prior: null,
    });
    expect(b.changed).toBeNull();
    expect(hasBriefingDelta(b.changed)).toBe(false);
  });

  it('computes finished / newlyBlocked / errored transitions against the prior', () => {
    const prior: BriefedSnapshot = {
      panes: [
        { ptyId: 'p-done', agentStatus: 'running' },
        { ptyId: 'p-block', agentStatus: 'running' },
        { ptyId: 'p-err', agentStatus: 'running' },
        { ptyId: 'p-still', agentStatus: 'complete' },
      ],
      decisionId: null,
      at: 1,
    };
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([
        { ptyId: 'p-done', agentStatus: 'complete' },
        { ptyId: 'p-block', agentStatus: 'awaiting_input' },
        { ptyId: 'p-err', agentStatus: 'error' },
        { ptyId: 'p-still', agentStatus: 'complete' }, // unchanged — not counted
      ]),
      prior,
    });
    expect(b.changed).toEqual({
      finished: ['p-done'],
      newlyBlocked: ['p-block'],
      errored: ['p-err'],
      newDecision: false,
    });
  });

  it('a brand-new pane (absent from prior) is not counted as a transition', () => {
    const prior: BriefedSnapshot = { panes: [{ ptyId: 'old', agentStatus: 'running' }], decisionId: null, at: 1 };
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([
        { ptyId: 'old', agentStatus: 'running' },
        { ptyId: 'fresh', agentStatus: 'complete' },
      ]),
      prior,
    });
    expect(b.changed?.finished).toEqual([]);
  });

  it('newDecision true when a pending decision id differs from the prior view', () => {
    const prior: BriefedSnapshot = { panes: [], decisionId: 'old-dec', at: 1 };
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      decision: decision({ id: 'new-dec' }),
      prior,
    });
    expect(b.changed?.newDecision).toBe(true);
    expect(b.pendingDecision?.id).toBe('new-dec');
  });

  it('newDecision false when the same decision persists across views', () => {
    const prior: BriefedSnapshot = { panes: [], decisionId: 'dec-1', at: 1 };
    const b = buildWorkspaceBriefing({ ...baseInputs, decision: decision({ id: 'dec-1' }), prior });
    expect(b.changed?.newDecision).toBe(false);
  });

  it('a resolved decision is not surfaced as pendingDecision', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      decision: decision({ status: 'resolved', resolution: 'yes' }),
    });
    expect(b.pendingDecision).toBeNull();
  });
});

describe('headline counts (structured, never prose)', () => {
  it('empty workspace → all-zero counts', () => {
    const b = buildWorkspaceBriefing({ ...baseInputs, snapshot: null });
    expect(b.counts).toEqual({ total: 0, blocked: 0, errored: 0, running: 0, done: 0, idle: 0 });
  });

  it('buckets every reason, including idle', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([
        { ptyId: 'a', agentStatus: 'awaiting_input' },
        { ptyId: 'b', agentStatus: 'running' },
        { ptyId: 'c', agentStatus: 'running' },
        { ptyId: 'd', agentStatus: 'complete' },
        { ptyId: 'e', agentStatus: 'error' },
        { ptyId: 'f', agentStatus: 'idle' },
      ]),
    });
    expect(b.counts).toEqual({ total: 6, blocked: 1, errored: 1, running: 2, done: 1, idle: 1 });
  });

  it('the builder ships NO prose — no locale-bearing string on the payload', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      coldStart: true,
      snapshot: snap([{ ptyId: 'p1', agentStatus: 'complete' }]),
    });
    expect(b).not.toHaveProperty('greeting');
    expect(JSON.stringify(b)).not.toContain('Welcome back');
  });

  it('summarizeBriefingCounts is pure over a pane list', () => {
    expect(
      summarizeBriefingCounts([
        { ptyId: 'a', agentName: null, agentStatus: 'idle', priority: 5, reason: 'idle' },
        { ptyId: 'b', agentName: null, agentStatus: 'idle', priority: 5, reason: 'idle' },
      ]),
    ).toEqual({ total: 2, blocked: 0, errored: 0, running: 0, done: 0, idle: 2 });
  });
});

describe('briefingHasContent', () => {
  it('an empty workspace with nothing pending has NOTHING to say', () => {
    expect(briefingHasContent(buildWorkspaceBriefing({ ...baseInputs, snapshot: null }))).toBe(
      false,
    );
  });

  it('a cold start alone is not content (no empty container opens)', () => {
    const b = buildWorkspaceBriefing({ ...baseInputs, snapshot: null, coldStart: true });
    expect(briefingHasContent(b)).toBe(false);
    expect(shouldAutoExpandBriefing(b)).toBe(false);
  });

  it('a pane, a pending decision, a loop, or a real delta each count as content', () => {
    expect(
      briefingHasContent(
        buildWorkspaceBriefing({ ...baseInputs, snapshot: snap([{ ptyId: 'p', agentStatus: 'idle' }]) }),
      ),
    ).toBe(true);
    expect(
      briefingHasContent(buildWorkspaceBriefing({ ...baseInputs, decision: decision() })),
    ).toBe(true);
    const loop = {
      objective: 'ship it',
      steps: [],
      tasks: [],
      progressLog: [],
      status: 'running',
      tier: 'continue',
      iterations: 25,
      updatedAt: 1,
    } as WorkspaceLoopState;
    expect(briefingHasContent(buildWorkspaceBriefing({ ...baseInputs, loop }))).toBe(true);
    const prior: BriefedSnapshot = { panes: [], decisionId: 'old', at: 1 };
    expect(
      briefingHasContent(buildWorkspaceBriefing({ ...baseInputs, decision: decision({ id: 'new' }), prior })),
    ).toBe(true);
  });
});

describe('isNewlyActionable (the card\'s rising-edge rule)', () => {
  const withBlocked = (ids: string[], decisionId: string | null = null) => ({
    decisionId,
    blocked: ids,
  });

  it('no previous observation ⇒ not a rising edge (hydration owns that)', () => {
    expect(isNewlyActionable(null, withBlocked(['p1']))).toBe(false);
  });

  it('the SAME blocked pane re-reported on every refresh is not a rising edge', () => {
    expect(isNewlyActionable(withBlocked(['p1']), withBlocked(['p1']))).toBe(false);
  });

  it('an ADDITIONAL blocked pane is a rising edge', () => {
    expect(isNewlyActionable(withBlocked(['p1']), withBlocked(['p1', 'p2']))).toBe(true);
  });

  it('a decision that just appeared (or was replaced) is a rising edge', () => {
    expect(isNewlyActionable(withBlocked([], null), withBlocked([], 'dec-1'))).toBe(true);
    expect(isNewlyActionable(withBlocked([], 'dec-1'), withBlocked([], 'dec-2'))).toBe(true);
  });

  it('the same decision persisting is not a rising edge, and losing one never is', () => {
    expect(isNewlyActionable(withBlocked([], 'dec-1'), withBlocked([], 'dec-1'))).toBe(false);
    expect(isNewlyActionable(withBlocked(['p1'], 'dec-1'), withBlocked([], null))).toBe(false);
  });

  it('briefingSignal reports the CURRENTLY blocked panes + the decision id', () => {
    const prior: BriefedSnapshot = { panes: [{ ptyId: 'p', agentStatus: 'running' }], decisionId: null, at: 1 };
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([{ ptyId: 'p', agentStatus: 'awaiting_input' }]),
      decision: decision({ id: 'dec-7' }),
      prior,
    });
    expect(briefingSignal(b)).toEqual({ decisionId: 'dec-7', blocked: ['p'] });
  });

  it('the signal is live state, NOT the persisted delta (a steady block still reports)', () => {
    // The pane was already blocked at the last acked view, so `changed` is
    // empty — but the signal must still say "this pane is blocked right now",
    // otherwise the next recovery→re-block cannot read as an edge.
    const prior: BriefedSnapshot = {
      panes: [{ ptyId: 'p', agentStatus: 'awaiting_input' }],
      decisionId: null,
      at: 1,
    };
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([{ ptyId: 'p', agentStatus: 'awaiting_input' }]),
      prior,
    });
    expect(b.changed?.newlyBlocked).toEqual([]);
    expect(briefingSignal(b).blocked).toEqual(['p']);
  });

  it('caps the blocked id list at MAX_BLOCKED_IDS, taking the stable sorted prefix', () => {
    const many = Array.from({ length: blockedIdCap + 5 }, (_, i) => ({
      ptyId: `p${String(i).padStart(3, '0')}`,
      agentStatus: 'awaiting_input' as AgentStatus,
    }));
    const b = buildWorkspaceBriefing({ ...baseInputs, snapshot: snap(many) });
    expect(b.blockedPtyIds.length).toBe(blockedIdCap);
    expect(b.blockedPtyIds[0]).toBe('p000');
  });
});

// ── THE RISING EDGE, DRIVEN THROUGH THE REAL PIPELINE ───────────────────────
// Every case below builds a briefing from a fleet snapshot, derives the signal
// with briefingSignal, and only then asks isNewlyActionable — no hand-built
// signals. The round-1 tests injected signals directly, which is exactly why
// they passed while the pipeline was mixing two clocks (the persisted
// last-acked baseline vs. two consecutive live observations).
describe('rising edge through build → briefingSignal → isNewlyActionable', () => {
  /** One live observation: build the briefing for this fleet + decision and
   *  return its signal. `prior` is the persisted baseline, deliberately left at
   *  a fixed stale value so the test proves the edge does NOT depend on it. */
  const observe = (
    panes: { ptyId: string; agentStatus: AgentStatus }[],
    over: Partial<Parameters<typeof buildWorkspaceBriefing>[0]> = {},
  ) => briefingSignal(buildWorkspaceBriefing({ ...baseInputs, snapshot: snap(panes), ...over }));

  it('a pane CREATED already blocked is a rising edge', () => {
    // The common case: an agent spawns and immediately hits a permission
    // prompt. It is absent from the baseline, so computeChange skips it and
    // `changed.newlyBlocked` is empty — the card must still open.
    const prior: BriefedSnapshot = {
      panes: [{ ptyId: 'old', agentStatus: 'running' }],
      decisionId: null,
      at: 1,
    };
    const before = observe([{ ptyId: 'old', agentStatus: 'running' }], { prior });
    const after = observe(
      [
        { ptyId: 'old', agentStatus: 'running' },
        { ptyId: 'fresh', agentStatus: 'awaiting_input' },
      ],
      { prior },
    );
    const built = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([
        { ptyId: 'old', agentStatus: 'running' },
        { ptyId: 'fresh', agentStatus: 'awaiting_input' },
      ]),
      prior,
    });
    expect(built.changed?.newlyBlocked).toEqual([]); // the delta genuinely can't see it
    expect(isNewlyActionable(before, after)).toBe(true);
  });

  it('a steadily blocked pane re-reported every tick is NOT a rising edge', () => {
    const fleet = [{ ptyId: 'p', agentStatus: 'awaiting_input' as AgentStatus }];
    const first = observe(fleet);
    const second = observe(fleet);
    const third = observe(fleet);
    expect(isNewlyActionable(first, second)).toBe(false);
    expect(isNewlyActionable(second, third)).toBe(false);
  });

  it('blocked → running → blocked IS a second rising edge', () => {
    // The Codex case: the ack is skipped between the two blocks, so the
    // persisted baseline still reads "blocked" and computeChange reports
    // nothing new. Consecutive live observations still see the edge.
    const prior: BriefedSnapshot = {
      panes: [{ ptyId: 'p', agentStatus: 'awaiting_input' }],
      decisionId: null,
      at: 1,
    };
    const blocked1 = observe([{ ptyId: 'p', agentStatus: 'awaiting_input' }], { prior });
    const running = observe([{ ptyId: 'p', agentStatus: 'running' }], { prior });
    const blocked2 = observe([{ ptyId: 'p', agentStatus: 'awaiting_input' }], { prior });
    const built = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([{ ptyId: 'p', agentStatus: 'awaiting_input' }]),
      prior,
    });
    expect(built.changed?.newlyBlocked).toEqual([]); // stale baseline sees nothing
    expect(isNewlyActionable(blocked1, running)).toBe(false); // recovery is never an edge
    expect(isNewlyActionable(running, blocked2)).toBe(true);
  });

  it('a decision that appears is still a rising edge', () => {
    const fleet = [{ ptyId: 'p', agentStatus: 'running' as AgentStatus }];
    const before = observe(fleet);
    const after = observe(fleet, { decision: decision({ id: 'dec-1' }) });
    expect(isNewlyActionable(before, after)).toBe(true);
    // ...and the same decision persisting is not.
    const again = observe(fleet, { decision: decision({ id: 'dec-1' }) });
    expect(isNewlyActionable(after, again)).toBe(false);
  });

  it('a `waiting` pane counts as blocked for the edge, same as awaiting_input', () => {
    const before = observe([{ ptyId: 'p', agentStatus: 'running' }]);
    const after = observe([{ ptyId: 'p', agentStatus: 'waiting' }]);
    expect(isNewlyActionable(before, after)).toBe(true);
  });
});

// ── mirror rows that are not agents ─────────────────────────────────────────
describe('non-terminal / unspawned mirror rows', () => {
  it('a workspace holding only an empty leaf has NOTHING to brief (no dead chrome)', () => {
    // buildFleetSnapshots emits a row per leaf with ptyId '' for an unspawned
    // leaf; without the filter this briefed as "The agent is idle.".
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([{ ptyId: '', agentStatus: 'idle' }]),
    });
    expect(b.counts.total).toBe(0);
    expect(b.topPane).toBeNull();
    expect(briefingHasContent(b)).toBe(false);
  });

  it('browser / editor / diff surfaces (ptyId "") never inflate the counts', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([
        { ptyId: '', agentStatus: 'idle' },
        { ptyId: '', agentStatus: 'idle' },
        { ptyId: 'p-real', agentStatus: 'running' },
      ]),
    });
    expect(b.counts).toEqual({ total: 1, blocked: 0, errored: 0, running: 1, done: 0, idle: 0 });
    expect(b.topPane?.ptyId).toBe('p-real');
  });

  it('the persisted baseline is filtered the same way', () => {
    expect(
      toBriefedSnapshot(
        snap([
          { ptyId: '', agentStatus: 'idle' },
          { ptyId: 'p1', agentStatus: 'running' },
        ]),
        null,
        1,
      ).panes,
    ).toEqual([{ ptyId: 'p1', agentStatus: 'running' }]);
  });

  it('a duplicated ptyId is counted once in the delta (no "2 finished" for one pane)', () => {
    const prior: BriefedSnapshot = {
      panes: [{ ptyId: 'p', agentStatus: 'running' }],
      decisionId: null,
      at: 1,
    };
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([
        { ptyId: 'p', agentStatus: 'complete' },
        { ptyId: 'p', agentStatus: 'complete' },
      ]),
      prior,
    });
    expect(b.changed?.finished).toEqual(['p']);
    expect(toBriefedSnapshot(snap([
      { ptyId: 'p', agentStatus: 'complete' },
      { ptyId: 'p', agentStatus: 'complete' },
    ]), null, 1).panes).toEqual([{ ptyId: 'p', agentStatus: 'complete' }]);
  });
});

describe('payload caps', () => {
  it('caps agentName, cwd and the loop objective', () => {
    const long = 'x'.repeat(500);
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: {
        workspaceId: 'ws-1',
        ts: 1,
        panes: [
          {
            ptyId: 'p1',
            agentName: long,
            agentStatus: 'running',
            isActivePane: false,
            cwd: long,
          },
        ],
      },
      loop: {
        objective: long,
        steps: [],
        tasks: [],
        progressLog: [],
        status: 'running',
        tier: 'continue',
        iterations: 25,
        updatedAt: 1,
      } as WorkspaceLoopState,
    });
    expect(b.topPane!.agentName!.length).toBe(BRIEFING_LIMITS.MAX_AGENT_NAME_CHARS);
    expect(b.topPane!.cwd!.length).toBe(BRIEFING_LIMITS.MAX_CWD_CHARS);
    expect(b.loop!.objective.length).toBe(BRIEFING_LIMITS.MAX_OBJECTIVE_CHARS);
  });
});

describe('shouldAutoExpandBriefing', () => {
  const build = (over: Partial<Parameters<typeof buildWorkspaceBriefing>[0]>) =>
    buildWorkspaceBriefing({ ...baseInputs, ...over });

  it('expands on cold start WHEN there is something to report', () => {
    const b = build({ coldStart: true, snapshot: snap([{ ptyId: 'p', agentStatus: 'running' }]) });
    expect(shouldAutoExpandBriefing(b)).toBe(true);
  });

  it('expands on a newly-blocked pane', () => {
    const prior: BriefedSnapshot = { panes: [{ ptyId: 'p', agentStatus: 'running' }], decisionId: null, at: 1 };
    const b = build({ snapshot: snap([{ ptyId: 'p', agentStatus: 'awaiting_input' }]), prior });
    expect(shouldAutoExpandBriefing(b)).toBe(true);
  });

  it('expands on a new decision', () => {
    const prior: BriefedSnapshot = { panes: [], decisionId: null, at: 1 };
    expect(shouldAutoExpandBriefing(build({ decision: decision(), prior }))).toBe(true);
  });

  it('stays collapsed on a plain "finished" delta (no nag)', () => {
    const prior: BriefedSnapshot = { panes: [{ ptyId: 'p', agentStatus: 'running' }], decisionId: null, at: 1 };
    const b = build({ snapshot: snap([{ ptyId: 'p', agentStatus: 'complete' }]), prior });
    expect(shouldAutoExpandBriefing(b)).toBe(false);
    expect(hasBriefingDelta(b.changed)).toBe(true); // there IS a delta line, just no auto-expand
  });

  it('stays collapsed when nothing changed and not cold start', () => {
    const prior: BriefedSnapshot = { panes: [{ ptyId: 'p', agentStatus: 'running' }], decisionId: null, at: 1 };
    const b = build({ snapshot: snap([{ ptyId: 'p', agentStatus: 'running' }]), prior });
    expect(shouldAutoExpandBriefing(b)).toBe(false);
  });
});

describe('loop summary + never-throw + snapshot', () => {
  it('summarizes the running loop objective + passed-task count', () => {
    const loop = {
      objective: 'keep CI green',
      steps: [],
      tasks: [
        { id: 't1', text: 'a', passes: true },
        { id: 't2', text: 'b', passes: false },
      ],
      progressLog: [],
      status: 'running',
      tier: 'continue',
      iterations: 25,
      updatedAt: 1,
    } as WorkspaceLoopState;
    const b = buildWorkspaceBriefing({ ...baseInputs, loop });
    expect(b.loop).toEqual({ objective: 'keep CI green', passes: 1, taskCount: 2 });
  });

  it('never throws on all-null feeds; workspaceName falls back to the id', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      entry: null,
      snapshot: null,
      decision: null,
      loop: null,
    });
    expect(b.workspaceName).toBe('ws-1');
    expect(b.topPane).toBeNull();
    expect(b.counts.total).toBe(0);
  });

  it('toBriefedSnapshot distils status-only panes + decision id from the RAW snapshot', () => {
    // The baseline needs EVERY pane's status, not just the named one — it is
    // read from the fleet snapshot the handler already holds, not from the
    // (now single-pane) briefing payload.
    expect(
      toBriefedSnapshot(
        snap([
          { ptyId: 'p1', agentStatus: 'running' },
          { ptyId: 'p2', agentStatus: 'idle' },
        ]),
        'dec-9',
        1000,
      ),
    ).toEqual({
      panes: [
        { ptyId: 'p1', agentStatus: 'running' },
        { ptyId: 'p2', agentStatus: 'idle' },
      ],
      decisionId: 'dec-9',
      at: 1000,
    });
  });

  it('toBriefedSnapshot on a null snapshot is an empty baseline', () => {
    expect(toBriefedSnapshot(null, null, 5)).toEqual({ panes: [], decisionId: null, at: 5 });
  });
});
