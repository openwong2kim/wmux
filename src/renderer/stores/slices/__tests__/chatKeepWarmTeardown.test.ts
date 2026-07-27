// PR-9 keep-warm LRU teardown, at the pane- and workspace-close sites.
//
// `chatToggleOrder` is the MRU list `keepWarmSet` computes the warm window from.
// A ptyId that outlives its pane keeps one of the N slots forever, so with
// keep-warm enabled the dead entries occupy the head of the list and LIVE chat
// panes fall out of the window — they get unmounted and replayed on toggle-back.
// closeSurface is covered in surfaceSlice.chatMode.test.ts; these are the other
// two teardowns that clear the same projection maps.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createChatSlice, type ChatSlice } from '../chatSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';

vi.mock('../../../events/publisher', () => ({
  publishPaneCreated: () => {},
  publishPaneClosed: () => {},
  publishPaneFocused: () => {},
  publishWorkspaceMetadataChanged: () => {},
  publishA2aTask: () => {},
}));

type TestState = PaneSlice & WorkspaceSlice & ChatSlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createChatSlice(...args),
    })),
  );
}

let store: ReturnType<typeof createTestStore>;
let wsId: string;

beforeEach(() => {
  store = createTestStore();
  wsId = store.getState().workspaces[0].id;
});

/** Split the root and give the new leaf a chat-mode surface on `ptyId`. */
function addChatPane(ptyId: string): string {
  const rootId = store.getState().workspaces[0].rootPane.id;
  store.getState().splitPane(rootId, 'horizontal');
  const root = store.getState().workspaces[0].rootPane;
  if (root.type !== 'branch') throw new Error('split failed');
  const target = root.children[root.children.length - 1];
  if (target.type !== 'leaf') throw new Error('unexpected tree');
  store.setState((s) => {
    const w = s.workspaces[0];
    if (w.rootPane.type !== 'branch') return;
    const leaf = w.rootPane.children.find((c) => c.id === target.id);
    if (leaf?.type === 'leaf') {
      leaf.surfaces.push({
        id: `sf-${ptyId}`,
        surfaceType: 'terminal',
        ptyId,
        chatMode: true,
      } as unknown as (typeof leaf.surfaces)[number]);
    }
    s.chatToggleOrder = [ptyId, ...(s.chatToggleOrder ?? [])];
  });
  return target.id;
}

describe('closePane', () => {
  it('drops the closed pane ptyIds from the keep-warm toggle order', () => {
    const paneId = addChatPane('pty-dead');
    store.setState((s) => { s.chatToggleOrder = ['pty-dead', 'pty-live']; });

    store.getState().closePane(paneId, wsId);

    expect(store.getState().chatToggleOrder).toEqual(['pty-live']);
  });
});

describe('removeWorkspace', () => {
  it('drops every ptyId of the removed workspace from the toggle order', () => {
    store.setState((s) => { s.workspaces.push(createWorkspace('Second') as Workspace); });
    const secondId = store.getState().workspaces[1].id;
    store.setState((s) => {
      const root = s.workspaces[1].rootPane;
      if (root.type !== 'leaf') return;
      root.surfaces.push({
        id: 'sf-ws2',
        surfaceType: 'terminal',
        ptyId: 'pty-ws2',
        chatMode: true,
      } as unknown as (typeof root.surfaces)[number]);
      s.chatToggleOrder = ['pty-ws2', 'pty-live'];
    });

    store.getState().removeWorkspace(secondId);

    expect(store.getState().chatToggleOrder).toEqual(['pty-live']);
  });
});
