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

// Issue #515: attach the profile atomically at creation so pane #1 spawns in
// profile.startupCwd (the create-then-set pair left pane #1 in home).
describe('workspaceSlice — addWorkspace(name, profile)', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('stops new phone creation at the history bound without evicting old requests', () => {
    const history = Array.from({length:10_000}, (_, index) =>
      `ws-phone-${index.toString(16).padStart(8,'0')}-89ab-4cde-8123-456789abcdef`);
    store.setState({phoneWorkspaceRequestIds:history});
    const before = store.getState().workspaces.length;
    store.getState().addWorkspace('Over limit', undefined, 'ws-phone-ffffffff-89ab-4cde-8123-456789abcdef');
    expect(store.getState().workspaces).toHaveLength(before);
    expect(store.getState().phoneWorkspaceRequestIds).toEqual(history);
    store.getState().addWorkspace('Desktop creation still works');
    expect(store.getState().workspaces).toHaveLength(before + 1);
  });

  it('keeps a phone request identity across session reload and does not create a duplicate', () => {
    const id = 'ws-phone-01234567-89ab-4cde-8123-456789abcdef';
    store.getState().addWorkspace('Phone project', { startupCwd: '/project' }, id);
    const saved = JSON.parse(JSON.stringify({ workspaces: store.getState().workspaces, activeWorkspaceId: id, sidebarVisible: true })) as SessionData;
    const restored = createTestStore();
    restored.getState().loadSession(saved);
    const count = restored.getState().workspaces.length;
    restored.getState().addWorkspace('Retry should not rename', { startupCwd: '/other' }, id);
    expect(restored.getState().workspaces).toHaveLength(count);
    expect(restored.getState().workspaces.find(w => w.id === id)).toMatchObject({ name: 'Phone project', profile: { startupCwd: '/project' } });
  });

  it('attaches a normalized profile to the newly-activated workspace', () => {
    store.getState().addWorkspace('proj', { startupCwd: 'D:\\proj' });
    const active = store.getState().workspaces.find((w) => w.id === store.getState().activeWorkspaceId);
    expect(active?.name).toBe('proj');
    expect(active?.profile).toEqual({ startupCwd: 'D:\\proj' });
  });

  it('drops secret-named keys on the atomic profile (editor/save boundary)', () => {
    store.getState().addWorkspace('proj', {
      startupCwd: 'D:\\proj',
      env: { CLAUDE_CONFIG_DIR: 'C:/a', OPENAI_API_KEY: 'sk-leak' },
    });
    const active = store.getState().workspaces.find((w) => w.id === store.getState().activeWorkspaceId);
    expect(active?.profile?.env).toEqual({ CLAUDE_CONFIG_DIR: 'C:/a' });
  });

  it('leaves the profile unset when none is passed (existing callers unchanged)', () => {
    store.getState().addWorkspace('plain');
    const active = store.getState().workspaces.find((w) => w.id === store.getState().activeWorkspaceId);
    expect(active?.profile).toBeUndefined();
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
