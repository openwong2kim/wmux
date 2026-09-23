// Fleet task rows show reported activity; raw output lives in the opt-in preview.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import FleetCard, { FleetCardMissionLine, FleetCardEvidenceBadge } from '../FleetCard';
import type { FleetPane } from '../../../stores/selectors/fleet';
import { fleetTitle } from '../fleetPresentation';
import type { WorkTask } from '../../../../shared/workTask';
import type { EvidenceItem, Task } from '../../../../shared/types';

const noop = () => undefined;

function card(overrides: Partial<FleetPane> = {}): FleetPane {
  return {
    workspaceId: 'ws-1',
    workspaceName: 'alpha',
    paneId: 'p1',
    surfaceId: 's1',
    ptyId: 'pty-1',
    agentStatus: 'running',
    title: 'claude',
    surfaceType: 'terminal',
    isActivePane: true,
    unverifiable: false,
    ...overrides,
  };
}

function render(props: { card: FleetPane; tail?: string[] }): string {
  return renderToStaticMarkup(
    createElement(FleetCard, { card: props.card, focused: false, onJump: noop, tail: props.tail }),
  );
}

describe('FleetCard — task-first rows', () => {
  it('shows a reported tool activity', () => {
    const html = render({ card: card({ activity: '✎ fleet.ts' }) });
    expect(html).toContain('data-fleet-activity');
    expect(html).toContain('✎ fleet.ts');
  });

  it('keeps raw prompts and separators out of the overview', () => {
    const html = render({ card: card({ agentStatus: 'idle' }), tail: ['────────', '❯ Ask Codex to do anything.'] });
    expect(html).not.toContain('────────');
    expect(html).not.toContain('Ask Codex');
    expect(html).toContain('No recent activity reported');
  });

  it('treats whitespace-only activity as missing information', () => {
    const html = render({ card: card({ agentStatus: 'idle', activity: '   ' }) });
    expect(html).not.toContain('data-fleet-activity');
    expect(html).toContain('No recent activity reported');
  });

  it('puts an input request ahead of a previous tool activity', () => {
    const html = render({ card: card({ agentStatus: 'awaiting_input', activity: '✎ fleet.ts' }) });
    expect(html).toContain('Needs your input');
    expect(html).not.toContain('data-fleet-activity');
    expect(html).toContain('Respond');
  });

  it('labels a question-less waiting pane as idle with a neutral dot, not a red needs-you signal', () => {
    const html = render({ card: card({ agentStatus: 'waiting' }) });
    expect(html).toContain('Idle');
    expect(html).not.toContain('Waiting');
    expect(html).not.toContain('var(--accent-red)');
    expect(html).toContain('var(--text-sub)');
  });

  it('labels response completion without claiming task success', () => {
    const html = render({ card: card({ agentStatus: 'complete' }) });
    expect(html).toContain('Turn complete');
    expect(html).toContain('Response finished');
    expect(html).toContain('Review');
  });

  it('shows stale running evidence as unconfirmed', () => {
    const html = render({ card: card({ unverifiable: true, activity: '$ old command' }) });
    expect(html).toContain('Unconfirmed');
    expect(html).toContain('No activity reported for 30m+');
    expect(html).not.toContain('data-fleet-activity');
  });

  it('uses the project to distinguish generic agent titles', () => {
    expect(fleetTitle(card({ title: 'Claude Code', agentName: 'Claude Code' }))).toBe('alpha');
    expect(fleetTitle(card({ title: 'Codex CLI' }))).toBe('alpha');
  });

  it('preserves real terminal task titles instead of replacing them with the agent name', () => {
    expect(fleetTitle(card({ title: '✳ 침대 범퍼 영상 검수', agentName: 'Claude Code' }))).toBe('침대 범퍼 영상 검수');
    expect(fleetTitle(card({ paneLabel: '내 작업', title: 'Claude Code' }))).toBe('내 작업');
  });

  it('does not present a terminal tool activity on a browser surface', () => {
    const html = render({ card: card({ surfaceType: 'browser', activity: '$ npm test' }) });
    expect(html).not.toContain('data-fleet-activity');
    expect(html).toContain('browser');
  });
});

describe('FleetCard — #1343 remote rows', () => {
  it('marks a remote agent with the origin glyph and names the host in the label', () => {
    const html = render({ card: card({ ptyId: 'remote:h1:s1', surfaceType: 'remote-terminal', remote: { hostId: 'h1', hostLabel: 'build-box' } }) });
    expect(html).toContain('data-fleet-remote');
    expect(html).toContain('title="@build-box"');
    expect(html).toMatch(/aria-label="[^"]*, alpha, build-box,/);
  });

  it('renders no origin glyph for a local agent', () => {
    expect(render({ card: card() })).not.toContain('data-fleet-remote');
  });
});

describe('FleetCard — X8 supervision chip', () => {
  it('renders an armed chip with the restart count', () => {
    const html = render({ card: card({ supervision: { status: 'armed', restartCount: 3 } }) });
    expect(html).toContain('data-fleet-supervision');
    expect(html).toContain('data-supervision-status="armed"');
    expect(html).toContain('⟳ 3');
  });

  it('omits the count on an armed pane with zero restarts', () => {
    const html = render({ card: card({ supervision: { status: 'armed', restartCount: 0 } }) });
    expect(html).toContain('data-fleet-supervision');
    expect(html).not.toContain('⟳ 0');
  });

  it('renders a stopped (guard-tripped) chip in red', () => {
    const html = render({ card: card({ supervision: { status: 'stopped', restartCount: 5 } }) });
    expect(html).toContain('data-supervision-status="stopped"');
    expect(html).toContain('⟳!');
    expect(html).toContain('var(--accent-red)');
  });

  it('renders no supervision chip when the pane is unsupervised', () => {
    expect(render({ card: card() })).not.toContain('data-fleet-supervision');
  });
});

describe('FleetCard — 사이클 C mission line', () => {
  function mission(over: Partial<WorkTask> & Pick<WorkTask, 'id' | 'title' | 'status'>): WorkTask {
    const ref = { principalId: 'p', verifiedWorkspaceId: 'parent-a' };
    return {
      missionChannelId: `chan-${over.id}`,
      createdAt: 0,
      createdBy: ref,
      owner: ref,
      ...over,
    } as WorkTask;
  }
  const renderLine = (m: WorkTask | undefined): string =>
    renderToStaticMarkup(createElement(FleetCardMissionLine, { mission: m }));

  it('renders nothing when the card has no matching mission', () => {
    expect(renderLine(undefined)).toBe('');
    // 미션 캐시가 비어 있으면(생성 시점) 카드 본체에도 미션 라인이 없다.
    expect(render({ card: card() })).not.toContain('data-fleet-mission');
  });

  it('shows an open mission title + status', () => {
    const html = renderLine(mission({ id: 'w1', title: 'Refactor auth', status: 'open' }));
    expect(html).toContain('data-fleet-mission');
    expect(html).toContain('data-mission-status="open"');
    expect(html).toContain('Refactor auth');
    expect(html).not.toContain('line-through');
  });

  it('strikes through a closed mission', () => {
    const html = renderLine(mission({ id: 'w2', title: 'Add tests', status: 'closed' }));
    expect(html).toContain('data-mission-status="closed"');
    expect(html).toContain('line-through');
  });
});

describe('FleetCard — NB3 completion-evidence badge', () => {
  // Pure sub-component (like FleetCardMissionLine): takes the already-resolved
  // Task and renders the badge or null. Addressing / "which task" is the
  // selector's job (see selectLatestCompletionEvidenceTask in fleet.test.ts) —
  // a store-seeded full-card render can't exercise it here because
  // renderToStaticMarkup reads zustand's INITIAL snapshot, not live state.
  function taskWithEvidence(
    items: EvidenceItem[],
    over: { title?: string; summary?: string } = {},
  ): Task {
    return {
      kind: 'task',
      id: 't-evidence',
      status: {
        state: 'completed',
        timestamp: '2026-07-10T00:00:00.000Z',
        evidence: { summary: over.summary ?? 'shipped the fix', items },
      },
      history: [],
      artifacts: [],
      metadata: {
        title: over.title ?? 'Refactor auth',
        from: { workspaceId: 'ws-2', name: 'sender' },
        to: { workspaceId: 'ws-1', name: 'receiver' },
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    };
  }
  const passed: EvidenceItem = { kind: 'command', status: 'passed', summary: 'tsc', command: 'tsc --noEmit' };
  const failed: EvidenceItem = { kind: 'command', status: 'failed', summary: 'lint', command: 'eslint .' };
  const verified: EvidenceItem = { kind: 'inspection', status: 'verified', summary: 'read the diff' };
  const unverified: EvidenceItem = { kind: 'artifact', status: 'unverified', summary: 'built a page' };

  const renderBadge = (task: Task | undefined): string =>
    renderToStaticMarkup(createElement(FleetCardEvidenceBadge, { task }));

  it('renders nothing when there is no evidence task', () => {
    expect(renderBadge(undefined)).toBe('');
  });

  it('renders nothing when the completed task carries no evidence items', () => {
    // A well-formed completed task always has ≥1 item, but the badge must be
    // defensive: an empty items array is not a badge.
    expect(renderBadge(taskWithEvidence([]))).toBe('');
  });

  it('shows ✓ evidence verified/total from the evidence items', () => {
    const html = renderBadge(taskWithEvidence([passed, failed, verified]));
    expect(html).toContain('data-fleet-evidence');
    expect(html).toContain('data-evidence-verified="2"');
    expect(html).toContain('data-evidence-total="3"');
    expect(html).toContain('evidence 2/3');
    // Detail (title + summary) lives in the tooltip, not on-card micro-text.
    expect(html).toContain('Refactor auth');
    expect(html).toContain('shipped the fix');
  });

  it('paints the check green when at least one item is verified', () => {
    const html = renderBadge(taskWithEvidence([passed, unverified]));
    expect(html).toContain('var(--accent-green)');
  });

  it('mutes the check (no green) when nothing is verified — verified is a grade, not a claim', () => {
    const html = renderBadge(taskWithEvidence([failed, unverified]));
    expect(html).toContain('data-evidence-verified="0"');
    expect(html).not.toContain('var(--accent-green)');
  });

  it('the full card has no evidence badge when the store holds no matching task', () => {
    // The default (initial) store has empty a2aTasks — the card's own store read
    // resolves to undefined, so no badge row is added.
    expect(render({ card: card() })).not.toContain('data-fleet-evidence');
  });
});
