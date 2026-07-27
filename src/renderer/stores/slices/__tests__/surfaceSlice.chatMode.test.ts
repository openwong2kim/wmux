/**
 * `Surface.chatMode` — the Chat View view-mode field (plan PR-8, amendment A9③).
 *
 * Availability gates the flag in BOTH directions. Turning Chat ON is refused for
 * a pane the projector cannot serve, and a status that turns unavailable forces
 * an already-on surface back OFF — otherwise a persisted `chatMode:true` whose
 * pane respawned as an unsupported agent would sit on a permanently empty view
 * with the toggle disabled, i.e. no way back.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createSurfaceSlice, type SurfaceSlice } from '../surfaceSlice';
import { createChatSlice, type ChatSlice } from '../chatSlice';
import { createWorkspace, type Surface, type Workspace } from '../../../../shared/types';
import { findLeaf } from '../../../../shared/paneUtils';

type TestState = SurfaceSlice & ChatSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
};

const PTY = 'pty-1';
const SURFACE_ID = 'sf-1';

function createTestStore() {
  const ws = createWorkspace('Test');
  const store = create<TestState>()(
    immer((...args) => ({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createSurfaceSlice(...args),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createChatSlice(...args),
    })),
  );
  store.setState((s) => {
    const leaf = findLeaf(s.workspaces[0].rootPane, s.workspaces[0].rootPane.id);
    if (!leaf) return;
    leaf.surfaces.length = 0;
    leaf.surfaces.push({
      id: SURFACE_ID,
      ptyId: PTY,
      title: 'Terminal',
      shell: '',
      cwd: '/repo',
      surfaceType: 'terminal',
    });
    leaf.activeSurfaceId = SURFACE_ID;
  });
  return store;
}

let store: ReturnType<typeof createTestStore>;

function surface(): Surface | undefined {
  const root = store.getState().workspaces[0].rootPane;
  const leaf = findLeaf(root, root.id);
  return leaf?.surfaces.find((s) => s.id === SURFACE_ID);
}

beforeEach(() => { store = createTestStore(); });

describe('setSurfaceChatMode', () => {
  it('turns Chat on when the projector reports available', () => {
    store.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    store.getState().setSurfaceChatMode(SURFACE_ID, true);
    expect(surface()?.chatMode).toBe(true);
  });

  it('refuses to turn Chat on for an unavailable pane', () => {
    store.getState().setChatStatus(PTY, { available: false, reason: 'not-claude' });
    store.getState().setSurfaceChatMode(SURFACE_ID, true);
    expect(surface()?.chatMode).toBeUndefined();
  });

  it('refuses to turn Chat on before the projector has answered at all', () => {
    store.getState().setSurfaceChatMode(SURFACE_ID, true);
    expect(surface()?.chatMode).toBeUndefined();
  });

  it('deletes the field rather than storing false, so a terminal surface serializes as before', () => {
    store.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    store.getState().setSurfaceChatMode(SURFACE_ID, true);
    store.getState().setSurfaceChatMode(SURFACE_ID, false);
    expect(surface()).not.toHaveProperty('chatMode');
  });

  it('ignores an unknown surface id', () => {
    store.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    store.getState().setSurfaceChatMode('sf-does-not-exist', true);
    expect(surface()?.chatMode).toBeUndefined();
  });
});

describe('A9③ — chatStatus turning unavailable forces chatMode off', () => {
  beforeEach(() => {
    store.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    store.getState().setSurfaceChatMode(SURFACE_ID, true);
    expect(surface()?.chatMode).toBe(true);
  });

  it('flips a chat surface back to the terminal when the pane stops publishing', () => {
    store.getState().setChatStatus(PTY, { available: false, reason: 'not-claude' });
    expect(surface()?.chatMode).toBeUndefined();
  });

  it('flips it back on an unreadable transcript too', () => {
    store.getState().setChatStatus(PTY, { available: false, reason: 'unreadable' });
    expect(surface()?.chatMode).toBeUndefined();
  });

  it('leaves it alone while the pane is still available', () => {
    store.getState().setChatStatus(PTY, { available: true, reason: 'ok', sizeBytes: 42 });
    expect(surface()?.chatMode).toBe(true);
  });

  it('does not touch a DIFFERENT pane going unavailable', () => {
    store.getState().setChatStatus('pty-other', { available: false, reason: 'not-claude' });
    expect(surface()?.chatMode).toBe(true);
  });
});

describe('A9④ — closeSurface drops the pane Chat projection window', () => {
  it('clears the chat maps for the closed ptyId', () => {
    store.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    store.getState().pushChatPending(PTY, 'hello');
    const root = store.getState().workspaces[0].rootPane;

    store.getState().closeSurface(root.id, SURFACE_ID);

    expect(store.getState().chatStatus[PTY]).toBeUndefined();
    expect(store.getState().chatPending[PTY]).toBeUndefined();
    expect(store.getState().chatEvents[PTY]).toBeUndefined();
  });
});
