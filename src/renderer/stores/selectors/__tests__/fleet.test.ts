import { describe, it, expect } from 'vitest';
import {
  selectFleetPanes,
  sortFleetPanes,
  countNeedsAttention,
  selectLatestCompletionEvidenceTask,
  selectWorkspaceAgentStatus,
  selectAllWorkspaceAgentStatus,
  isPaneAgentBusy,
  HOOK_RUNNING_TTL_MS,
  type FleetPane,
} from '../fleet';
import type { Workspace, Pane, Surface, AgentStatus, Task, TaskState, EvidenceItem } from '../../../../shared/types';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: `C:\\repo\\${id}`, surfaceType: 'terminal', ...extra };
}
function leaf(id: string, surfaces: Surface[], activeSurfaceId?: string): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: activeSurfaceId ?? surfaces[0]?.id ?? '' };
}
function branch(id: string, children: Pane[]): Pane {
  return { id, type: 'branch', direction: 'horizontal', children };
}
function workspace(
  id: string,
  name: string,
  rootPane: Pane,
  activePaneId: string,
  metadata?: Workspace['metadata'],
): Workspace {
  return { id, name, rootPane, activePaneId, metadata };
}

// ws-1: single active leaf. Per-pty attention status (awaiting_input) must win
// over the workspace-level metadata (running) — proves resolution precedence.
const w1 = workspace(
  'ws-1', 'alpha',
  leaf('p1', [surface('s1', 'pty-1')]),
  'p1',
  { agentName: 'Claude Code', agentStatus: 'running' },
);
// ws-2: a branch (depth-1) with two leaves. p2a (active) has two surfaces — the
// selector must pick the activeSurfaceId, not surfaces[0]. p2b (background) is a
// browser surface whose per-pty status (complete) is accurate even in the
// background, while its agentName must NOT be borrowed from the workspace.
const w2 = workspace(
  'ws-2', 'beta',
  branch('b', [
    leaf('p2a', [surface('s2a-first', 'pty-2a-first'), surface('s2a', 'pty-2a')], 's2a'),
    leaf('p2b', [surface('s2b', 'pty-2b', { surfaceType: 'browser' })]),
  ]),
  'p2a',
  { agentName: 'Codex', agentStatus: 'running' },
);
// ws-3: an unspawned surface (ptyId === ''), no workspace metadata → idle.
const w3 = workspace('ws-3', 'gamma', leaf('p3', [surface('s3', '')]), 'p3');

const surfaceAgentStatus: Record<string, AgentStatus> = {
  'pty-1': 'awaiting_input',
  'pty-2b': 'complete',
};

// Hook-driven activity strings keyed per-ptyId. pty-2a is the ACTIVE surface of
// the multi-surface leaf p2a, so its activity must land on that card; pty-1 has
// one to prove activity coexists with an attention status.
const surfaceActivity: Record<string, string> = {
  'pty-1': '$ npm test',
  'pty-2a': '✎ fleet.ts',
};

function fixture() {
  return { workspaces: [w1, w2, w3], surfaceAgentStatus, surfaceActivity };
}

function byPane(panes: FleetPane[], paneId: string): FleetPane {
  const found = panes.find((p) => p.paneId === paneId);
  if (!found) throw new Error(`pane ${paneId} not in fleet`);
  return found;
}

// ─── selectFleetPanes ────────────────────────────────────────────────────────

describe('selectFleetPanes', () => {
  it('emits exactly one card per leaf across every workspace and branch', () => {
    const panes = selectFleetPanes(fixture());
    expect(panes.map((p) => p.paneId).sort()).toEqual(['p1', 'p2a', 'p2b', 'p3']);
  });

  it('walks deeply nested branch-of-branches (recursion regression)', () => {
    // A root branch holding an inner branch (two leaves) + a sibling leaf:
    // three leaves at depth 2/1. Exercises getLeafPanes recursion beyond the
    // depth-1 trees the shared fixture uses.
    const deep = workspace(
      'ws-deep', 'deep',
      branch('root', [
        branch('inner', [
          leaf('p4a', [surface('s4a', 'pty-4a')]),
          leaf('p4b', [surface('s4b', 'pty-4b')]),
        ]),
        leaf('p4c', [surface('s4c', 'pty-4c')]),
      ]),
      'p4a',
    );
    const panes = selectFleetPanes({ workspaces: [deep], surfaceAgentStatus: {}, surfaceActivity: {} });
    expect(panes.map((p) => p.paneId).sort()).toEqual(['p4a', 'p4b', 'p4c']);
  });

  it('surfaces attention from a NON-active surface of a multi-tab leaf', () => {
    // The active tab is quiet but a background tab is awaiting_input — the card
    // must reflect the urgent state, not silently show idle.
    const tabbed = leaf('p', [surface('active', 'pty-active'), surface('bg', 'pty-bg')], 'active');
    const ws = workspace('w', 'w', tabbed, 'p');
    const [card] = selectFleetPanes({ workspaces: [ws], surfaceAgentStatus: { 'pty-bg': 'awaiting_input' }, surfaceActivity: {} });
    expect(card.agentStatus).toBe('awaiting_input'); // from the background tab
    expect(card.ptyId).toBe('pty-active');           // card stays keyed on active surface
  });

  it('picks the most-urgent attention status across a leaf\'s surfaces', () => {
    const tabbed = leaf('p', [surface('a', 'pa'), surface('b', 'pb'), surface('c', 'pc')], 'a');
    const ws = workspace('w', 'w', tabbed, 'p');
    const [card] = selectFleetPanes({
      workspaces: [ws],
      surfaceAgentStatus: { pb: 'complete', pc: 'awaiting_input' },
      surfaceActivity: {},
    });
    expect(card.agentStatus).toBe('awaiting_input'); // rank 0 beats complete (rank 3)
  });

  it('picks the active surface of a multi-surface leaf, not surfaces[0]', () => {
    const p2a = byPane(selectFleetPanes(fixture()), 'p2a');
    expect(p2a.surfaceId).toBe('s2a');
    expect(p2a.ptyId).toBe('pty-2a');
  });

  it('per-pty attention status wins over workspace-level metadata', () => {
    // pty-1 is awaiting_input in surfaceAgentStatus; ws-1 metadata says running.
    const p1 = byPane(selectFleetPanes(fixture()), 'p1');
    expect(p1.agentStatus).toBe('awaiting_input');
  });

  it('falls back to workspace metadata.agentStatus only for the active pane', () => {
    // p2a is active, has no per-pty entry → inherits ws-2 metadata 'running'.
    const p2a = byPane(selectFleetPanes(fixture()), 'p2a');
    expect(p2a.agentStatus).toBe('running');
    expect(p2a.isActivePane).toBe(true);
  });

  it('keeps per-pty attention status for a BACKGROUND pane but not its agentName', () => {
    const p2b = byPane(selectFleetPanes(fixture()), 'p2b');
    expect(p2b.agentStatus).toBe('complete'); // per-pty, accurate in background
    expect(p2b.isActivePane).toBe(false);
    expect(p2b.agentName).toBeUndefined();     // workspace name not borrowed
    expect(p2b.surfaceType).toBe('browser');
  });

  it('defaults to idle for an unspawned surface (ptyId === "") with no metadata', () => {
    const p3 = byPane(selectFleetPanes(fixture()), 'p3');
    expect(p3.agentStatus).toBe('idle');
    expect(p3.ptyId).toBe('');
    expect(p3.surfaceType).toBe('terminal');
  });

  it('exposes agentName only for the active pane', () => {
    const panes = selectFleetPanes(fixture());
    expect(byPane(panes, 'p1').agentName).toBe('Claude Code');
    expect(byPane(panes, 'p2a').agentName).toBe('Codex');
    expect(byPane(panes, 'p3').agentName).toBeUndefined();
  });

  it('carries workspace identity + cwd for the jump + context line', () => {
    const p2b = byPane(selectFleetPanes(fixture()), 'p2b');
    expect(p2b.workspaceId).toBe('ws-2');
    expect(p2b.workspaceName).toBe('beta');
    expect(p2b.cwd).toBe('C:\\repo\\s2b');
  });

  // ─── Hook-driven activity line (fleet-activity-line-hook) ──────────────────

  it('threads the per-ptyId activity string onto the card', () => {
    const p1 = byPane(selectFleetPanes(fixture()), 'p1');
    expect(p1.activity).toBe('$ npm test'); // surfaceActivity['pty-1']
  });

  it('keys activity on the ACTIVE surface of a multi-surface leaf (not surfaces[0])', () => {
    // p2a's active surface is pty-2a; surfaceActivity has pty-2a → "✎ fleet.ts".
    // The non-active first surface (pty-2a-first) has no entry, so picking the
    // wrong surface would yield undefined.
    const p2a = byPane(selectFleetPanes(fixture()), 'p2a');
    expect(p2a.ptyId).toBe('pty-2a');
    expect(p2a.activity).toBe('✎ fleet.ts');
  });

  it('leaves activity undefined when the pty has no entry (no-hook fallback path)', () => {
    // p2b (browser, pty-2b) and p3 (unspawned, ptyId '') have no activity entry.
    const panes = selectFleetPanes(fixture());
    expect(byPane(panes, 'p2b').activity).toBeUndefined();
    expect(byPane(panes, 'p3').activity).toBeUndefined();
  });

  it('never reads activity for an unspawned surface (empty ptyId)', () => {
    // Even if a stray '' key existed in the map, the selector must not surface
    // it onto an unspawned card.
    const ws = workspace('w', 'w', leaf('p', [surface('s', '')]), 'p');
    const [card] = selectFleetPanes({
      workspaces: [ws],
      surfaceAgentStatus: {},
      surfaceActivity: { '': 'should-never-show' },
    });
    expect(card.activity).toBeUndefined();
  });
});

// ─── sortFleetPanes ──────────────────────────────────────────────────────────

describe('sortFleetPanes', () => {
  it('floats awaiting_input to the top and sinks idle (attention-first)', () => {
    const sorted = sortFleetPanes(selectFleetPanes(fixture()));
    // ranks: awaiting_input(p1)=0, complete(p2b)=3, running(p2a)=4, idle(p3)=5
    expect(sorted.map((p) => p.paneId)).toEqual(['p1', 'p2b', 'p2a', 'p3']);
  });

  it('breaks ties by workspace (selector) order, NOT alphabetical name', () => {
    const base: FleetPane = { workspaceId: 'w', workspaceName: '', paneId: '', surfaceId: 's', ptyId: 'p', agentStatus: 'running', title: '', surfaceType: 'terminal', isActivePane: false };
    // Same status → the selector's emission order (== state.workspaces / sidebar
    // order) is preserved, even though the names are reverse-alphabetical. The
    // old behavior reordered these to [b, a] by name; the fix keeps input order
    // so the cockpit mirrors the sidebar.
    const a = { ...base, paneId: 'a', workspaceName: 'zeta', title: 'z' };
    const b = { ...base, paneId: 'b', workspaceName: 'alpha', title: 'a' };
    expect(sortFleetPanes([a, b]).map((p) => p.paneId)).toEqual(['a', 'b']);
  });

  it("'workspace' mode mirrors selector order and ignores status", () => {
    const base: FleetPane = { workspaceId: 'w', workspaceName: 'w', paneId: '', surfaceId: 's', ptyId: 'p', agentStatus: 'idle', title: 't', surfaceType: 'terminal', isActivePane: false };
    const first = { ...base, paneId: 'first', agentStatus: 'idle' as const };
    const second = { ...base, paneId: 'second', agentStatus: 'awaiting_input' as const };
    // workspace mode: pure input (sidebar) order, status ignored.
    expect(sortFleetPanes([first, second], 'workspace').map((p) => p.paneId)).toEqual(['first', 'second']);
    // attention mode (default): awaiting_input floats above idle.
    expect(sortFleetPanes([first, second], 'attention').map((p) => p.paneId)).toEqual(['second', 'first']);
  });

  it('preserves input order for fully-equal entries (stable sort)', () => {
    const base: FleetPane = { workspaceId: 'w', workspaceName: 'w', paneId: '', surfaceId: 's', ptyId: 'p', agentStatus: 'running', title: 't', surfaceType: 'terminal', isActivePane: false };
    const x = { ...base, paneId: 'x' };
    const y = { ...base, paneId: 'y' };
    const z = { ...base, paneId: 'z' };
    expect(sortFleetPanes([x, y, z]).map((p) => p.paneId)).toEqual(['x', 'y', 'z']);
  });

  it('does not mutate its input', () => {
    const input = selectFleetPanes(fixture());
    const before = input.map((p) => p.paneId);
    sortFleetPanes(input);
    expect(input.map((p) => p.paneId)).toEqual(before);
  });
});

// ─── countNeedsAttention ─────────────────────────────────────────────────────

describe('countNeedsAttention', () => {
  it('counts awaiting_input and waiting, ignores everything else', () => {
    const panes = selectFleetPanes(fixture());
    expect(countNeedsAttention(panes)).toBe(1); // only p1 (awaiting_input)
  });

  it('counts both awaiting_input and waiting states', () => {
    const base: FleetPane = { workspaceId: 'w', workspaceName: 'w', paneId: 'x', surfaceId: 'x', ptyId: 'x', agentStatus: 'idle', title: 'x', surfaceType: 'terminal', isActivePane: false };
    const panes: FleetPane[] = [
      { ...base, paneId: '1', agentStatus: 'awaiting_input' },
      { ...base, paneId: '2', agentStatus: 'waiting' },
      { ...base, paneId: '3', agentStatus: 'running' },
      { ...base, paneId: '4', agentStatus: 'complete' },
    ];
    expect(countNeedsAttention(panes)).toBe(2);
  });
});

describe('selectFleetPanes — X8 supervision mirror', () => {
  const wsSup = workspace('ws-s', 'sup', leaf('ps', [surface('ss', 'pty-s')]), 'ps');
  const base = { workspaces: [wsSup], surfaceAgentStatus: {}, surfaceActivity: {} };

  it('surfaces supervision for a supervised pane (keyed by active-surface ptyId)', () => {
    const [pane] = selectFleetPanes({ ...base, supervisionByPtyId: { 'pty-s': { status: 'armed', restartCount: 3 } } });
    expect(pane.supervision).toEqual({ status: 'armed', restartCount: 3 });
  });

  it('carries a guard-tripped (stopped) verdict through', () => {
    const [pane] = selectFleetPanes({ ...base, supervisionByPtyId: { 'pty-s': { status: 'stopped', restartCount: 5 } } });
    expect(pane.supervision).toEqual({ status: 'stopped', restartCount: 5 });
  });

  it('leaves supervision undefined for an unsupervised pane (empty map or omitted)', () => {
    expect(selectFleetPanes({ ...base, supervisionByPtyId: {} })[0].supervision).toBeUndefined();
    expect(selectFleetPanes(base)[0].supervision).toBeUndefined();
  });

  it('never attaches supervision to an unspawned surface (empty ptyId)', () => {
    const wsNoPty = workspace('ws-n', 'nopty', leaf('pn', [surface('sn', '')]), 'pn');
    const [pane] = selectFleetPanes({
      workspaces: [wsNoPty],
      surfaceAgentStatus: {},
      surfaceActivity: {},
      supervisionByPtyId: { '': { status: 'armed', restartCount: 1 } },
    });
    expect(pane.supervision).toBeUndefined();
  });
});

// ─── selectLatestCompletionEvidenceTask (NB3 trust surface) ──────────────────

describe('selectLatestCompletionEvidenceTask', () => {
  const item = (over: Partial<EvidenceItem> = {}): EvidenceItem =>
    ({ kind: 'command', status: 'passed', summary: 'tsc', command: 'tsc', ...over } as EvidenceItem);

  function task(
    id: string,
    over: {
      state?: TaskState;
      to?: { workspaceId: string; name: string; paneId?: string };
      items?: EvidenceItem[] | undefined;
      timestamp?: string;
      noEvidence?: boolean;
    } = {},
  ): Task {
    return {
      kind: 'task',
      id,
      status: {
        state: over.state ?? 'completed',
        timestamp: over.timestamp ?? '2026-07-10T00:00:00.000Z',
        ...(over.noEvidence ? {} : { evidence: { summary: 's', items: over.items ?? [item()] } }),
      },
      history: [],
      artifacts: [],
      metadata: {
        title: `title-${id}`,
        from: { workspaceId: 'ws-sender', name: 'from' },
        to: over.to ?? { workspaceId: 'ws-1', name: 'to' },
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    };
  }
  const store = (...tasks: Task[]): Record<string, Task> =>
    Object.fromEntries(tasks.map((t) => [t.id, t]));

  it('returns undefined when no task is addressed to the workspace', () => {
    const s = store(task('t1', { to: { workspaceId: 'ws-OTHER', name: 'x' } }));
    expect(selectLatestCompletionEvidenceTask(s, 'ws-1', 'p1', true)).toBeUndefined();
  });

  it('matches a ws-only (unpinned) task on the ACTIVE pane only', () => {
    const s = store(task('t1')); // to = ws-1, no paneId
    expect(selectLatestCompletionEvidenceTask(s, 'ws-1', 'p1', true)?.id).toBe('t1');
    // background sibling pane of the same ws must NOT inherit a ws-level completion
    expect(selectLatestCompletionEvidenceTask(s, 'ws-1', 'p2', false)).toBeUndefined();
  });

  it('matches a pane-pinned task on exactly that pane (active flag irrelevant)', () => {
    const s = store(task('t1', { to: { workspaceId: 'ws-1', name: 'to', paneId: 'p2' } }));
    expect(selectLatestCompletionEvidenceTask(s, 'ws-1', 'p2', false)?.id).toBe('t1');
    expect(selectLatestCompletionEvidenceTask(s, 'ws-1', 'p1', true)).toBeUndefined();
  });

  it('ignores non-completed tasks even when they carry evidence', () => {
    const s = store(task('t1', { state: 'working' }), task('t2', { state: 'failed' }));
    expect(selectLatestCompletionEvidenceTask(s, 'ws-1', 'p1', true)).toBeUndefined();
  });

  it('ignores a completed task with no evidence or empty items', () => {
    const none = store(task('t1', { noEvidence: true }));
    expect(selectLatestCompletionEvidenceTask(none, 'ws-1', 'p1', true)).toBeUndefined();
    const empty = store(task('t2', { items: [] }));
    expect(selectLatestCompletionEvidenceTask(empty, 'ws-1', 'p1', true)).toBeUndefined();
  });

  it('picks the most recently completed task by status timestamp', () => {
    const s = store(
      task('old', { timestamp: '2026-07-10T00:00:00.000Z' }),
      task('new', { timestamp: '2026-07-10T09:00:00.000Z' }),
      task('mid', { timestamp: '2026-07-10T03:00:00.000Z' }),
    );
    expect(selectLatestCompletionEvidenceTask(s, 'ws-1', 'p1', true)?.id).toBe('new');
  });

  it('returns the store Task reference (not a copy) so a card read stays stable', () => {
    const t = task('t1');
    const s = store(t);
    expect(selectLatestCompletionEvidenceTask(s, 'ws-1', 'p1', true)).toBe(t);
  });
});

// ─── selectWorkspaceAgentStatus (sidebar dot source) ─────────────────────────

describe('selectWorkspaceAgentStatus', () => {
  it('surfaces a workspace pane attention status (ws-1: awaiting_input)', () => {
    // w1's only pane has pty-1 = awaiting_input, which must win over the
    // workspace-metadata 'running' — the dot shows the most-urgent real state.
    expect(selectWorkspaceAgentStatus(fixture(), 'ws-1')).toBe('awaiting_input');
  });

  it('sees a BACKGROUND pane attention status (ws-2 p2b: complete, not active)', () => {
    // p2b is the non-active pane; its pty-2b=complete must still light the ws
    // dot even though the active pane p2a is running-per-metadata. This is the
    // exact background-blindness the old active-pane-only read could not show.
    expect(selectWorkspaceAgentStatus(fixture(), 'ws-2')).toBe('complete');
  });

  it('returns idle for an all-idle / unspawned workspace (ws-3)', () => {
    expect(selectWorkspaceAgentStatus(fixture(), 'ws-3')).toBe('idle');
  });

  it('returns idle for an unknown workspaceId', () => {
    expect(selectWorkspaceAgentStatus(fixture(), 'nope')).toBe('idle');
  });

  it('picks the MOST-URGENT status across sibling panes (awaiting_input > complete)', () => {
    const s = workspace(
      'ws-x', 'x',
      branch('bx', [
        leaf('pa', [surface('sa', 'pa-pty')]),
        leaf('pb', [surface('sb', 'pb-pty')]),
      ]),
      'pa',
    );
    const st = selectWorkspaceAgentStatus(
      { workspaces: [s], surfaceAgentStatus: { 'pa-pty': 'complete', 'pb-pty': 'awaiting_input' }, surfaceActivity: {} },
      'ws-x',
    );
    expect(st).toBe('awaiting_input');
  });
});

// ─── selectAllWorkspaceAgentStatus (MiniSidebar map) ─────────────────────────

describe('selectAllWorkspaceAgentStatus', () => {
  it('rolls every workspace up in one pass, omitting idle-only workspaces', () => {
    const map = selectAllWorkspaceAgentStatus(fixture());
    expect(map['ws-1']).toBe('awaiting_input');
    expect(map['ws-2']).toBe('complete');
    // ws-3 is all-idle → omitted (caller defaults missing → idle).
    expect(map['ws-3']).toBeUndefined();
  });

  it('agrees with the single-workspace selector for every workspace', () => {
    const fx = fixture();
    const map = selectAllWorkspaceAgentStatus(fx);
    for (const ws of fx.workspaces) {
      expect(map[ws.id] ?? 'idle').toBe(selectWorkspaceAgentStatus(fx, ws.id));
    }
  });
});

// ─── hook-driven 'running' (orca-style TTL) ──────────────────────────────────

describe('selectFleetPanes hook-driven running', () => {
  const NOW = 1_000_000_000_000;
  // One quiet background pane (no attention, no active-metadata running) whose
  // only signal is a `surfaceActivityAt` stamp — the "thinking mid-turn /
  // background running" case. The stamp is source-agnostic: since 2026-07-13
  // it comes from the daemon's byte-based 'running' broadcast (markSurfaceRunning)
  // rather than the per-tool-call PostToolUse hook; the selector is unchanged.
  const wq = workspace('ws-q', 'quiet', leaf('pq', [surface('sq', 'pty-q')]), 'other-pane');
  const base = { workspaces: [wq], surfaceAgentStatus: {}, surfaceActivity: {} };

  it('is idle with no clock/stamp (legacy behavior preserved)', () => {
    expect(byPane(selectFleetPanes(base), 'pq').agentStatus).toBe('idle');
  });

  it('reads running when the last PostToolUse is within the TTL', () => {
    const fx = { ...base, surfaceActivityAt: { 'pty-q': NOW - 30_000 }, agentClockMs: NOW };
    expect(byPane(selectFleetPanes(fx), 'pq').agentStatus).toBe('running');
  });

  it('decays to idle once the stamp ages past the TTL', () => {
    const fx = { ...base, surfaceActivityAt: { 'pty-q': NOW - (HOOK_RUNNING_TTL_MS + 1) }, agentClockMs: NOW };
    expect(byPane(selectFleetPanes(fx), 'pq').agentStatus).toBe('idle');
  });

  it('lets a retained attention status OUTRANK a fresh hook stamp', () => {
    // Same pane both awaiting_input (retained) AND freshly active — the user-
    // facing "needs you" must win over "running".
    const fx = {
      ...base,
      surfaceAgentStatus: { 'pty-q': 'awaiting_input' as AgentStatus },
      surfaceActivityAt: { 'pty-q': NOW },
      agentClockMs: NOW,
    };
    expect(byPane(selectFleetPanes(fx), 'pq').agentStatus).toBe('awaiting_input');
  });

  it('lets a fresh hook stamp override a stale active-pane idle (the byte-silence miss)', () => {
    // Active pane, workspace metadata cleared to 'idle' by the 5s byte-silence
    // path, but a tool fired 10s ago → still running.
    const wActive = workspace(
      'ws-a', 'active', leaf('pa', [surface('sa', 'pty-a')]), 'pa',
      { agentStatus: 'idle' },
    );
    const fx = {
      workspaces: [wActive], surfaceAgentStatus: {}, surfaceActivity: {},
      surfaceActivityAt: { 'pty-a': NOW - 10_000 }, agentClockMs: NOW,
    };
    expect(byPane(selectFleetPanes(fx), 'pa').agentStatus).toBe('running');
  });
});

// ─── isPaneAgentBusy — the resume-chip suppression gate ──────────────────────
describe('isPaneAgentBusy', () => {
  const NOW = 1_000_000_000;

  it('recent agent activity (within TTL) → busy (chip hidden)', () => {
    expect(isPaneAgentBusy({
      activityAt: NOW - 10_000, agentClockMs: NOW, status: undefined,
    })).toBe(true);
  });

  it('stale agent activity (past TTL) + no status → idle (chip shown)', () => {
    expect(isPaneAgentBusy({
      activityAt: NOW - (HOOK_RUNNING_TTL_MS + 5_000), agentClockMs: NOW, status: undefined,
    })).toBe(false);
  });

  it('never-active pane (activityAt 0) + no status → idle', () => {
    expect(isPaneAgentBusy({ activityAt: 0, agentClockMs: NOW, status: undefined })).toBe(false);
  });

  it.each(['running', 'waiting', 'awaiting_input', 'error'] as AgentStatus[])(
    'live attention status %s → busy even with stale activity',
    (status) => {
      expect(isPaneAgentBusy({
        activityAt: NOW - (HOOK_RUNNING_TTL_MS + 5_000), agentClockMs: NOW, status,
      })).toBe(true);
    },
  );

  it.each(['complete', 'idle'] as AgentStatus[])(
    'settled status %s + stale activity → idle (chip returns)',
    (status) => {
      expect(isPaneAgentBusy({
        activityAt: NOW - (HOOK_RUNNING_TTL_MS + 5_000), agentClockMs: NOW, status,
      })).toBe(false);
    },
  );
});

// ─── isPaneAgentBusy — OSC 133 authoritative short-circuit ───────────────────
describe('isPaneAgentBusy — OSC 133 commandRunning', () => {
  const NOW = 1_000_000_000;
  const staleActivity = NOW - (HOOK_RUNNING_TTL_MS + 5_000);

  it('commandRunning=true → busy even with NO activity and no status (closes the idle-TUI gap)', () => {
    expect(isPaneAgentBusy({
      activityAt: 0, agentClockMs: NOW, status: undefined, commandRunning: true,
    })).toBe(true);
  });

  it('commandRunning=false → idle even if the heuristic would say busy (authoritative at-prompt)', () => {
    // Recent activity AND a running status would both trip the heuristic, but the
    // shell is provably at a prompt → chip must show.
    expect(isPaneAgentBusy({
      activityAt: NOW, agentClockMs: NOW, status: 'running', commandRunning: false,
    })).toBe(false);
  });

  it('commandRunning=undefined → falls through to the activity heuristic', () => {
    expect(isPaneAgentBusy({
      activityAt: NOW, agentClockMs: NOW, status: undefined, commandRunning: undefined,
    })).toBe(true);
    expect(isPaneAgentBusy({
      activityAt: staleActivity, agentClockMs: NOW, status: undefined, commandRunning: undefined,
    })).toBe(false);
  });
});
