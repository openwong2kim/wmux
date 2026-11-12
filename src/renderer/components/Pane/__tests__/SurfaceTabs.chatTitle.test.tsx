// @vitest-environment jsdom
//
// A tab a chat-v2 chat holds in chat view reads as its agent, not as the
// anchor shell ("Zsh"). The label is derived, never written to the title, so
// it ends with the chat.
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import { agentRow } from '../../../../shared/agentIdentity';
import type { ChatV2Binding } from '../../../../shared/chatv2/ipc';
import type { Surface, Workspace } from '../../../../shared/types';
import { forgetKnownBinding, setKnownBinding } from '../../ChatV2/controller';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PTY = 'pty-chat-title';
let container: HTMLDivElement;
let root: Root;

function mount(surfaces: Surface[]): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws: Workspace = useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
  act(() => {
    root.render(React.createElement(SurfaceTabs, {
      surfaces, activeSurfaceId: surfaces[0]!.id, workspace: ws, paneId: ws.rootPane.id, paneActive: true,
      onSelect: () => undefined, onClose: () => undefined, onSplitHorizontal: () => undefined,
      onSplitVertical: () => undefined, onAddTerminal: () => undefined, onAddBrowser: () => undefined,
    }));
  });
}

const tabText = () => container.querySelector('.wmux-surface-tab .truncate')?.textContent;
const chatSurface = (): Surface => ({ id: 's1', ptyId: PTY, title: 'Zsh', shell: 'zsh', cwd: '/tmp', viewMode: 'chat' });
const binding = (patch: Partial<ChatV2Binding> = {}): ChatV2Binding => ({
  paneId: PTY, chatSessionId: 'chat-1', agent: 'claude', mode: 'default', model: '', status: 'idle',
  epoch: '0123456789abcdef', seq: 1,
  capabilities: { send: true, interrupt: true, approvals: true, questions: true, images: false, toTerminal: true },
  ...patch,
});

describe('SurfaceTabs — a chat tab is named after its agent', () => {
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    act(() => forgetKnownBinding(PTY));
    useStore.getState().setChatViewEnabled(false);
  });

  it('follows the chat: agent name while it holds the pane, the shell title once it hands off', () => {
    act(() => useStore.getState().setChatViewEnabled(true));
    mount([chatSurface()]);
    expect(tabText()).toBe('Zsh');
    act(() => setKnownBinding(PTY, binding({ agent: 'codex' })));
    expect(tabText()).toBe(agentRow('codex')!.display);
    act(() => setKnownBinding(PTY, binding({ status: 'handed-off' })));
    expect(tabText()).toBe('Zsh');
  });
});
