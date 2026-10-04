import { describe, it, expect } from 'vitest';
import { moaMascotState, moaOwnsPanel, moaQuestionBlock, resolveMoaPanelMode } from '../moaPanelMode';
import { selectTaskCards, MOA_TASK_CARD_LIMIT } from '../useMoaPanelData';
import type { MoaState } from '../../../../../shared/moa';
import type { WorkLink } from '../../../../../shared/workLink';

const moa = (over: { enabled?: boolean; hq?: MoaState['hq']; defaultReason?: MoaState['config']['defaultReason'] } = {}): MoaState => ({
  config: {
    enabled: over.enabled ?? true,
    onboarded: true,
    level: 1,
    maxTurnsPerHour: 20,
    bubbles: true,
    reduceMotion: false,
    defaultReason: over.defaultReason ?? null,
  },
  hq: over.hq ?? { workspaceId: 'ws-hq', state: 'ok' },
  archive: { unacked: 0, total: 0 },
});

describe('resolveMoaPanelMode', () => {
  it('pins the chat to the HQ whatever workspace is active', () => {
    const state = moa();
    for (const active of ['ws-a', 'ws-b', 'ws-hq', '']) {
      const mode = resolveMoaPanelMode(state, active);
      expect(mode).toEqual({ kind: 'moa', chatWorkspaceId: 'ws-hq', hqId: 'ws-hq' });
    }
    expect(moaOwnsPanel(state)).toBe(true);
  });

  it('Moa off: the panel is only the turn-on card', () => {
    expect(resolveMoaPanelMode(moa({ enabled: false }), 'ws-a')).toEqual({ kind: 'off' });
    expect(moaOwnsPanel(moa({ enabled: false }))).toBe(false);
  });

  it('Moa on without an HQ keeps today\'s per-workspace chat, with the set-up hint', () => {
    const state = moa({ hq: { workspaceId: null, state: 'unset' }, defaultReason: 'existing-brain' });
    expect(resolveMoaPanelMode(state, 'ws-a')).toEqual({ kind: 'legacy', chatWorkspaceId: 'ws-a', setupHint: true });
    expect(resolveMoaPanelMode(state, 'ws-b')).toEqual({ kind: 'legacy', chatWorkspaceId: 'ws-b', setupHint: true });
    expect(moaOwnsPanel(state)).toBe(false);
  });

  it('Moa state not known yet (boot, an older main) behaves as today, without a hint', () => {
    expect(resolveMoaPanelMode(null, 'ws-a')).toEqual({ kind: 'legacy', chatWorkspaceId: 'ws-a', setupHint: false });
  });

  it('an HQ that cannot run is a problem card, never a chat with another workspace', () => {
    for (const state of ['hq-missing', 'hq-unknown', 'hq-store-corrupt'] as const) {
      expect(resolveMoaPanelMode(moa({ hq: { workspaceId: 'ws-hq', state } }), 'ws-a')).toEqual({ kind: 'hq-problem', state });
    }
  });
});

describe('moaQuestionBlock', () => {
  it('blocks a question only while Moa is off or its HQ cannot run', () => {
    expect(moaQuestionBlock(moa({ enabled: false }))).toBe('off');
    expect(moaQuestionBlock(moa({ hq: { workspaceId: 'ws-hq', state: 'hq-missing' } }))).toBe('hq-problem');
    expect(moaQuestionBlock(moa({ hq: { workspaceId: null, state: 'hq-unknown' } }))).toBe('hq-problem');
    expect(moaQuestionBlock(moa())).toBeNull();
    // Today's per-workspace chat (no HQ, or Moa's state not known yet) takes it.
    expect(moaQuestionBlock(moa({ hq: { workspaceId: null, state: 'unset' } }))).toBeNull();
    expect(moaQuestionBlock(null)).toBeNull();
  });
});

describe('moaMascotState', () => {
  it('needs-you outranks working; idle otherwise', () => {
    expect(moaMascotState({ busy: true, pendingDecisions: 2 })).toBe('needs-you');
    expect(moaMascotState({ busy: true, pendingDecisions: 0 })).toBe('working');
    expect(moaMascotState({ busy: false, pendingDecisions: 0 })).toBe('idle');
  });
});

describe('selectTaskCards', () => {
  const link = (id: string, over: Partial<WorkLink> = {}): WorkLink => ({
    id,
    origin: 'moa',
    owner: { workspaceId: 'ws-a' },
    state: 'running',
    decisionIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  it('drops abandoned work, newest first, capped', () => {
    const links = [
      link('old', { updatedAt: 1 }),
      link('gone', { updatedAt: 9, state: 'abandoned', manualClose: true }),
      link('new', { updatedAt: 5 }),
      ...Array.from({ length: MOA_TASK_CARD_LIMIT + 5 }, (_, i) => link(`x${i}`, { updatedAt: 0 })),
    ];
    const cards = selectTaskCards(links, new Set());
    expect(cards.map((c) => c.id).slice(0, 2)).toEqual(['new', 'old']);
    expect(cards.some((c) => c.id === 'gone')).toBe(false);
    expect(cards).toHaveLength(MOA_TASK_CARD_LIMIT);
  });

  it('shows the derived state: a pending decision means needs-you, a merged PR means done', () => {
    const [asking, merged] = selectTaskCards([
      link('asking', { updatedAt: 2, decisionIds: ['d1'], a2aState: 'working' }),
      link('merged', {
        updatedAt: 1,
        a2aState: 'working',
        pr: { host: 'github.com', owner: 'o', repo: 'r', number: 7 },
        prStatus: { state: 'merged', checks: 'passing', reviewDecision: '', mergeable: 'MERGEABLE', observedAt: 1 },
      }),
    ], new Set(['d1']));
    expect(asking.state).toBe('needs-you');
    expect(asking.reason).toBe('decision');
    expect(merged.state).toBe('done');
  });
});
