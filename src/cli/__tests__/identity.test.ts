import { describe, it, expect, vi } from 'vitest';
import { resolveSelfContext, parseIdentityEntries, type IdentityDeps } from '../identity';
import type { RpcResponse } from '../../shared/rpc';

function okResponse(result: unknown): RpcResponse {
  return { id: 'r', ok: true, result };
}

function makeDeps(overrides: Partial<IdentityDeps>): IdentityDeps {
  return {
    sendRequest: vi.fn(async () => okResponse({ mappings: {}, entries: [] })),
    env: {},
    ppid: 1000,
    getParentPid: vi.fn(async () => null),
    ...overrides,
  };
}

describe('parseIdentityEntries', () => {
  it('prefers the entries array (pane-level identity)', () => {
    const entries = parseIdentityEntries({
      mappings: { '10': 'ws-a' },
      entries: [{ pid: '10', ptyId: 'pty-1', workspaceId: 'ws-a' }],
    });
    expect(entries).toEqual([{ pid: '10', ptyId: 'pty-1', workspaceId: 'ws-a' }]);
  });

  it('falls back to mappings for older mains (workspace-only, empty ptyId)', () => {
    const entries = parseIdentityEntries({ mappings: { '10': 'ws-a', '20': 'ws-b' } });
    expect(entries).toEqual([
      { pid: '10', ptyId: '', workspaceId: 'ws-a' },
      { pid: '20', ptyId: '', workspaceId: 'ws-b' },
    ]);
  });

  it('drops malformed entries and non-string mapping values', () => {
    expect(
      parseIdentityEntries({ entries: [{ pid: 5 }, null, { pid: '7', ptyId: 'p', workspaceId: 'w' }] }),
    ).toEqual([{ pid: '7', ptyId: 'p', workspaceId: 'w' }]);
    expect(parseIdentityEntries({ mappings: { '10': 42 } })).toEqual([]);
    expect(parseIdentityEntries(null)).toEqual([]);
    expect(parseIdentityEntries('nope')).toEqual([]);
  });
});

describe('resolveSelfContext', () => {
  it('resolves pane identity at depth 0 with zero getParentPid spawns', async () => {
    const getParentPid = vi.fn(async () => null);
    const deps = makeDeps({
      sendRequest: vi.fn(async () =>
        okResponse({ entries: [{ pid: '1000', ptyId: 'pty-self', workspaceId: 'ws-self' }] }),
      ),
      ppid: 1000,
      getParentPid,
    });
    const ctx = await resolveSelfContext(deps);
    expect(ctx).toEqual({ ptyId: 'pty-self', workspaceId: 'ws-self' });
    expect(getParentPid).not.toHaveBeenCalled();
  });

  it('omits ptyId for workspace-only legacy entries', async () => {
    const deps = makeDeps({
      sendRequest: vi.fn(async () => okResponse({ mappings: { '1000': 'ws-legacy' } })),
      ppid: 1000,
    });
    const ctx = await resolveSelfContext(deps);
    expect(ctx).toEqual({ workspaceId: 'ws-legacy' });
    expect(ctx.ptyId).toBeUndefined();
  });

  it('walks the parent chain only when the WMUX_WORKSPACE_ID hint is present', async () => {
    // chain: ppid 1000 → 2000 → 3000 (mapped)
    const chain: Record<number, number> = { 1000: 2000, 2000: 3000 };
    const getParentPid = vi.fn(async (pid: number) => chain[pid] ?? null);
    const entriesResult = okResponse({
      entries: [{ pid: '3000', ptyId: 'pty-deep', workspaceId: 'ws-deep' }],
    });

    // without hint: depth-0 miss → give up immediately, no spawns
    const noHint = await resolveSelfContext(
      makeDeps({ sendRequest: vi.fn(async () => entriesResult), ppid: 1000, getParentPid }),
    );
    expect(noHint).toEqual({});
    expect(getParentPid).not.toHaveBeenCalled();

    // with hint: walk up and hit at depth 2
    const withHint = await resolveSelfContext(
      makeDeps({
        sendRequest: vi.fn(async () => entriesResult),
        env: { WMUX_WORKSPACE_ID: 'ws-hint-stale' },
        ppid: 1000,
        getParentPid,
      }),
    );
    expect(withHint).toEqual({ ptyId: 'pty-deep', workspaceId: 'ws-deep' });
    // NOTE: the stale env hint value itself is never returned — only the
    // verified PID-map identity is.
    expect(withHint.workspaceId).not.toBe('ws-hint-stale');
  });

  it('stops the walk at maxDepth / self-parent / pid<=1', async () => {
    const getParentPid = vi.fn(async (pid: number) => (pid === 1000 ? 1000 : null));
    const ctx = await resolveSelfContext(
      makeDeps({
        sendRequest: vi.fn(async () =>
          okResponse({ entries: [{ pid: '9', ptyId: 'p', workspaceId: 'w' }] }),
        ),
        env: { WMUX_WORKSPACE_ID: 'ws' },
        ppid: 1000,
        getParentPid,
      }),
    );
    expect(ctx).toEqual({});
    expect(getParentPid).toHaveBeenCalledTimes(1); // self-parent loop detected
  });

  it('returns {} on RPC failure, error envelope, or empty map (never throws)', async () => {
    expect(
      await resolveSelfContext(
        makeDeps({ sendRequest: vi.fn(async () => { throw new Error('down'); }) }),
      ),
    ).toEqual({});
    expect(
      await resolveSelfContext(
        makeDeps({ sendRequest: vi.fn(async () => ({ id: 'r', ok: false, error: 'nope' }) as RpcResponse) }),
      ),
    ).toEqual({});
    expect(
      await resolveSelfContext(
        makeDeps({ sendRequest: vi.fn(async () => okResponse({ mappings: {}, entries: [] })) }),
      ),
    ).toEqual({});
  });
});
