import { describe, it, expect } from 'vitest';
import {
  buildMentionCandidates,
  describeMentionTargets,
  pickMostRecentlyActivePane,
  promoteTypedMentions,
  type MentionCandidate,
} from '../Composer';
import { createLeafPane, createSurface, type Pane, type Workspace } from '../../../../shared/types';
import type { ChannelMember } from '../../../../shared/channels';

// C-1 — a mention only wakes an IDLE agent when it carries a pane pin. These
// tests fix the two shapes that decides: a roster member whose workspace runs
// several agent panes must pin the most recently active one, and a member with
// no live agent pane must stay badge-only (and SAY so) rather than silently
// resolving to nothing.

const CLAUDE = { name: 'Claude Code', slug: 'claude' as const };

function twoPaneWorkspace() {
  const leafA = createLeafPane(createSurface('ptyA', 'pwsh', ''), 1);
  const leafB = createLeafPane(createSurface('ptyB', 'pwsh', ''), 2);
  const root: Pane = {
    id: 'br', type: 'branch', direction: 'horizontal', children: [leafA, leafB], sizes: [50, 50],
  };
  const ws: Workspace = {
    id: 'ws-1', name: 'Backend', wsOrdinal: 1, nextPaneOrdinal: 3, rootPane: root, activePaneId: leafA.id,
  };
  return { ws, leafA, leafB };
}

function member(
  workspaceId: string,
  memberId: string,
  memberName?: string,
  principalId?: string,
): ChannelMember {
  return {
    workspaceId,
    memberId,
    joinedAt: 0,
    historyFromSeq: 0,
    ...(memberName ? { memberName } : {}),
    ...(principalId ? { principalId } : {}),
  };
}

describe('buildMentionCandidates — roster members (C-1)', () => {
  it('pins a member candidate to its workspace\'s MOST RECENTLY ACTIVE agent pane', () => {
    const { ws, leafB } = twoPaneWorkspace();
    const candidates = buildMentionCandidates({
      workspaces: [ws],
      surfaceAgent: { ptyA: CLAUDE, ptyB: CLAUDE },
      paneLabel: {},
      memberWorkspaceIds: new Set(['ws-1']),
      selfWorkspaceId: null,
      members: [member('ws-1', 'backend')],
      surfaceActivityAt: { ptyA: 1_000, ptyB: 9_000 },
    });
    const roster = candidates.find((c) => c.insertToken === 'backend');
    expect(roster).toBeDefined();
    expect(roster!.paneId).toBe(leafB.id);
    expect(roster!.ptyId).toBe('ptyB');
    expect(roster!.pinnedPaneName).toBe('w1-2(claude)');
    // The per-pane candidates are untouched — the roster row is additive.
    expect(candidates.filter((c) => c.paneId).length).toBe(3);
  });

  it('leaves a member with no live agent pane badge-only (no pane pin)', () => {
    const candidates = buildMentionCandidates({
      workspaces: [],
      surfaceAgent: {},
      paneLabel: {},
      memberWorkspaceIds: new Set(['ws-gone']),
      selfWorkspaceId: null,
      members: [member('ws-gone', 'w9-1(claude)', 'worker-9')],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].paneId).toBeUndefined();
    expect(candidates[0].ptyId).toBeUndefined();
    expect(candidates[0].insertToken).toBe('worker-9');
    expect(candidates[0].memberId).toBe('w9-1(claude)');
  });

  // Review fix: the member row records the pane it IS. "Most recently active"
  // sent @backend to whichever sibling typed last.
  it("prefers the member's OWN pane from principalId over the most recently active one", () => {
    const { ws, leafA } = twoPaneWorkspace();
    const candidates = buildMentionCandidates({
      workspaces: [ws],
      surfaceAgent: { ptyA: CLAUDE, ptyB: CLAUDE },
      paneLabel: {},
      memberWorkspaceIds: new Set(['ws-1']),
      selfWorkspaceId: null,
      members: [member('ws-1', 'backend', undefined, `pane:ws-1/${leafA.id}`)],
      // ptyB is far more recent — the old rule would have pinned it.
      surfaceActivityAt: { ptyA: 1_000, ptyB: 9_000 },
    });
    const roster = candidates.find((c) => c.insertToken === 'backend')!;
    expect(roster.paneId).toBe(leafA.id);
    expect(roster.ptyId).toBe('ptyA');
    expect(roster.pinnedPaneName).toBe('w1-1(claude)');
  });

  it('falls back to recent activity when the principal pane is gone', () => {
    const { ws, leafB } = twoPaneWorkspace();
    const candidates = buildMentionCandidates({
      workspaces: [ws],
      surfaceAgent: { ptyA: CLAUDE, ptyB: CLAUDE },
      paneLabel: {},
      memberWorkspaceIds: new Set(['ws-1']),
      selfWorkspaceId: null,
      members: [member('ws-1', 'backend', undefined, 'pane:ws-1/pane-that-closed')],
      surfaceActivityAt: { ptyA: 1_000, ptyB: 9_000 },
    });
    const roster = candidates.find((c) => c.insertToken === 'backend')!;
    expect(roster.paneId).toBe(leafB.id);
  });

  it('never duplicates a token a pane candidate already owns, and skips a name with a space', () => {
    const { ws } = twoPaneWorkspace();
    const candidates = buildMentionCandidates({
      workspaces: [ws],
      surfaceAgent: { ptyA: CLAUDE },
      paneLabel: {},
      memberWorkspaceIds: new Set(['ws-1']),
      selfWorkspaceId: null,
      members: [member('ws-1', 'w1-1(claude)'), member('ws-1', 'two words')],
    });
    expect(candidates.map((c) => c.insertToken)).toEqual(['w1-1(claude)']);
  });
});

describe('pickMostRecentlyActivePane', () => {
  it('returns undefined when the workspace has no pane candidate', () => {
    expect(pickMostRecentlyActivePane([], {})).toBeUndefined();
  });

  it('falls back to the first candidate when no activity has been sampled', () => {
    const cands: MentionCandidate[] = [
      { workspaceId: 'w', paneId: 'p1', ptyId: 't1', insertToken: 'a', displayName: 'a' },
      { workspaceId: 'w', paneId: 'p2', ptyId: 't2', insertToken: 'b', displayName: 'b' },
    ];
    expect(pickMostRecentlyActivePane(cands, {})!.paneId).toBe('p1');
  });
});

// Review fix: (workspaceId, paneId) folded two badge-only seats of one
// workspace onto a single key, and the second mention vanished with no warning.
describe('badge-only mention dedup', () => {
  const candidates: MentionCandidate[] = [
    { workspaceId: 'ws-1', memberId: 'm-1', insertToken: 'alice', displayName: 'alice' },
    { workspaceId: 'ws-1', memberId: 'm-2', insertToken: 'bob', displayName: 'bob' },
  ];

  it('keeps both badge-only members of the same workspace', () => {
    const { mentions } = promoteTypedMentions('@alice @bob ship it', candidates, []);
    expect(mentions.map((m) => m.memberId)).toEqual(['m-1', 'm-2']);
  });

  it('still collapses two tokens that resolve to the SAME pane — one pane, one nudge', () => {
    const pinned: MentionCandidate[] = [
      { workspaceId: 'ws-1', paneId: 'p1', ptyId: 't1', insertToken: 'w1-1(claude)', displayName: 'w1-1(claude)' },
      { workspaceId: 'ws-1', paneId: 'p1', ptyId: 't1', memberId: 'm-1', insertToken: 'alice', displayName: 'alice' },
    ];
    const { mentions } = promoteTypedMentions('@w1-1(claude) @alice', pinned, []);
    expect(mentions).toHaveLength(1);
  });

  it('describes both badge-only mentions instead of one', () => {
    const { mentions } = promoteTypedMentions('@alice @bob', candidates, []);
    expect(describeMentionTargets(mentions, candidates)).toEqual([
      { name: 'alice', badgeOnly: true },
      { name: 'bob', badgeOnly: true },
    ]);
  });
});

describe('describeMentionTargets (C-1 hint)', () => {
  it('names the pane a pinned mention will reach, and flags a badge-only one', () => {
    const candidates: MentionCandidate[] = [
      { workspaceId: 'ws-1', paneId: 'p2', ptyId: 't2', insertToken: 'backend', displayName: 'backend', pinnedPaneName: 'w1-2(claude)' },
      { workspaceId: 'ws-gone', insertToken: 'worker-9', displayName: 'worker-9' },
    ];
    const { mentions } = promoteTypedMentions('@backend @worker-9 ship it', candidates, []);
    const hints = describeMentionTargets(mentions, candidates);
    expect(hints).toEqual([
      { name: 'backend', paneName: 'w1-2(claude)', badgeOnly: false },
      { name: 'worker-9', badgeOnly: true },
    ]);
  });
});
