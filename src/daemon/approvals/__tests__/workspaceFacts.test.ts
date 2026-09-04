import { describe, expect, it } from 'vitest';
import { WorkspaceFactStore, WORKSPACE_FACTS_MAX_ROWS } from '../workspaceFacts';

const ROW = { workspaceId: 'ws-task', isTaskWorkspace: true, autonomyMode: 'assist' };

describe('WorkspaceFactStore', () => {
  it('answers null until main publishes, and {} for an unlisted workspace after', () => {
    const store = new WorkspaceFactStore();
    // Nothing published: "not established", which the registry reports as
    // scope-unavailable rather than as a fact about the workspace.
    expect(store.published).toBe(false);
    expect(store.get('ws-task')).toBeNull();

    store.replace([ROW]);
    expect(store.published).toBe(true);
    expect(store.get('ws-task')).toEqual({ isTaskWorkspace: true, autonomyMode: 'assist' });
    // Main answered and did not list this one — an answer, not a silence.
    expect(store.get('ws-other')).toEqual({});
  });

  it('replaces rather than merges, so a workspace can leave the table', () => {
    const store = new WorkspaceFactStore();
    store.replace([ROW, { workspaceId: 'ws-2', isTaskWorkspace: true, autonomyMode: 'danger' }]);
    store.replace([ROW]);
    expect(store.get('ws-2')).toEqual({});
  });

  it('drops malformed rows and caps the table', () => {
    const store = new WorkspaceFactStore();
    const accepted = store.replace([
      ROW,
      { workspaceId: '', isTaskWorkspace: true, autonomyMode: 'assist' },
      { workspaceId: 'ws-bad', isTaskWorkspace: 'yes', autonomyMode: 'assist' } as never,
      { workspaceId: 'ws-bad2', isTaskWorkspace: true, autonomyMode: 3 } as never,
    ]);
    expect(accepted).toBe(1);
    expect(store.get('ws-bad')).toEqual({});

    const flood = Array.from({ length: WORKSPACE_FACTS_MAX_ROWS + 10 }, (_, i) => ({
      workspaceId: `ws-${i}`,
      isTaskWorkspace: true,
      autonomyMode: 'assist',
    }));
    expect(store.replace(flood)).toBe(WORKSPACE_FACTS_MAX_ROWS);
  });

  it('clears back to "not established" when its publisher goes away', () => {
    const store = new WorkspaceFactStore();
    store.replace([ROW]);
    store.clear();
    expect(store.published).toBe(false);
    // Not {} — a table nobody is maintaining is not evidence about anything.
    expect(store.get('ws-task')).toBeNull();
  });
});
