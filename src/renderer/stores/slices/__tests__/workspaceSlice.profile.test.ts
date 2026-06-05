import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import type { SessionData } from '../../../../shared/types';

// Capture publisher calls — the profile setter must NOT publish a metadata event
// (env values must never travel the metadata bus).
const publishCalls: Array<{ fn: string; args: unknown[] }> = [];
vi.mock('../../../events/publisher', () => ({
  publishWorkspaceMetadataChanged: (...args: unknown[]) => {
    publishCalls.push({ fn: 'workspace.metadata.changed', args });
  },
}));

function createTestStore() {
  return create<WorkspaceSlice>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
    })),
  );
}

describe('workspaceSlice — setWorkspaceProfile', () => {
  let store: ReturnType<typeof createTestStore>;
  let wsId: string;

  beforeEach(() => {
    publishCalls.length = 0;
    store = createTestStore();
    wsId = store.getState().workspaces[0].id;
  });

  it('stores a normalized profile', () => {
    store.getState().setWorkspaceProfile(wsId, {
      env: { CLAUDE_CONFIG_DIR: 'C:/a' },
      defaultPaneCommand: 'claude',
    });
    const ws = store.getState().workspaces.find((w) => w.id === wsId);
    expect(ws?.profile).toEqual({ env: { CLAUDE_CONFIG_DIR: 'C:/a' }, defaultPaneCommand: 'claude' });
  });

  it('drops invalid, reserved, and secret-named keys on save', () => {
    store.getState().setWorkspaceProfile(wsId, {
      env: {
        CLAUDE_CONFIG_DIR: 'C:/a',
        '1BAD': 'x',
        WMUX_WORKSPACE_ID: 'spoof',
        OPENAI_API_KEY: 'sk-leak',
        GOOGLE_APPLICATION_CREDENTIALS: 'C:/gcp.json', // allowlisted path pointer — kept
      },
    });
    const ws = store.getState().workspaces.find((w) => w.id === wsId);
    expect(ws?.profile?.env).toEqual({
      CLAUDE_CONFIG_DIR: 'C:/a',
      GOOGLE_APPLICATION_CREDENTIALS: 'C:/gcp.json',
    });
  });

  it('clears the profile when given an empty profile', () => {
    store.getState().setWorkspaceProfile(wsId, { env: { OK: '1' } });
    expect(store.getState().workspaces.find((w) => w.id === wsId)?.profile).toBeDefined();
    store.getState().setWorkspaceProfile(wsId, {});
    expect(store.getState().workspaces.find((w) => w.id === wsId)?.profile).toBeUndefined();
  });

  it('clears the profile when given undefined', () => {
    store.getState().setWorkspaceProfile(wsId, { env: { OK: '1' } });
    store.getState().setWorkspaceProfile(wsId, undefined);
    expect(store.getState().workspaces.find((w) => w.id === wsId)?.profile).toBeUndefined();
  });

  it('does NOT publish a metadata-change event', () => {
    store.getState().setWorkspaceProfile(wsId, { env: { OK: '1' } });
    expect(publishCalls).toHaveLength(0);
  });

  it('is a silent no-op for an unknown workspace', () => {
    expect(() => store.getState().setWorkspaceProfile('nope', { env: { OK: '1' } })).not.toThrow();
  });
});

describe('workspaceSlice — loadSession profile sanitization', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  function sessionWith(profile: unknown): SessionData {
    const base = store.getState().workspaces[0];
    return {
      workspaces: [{ ...base, profile } as never],
      activeWorkspaceId: base.id,
      sidebarVisible: true,
    } as SessionData;
  }

  it('keeps a valid profile and strips invalid entries on load', () => {
    store.getState().loadSession(
      sessionWith({ env: { CLAUDE_CONFIG_DIR: 'C:/a', 'BAD KEY': 'x' }, defaultPaneCommand: 'go' }),
    );
    const ws = store.getState().workspaces[0];
    expect(ws.profile).toEqual({ env: { CLAUDE_CONFIG_DIR: 'C:/a' }, defaultPaneCommand: 'go' });
  });

  it('PRESERVES a secret-named key on load (non-destructive for legacy sessions)', () => {
    // A session.json saved before the secret-name policy must keep working —
    // load does not drop secret keys (only the editor save path does).
    store.getState().loadSession(
      sessionWith({ env: { CLAUDE_CONFIG_DIR: 'C:/a', LEGACY_TOKEN: 'keep-me' } }),
    );
    const ws = store.getState().workspaces[0];
    expect(ws.profile?.env).toEqual({ CLAUDE_CONFIG_DIR: 'C:/a', LEGACY_TOKEN: 'keep-me' });
  });

  it('drops an empty/invalid profile on load', () => {
    store.getState().loadSession(sessionWith({ env: { '1BAD': 'x' } }));
    expect(store.getState().workspaces[0].profile).toBeUndefined();
  });
});
