import { describe, it, expect } from 'vitest';
import { parseWorkspaceMirrorPayload } from '../workspaceMirror.handler';

describe('parseWorkspaceMirrorPayload — defensive renderer-trust validation', () => {
  it('accepts a well-formed payload and normalizes metadata nulls', () => {
    const parsed = parseWorkspaceMirrorPayload({
      ts: 42,
      entries: [
        {
          id: 'ws-1',
          name: 'alpha',
          metadata: { cwd: 'C:/repo/a', gitBranch: 'main' },
          activePtyId: 'pty-1',
          ptyIds: ['pty-1', 'pty-2'],
        },
      ],
      fleets: [
        {
          workspaceId: 'ws-1',
          ts: 42,
          panes: [{ ptyId: 'pty-1', agentName: 'Claude', agentStatus: 'running', isActivePane: true }],
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.entries[0].metadata).toMatchObject({
      cwd: 'C:/repo/a',
      gitBranch: 'main',
      agentName: null, // absent → normalized to null
      progress: null,
    });
    expect(parsed?.entries[0].ptyIds).toEqual(['pty-1', 'pty-2']);
    expect(parsed?.fleets[0].panes[0].agentStatus).toBe('running');
  });

  it('drops a non-object / missing-arrays payload entirely (keep last-good)', () => {
    expect(parseWorkspaceMirrorPayload(null)).toBeNull();
    expect(parseWorkspaceMirrorPayload('nope')).toBeNull();
    expect(parseWorkspaceMirrorPayload({ ts: 1 })).toBeNull(); // no entries/fleets arrays
    expect(parseWorkspaceMirrorPayload({ entries: [], fleets: {} })).toBeNull();
  });

  it('filters malformed entries but keeps the good ones', () => {
    const parsed = parseWorkspaceMirrorPayload({
      ts: 1,
      entries: [
        { id: 'ws-good', name: 'ok' },
        { id: 'bad id with spaces', name: 'x' }, // id fails WORKSPACE_ID_RE
        { name: 'no-id' },
        { id: 'ws-2', name: 42 }, // non-string name
      ],
      fleets: [],
    });
    expect(parsed?.entries.map((e) => e.id)).toEqual(['ws-good']);
  });

  it('rejects an unknown agentStatus and non-string ptyIds inside a fleet', () => {
    const parsed = parseWorkspaceMirrorPayload({
      ts: 1,
      entries: [{ id: 'ws-1', name: 'a' }],
      fleets: [
        {
          workspaceId: 'ws-1',
          ts: 1,
          panes: [
            { ptyId: 'pty-1', agentName: null, agentStatus: 'bogus', isActivePane: true }, // bad status
            { ptyId: 'pty-2', agentName: null, agentStatus: 'idle', isActivePane: false }, // ok
            { ptyId: '', agentName: null, agentStatus: 'complete', isActivePane: false }, // empty ptyId allowed
          ],
        },
      ],
    });
    const panes = parsed?.fleets[0].panes ?? [];
    expect(panes.map((p) => p.ptyId)).toEqual(['pty-2', '']);
  });

  it('coerces isActivePane to a strict boolean and defaults absent cwd', () => {
    const parsed = parseWorkspaceMirrorPayload({
      ts: 1,
      entries: [{ id: 'ws-1', name: 'a' }],
      fleets: [
        {
          workspaceId: 'ws-1',
          ts: 1,
          panes: [{ ptyId: 'pty-1', agentName: 'A', agentStatus: 'waiting', isActivePane: 'yes' }],
        },
      ],
    });
    const pane = parsed?.fleets[0].panes[0];
    expect(pane?.isActivePane).toBe(false); // only strict true counts
    expect(pane?.cwd).toBeUndefined();
  });
});
