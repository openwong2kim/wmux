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

  // The deck gates read `isAgent === false` as "this is the human's shell, do
  // not hold the turn for it", so a missing or garbled field must stay
  // undefined ("unknown") rather than be coerced into that release.
  it('carries a real isAgent boolean and leaves anything else undefined', () => {
    const parsed = parseWorkspaceMirrorPayload({
      ts: 1,
      entries: [{ id: 'ws-1', name: 'a' }],
      fleets: [
        {
          workspaceId: 'ws-1',
          ts: 1,
          panes: [
            { ptyId: 'pty-1', agentName: 'A', agentStatus: 'running', isActivePane: true, isAgent: true },
            { ptyId: 'pty-2', agentName: null, agentStatus: 'running', isActivePane: false, isAgent: false },
            { ptyId: 'pty-3', agentName: null, agentStatus: 'running', isActivePane: false, isAgent: 'no' },
            { ptyId: 'pty-4', agentName: null, agentStatus: 'running', isActivePane: false },
          ],
        },
      ],
    });
    const panes = parsed?.fleets[0].panes ?? [];
    expect(panes.map((p) => p.isAgent)).toEqual([true, false, undefined, undefined]);
  });
});

describe('parseWorkspaceMirrorPayload — roleBindings passthrough (3-way review: Codex)', () => {
  // The original fast-path change validated the mirror by calling setSnapshot
  // directly, bypassing this parser — which silently DROPPED roleBindings, so
  // the resolver fell back to the round-trip on every call. These tests pin
  // the production path: whatever reaches setSnapshot must carry the field.
  const base = { ts: 1, entries: [], fleets: [] };

  it('forwards a present roleBindings map (values opaque, keys validated)', () => {
    const parsed = parseWorkspaceMirrorPayload({
      ...base,
      roleBindings: { 'pty-1': { agent: 'claude', model: 'haiku' }, '': { dropped: true } },
    });
    expect(parsed?.roleBindings).toEqual({ 'pty-1': { agent: 'claude', model: 'haiku' } });
  });

  it('an ABSENT field stays absent (old renderer ⇒ resolver must round-trip)', () => {
    const parsed = parseWorkspaceMirrorPayload({ ...base });
    expect(parsed).not.toBeNull();
    expect('roleBindings' in (parsed as object)).toBe(false);
  });

  it('an EMPTY map survives as empty (authoritative "nothing bound")', () => {
    const parsed = parseWorkspaceMirrorPayload({ ...base, roleBindings: {} });
    expect(parsed?.roleBindings).toEqual({});
  });

  it('a non-record roleBindings is dropped, not fatal', () => {
    const parsed = parseWorkspaceMirrorPayload({ ...base, roleBindings: 'junk' });
    expect(parsed).not.toBeNull();
    expect(parsed?.roleBindings).toBeUndefined();
  });
});
