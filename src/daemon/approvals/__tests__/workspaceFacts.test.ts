import { describe, expect, it } from 'vitest';
import { WorkspaceFactStore, WORKSPACE_FACTS_MAX_ROWS } from '../workspaceFacts';

const ROW = { workspaceId: 'ws-task', isTaskWorkspace: true, autonomyMode: 'assist', approvalPress: true };

describe('WorkspaceFactStore', () => {
  it('answers null until main publishes, and {} for an unlisted workspace after', () => {
    const store = new WorkspaceFactStore();
    // Nothing published: "not established", which the registry reports as
    // scope-unavailable rather than as a fact about the workspace.
    expect(store.published).toBe(false);
    expect(store.get('ws-task')).toBeNull();

    store.replace([ROW], 1);
    expect(store.published).toBe(true);
    expect(store.get('ws-task')).toEqual({
      isTaskWorkspace: true,
      autonomyMode: 'assist',
      approvalPress: true,
    });
    // Main answered and did not list this one — an answer, not a silence.
    expect(store.get('ws-other')).toEqual({});
  });

  it('replaces rather than merges, so a workspace can leave the table', () => {
    const store = new WorkspaceFactStore();
    store.replace([ROW, { ...ROW, workspaceId: 'ws-2' }], 1);
    store.replace([ROW], 2);
    expect(store.get('ws-2')).toEqual({});
  });

  // The race this exists for: a task CLOSES (push B says isTaskWorkspace false),
  // and an older push A — built before the close — lands after it. Without the
  // sequence the closed task's workspace goes back to being pressable.
  it('drops a table whose seq is not newer than the one held', () => {
    const store = new WorkspaceFactStore();
    expect(store.replace([ROW], 5).ok).toBe(true);

    const stale = store.replace([{ ...ROW, isTaskWorkspace: false }], 4);
    expect(stale).toMatchObject({ ok: false, reason: 'stale', seq: 5 });
    expect(store.get('ws-task')).toMatchObject({ isTaskWorkspace: true });

    // Same seq is not newer either — a replayed push must not re-apply.
    expect(store.replace([{ ...ROW, isTaskWorkspace: false }], 5).ok).toBe(false);
    // …and the genuinely newer one wins.
    expect(store.replace([{ ...ROW, isTaskWorkspace: false }], 6).ok).toBe(true);
    expect(store.get('ws-task')).toMatchObject({ isTaskWorkspace: false });
  });

  it('drops malformed rows and caps the table', () => {
    const store = new WorkspaceFactStore();
    const accepted = store.replace(
      [
        ROW,
        { ...ROW, workspaceId: '' },
        { ...ROW, workspaceId: 'ws-bad', isTaskWorkspace: 'yes' } as never,
        { ...ROW, workspaceId: 'ws-bad2', autonomyMode: 3 } as never,
        // The capability is the authorization, so a row without it is dropped
        // rather than defaulted.
        { workspaceId: 'ws-bad3', isTaskWorkspace: true, autonomyMode: 'assist' } as never,
      ],
      1,
    );
    expect(accepted).toMatchObject({ ok: true, accepted: 1 });
    expect(store.get('ws-bad')).toEqual({});
    expect(store.get('ws-bad3')).toEqual({});

    const flood = Array.from({ length: WORKSPACE_FACTS_MAX_ROWS + 10 }, (_, i) => ({
      ...ROW,
      workspaceId: `ws-${i}`,
    }));
    expect(store.replace(flood, 2)).toMatchObject({ accepted: WORKSPACE_FACTS_MAX_ROWS });
  });

  it('clears back to "not established", and resets the sequence for the next publisher', () => {
    const store = new WorkspaceFactStore();
    store.replace([ROW], 9);
    store.clear();
    expect(store.published).toBe(false);
    // Not {} — a table nobody is maintaining is not evidence about anything.
    expect(store.get('ws-task')).toBeNull();
    // A fresh main counts from 1; holding the dead one's high-water mark would
    // make every table it sends look stale.
    expect(store.replace([ROW], 1).ok).toBe(true);
  });
});
