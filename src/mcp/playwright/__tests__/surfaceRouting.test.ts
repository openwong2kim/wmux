import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Where a browser call that named no surfaceId lands.
 *
 * Two agent panes in one workspace hold two MCP connections. The default used
 * to be "the newest surface in the workspace", which both connections resolved
 * to the same answer: agent B's browser_navigate drove agent A's tab. These
 * tests pin the per-connection order that replaces it — pin, then my newest,
 * then an unclaimed one, then nothing (open my own) — and that a surface
 * another connection opened is never the silent default.
 */

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { createConnectionScope, runInConnectionScope } from '../../connectionScope';
import {
  __resetSurfaceRoutingForTesting,
  clearPinnedSurface,
  getOpenerKey,
  getPinnedSurface,
  noteOpenedSurface,
  pickDefaultSurface,
  resolveDefaultSurface,
  scopeTargets,
  type RoutableTarget,
} from '../surfaceRouting';

const WS = 'ws-1';

beforeEach(() => {
  mockSendRpc.mockReset();
  __resetSurfaceRoutingForTesting();
});

describe('opener key identity', () => {
  it('mints one key per connection, stable across calls', () => {
    const a = createConnectionScope();
    const b = createConnectionScope();

    const a1 = runInConnectionScope(a, () => getOpenerKey());
    const a2 = runInConnectionScope(a, () => getOpenerKey());
    const b1 = runInConnectionScope(b, () => getOpenerKey());

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
  });

  it('falls back to one process-wide key for the single-child stdio server', () => {
    // No broker scope: one process IS one caller there, so the module fallback
    // has exactly the meaning the per-connection key has in the broker.
    const first = getOpenerKey();
    expect(getOpenerKey()).toBe(first);

    const scoped = runInConnectionScope(createConnectionScope(), () => getOpenerKey());
    expect(scoped).not.toBe(first);
  });

  it('keeps the pin per connection, and opening moves it', () => {
    const a = createConnectionScope();
    const b = createConnectionScope();

    runInConnectionScope(a, () => noteOpenedSurface(WS, 'surf-a'));
    runInConnectionScope(b, () => noteOpenedSurface(WS, 'surf-b'));

    expect(runInConnectionScope(a, () => getPinnedSurface())).toEqual({
      workspaceId: WS,
      surfaceId: 'surf-a',
    });
    expect(runInConnectionScope(b, () => getPinnedSurface())).toEqual({
      workspaceId: WS,
      surfaceId: 'surf-b',
    });
  });
});

describe('pickDefaultSurface fallback order', () => {
  const mine = 'opener-mine';
  const theirs = 'opener-theirs';

  it('a — the pin wins while its surface is still listed', () => {
    const targets: RoutableTarget[] = [
      { surfaceId: 'surf-new', openerKey: mine },
      { surfaceId: 'surf-pinned', openerKey: mine },
    ];
    expect(
      pickDefaultSurface(targets, WS, mine, { workspaceId: WS, surfaceId: 'surf-pinned' }),
    ).toEqual({ kind: 'surface', surfaceId: 'surf-pinned' });
  });

  it('b — without a pin, my newest surface, not the workspace\'s newest', () => {
    const targets: RoutableTarget[] = [
      { surfaceId: 'surf-mine-old', openerKey: mine },
      { surfaceId: 'surf-mine', openerKey: mine },
      { surfaceId: 'surf-theirs', openerKey: theirs },
    ];
    expect(pickDefaultSurface(targets, WS, mine, null)).toEqual({
      kind: 'surface',
      surfaceId: 'surf-mine',
    });
  });

  it('c — otherwise the newest surface nobody claims', () => {
    const targets: RoutableTarget[] = [
      { surfaceId: 'surf-restored-old' },
      { surfaceId: 'surf-restored' },
      { surfaceId: 'surf-theirs', openerKey: theirs },
    ];
    expect(pickDefaultSurface(targets, WS, mine, null)).toEqual({
      kind: 'surface',
      surfaceId: 'surf-restored',
    });
  });

  it('d — never another connection\'s surface, even as the only one', () => {
    const targets: RoutableTarget[] = [{ surfaceId: 'surf-theirs', openerKey: theirs }];
    expect(pickDefaultSurface(targets, WS, mine, null)).toEqual({ kind: 'none' });
  });

  it('reports an unlisted pin instead of silently picking somebody else\'s tab', () => {
    // A surface can exist before its CDP target registers. Dropping the pin on
    // that absence would hand the call to the ownerless tab below at exactly
    // the moment the agent opened its own.
    const targets: RoutableTarget[] = [{ surfaceId: 'surf-restored' }];
    expect(
      pickDefaultSurface(targets, WS, mine, { workspaceId: WS, surfaceId: 'surf-fresh' }),
    ).toEqual({ kind: 'pin-unlisted', surfaceId: 'surf-fresh' });
  });

  it('ignores a pin from another workspace', () => {
    const targets: RoutableTarget[] = [{ surfaceId: 'surf-restored' }];
    expect(
      pickDefaultSurface(targets, WS, mine, { workspaceId: 'ws-other', surfaceId: 'surf-elsewhere' }),
    ).toEqual({ kind: 'surface', surfaceId: 'surf-restored' });
  });
});

describe('scopeTargets', () => {
  it('trusts a scoped response as already the caller\'s', () => {
    const targets = [{ surfaceId: 's1' }];
    expect(scopeTargets({ targets, targetsScoped: true }, WS)).toEqual(targets);
  });

  it('filters a legacy response by workspace tag', () => {
    const targets = [
      { surfaceId: 's1', workspaceId: 'ws-other' },
      { surfaceId: 's2', workspaceId: WS },
    ];
    expect(scopeTargets({ targets }, WS)).toEqual([{ surfaceId: 's2', workspaceId: WS }]);
  });

  it('refuses a legacy response that tags nothing', () => {
    expect(() => scopeTargets({ targets: [{ surfaceId: 's1' }] }, WS)).toThrow(
      'WORKSPACE_SCOPE_UNRESOLVED',
    );
  });

  it('treats a response with no target list as nothing to route to', () => {
    expect(scopeTargets({ targets: undefined as unknown as RoutableTarget[] }, WS)).toEqual([]);
  });
});

describe('resolveDefaultSurface over the transport', () => {
  /** A main answering cdp.info with `targets`, scoped, plus a tabs list. */
  function mainWith(targets: RoutableTarget[], listed: string[] = targets.map((t) => t.surfaceId)) {
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.cdp.info') return Promise.resolve({ targetsScoped: true, targets });
      if (method === 'browser.tabs') {
        return Promise.resolve({
          ok: true,
          action: 'list',
          tabs: listed.map((surfaceId) => ({ surfaceId })),
        });
      }
      return Promise.resolve({});
    });
  }

  it('keeps two connections in one workspace off each other\'s tab', async () => {
    const a = createConnectionScope();
    const b = createConnectionScope();
    const openerA = runInConnectionScope(a, () => getOpenerKey());
    // A opened the only surface in the workspace and pinned it.
    runInConnectionScope(a, () => noteOpenedSurface(WS, 'surf-a'));
    mainWith([{ surfaceId: 'surf-a', openerKey: openerA }]);

    await expect(runInConnectionScope(a, () => resolveDefaultSurface(WS))).resolves.toEqual({
      kind: 'surface',
      surfaceId: 'surf-a',
    });
    // B has opened nothing, and the one live surface is A's: B opens its own
    // rather than taking over the tab A is working in.
    await expect(runInConnectionScope(b, () => resolveDefaultSurface(WS))).resolves.toEqual({
      kind: 'none',
    });
  });

  it('adopts a restored, unclaimed surface for a connection that opened none', async () => {
    mainWith([{ surfaceId: 'surf-restored' }]);
    await expect(resolveDefaultSurface(WS)).resolves.toEqual({
      kind: 'surface',
      surfaceId: 'surf-restored',
    });
  });

  it('keeps a pin whose CDP target has not registered yet', async () => {
    noteOpenedSurface(WS, 'surf-fresh');
    // The control plane knows the surface; no target exists for it yet.
    mainWith([{ surfaceId: 'surf-restored' }], ['surf-restored', 'surf-fresh']);

    await expect(resolveDefaultSurface(WS)).resolves.toEqual({
      kind: 'surface',
      surfaceId: 'surf-fresh',
    });
    expect(getPinnedSurface()).toEqual({ workspaceId: WS, surfaceId: 'surf-fresh' });
  });

  it('clears a pin whose surface is gone, then falls through the order', async () => {
    noteOpenedSurface(WS, 'surf-closed');
    mainWith([{ surfaceId: 'surf-restored' }], ['surf-restored']);

    await expect(resolveDefaultSurface(WS)).resolves.toEqual({
      kind: 'surface',
      surfaceId: 'surf-restored',
    });
    expect(getPinnedSurface()).toBeNull();
  });

  it('refuses when cdp.info is unavailable rather than guessing a surface', async () => {
    clearPinnedSurface();
    mockSendRpc.mockRejectedValue(new Error('pipe closed'));
    await expect(resolveDefaultSurface(WS)).rejects.toThrow('WORKSPACE_SCOPE_UNRESOLVED');
  });

  it('refuses an empty workspace id', async () => {
    await expect(resolveDefaultSurface('')).rejects.toThrow('WORKSPACE_SCOPE_UNRESOLVED');
    expect(mockSendRpc).not.toHaveBeenCalled();
  });
});
