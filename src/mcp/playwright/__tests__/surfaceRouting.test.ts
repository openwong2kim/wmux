import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { CHROME_START_CEILING_MS } from '../../../shared/chromeStart';
import {
  __resetSurfaceRoutingForTesting,
  clearPinnedSurface,
  getOpenerKey,
  getPinnedSurface,
  noteOpenedSurface,
  openSurfaceForConnection,
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
  it('a — the pin wins while its surface is still listed', () => {
    const targets: RoutableTarget[] = [
      { surfaceId: 'surf-new', opener: 'mine' as const },
      { surfaceId: 'surf-pinned', opener: 'mine' as const },
    ];
    expect(
      pickDefaultSurface(targets, WS, { workspaceId: WS, surfaceId: 'surf-pinned' }),
    ).toEqual({ kind: 'surface', surfaceId: 'surf-pinned' });
  });

  it('b — without a pin, my newest surface, not the workspace\'s newest', () => {
    const targets: RoutableTarget[] = [
      { surfaceId: 'surf-mine-old', opener: 'mine' as const },
      { surfaceId: 'surf-mine', opener: 'mine' as const },
      { surfaceId: 'surf-theirs', opener: 'other' as const },
    ];
    expect(pickDefaultSurface(targets, WS, null)).toEqual({
      kind: 'surface',
      surfaceId: 'surf-mine',
    });
  });

  it('c — otherwise the newest surface nobody claims', () => {
    const targets: RoutableTarget[] = [
      { surfaceId: 'surf-restored-old' },
      { surfaceId: 'surf-restored' },
      { surfaceId: 'surf-theirs', opener: 'other' as const },
    ];
    expect(pickDefaultSurface(targets, WS, null)).toEqual({
      kind: 'surface',
      surfaceId: 'surf-restored',
      // Claimed on the way past, so the next connection with nothing of its
      // own does not land on the same tab.
      adopt: true,
    });
  });

  it('d — never another connection\'s surface, even as the only one', () => {
    const targets: RoutableTarget[] = [{ surfaceId: 'surf-theirs', opener: 'other' as const }];
    expect(pickDefaultSurface(targets, WS, null)).toEqual({ kind: 'none' });
  });

  it('reports an unlisted pin instead of silently picking somebody else\'s tab', () => {
    // A surface can exist before its CDP target registers. Dropping the pin on
    // that absence would hand the call to the ownerless tab below at exactly
    // the moment the agent opened its own.
    const targets: RoutableTarget[] = [{ surfaceId: 'surf-restored' }];
    expect(
      pickDefaultSurface(targets, WS, { workspaceId: WS, surfaceId: 'surf-fresh' }),
    ).toEqual({ kind: 'pin-unlisted', surfaceId: 'surf-fresh' });
  });

  it('ignores a pin from another workspace', () => {
    const targets: RoutableTarget[] = [{ surfaceId: 'surf-restored' }];
    expect(
      pickDefaultSurface(targets, WS, { workspaceId: 'ws-other', surfaceId: 'surf-elsewhere' }),
    ).toEqual({ kind: 'surface', surfaceId: 'surf-restored', adopt: true });
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
    // A opened the only surface in the workspace and pinned it. Main answers
    // each caller with a VERDICT about that surface, never with A's key.
    runInConnectionScope(a, () => noteOpenedSurface(WS, 'surf-a'));
    mockSendRpc.mockImplementation((method: string, params?: { openerKey?: string }) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({
          targetsScoped: true,
          workspaceBackend: 'builtin',
          targets: [
            { surfaceId: 'surf-a', opener: params?.openerKey === openerA ? 'mine' : 'other' },
          ],
        });
      }
      if (method === 'browser.tabs') {
        return Promise.resolve({
          ok: true,
          action: 'list',
          tabs: [{ surfaceId: 'surf-a', opener: 'other' }],
        });
      }
      return Promise.resolve({});
    });

    await expect(runInConnectionScope(a, () => resolveDefaultSurface(WS))).resolves.toEqual({
      kind: 'surface',
      surfaceId: 'surf-a',
    });
    // B has opened nothing, and the one live surface is A's: B opens its own
    // rather than taking over the tab A is working in.
    await expect(runInConnectionScope(b, () => resolveDefaultSurface(WS))).resolves.toEqual({
      // The count, not a flag: a refusal can then say what the caller is up
      // against instead of "nothing is open here".
      kind: 'none',
      foreignSurfaces: 1,
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
    // The dead pin is replaced by the adopted surface, not merely dropped.
    expect(getPinnedSurface()).toEqual({ workspaceId: WS, surfaceId: 'surf-restored' });
  });

  it('keeps the pin when the control plane cannot be asked', async () => {
    // A lane that refuses browser.tabs (the commander lane does) answers with
    // an error, not with "gone". Treating that as gone would retire the pin on
    // the first miss and send the connection adopting other agents' tabs.
    noteOpenedSurface(WS, 'surf-fresh');
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({ targetsScoped: true, targets: [{ surfaceId: 'surf-restored' }] });
      }
      return Promise.reject(new Error('COMMANDER_TEARDOWN_DENY: browser.tabs'));
    });

    await expect(resolveDefaultSurface(WS)).resolves.toEqual({
      kind: 'surface',
      surfaceId: 'surf-fresh',
    });
    expect(getPinnedSurface()).toEqual({ workspaceId: WS, surfaceId: 'surf-fresh' });
  });

  it('records the adoption of an unclaimed surface, and pins it', async () => {
    mainWith([{ surfaceId: 'surf-restored' }]);

    await resolveDefaultSurface(WS);

    expect(getPinnedSurface()).toEqual({ workspaceId: WS, surfaceId: 'surf-restored' });
    expect(mockSendRpc).toHaveBeenCalledWith('browser.surface.adopt', {
      workspaceId: WS,
      surfaceId: 'surf-restored',
      openerKey: expect.any(String),
    });
  });

  it('the calls that may start wmux\'s own Chrome wait out its cold start, not the 10 s default', async () => {
    let created = false;
    mockSendRpc.mockImplementation((method: string, params?: { action?: string }) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({ targetsScoped: true, workspaceBackend: 'chrome', targets: created ? [{ surfaceId: 'surf-new' }] : [] });
      }
      if (method === 'browser.tabs' && params?.action === 'list') return Promise.resolve({ ok: true, action: 'list', tabs: [] });
      if (method === 'browser.tabs' && params?.action === 'new') {
        created = true;
        return Promise.resolve({ ok: true, action: 'new', tab: { surfaceId: 'surf-new' } });
      }
      return Promise.resolve({ ok: true });
    });

    // The first contact (a default target) and the open of a new one.
    await resolveDefaultSurface(WS);
    const first = mockSendRpc.mock.calls[0] as unknown[];
    expect(first[0]).toBe('browser.cdp.info');
    expect(first[2]).toBeGreaterThan(CHROME_START_CEILING_MS);
    await expect(openSurfaceForConnection(WS)).resolves.toBe('surf-new');
    const opened = mockSendRpc.mock.calls.find((c) => c[0] === 'browser.tabs' && (c[1] as { action?: string }).action === 'new') as unknown[] | undefined;
    expect(opened?.[2]).toBeGreaterThan(CHROME_START_CEILING_MS);

    // A main without `browser.tabs new`: the browser.open fallback waits as long.
    mockSendRpc.mockReset();
    mockSendRpc.mockImplementation((method: string, params?: { action?: string }) => {
      if (method === 'browser.tabs' && params?.action === 'new') return Promise.reject(new Error('Unknown method: browser.tabs'));
      if (method === 'browser.open') return Promise.resolve({ surfaceId: 'surf-open' });
      return Promise.resolve({ ok: true });
    });
    await expect(openSurfaceForConnection(WS)).resolves.toBe('surf-open');
    const fallback = mockSendRpc.mock.calls.find((c) => c[0] === 'browser.open') as unknown[] | undefined;
    expect(fallback?.[2]).toBeGreaterThan(CHROME_START_CEILING_MS);
  });

  it('adopts a pane whose guest has not registered a target yet', async () => {
    // A browser pane a person opened seconds ago is invisible to cdp.info.
    // Splitting a second pane beside it is a worse answer than taking it.
    mockSendRpc.mockImplementation((method: string, params?: { action?: string }) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({ targetsScoped: true, workspaceBackend: 'builtin', targets: [] });
      }
      if (method === 'browser.tabs' && params?.action === 'list') {
        return Promise.resolve({ ok: true, action: 'list', tabs: [{ surfaceId: 'surf-human' }] });
      }
      return Promise.resolve({ ok: true });
    });

    await expect(resolveDefaultSurface(WS)).resolves.toEqual({
      kind: 'surface',
      surfaceId: 'surf-human',
    });
    expect(mockSendRpc).toHaveBeenCalledWith('browser.surface.adopt', expect.objectContaining({
      surfaceId: 'surf-human',
    }));
  });

  it('never sweeps the pane list on a live-Chrome attach', async () => {
    // There the list is every tab the PERSON has open, and adopting one as an
    // agent's default is what that backend exists to avoid.
    mockSendRpc.mockImplementation((method: string) =>
      method === 'browser.cdp.info'
        ? Promise.resolve({ targetsScoped: true, workspaceBackend: 'chrome', targets: [] })
        : Promise.resolve({ ok: true, action: 'list', tabs: [{ surfaceId: 'user-tab' }] }),
    );

    await expect(resolveDefaultSurface(WS)).resolves.toEqual({ kind: 'none', foreignSurfaces: 0 });
    expect(mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.tabs')).toHaveLength(0);
  });

  it('treats an answered open as done, even when it names no surface', async () => {
    // The external backend hands the url to the OS browser and holds no
    // handle: `{ok:true}` with no tab. Retrying through browser.open there
    // would open the page a SECOND time.
    mockSendRpc.mockImplementation((method: string, params?: { action?: string }) => {
      if (method === 'browser.tabs' && params?.action === 'new') {
        return Promise.resolve({ ok: true, action: 'new', backend: 'external', opened: true, url: 'https://a.test/' });
      }
      return Promise.resolve({});
    });

    await expect(openSurfaceForConnection(WS)).resolves.toBeNull();
    expect(mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.open')).toHaveLength(0);
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

/*
 * #1328 — the readiness wait's three verdicts.
 *
 * The wait used to end silently on timeout, so a surface that was ANSWERED and
 * never existed was pinned and handed to the call anyway. Failing on a timeout
 * alone would be worse: a builtin pane registers its guest a moment after it is
 * created, and a slow one is not a missing one. So the timeout asks the control
 * plane, and only the two answers together convict.
 */
describe('waiting for a freshly opened surface', () => {
  /**
   * A main whose `browser.tabs new` answers `surf-new`, and which then reports
   * the three sources the verdict reads: CDP targets, the visible pane tree
   * (`browser.tabs list`), and what the workspace OWNS including stashed panes
   * (`surface.list`). `owns` defaults to the agent's own terminal alone, which
   * is the "this surface does not exist" answer.
   */
  function mainAnswering(listed: {
    cdp: string[];
    tabs: string[] | 'unreadable';
    owns?: string[] | 'unreadable';
  }) {
    mockSendRpc.mockImplementation((method: string, params: { action?: string } = {}) => {
      if (method === 'browser.cdp.info') {
        return Promise.resolve({
          targetsScoped: true,
          workspaceBackend: 'builtin',
          targets: listed.cdp.map((surfaceId) => ({ surfaceId })),
        });
      }
      if (method === 'browser.tabs' && params.action === 'new') {
        return Promise.resolve({ ok: true, action: 'new', tab: { surfaceId: 'surf-new' } });
      }
      if (method === 'browser.tabs' && params.action === 'list') {
        return listed.tabs === 'unreadable'
          ? Promise.reject(new Error('method denied'))
          : Promise.resolve({
              ok: true,
              action: 'list',
              tabs: listed.tabs.map((surfaceId) => ({ surfaceId })),
            });
      }
      if (method === 'surface.list') {
        const owns = listed.owns ?? [];
        return owns === 'unreadable'
          ? Promise.reject(new Error('method denied'))
          : Promise.resolve([{ id: 'surf-agent-terminal' }, ...owns.map((id) => ({ id }))]);
      }
      return Promise.resolve({ ok: true });
    });
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /**
   * Advance past the readiness deadline while the open is in flight.
   *
   * The outcome is captured rather than re-thrown from a derived promise: a
   * rejection parked until the loop ends is an unhandled rejection to node,
   * and vitest fails the run on it.
   */
  async function settle<T>(call: Promise<T>): Promise<T> {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    void call.then(
      (value) => { outcome = { ok: true, value }; },
      (error) => { outcome = { ok: false, error }; },
    );
    for (let i = 0; i < 300 && !outcome; i++) await vi.advanceTimersByTimeAsync(100);
    if (!outcome) throw new Error('the call never settled');
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }

  it('refuses, and drops the pin, when neither lane has ever heard of it', async () => {
    mainAnswering({ cdp: [], tabs: [] });

    await expect(
      settle(openSurfaceForConnection(WS, { awaitReady: true })),
    ).rejects.toThrow('BROWSER_SURFACE_NOT_REGISTERED');
    // Left in place it would aim every later unsaid call of this connection at
    // a surface that does not exist.
    expect(getPinnedSurface()).toBeNull();
  });

  it('keeps a surface the pane list knows — a late guest is not a missing one', async () => {
    mainAnswering({ cdp: [], tabs: ['surf-new'] });

    await expect(settle(openSurfaceForConnection(WS, { awaitReady: true }))).resolves.toBe(
      'surf-new',
    );
    expect(getPinnedSurface()).toEqual({ workspaceId: WS, surfaceId: 'surf-new' });
  });

  it('keeps a surface it could not ask about', async () => {
    // The commander lane refuses `browser.tabs` outright. "Cannot check" must
    // never read as "never existed".
    mainAnswering({ cdp: [], tabs: 'unreadable' });

    await expect(settle(openSurfaceForConnection(WS, { awaitReady: true }))).resolves.toBe(
      'surf-new',
    );
  });

  it('keeps a surface the workspace owns but has stashed out of the visible tree', async () => {
    // `browser.tabs list` walks the VISIBLE tree, so a stashed pane is missing
    // from it and from the CDP targets alike. It still exists.
    mainAnswering({ cdp: [], tabs: [], owns: ['surf-new'] });

    await expect(settle(openSurfaceForConnection(WS, { awaitReady: true }))).resolves.toBe(
      'surf-new',
    );
    expect(getPinnedSurface()).toEqual({ workspaceId: WS, surfaceId: 'surf-new' });
  });

  it('keeps a surface whose ownership could not be established', async () => {
    mainAnswering({ cdp: [], tabs: [], owns: 'unreadable' });

    await expect(settle(openSurfaceForConnection(WS, { awaitReady: true }))).resolves.toBe(
      'surf-new',
    );
  });

  it('bounds every conviction probe, so a wedged main cannot stretch the refusal', async () => {
    // The default sendRpc budget is 10s per attempt, three attempts, plus the
    // pipe-path loop and the TCP fallback — half a minute added to a call the
    // agent is blocked on, on exactly the main state that produces a phantom.
    mainAnswering({ cdp: [], tabs: [] });

    await expect(
      settle(openSurfaceForConnection(WS, { awaitReady: true })),
    ).rejects.toThrow('BROWSER_SURFACE_NOT_REGISTERED');

    const probes = mockSendRpc.mock.calls.filter(
      (c) => (c[0] === 'browser.tabs' && c[1]?.action === 'list') || c[0] === 'surface.list',
    );
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(probe[2]).toBe(2_000);
  });

  it('returns as soon as the target registers, without asking the pane list', async () => {
    mainAnswering({ cdp: ['surf-new'], tabs: [] });

    await expect(settle(openSurfaceForConnection(WS, { awaitReady: true }))).resolves.toBe(
      'surf-new',
    );
    expect(
      mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.tabs' && c[1]?.action === 'list'),
    ).toHaveLength(0);
  });
});
