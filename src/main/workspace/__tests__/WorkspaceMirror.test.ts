import { describe, it, expect } from 'vitest';
import {
  WorkspaceMirror,
  getWorkspaceMirror,
  __resetWorkspaceMirrorForTest,
} from '../WorkspaceMirror';
import type { WorkspaceMirrorPushPayload } from '../../../shared/workspaceMirror';

function payload(overrides: Partial<WorkspaceMirrorPushPayload> = {}): WorkspaceMirrorPushPayload {
  return {
    ts: 1000,
    entries: [
      { id: 'ws-1', name: 'alpha', metadata: { cwd: 'C:/repo/a' }, activePtyId: 'pty-1', ptyIds: ['pty-1'] },
    ],
    fleets: [
      {
        workspaceId: 'ws-1',
        ts: 1000,
        panes: [{ ptyId: 'pty-1', agentName: 'Claude Code', agentStatus: 'running', isActivePane: true }],
      },
    ],
    ...overrides,
  };
}

describe('WorkspaceMirror', () => {
  it('starts empty — null entries/peek, no fleet, never populated', () => {
    const m = new WorkspaceMirror();
    expect(m.getEntries()).toBeNull();
    expect(m.peek()).toBeNull();
    expect(m.getFleetSnapshot('ws-1')).toBeNull();
    expect(m.hasEverBeenPopulated()).toBe(false);
  });

  it('setSnapshot stores entries + per-workspace fleet and flips populated', () => {
    const m = new WorkspaceMirror();
    m.setSnapshot(payload());
    expect(m.getEntries()).toHaveLength(1);
    expect(m.getEntries()?.[0].id).toBe('ws-1');
    expect(m.getFleetSnapshot('ws-1')?.panes[0].agentStatus).toBe('running');
    expect(m.getFleetSnapshot('ws-2')).toBeNull();
    expect(m.hasEverBeenPopulated()).toBe(true);
  });

  it('peek reports age against the injected clock, not the renderer ts', () => {
    let clock = 5000;
    const m = new WorkspaceMirror(() => clock);
    // Renderer clock (payload.ts) is deliberately far from `clock` — age must be
    // measured on our own clock so cross-process skew can't distort it.
    m.setSnapshot(payload({ ts: 999_999 }));
    clock = 5300;
    const peeked = m.peek();
    expect(peeked).not.toBeNull();
    expect(peeked?.ageMs).toBe(300);
    expect(peeked?.entries[0].id).toBe('ws-1');
  });

  it('is full-replacement — last write wins, including clearing to empty', () => {
    const m = new WorkspaceMirror();
    m.setSnapshot(payload());
    m.setSnapshot(
      payload({
        entries: [{ id: 'ws-9', name: 'zeta', activePtyId: null }],
        fleets: [{ workspaceId: 'ws-9', ts: 2000, panes: [] }],
      }),
    );
    expect(m.getEntries()?.map((e) => e.id)).toEqual(['ws-9']);
    // The prior workspace's fleet must be gone (replacement, not merge).
    expect(m.getFleetSnapshot('ws-1')).toBeNull();
    expect(m.getFleetSnapshot('ws-9')?.panes).toEqual([]);
  });

  it('an empty push clears entries but keeps hasEverBeenPopulated true', () => {
    const m = new WorkspaceMirror();
    m.setSnapshot(payload());
    m.setSnapshot({ ts: 3000, entries: [], fleets: [] });
    expect(m.getEntries()).toEqual([]);
    expect(m.peek()?.entries).toEqual([]);
    expect(m.hasEverBeenPopulated()).toBe(true);
  });

  it('read accessors return copies — mutating a returned list cannot corrupt the mirror', () => {
    const m = new WorkspaceMirror();
    m.setSnapshot(payload());

    // getEntries: splice the returned array, then re-read — the mirror is intact.
    const entries = m.getEntries();
    entries?.splice(0, entries.length);
    expect(m.getEntries()).toHaveLength(1);

    // peek: same guarantee on the entries it hands back.
    const peeked = m.peek();
    peeked?.entries.push({ id: 'ws-evil', name: 'x', activePtyId: null });
    expect(m.peek()?.entries).toHaveLength(1);

    // getFleetSnapshot: mutating the panes array must not affect a later read.
    const fleet = m.getFleetSnapshot('ws-1');
    fleet?.panes.splice(0, fleet.panes.length);
    expect(m.getFleetSnapshot('ws-1')?.panes).toHaveLength(1);
  });

  it('getWorkspaceMirror returns a stable singleton; reset yields a fresh one', () => {
    __resetWorkspaceMirrorForTest();
    const a = getWorkspaceMirror();
    const b = getWorkspaceMirror();
    expect(a).toBe(b);
    a.setSnapshot(payload());
    expect(getWorkspaceMirror().hasEverBeenPopulated()).toBe(true);
    __resetWorkspaceMirrorForTest();
    expect(getWorkspaceMirror().hasEverBeenPopulated()).toBe(false);
  });
});
