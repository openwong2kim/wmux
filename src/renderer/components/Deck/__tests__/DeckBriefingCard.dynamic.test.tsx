// @vitest-environment jsdom
//
// Render tests for the D1 "welcome home" briefing card — fake api/onStream
// injected, no store/IPC. Covers the collapse/expand rules, the reqSeq
// workspace-switch race guard, pane-row jumps, the channels-unread overlay, and
// scoped onStream refetch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeckBriefingCard, type DeckBriefingApi } from '../DeckBriefingCard';
import type { WorkspaceBriefing } from '../../../../main/deck/deckBriefing';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const briefing = (over: Partial<WorkspaceBriefing> = {}): WorkspaceBriefing => ({
  workspaceId: 'ws-1',
  workspaceName: 'Proj',
  mode: 'assist',
  greeting: 'All quiet.',
  pendingDecision: null,
  loop: null,
  panes: [],
  changed: null,
  coldStart: false,
  builtAt: 1,
  ...over,
});

function fakeApi(
  result: { briefing: WorkspaceBriefing | null; autoShow?: boolean },
): DeckBriefingApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: async (workspaceId: string) => {
      calls.push(workspaceId);
      return result;
    },
  };
}

async function mount(
  props: Parameters<typeof DeckBriefingCard>[0],
): Promise<void> {
  await act(async () => {
    root.render(createElement(DeckBriefingCard, props));
  });
}

describe('DeckBriefingCard', () => {
  it('renders nothing without an api (preload absent)', async () => {
    await mount({ workspaceId: 'ws-1' });
    expect(container.querySelector('[data-deck-briefing]')).toBeNull();
  });

  it('renders nothing when the briefing is null (config disabled)', async () => {
    await mount({ api: fakeApi({ briefing: null }), workspaceId: 'ws-1' });
    expect(container.querySelector('[data-deck-briefing]')).toBeNull();
  });

  it('collapsed by default when no delta and not cold start', async () => {
    await mount({ api: fakeApi({ briefing: briefing(), autoShow: true }), workspaceId: 'ws-1' });
    expect(container.querySelector('[data-deck-briefing]')).not.toBeNull();
    expect(container.querySelector('[data-briefing-body]')).toBeNull();
    expect(container.querySelector('[data-briefing-toggle]')!.textContent).toContain('All quiet.');
  });

  it('auto-expands on cold start', async () => {
    await mount({
      api: fakeApi({ briefing: briefing({ coldStart: true, greeting: 'Welcome back.' }), autoShow: true }),
      workspaceId: 'ws-1',
    });
    expect(container.querySelector('[data-briefing-body]')).not.toBeNull();
  });

  it('auto-expands on a newly-blocked delta', async () => {
    const b = briefing({
      changed: { finished: [], newlyBlocked: ['p1'], errored: [], newDecision: false },
    });
    await mount({ api: fakeApi({ briefing: b, autoShow: true }), workspaceId: 'ws-1' });
    expect(container.querySelector('[data-briefing-body]')).not.toBeNull();
    expect(container.querySelector('[data-briefing-delta]')!.textContent).toContain('now blocked on you');
  });

  it('stays collapsed on a plain finished delta but still shows it once expanded', async () => {
    const b = briefing({
      changed: { finished: ['p1'], newlyBlocked: [], errored: [], newDecision: false },
    });
    await mount({ api: fakeApi({ briefing: b, autoShow: true }), workspaceId: 'ws-1' });
    expect(container.querySelector('[data-briefing-body]')).toBeNull();
    // Manual expand via the toggle reveals the delta line.
    await act(async () => {
      (container.querySelector('[data-briefing-toggle]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-briefing-delta]')!.textContent).toContain('finished');
  });

  it('never auto-expands when autoShow is false, even on cold start', async () => {
    await mount({
      api: fakeApi({ briefing: briefing({ coldStart: true }), autoShow: false }),
      workspaceId: 'ws-1',
    });
    expect(container.querySelector('[data-briefing-body]')).toBeNull();
  });

  it('a pane jump resolves the ptyId and calls onJumpToPane', async () => {
    const jumps: { workspaceId: string; paneId: string }[] = [];
    const b = briefing({
      coldStart: true,
      panes: [
        { ptyId: 'pty-9', agentName: 'claude', agentStatus: 'awaiting_input', priority: 1, reason: 'blocked' },
      ],
    });
    await mount({
      api: fakeApi({ briefing: b, autoShow: true }),
      workspaceId: 'ws-1',
      resolvePtyPane: (ptyId) => (ptyId === 'pty-9' ? { workspaceId: 'ws-1', paneId: 'pane-3' } : null),
      onJumpToPane: (workspaceId, paneId) => jumps.push({ workspaceId, paneId }),
    });
    const jump = container.querySelector('[data-briefing-jump]') as HTMLButtonElement;
    expect(jump).not.toBeNull();
    await act(async () => { jump.click(); });
    expect(jumps).toEqual([{ workspaceId: 'ws-1', paneId: 'pane-3' }]);
  });

  it('caps the pane list at 8 rows with a "+N more"', async () => {
    const panes = Array.from({ length: 11 }, (_, i) => ({
      ptyId: `p${i}`,
      agentName: `a${i}`,
      agentStatus: 'running' as const,
      priority: 4,
      reason: 'running' as const,
    }));
    await mount({
      api: fakeApi({ briefing: briefing({ coldStart: true, panes }), autoShow: true }),
      workspaceId: 'ws-1',
    });
    expect(container.querySelectorAll('[data-briefing-pane]').length).toBe(8);
    expect(container.querySelector('[data-briefing-more]')!.textContent).toContain('3 more');
  });

  it('shows the channels-unread overlay and jumps to channels', async () => {
    let jumped = 0;
    await mount({
      api: fakeApi({ briefing: briefing({ coldStart: true }), autoShow: true }),
      workspaceId: 'ws-1',
      channelsUnread: 4,
      onJumpToChannels: () => { jumped += 1; },
    });
    const chip = container.querySelector('[data-briefing-channels]') as HTMLButtonElement;
    expect(chip.textContent).toContain('4 unread in channels');
    await act(async () => { chip.click(); });
    expect(jumped).toBe(1);
  });

  it('reqSeq guard: a stale response for the old workspace does not overwrite the new card', async () => {
    // Slow api for ws-1, fast for ws-2 — remount with ws-2 before ws-1 resolves.
    let releaseWs1: (v: { briefing: WorkspaceBriefing | null; autoShow?: boolean }) => void = () => {};
    const slow = new Promise<{ briefing: WorkspaceBriefing | null; autoShow?: boolean }>((res) => {
      releaseWs1 = res;
    });
    const api: DeckBriefingApi = {
      get: async (workspaceId: string) => {
        if (workspaceId === 'ws-1') return slow;
        return { briefing: briefing({ workspaceId: 'ws-2', greeting: 'ws-2 view' }), autoShow: false };
      },
    };
    await mount({ api, workspaceId: 'ws-1' });
    await mount({ api, workspaceId: 'ws-2' });
    expect(container.querySelector('[data-briefing-toggle]')!.textContent).toContain('ws-2 view');
    // ws-1's slow response now lands — it must be ignored (superseded).
    await act(async () => {
      releaseWs1({ briefing: briefing({ workspaceId: 'ws-1', greeting: 'STALE ws-1' }), autoShow: false });
      await slow;
    });
    expect(container.querySelector('[data-briefing-toggle]')!.textContent).toContain('ws-2 view');
    expect(container.querySelector('[data-briefing-toggle]')!.textContent).not.toContain('STALE');
  });

  it('refetches on an onStream tick for the matching workspace only', async () => {
    const api = fakeApi({ briefing: briefing(), autoShow: false });
    let fire: (env: { workspaceId: string; event: unknown }) => void = () => {};
    const onStream = (cb: (env: { workspaceId: string; event: unknown }) => void) => {
      fire = cb;
      return () => {};
    };
    await mount({ api, onStream, workspaceId: 'ws-1' });
    expect(api.calls.length).toBe(1); // initial mount fetch
    // A tick for a DIFFERENT workspace is ignored.
    await act(async () => { fire({ workspaceId: 'ws-other', event: {} }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    expect(api.calls.length).toBe(1);
    // A tick for THIS workspace triggers a debounced refetch.
    await act(async () => { fire({ workspaceId: 'ws-1', event: {} }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    expect(api.calls.length).toBe(2);
  });
});
