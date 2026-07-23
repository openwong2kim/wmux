// Unit tests for the pure briefing builder: priority ordering, the
// delta-vs-prior-snapshot computation (null prior ⇒ no delta), greeting
// templates, auto-expand rules, and never-throw on null/empty feeds.

import { describe, it, expect } from 'vitest';
import {
  buildWorkspaceBriefing,
  renderBriefingGreeting,
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

describe('renderBriefingGreeting', () => {
  it('empty workspace → nothing running', () => {
    const b = buildWorkspaceBriefing({ ...baseInputs, snapshot: null });
    expect(b.greeting).toBe('Nothing running here yet.');
  });

  it('empty workspace with a pending decision → decision greeting', () => {
    const b = buildWorkspaceBriefing({ ...baseInputs, snapshot: null, decision: decision() });
    expect(b.greeting).toBe('One decision is waiting on you.');
  });

  it('cold start prefixes "Welcome back."', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      coldStart: true,
      snapshot: snap([{ ptyId: 'p1', agentStatus: 'complete' }]),
    });
    expect(b.greeting).toBe('Welcome back. 1 finished.');
  });

  it('composes "N need you, M running, K finished"', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([
        { ptyId: 'a', agentStatus: 'awaiting_input' },
        { ptyId: 'b', agentStatus: 'running' },
        { ptyId: 'c', agentStatus: 'running' },
        { ptyId: 'd', agentStatus: 'complete' },
      ]),
    });
    expect(b.greeting).toBe('1 needs you, 2 running, 1 finished.');
  });

  it('all idle → idle greeting', () => {
    const b = buildWorkspaceBriefing({
      ...baseInputs,
      snapshot: snap([
        { ptyId: 'a', agentStatus: 'idle' },
        { ptyId: 'b', agentStatus: 'idle' },
      ]),
    });
    expect(b.greeting).toBe('All 2 agents are idle.');
  });
});

describe('shouldAutoExpandBriefing', () => {
  const build = (over: Partial<Parameters<typeof buildWorkspaceBriefing>[0]>) =>
    buildWorkspaceBriefing({ ...baseInputs, ...over });

  it('expands on cold start', () => {
    expect(shouldAutoExpandBriefing(build({ coldStart: true }))).toBe(true);
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
    expect(b.greeting).toBe('Nothing running here yet.');
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
