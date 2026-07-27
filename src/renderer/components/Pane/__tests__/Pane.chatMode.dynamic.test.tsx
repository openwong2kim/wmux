// @vitest-environment jsdom
//
// The Chat View render switch (plan PR-8).
//
// The load-bearing property: with `chatMode` on, the xterm stays MOUNTED at
// `visible={false}` and ChatView renders over it. Unmounting the terminal would
// be safe for the PTY (Terminal.tsx only disposes one it created itself) but a
// remount pays a full ring-buffer replay — PR-9 owns that trade behind a setting.
// Until then the terminal never leaves the tree, so toggle-back is instant.
//
// Terminal and ChatView are mocked down to prop-reporting markers: this test is
// about the switch, not about either component's internals (they have their own).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../Terminal/Terminal', () => ({
  default: (props: { visible?: boolean; isActive: boolean; surfaceId: string }) =>
    React.createElement('div', {
      'data-mock-terminal': props.surfaceId,
      'data-visible': props.visible === undefined ? 'default' : String(props.visible),
      'data-active': String(props.isActive),
    }),
}));

vi.mock('../../Chat/ChatView', () => ({
  ChatView: (props: {
    ptyId: string;
    needsInput?: boolean;
    pendingQuestion?: string;
    agentStatus?: string;
    agentName?: string;
    onFetchBody?: unknown;
    onOpenDiff?: unknown;
  }) =>
    React.createElement('div', {
      'data-mock-chat': props.ptyId,
      'data-needs-input': String(!!props.needsInput),
      'data-pending-question': props.pendingQuestion ?? '',
      'data-agent-status': props.agentStatus ?? '',
      'data-agent-name': props.agentName ?? '',
      'data-has-fetch-body': String(typeof props.onFetchBody === 'function'),
      'data-has-open-diff': String(typeof props.onOpenDiff === 'function'),
    }),
}));

import { TerminalOrChat } from '../Pane';
import { useStore } from '../../../stores';
import type { Surface } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PTY = 'pty-switch-1';

let container: HTMLDivElement;
let root: Root;

function surface(overrides: Partial<Surface> = {}): Surface {
  return {
    id: 'sf-switch-1',
    ptyId: PTY,
    title: 'Terminal',
    shell: '',
    cwd: '/repo',
    surfaceType: 'terminal',
    ...overrides,
  };
}

function mount(sf: Surface, visible?: boolean): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(TerminalOrChat, {
        surface: sf,
        workspaceId: 'ws-1',
        isActive: true,
        ...(visible === undefined ? {} : { visible }),
        isWorkspaceVisible: true,
        onPtyCreated: () => undefined,
      }),
    );
  });
}

const term = () => container.querySelector('[data-mock-terminal]');
const chat = () => container.querySelector('[data-mock-chat]');

beforeEach(() => {
  useStore.setState((s) => {
    s.surfaceNeedsInput = {};
    s.surfacePendingQuestion = {};
    s.surfaceAgent = {};
  });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('TerminalOrChat — the render switch', () => {
  it('terminal mode renders the xterm and no chat', () => {
    mount(surface());
    expect(term()).not.toBeNull();
    expect(term()!.getAttribute('data-visible')).toBe('default');
    expect(chat()).toBeNull();
  });

  it('chat mode KEEPS the terminal mounted at visible=false and renders chat', () => {
    mount(surface({ chatMode: true }));
    expect(term()).not.toBeNull();
    expect(term()!.getAttribute('data-visible')).toBe('false');
    expect(chat()).not.toBeNull();
    expect(chat()!.getAttribute('data-mock-chat')).toBe(PTY);
  });

  it('chat mode takes focus off the terminal so keystrokes go to the composer', () => {
    mount(surface({ chatMode: true }));
    expect(term()!.getAttribute('data-active')).toBe('false');
  });

  it("preserves the split path's own visible=false decision in terminal mode", () => {
    mount(surface(), false);
    expect(term()!.getAttribute('data-visible')).toBe('false');
    expect(chat()).toBeNull();
  });

  it('ignores chatMode on a surface with no ptyId (nothing to project)', () => {
    mount(surface({ ptyId: '', chatMode: true }));
    expect(chat()).toBeNull();
    expect(term()!.getAttribute('data-visible')).toBe('default');
  });

  it('threads the composer gate, question, agent identity and both callbacks', () => {
    useStore.setState((s) => {
      s.surfaceNeedsInput[PTY] = true;
      s.surfacePendingQuestion[PTY] = 'Which file should I delete?';
      s.surfaceAgent[PTY] = { name: 'Claude Code', status: 'running' };
    });
    mount(surface({ chatMode: true }));

    expect(chat()!.getAttribute('data-needs-input')).toBe('true');
    expect(chat()!.getAttribute('data-pending-question')).toBe('Which file should I delete?');
    expect(chat()!.getAttribute('data-agent-status')).toBe('running');
    expect(chat()!.getAttribute('data-agent-name')).toBe('Claude Code');
    expect(chat()!.getAttribute('data-has-fetch-body')).toBe('true');
    expect(chat()!.getAttribute('data-has-open-diff')).toBe('true');
  });

  it("does not pass awaiting_input as a chat status — that is the gate's job", () => {
    useStore.setState((s) => {
      s.surfaceAgent[PTY] = { name: 'Claude Code', status: 'awaiting_input' };
    });
    mount(surface({ chatMode: true }));
    expect(chat()!.getAttribute('data-agent-status')).toBe('');
  });
});
