// Unit tests for the pure briefing builder: priority ordering, the
// delta-vs-prior-snapshot computation (null prior ⇒ no delta), the structured
// headline counts (prose lives in the renderer), the content guard, auto-expand
// + rising-edge rules, payload caps, and never-throw on null/empty feeds.

import { describe, it, expect } from 'vitest';
import {
  BRIEFING_LIMITS,
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
    expect(b.panes.map((p) => p.ptyId)).toEqual(['p-block', 'p-err', 'p-done', 'p-run', 'p-idle']);
    expect(b.panes[0].reason).toBe('blocked');
    expect(b.panes[1].reason).toBe('error');
  });

  it('waiting is treated as blocked (same priority as awaiting_input)', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([
        { ptyId: 'p-run', agentStatus: 'running' },
        { ptyId: 'p-wait', agentStatus: 'waiting' },
      ]),
    });
    expect(b.panes[0].ptyId).toBe('p-wait');
    expect(b.panes[0].reason).toBe('blocked');
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

  it('briefingSignal extracts the decision id + newly-blocked ids', () => {
    const prior: BriefedSnapshot = { panes: [{ ptyId: 'p', agentStatus: 'running' }], decisionId: null, at: 1 };
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([{ ptyId: 'p', agentStatus: 'awaiting_input' }]),
      decision: decision({ id: 'dec-7' }),
      prior,
    });
    expect(briefingSignal(b)).toEqual({ decisionId: 'dec-7', blocked: ['p'] });
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
    expect(b.panes[0].agentName!.length).toBe(BRIEFING_LIMITS.MAX_AGENT_NAME_CHARS);
    expect(b.panes[0].cwd!.length).toBe(BRIEFING_LIMITS.MAX_CWD_CHARS);
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
    expect(b.panes).toEqual([]);
    expect(b.counts.total).toBe(0);
  });

  it('toBriefedSnapshot distils status-only panes + decision id', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([{ ptyId: 'p1', agentStatus: 'running' }]),
      decision: decision({ id: 'dec-9' }),
    });
    expect(toBriefedSnapshot(b)).toEqual({
      panes: [{ ptyId: 'p1', agentStatus: 'running' }],
      decisionId: 'dec-9',
      at: 1000,
    });
  });
});
