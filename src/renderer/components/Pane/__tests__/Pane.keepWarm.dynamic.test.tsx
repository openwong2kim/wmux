// @vitest-environment jsdom
//
// PR-9 keep-warm LRU at the render switch.
//
// The load-bearing properties:
//  • setting OFF (the shipped default) → the terminal NEVER unmounts, exactly
//    as it behaved before this policy existed;
//  • setting ON + pane inside the warm set → still mounted (instant toggle-back);
//  • setting ON + pane evicted → unmounted (its memory is what we are reclaiming);
//  • terminal mode is never affected, whatever the LRU says.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../Terminal/Terminal', () => ({
  default: (props: { visible?: boolean; surfaceId: string }) =>
    React.createElement('div', {
      'data-mock-terminal': props.surfaceId,
      'data-visible': props.visible === undefined ? 'default' : String(props.visible),
    }),
}));

vi.mock('../../Chat/ChatView', () => ({
  ChatView: (props: { ptyId: string }) =>
    React.createElement('div', { 'data-mock-chat': props.ptyId }),
}));

import { TerminalOrChat } from '../Pane';
import { useStore } from '../../../stores';
import { KEEP_WARM_DEFAULT_N } from '../../../chat/keepWarmLru';
import type { Surface } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PTY = 'pty-warm-1';

let container: HTMLDivElement;
let root: Root;

function surface(overrides: Partial<Surface> = {}): Surface {
  return {
    id: 'sf-warm-1',
    ptyId: PTY,
    title: 'Terminal',
    shell: '',
    cwd: '/repo',
    surfaceType: 'terminal',
    ...overrides,
  };
}

function mount(sf: Surface): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(TerminalOrChat, {
        surface: sf,
        workspaceId: 'ws-1',
        isActive: true,
        isWorkspaceVisible: true,
        onPtyCreated: () => undefined,
      }),
    );
  });
}

const term = () => container.querySelector('[data-mock-terminal]');
const chat = () => container.querySelector('[data-mock-chat]');

/** MRU-first order in which PTY is the `position`-th entry (0 = most recent). */
function orderWithPtyAt(position: number, length: number): string[] {
  const order = Array.from({ length }, (_, i) => `other-${i}`);
  order.splice(position, 0, PTY);
  return order;
}

beforeEach(() => {
  useStore.setState((s) => {
    s.surfaceNeedsInput = {};
    s.surfacePendingQuestion = {};
    s.surfaceAgent = {};
    s.chatToggleOrder = [];
    s.chatKeepWarmLru = false;
  });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  useStore.setState((s) => { s.chatKeepWarmLru = false; s.chatToggleOrder = []; });
});

describe('TerminalOrChat — keep-warm LRU', () => {
  it('setting OFF: keeps the terminal mounted even for a pane far down the LRU', () => {
    useStore.setState((s) => {
      s.chatKeepWarmLru = false;
      s.chatToggleOrder = orderWithPtyAt(KEEP_WARM_DEFAULT_N + 3, 10);
    });
    mount(surface({ chatMode: true }));
    expect(term()).not.toBeNull();
    expect(term()!.getAttribute('data-visible')).toBe('false');
    expect(chat()).not.toBeNull();
  });

  it('setting ON, pane in the warm set: still mounted at visible=false', () => {
    useStore.setState((s) => {
      s.chatKeepWarmLru = true;
      s.chatToggleOrder = orderWithPtyAt(0, 10);
    });
    mount(surface({ chatMode: true }));
    expect(term()).not.toBeNull();
    expect(term()!.getAttribute('data-visible')).toBe('false');
    expect(chat()).not.toBeNull();
  });

  it('setting ON, pane evicted from the warm set: the terminal UNMOUNTS, chat stays', () => {
    useStore.setState((s) => {
      s.chatKeepWarmLru = true;
      s.chatToggleOrder = orderWithPtyAt(KEEP_WARM_DEFAULT_N, 10);
    });
    mount(surface({ chatMode: true }));
    expect(term()).toBeNull();
    expect(chat()).not.toBeNull();
  });

  it('setting ON, pane never toggled (absent from the order): evicted', () => {
    useStore.setState((s) => {
      s.chatKeepWarmLru = true;
      s.chatToggleOrder = ['other-0', 'other-1'];
    });
    mount(surface({ chatMode: true }));
    expect(term()).toBeNull();
  });

  it('terminal mode always renders the xterm, whatever the LRU says', () => {
    useStore.setState((s) => {
      s.chatKeepWarmLru = true;
      s.chatToggleOrder = orderWithPtyAt(KEEP_WARM_DEFAULT_N + 2, 10);
    });
    mount(surface());
    expect(term()).not.toBeNull();
    expect(term()!.getAttribute('data-visible')).toBe('default');
    expect(chat()).toBeNull();
  });

  it('re-entering the warm set remounts the terminal', () => {
    useStore.setState((s) => {
      s.chatKeepWarmLru = true;
      s.chatToggleOrder = orderWithPtyAt(KEEP_WARM_DEFAULT_N, 10);
    });
    mount(surface({ chatMode: true }));
    expect(term()).toBeNull();
    act(() => {
      useStore.setState((s) => { s.chatToggleOrder = orderWithPtyAt(0, 10); });
    });
    expect(term()).not.toBeNull();
  });
});

describe('surfaceSlice.setSurfaceChatMode — toggle recency', () => {
  it('promotes on chat-mode on and drops on chat-mode off', () => {
    // Direct slice check: the LRU input is only correct if the toggle updates it.
    const wsSnapshot = useStore.getState().workspaces;
    try {
      useStore.setState((s) => {
        s.chatToggleOrder = ['stale-1'];
        s.chatStatus = { [PTY]: { available: true } as never };
        s.workspaces = [{
          id: 'ws-warm',
          name: 'WS',
          activePaneId: 'pane-warm',
          rootPane: {
            id: 'pane-warm',
            type: 'leaf',
            surfaces: [surface()],
            activeSurfaceId: 'sf-warm-1',
          },
        } as never];
      });

      useStore.getState().setSurfaceChatMode('sf-warm-1', true);
      expect(useStore.getState().chatToggleOrder).toEqual([PTY, 'stale-1']);

      useStore.getState().setSurfaceChatMode('sf-warm-1', false);
      expect(useStore.getState().chatToggleOrder).toEqual(['stale-1']);
    } finally {
      useStore.setState((s) => { s.workspaces = wsSnapshot; s.chatStatus = {}; });
    }
  });
});
