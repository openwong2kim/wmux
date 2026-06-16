import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerPaneRpc } from '../pane.rpc';
import { PANE_METADATA_MAX_BYTES } from '../../../../shared/types';
import { EventBus } from '../../../events/EventBus';
import { MetadataStore } from '../../../metadata/MetadataStore';

const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

function register(): RpcRouter {
  const router = new RpcRouter();
  registerPaneRpc(router, (() => null) as () => BrowserWindow | null);
  return router;
}

/**
 * Setup helper for M0-b metadata tests. Injects a fresh MetadataStore so
 * each test gets a clean slate without poking the module-level singleton.
 */
function setupWithStore(): { router: RpcRouter; store: MetadataStore } {
  const win = {} as BrowserWindow;
  const router = new RpcRouter();
  const store = new MetadataStore({ eventBus: new EventBus() });
  registerPaneRpc(router, () => win, { store });
  return { router, store };
}

describe('pane.rpc — search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendToRendererMock.mockResolvedValue({
      resultShapeVersion: 1,
      results: [],
      truncated: false,
      totalMatches: 0,
      workspaceId: 'ws-1',
    });
  });

  it('forwards a valid query to the renderer', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '1',
      method: 'pane.search',
      params: { query: 'foo' },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledTimes(1);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'pane.search',
      { query: 'foo' },
    );
  });

  it('forwards the regex flag when provided as a boolean', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '2',
      method: 'pane.search',
      params: { query: 'foo', regex: true },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'pane.search',
      { query: 'foo', regex: true },
    );
  });

  it('omits regex from forwarded payload when caller did not provide it', async () => {
    const router = register();
    await router.dispatch({
      id: '3',
      method: 'pane.search',
      params: { query: 'foo' },
    });

    const forwardedPayload = sendToRendererMock.mock.calls[0][2] as Record<string, unknown>;
    expect(forwardedPayload).toEqual({ query: 'foo' });
    expect('regex' in forwardedPayload).toBe(false);
  });

  it('forwards regex: false explicitly when caller provided it', async () => {
    const router = register();
    await router.dispatch({
      id: '4',
      method: 'pane.search',
      params: { query: 'foo', regex: false },
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'pane.search',
      { query: 'foo', regex: false },
    );
  });

  it('rejects an empty query', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '5',
      method: 'pane.search',
      params: { query: '' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatch(/non-empty/);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('rejects a missing query (params has no `query` key)', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '6',
      method: 'pane.search',
      params: {},
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatch(/string/);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('rejects a non-string query', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '7',
      method: 'pane.search',
      params: { query: 42 as unknown as string },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatch(/string/);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean regex flag (e.g. string "true")', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '8',
      method: 'pane.search',
      params: { query: 'x', regex: 'true' as unknown as boolean },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatch(/boolean/);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  // C1 — workspaceId forwarding. The main handler must thread the caller's
  // workspaceId through so the renderer scopes the search to that workspace
  // (not whichever the user happens to be viewing).
  it('forwards workspaceId when caller provides it (C1)', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '10',
      method: 'pane.search',
      params: { query: 'foo', workspaceId: 'ws-caller' },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'pane.search',
      { query: 'foo', workspaceId: 'ws-caller' },
    );
  });

  it('forwards workspaceId together with regex when both are provided (C1)', async () => {
    const router = register();
    await router.dispatch({
      id: '11',
      method: 'pane.search',
      params: { query: 'foo', regex: true, workspaceId: 'ws-caller' },
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'pane.search',
      { query: 'foo', regex: true, workspaceId: 'ws-caller' },
    );
  });

  it('omits workspaceId from forwarded payload when caller did not provide it (C1)', async () => {
    const router = register();
    await router.dispatch({
      id: '12',
      method: 'pane.search',
      params: { query: 'foo' },
    });

    const forwardedPayload = sendToRendererMock.mock.calls[0][2] as Record<string, unknown>;
    expect('workspaceId' in forwardedPayload).toBe(false);
  });

  it('rejects a non-string workspaceId (C1)', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '13',
      method: 'pane.search',
      params: { query: 'foo', workspaceId: 42 as unknown as string },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatch(/string/);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('returns the renderer response payload to the caller', async () => {
    const router = register();
    const fakeResponse = {
      resultShapeVersion: 1,
      results: [
        {
          paneId: 'p1',
          surfaceId: 's1',
          ptyId: 'pty1',
          lineIdx: 5,
          physicalBaseY: 5,
          text: 'matched line',
          contextBefore: [],
          contextAfter: [],
        },
      ],
      truncated: false,
      totalMatches: 1,
      workspaceId: 'ws-1',
    };
    sendToRendererMock.mockResolvedValueOnce(fakeResponse);

    const response = await router.dispatch({
      id: '9',
      method: 'pane.search',
      params: { query: 'matched' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual(fakeResponse);
    }
  });
});

const fakeWindow = {} as BrowserWindow;

function setupRouter(): RpcRouter {
  const router = new RpcRouter();
  registerPaneRpc(router, () => fakeWindow);
  return router;
}

describe('pane.rpc — metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // M0-d follow-up (codex P1): resolveTarget now routes paneId-present
    // calls through `pane.validateWorkspace` so an MCP scoped to one
    // workspace can't read/write metadata on a pane in another workspace.
    // Default the mock to echo back the caller's paneId+workspaceId as if
    // the renderer confirmed membership; tests that want to exercise the
    // rejection path override with `mockResolvedValueOnce({ error: ... })`.
    sendToRendererMock.mockImplementation(
      (_getWin: unknown, method: string, params: Record<string, unknown>) => {
        if (method === 'pane.validateWorkspace') {
          return Promise.resolve({
            paneId: typeof params['paneId'] === 'string' ? params['paneId'] : '',
            workspaceId: typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined,
          });
        }
        // After alphabeen review #4 fix: validation moved entirely into
        // MetadataStore, so a "bad payload" test reaches resolveTarget
        // first. Provide a default active-leaf so the resolve succeeds
        // and the rejection bubbles up from store.sanitize(). Tests that
        // need a specific resolver response override per-call with
        // `sendToRendererMock.mockResolvedValueOnce(...)`.
        if (method === 'pane.resolveActiveLeaf') {
          return Promise.resolve({
            paneId: '__test_active_leaf__',
            workspaceId:
              typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined,
          });
        }
        return Promise.resolve({ ok: true });
      },
    );
  });

  describe('pane.setMetadata', () => {
    // === M0-b: paneId-present path writes to MetadataStore directly ===

    it('writes a sanitized patch to MetadataStore with merge=true by default (paneId path)', async () => {
      const { router, store } = setupWithStore();
      const res = await router.dispatch({
        id: 'rpc-1',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', label: 'Backend', role: 'service' },
      });

      expect(res.ok).toBe(true);
      // M0-d follow-up (codex P1): paneId-present writes now round-trip
      // through `pane.validateWorkspace` to verify workspace membership.
      // The store write itself still happens in main — sendToRenderer is
      // ONLY called for the validation IPC, never for the actual mutation.
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);
      expect(sendToRendererMock.mock.calls[0][1]).toBe('pane.validateWorkspace');
      // The store committed the sanitized patch.
      const entry = store.get('pane-x');
      expect(entry.version).toBe(1);
      expect(entry.metadata.label).toBe('Backend');
      expect(entry.metadata.role).toBe('service');
    });

    it('honors merge=false (mergeMode=replace) when caller passes it (paneId path)', async () => {
      const { router, store } = setupWithStore();
      // Seed with prior metadata so 'replace' has something to discard.
      store.set('pane-x', { label: 'Old', role: 'svc' }, { workspaceId: 'ws-1' });

      await router.dispatch({
        id: 'rpc-2',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', status: 'idle', merge: false },
      });

      const entry = store.get('pane-x');
      // 'replace' wipes label/role and only status survives.
      expect(entry.metadata.label).toBeUndefined();
      expect(entry.metadata.role).toBeUndefined();
      expect(entry.metadata.status).toBe('idle');
      // M0-d follow-up (codex P1): only the validateWorkspace IPC is
      // called; the actual replace lands in MetadataStore.
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);
      expect(sendToRendererMock.mock.calls[0][1]).toBe('pane.validateWorkspace');
    });

    it('reply carries v2.x-compatible keys plus the M0-f `version` field', async () => {
      const { router } = setupWithStore();
      const res = await router.dispatch({
        id: 'rpc-shape',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', label: 'X' },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const result = res.result as { ok: boolean; paneId: string; metadata: unknown; version: number };
        expect(result.ok).toBe(true);
        expect(result.paneId).toBe('pane-x');
        expect(result.metadata).toBeDefined();
        // M0-f: version is now part of the wire shape (additive — v2.8.x
        // clients reading { ok, paneId, metadata } still work).
        expect(result.version).toBe(1);
      }
    });

    it('subsequent setMetadata writes bump version monotonically (paneId path)', async () => {
      const { router, store } = setupWithStore();
      await router.dispatch({
        id: 'v1', method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', label: 'A' },
      });
      await router.dispatch({
        id: 'v2', method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', status: 'running' },
      });
      const entry = store.get('pane-x');
      expect(entry.version).toBe(2);
      expect(entry.metadata.label).toBe('A');
      expect(entry.metadata.status).toBe('running');
    });

    it('rejects with a descriptive error when the merged shape blows the byte cap', async () => {
      const { router } = setupWithStore();
      const huge = 'x'.repeat(PANE_METADATA_MAX_BYTES);
      const res = await router.dispatch({
        id: 'rpc-cap',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', custom: { blob: huge } },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/exceeds/);
    });

    // === Legacy fallback: paneId omitted → renderer resolves active leaf ===

    it('rejects when label exceeds 64 chars', async () => {
      const router = setupRouter();
      const longLabel = 'a'.repeat(65);
      const res = await router.dispatch({
        id: 'rpc-3',
        method: 'pane.setMetadata',
        params: { label: longLabel },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/label/);
      }
      // alphabeen review #4: validation now lives in MetadataStore.set, so
      // resolveTarget (which IPCs into the renderer) runs BEFORE the
      // rejection. The substrate invariant is "store is the sole validator",
      // not "no IPC happens on a bad payload" — that property never had a
      // contract behind it anyway.
    });

    it('rejects when status exceeds 128 chars', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-4',
        method: 'pane.setMetadata',
        params: { status: 's'.repeat(129) },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/status/);
    });

    it('rejects non-string values inside custom map', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-5',
        method: 'pane.setMetadata',
        params: { custom: { count: 42 } as unknown as Record<string, string> },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/custom\.count/);
    });

    it('rejects when custom is an array, not an object', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-6',
        method: 'pane.setMetadata',
        params: { custom: ['nope'] as unknown as Record<string, string> },
      });

      expect(res.ok).toBe(false);
    });

    it('rejects oversized payload over 8KB cap', async () => {
      const router = setupRouter();
      const huge = 'x'.repeat(PANE_METADATA_MAX_BYTES + 50);
      const res = await router.dispatch({
        id: 'rpc-7',
        method: 'pane.setMetadata',
        params: { custom: { blob: huge } },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/exceeds/);
    });

    it('resolves active leaf via pane.resolveActiveLeaf IPC when paneId is omitted', async () => {
      // M0-b: paneId-absent path asks the renderer for the active leaf id
      // (read-only — no paneSlice write) and then commits the metadata
      // through MetadataStore. Codex P1 regression guard: a write here is
      // visible to a subsequent paneId-present read.
      const { router, store } = setupWithStore();
      sendToRendererMock.mockResolvedValueOnce({
        paneId: 'pane-active',
        workspaceId: 'ws-active',
      });
      const res = await router.dispatch({
        id: 'rpc-8',
        method: 'pane.setMetadata',
        params: { label: 'Active' },
      });
      expect(res.ok).toBe(true);
      // sendToRenderer was called for the resolve, not for a write.
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);
      const [, method, payload] = sendToRendererMock.mock.calls[0];
      expect(method).toBe('pane.resolveActiveLeaf');
      expect(payload).toEqual({ workspaceId: undefined });
      // MetadataStore committed under the resolved paneId.
      const entry = store.get('pane-active');
      expect(entry.version).toBe(1);
      expect(entry.metadata.label).toBe('Active');
    });

    // === Codex P1 regression: read-after-write across paneId modes ===

    it('paneId-absent write then paneId-present read returns the committed metadata (P1 fix)', async () => {
      const { router, store } = setupWithStore();
      sendToRendererMock.mockResolvedValueOnce({
        paneId: 'pane-resolved',
        workspaceId: 'ws-1',
      });
      // Step 1: paneId-absent write — resolver returns pane-resolved.
      await router.dispatch({
        id: 'step1',
        method: 'pane.setMetadata',
        params: { label: 'WritesThrough' },
      });
      // Step 2: paneId-present read — must see the write.
      const res = await router.dispatch({
        id: 'step2',
        method: 'pane.getMetadata',
        params: { paneId: 'pane-resolved' },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const result = res.result as { paneId: string; metadata: { label?: string } };
        expect(result.paneId).toBe('pane-resolved');
        expect(result.metadata.label).toBe('WritesThrough');
      }
      // Store reflects the same.
      expect(store.get('pane-resolved').metadata.label).toBe('WritesThrough');
    });

    // === Codex P2 regression: workspaceId remembered across paneId-only writes ===

    it('remembers workspaceId across writes — later paneId-only call still emits scoped event (P2 fix)', async () => {
      const { router, store } = setupWithStore();
      // First write establishes workspaceId on the entry.
      await router.dispatch({
        id: 'first',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-1', workspaceId: 'ws-A', label: 'one' },
      });
      // Second write omits workspaceId — must NOT erase the remembered scope.
      await router.dispatch({
        id: 'second',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-1', status: 'running' },
      });
      // Snapshot still has the original workspaceId tag.
      const snap = store.snapshot();
      const entry = snap.entries.find((e) => e.paneId === 'pane-1');
      expect(entry?.workspaceId).toBe('ws-A');
    });
  });

  describe('pane.getMetadata', () => {
    it('reads from MetadataStore when paneId is provided (only the validateWorkspace IPC fires)', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-x', { label: 'Backend' }, { workspaceId: 'ws-1' });

      const res = await router.dispatch({
        id: 'rpc-9',
        method: 'pane.getMetadata',
        params: { paneId: 'pane-x' },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        // M0-f wire-format reply: { paneId, metadata, version }.
        expect(res.result).toEqual({
          paneId: 'pane-x',
          metadata: expect.objectContaining({ label: 'Backend' }),
          version: 1,
        });
      }
      // M0-d follow-up (codex P1): paneId-present reads validate workspace
      // membership via the renderer. The actual read still hits the store
      // directly; sendToRenderer is only called for that validation.
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);
      expect(sendToRendererMock.mock.calls[0][1]).toBe('pane.validateWorkspace');
    });

    it('reply includes the M0-f `version` field alongside paneId+metadata', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-x', { label: 'Y' }, { workspaceId: 'ws-1' });
      const res = await router.dispatch({
        id: 'rpc-9b',
        method: 'pane.getMetadata',
        params: { paneId: 'pane-x' },
      });
      if (res.ok) {
        const result = res.result as { paneId: string; metadata: unknown; version: number };
        // M0-f: getMetadata now returns the monotonic version. The store
        // seed above is the only write, so version === 1.
        expect(result.version).toBe(1);
      }
    });

    it('returns empty metadata for a pane that has never been written', async () => {
      const { router } = setupWithStore();
      const res = await router.dispatch({
        id: 'rpc-9c',
        method: 'pane.getMetadata',
        params: { paneId: 'pane-unknown' },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        // M0-f wire-format reply: { paneId, metadata, version }. Never-written
        // panes get version 0 (the "no entry" sentinel from MetadataStore.get).
        expect(res.result).toEqual({ paneId: 'pane-unknown', metadata: {}, version: 0 });
      }
    });

    it('resolves active leaf via pane.resolveActiveLeaf IPC when paneId is omitted', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-active', { label: 'Hello' }, { workspaceId: 'ws-1' });
      sendToRendererMock.mockResolvedValueOnce({
        paneId: 'pane-active',
        workspaceId: 'ws-1',
      });
      const res = await router.dispatch({
        id: 'rpc-10',
        method: 'pane.getMetadata',
        params: {},
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        // M0-f wire-format reply: { paneId, metadata, version }.
        expect(res.result).toEqual({
          paneId: 'pane-active',
          metadata: expect.objectContaining({ label: 'Hello' }),
          version: 1,
        });
      }
      const [, method] = sendToRendererMock.mock.calls[0];
      expect(method).toBe('pane.resolveActiveLeaf');
    });
  });

  describe('pane.clearMetadata', () => {
    it('clears via MetadataStore when paneId is provided (only the validateWorkspace IPC fires)', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-x', { label: 'Backend' }, { workspaceId: 'ws-1' });

      const res = await router.dispatch({
        id: 'rpc-11',
        method: 'pane.clearMetadata',
        params: { paneId: 'pane-x' },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        // M0-f wire-format reply: { ok, paneId, version }. Version is the
        // post-clear monotonic counter (bumped from 1 → 2).
        expect(res.result).toEqual({ ok: true, paneId: 'pane-x', version: 2 });
      }
      // Store entry is cleared but version stays monotonic (clear bumped to v2).
      const after = store.get('pane-x');
      expect(after.version).toBe(2);
      expect(after.metadata).toEqual({});
      // M0-d follow-up (codex P1): paneId-present clears validate workspace
      // membership via the renderer before MetadataStore performs the clear.
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);
      expect(sendToRendererMock.mock.calls[0][1]).toBe('pane.validateWorkspace');
    });

    it('resolves active leaf via pane.resolveActiveLeaf IPC when paneId is omitted', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-active', { label: 'X' }, { workspaceId: 'ws-1' });
      sendToRendererMock.mockResolvedValueOnce({
        paneId: 'pane-active',
        workspaceId: 'ws-1',
      });
      const res = await router.dispatch({
        id: 'rpc-11b',
        method: 'pane.clearMetadata',
        params: {},
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        // M0-f wire-format reply: { ok, paneId, version }. Store had
        // version 1 from the seed set, clear bumped to 2.
        expect(res.result).toEqual({ ok: true, paneId: 'pane-active', version: 2 });
      }
      // Metadata cleared via MetadataStore, not via renderer paneSlice.
      expect(store.get('pane-active').metadata).toEqual({});
      const [, method] = sendToRendererMock.mock.calls[0];
      expect(method).toBe('pane.resolveActiveLeaf');
    });
  });

  describe('review fixes', () => {
    it('1.1 — workspaceId scopes the MetadataStore write (M0-b paneId path)', async () => {
      const { router, store } = setupWithStore();
      await router.dispatch({
        id: 'rpc-fix-1',
        method: 'pane.setMetadata',
        params: { workspaceId: 'ws-caller', paneId: 'pane-y', label: 'X' },
      });
      // The store remembers the workspaceId on the entry so subsequent
      // events emit with the right scope.
      const entry = store.get('pane-y');
      expect(entry.metadata.label).toBe('X');
      // M0-d follow-up (codex P1): the only sendToRenderer call is the
      // validateWorkspace round-trip — the workspace+pane pair gets
      // confirmed by the renderer before MetadataStore commits.
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);
      expect(sendToRendererMock.mock.calls[0][1]).toBe('pane.validateWorkspace');
      expect(sendToRendererMock.mock.calls[0][2]).toEqual({
        paneId: 'pane-y',
        workspaceId: 'ws-caller',
      });
    });

    it('1.1 — forwards workspaceId on resolveActiveLeaf for getMetadata + clearMetadata', async () => {
      const { router } = setupWithStore();
      sendToRendererMock.mockResolvedValue({
        paneId: 'pane-caller-active',
        workspaceId: 'ws-caller',
      });
      await router.dispatch({
        id: 'rpc-fix-2',
        method: 'pane.getMetadata',
        params: { workspaceId: 'ws-caller' },
      });
      await router.dispatch({
        id: 'rpc-fix-3',
        method: 'pane.clearMetadata',
        params: { workspaceId: 'ws-caller' },
      });
      const getCall = sendToRendererMock.mock.calls[0];
      const clearCall = sendToRendererMock.mock.calls[1];
      // Both round-trip to the renderer for active-leaf resolution scoped to
      // the caller's workspace, then MetadataStore handles the read/clear.
      expect(getCall[1]).toBe('pane.resolveActiveLeaf');
      expect(getCall[2]).toEqual({ workspaceId: 'ws-caller' });
      expect(clearCall[1]).toBe('pane.resolveActiveLeaf');
      expect(clearCall[2]).toEqual({ workspaceId: 'ws-caller' });
    });

    it('1.2 — rejects role exceeding 64 chars', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-fix-4',
        method: 'pane.setMetadata',
        params: { role: 'r'.repeat(65) },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/role/);
    });

    it('1.3 — rejects empty custom key', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-fix-5',
        method: 'pane.setMetadata',
        params: { custom: { '': 'value' } },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/empty/);
    });

    it('1.3 — rejects custom key exceeding 64 chars', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-fix-6',
        method: 'pane.setMetadata',
        params: { custom: { ['k'.repeat(65)]: 'value' } },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/key exceeds/);
    });

    it('1.3 — rejects custom maps with > 32 entries', async () => {
      const router = setupRouter();
      const custom: Record<string, string> = {};
      for (let i = 0; i < 33; i++) custom[`k${i}`] = 'v';
      const res = await router.dispatch({
        id: 'rpc-fix-7',
        method: 'pane.setMetadata',
        params: { custom },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/32 entries/);
    });

    it('1.3 — accepts custom map at exactly the entry limit', async () => {
      const { router } = setupWithStore();
      const custom: Record<string, string> = {};
      for (let i = 0; i < 32; i++) custom[`k${i}`] = 'v';
      const res = await router.dispatch({
        id: 'rpc-fix-8',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-z', workspaceId: 'ws-1', custom },
      });
      expect(res.ok).toBe(true);
    });
  });

  describe('pane.list snapshot wrapper (review fix 2b + 5a)', () => {
    it('wraps the renderer response with asOfSeq + bootId', async () => {
      sendToRendererMock.mockResolvedValueOnce([
        { id: 'p1', surfaceCount: 1, active: true },
      ]);

      const router = setupRouter();
      const res = await router.dispatch({ id: 'rpc-list-1', method: 'pane.list', params: {} });

      expect(res.ok).toBe(true);
      if (res.ok) {
        const result = res.result as { asOfSeq: number; bootId: string; panes: unknown[] };
        expect(typeof result.asOfSeq).toBe('number');
        expect(typeof result.bootId).toBe('string');
        expect(result.bootId.length).toBeGreaterThan(0);
        expect(result.panes).toHaveLength(1);
      }
    });

    it('forwards workspaceId param to the renderer', async () => {
      sendToRendererMock.mockResolvedValueOnce([]);
      const router = setupRouter();
      await router.dispatch({
        id: 'rpc-list-2',
        method: 'pane.list',
        params: { workspaceId: 'ws-target' },
      });
      const [, method, payload] = sendToRendererMock.mock.calls[0];
      expect(method).toBe('pane.list');
      expect(payload).toMatchObject({ workspaceId: 'ws-target' });
    });

    // === M0-c: MetadataStore snapshot inject into pane.list panes[] ===

    it('panes carry metadata + version joined from MetadataStore (M0-c)', async () => {
      const { router, store } = setupWithStore();
      // Seed the store with metadata for pane-meta.
      const setResult = store.set(
        'pane-meta',
        { label: 'Backend', role: 'service' },
        { workspaceId: 'ws-1' },
      );
      expect(setResult.ok).toBe(true);

      // Renderer returns the pane tree; metadata is injected by the handler.
      sendToRendererMock.mockResolvedValueOnce([
        { id: 'pane-meta', surfaceCount: 1, active: true },
      ]);

      const res = await router.dispatch({
        id: 'rpc-list-m0c-1',
        method: 'pane.list',
        params: { workspaceId: 'ws-1' },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        const result = res.result as {
          asOfSeq: number;
          bootId: string;
          panes: Array<{
            id: string;
            metadata: { label?: string; role?: string };
            version: number;
          }>;
        };
        expect(result.panes).toHaveLength(1);
        const pane = result.panes[0];
        const stored = store.get('pane-meta');
        expect(pane.version).toBe(stored.version);
        expect(pane.metadata.label).toBe(stored.metadata.label);
        expect(pane.metadata.role).toBe(stored.metadata.role);
      }
    });

    it('panes without a store entry get metadata: {} and version: 0 (M0-c)', async () => {
      const { router } = setupWithStore();
      sendToRendererMock.mockResolvedValueOnce([
        { id: 'pane-unknown', surfaceCount: 1, active: true },
      ]);

      const res = await router.dispatch({
        id: 'rpc-list-m0c-2',
        method: 'pane.list',
        params: {},
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        const result = res.result as {
          panes: Array<{ id: string; metadata: Record<string, unknown>; version: number }>;
        };
        expect(result.panes).toHaveLength(1);
        expect(result.panes[0].id).toBe('pane-unknown');
        expect(result.panes[0].metadata).toEqual({});
        expect(result.panes[0].version).toBe(0);
      }
    });

    // Codex P2: until M0-e wires SessionManager hydration, restored panes
    // only carry their saved metadata on the renderer's PaneLeaf.metadata.
    // The join must fall back to it rather than overwriting with {}.
    it('falls back to renderer-provided metadata when the store has no entry (codex P2)', async () => {
      const { router } = setupWithStore();
      sendToRendererMock.mockResolvedValueOnce([
        {
          id: 'pane-restored',
          surfaceCount: 1,
          active: true,
          metadata: { label: 'Restored', role: 'svc' },
        },
      ]);

      const res = await router.dispatch({
        id: 'rpc-list-m0c-3',
        method: 'pane.list',
        params: {},
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        const result = res.result as {
          panes: Array<{ id: string; metadata: { label?: string; role?: string }; version: number }>;
        };
        expect(result.panes).toHaveLength(1);
        expect(result.panes[0].metadata.label).toBe('Restored');
        expect(result.panes[0].metadata.role).toBe('svc');
        // No store entry exists yet, so version is still 0.
        expect(result.panes[0].version).toBe(0);
      }
    });
  });

  // === M0-f: wire-format spec for metadata RPCs ===
  //
  // The new fields (mergeMode, expectedVersion) and the `version` reply
  // field are additive. v2.8.x clients keep working — covered by the
  // legacy-fallback test below.
  describe('M0-f wire-format', () => {
    it('pane.setMetadata reply carries the new version on consecutive writes', async () => {
      const { router } = setupWithStore();
      const res1 = await router.dispatch({
        id: 'm0f-v1',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-v', workspaceId: 'ws-1', label: 'A' },
      });
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        const r = res1.result as { version: number };
        expect(r.version).toBe(1);
      }
      // Second set on the same pane bumps version monotonically.
      const res2 = await router.dispatch({
        id: 'm0f-v2',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-v', workspaceId: 'ws-1', status: 'running' },
      });
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        const r = res2.result as { version: number };
        expect(r.version).toBe(2);
      }
    });

    it('pane.getMetadata reply includes the current monotonic version', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-g', { label: 'X' }, { workspaceId: 'ws-1' });
      store.set('pane-g', { status: 'idle' }, { workspaceId: 'ws-1' });
      const res = await router.dispatch({
        id: 'm0f-get',
        method: 'pane.getMetadata',
        params: { paneId: 'pane-g' },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const r = res.result as { paneId: string; version: number };
        expect(r.paneId).toBe('pane-g');
        expect(r.version).toBe(2);
      }
    });

    it('expectedVersion=current passes through; mismatch returns VERSION_CONFLICT', async () => {
      const { router } = setupWithStore();
      // First write — no guard, lands as version 1.
      const w1 = await router.dispatch({
        id: 'm0f-ev1',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-ev', workspaceId: 'ws-1', label: 'one' },
      });
      expect(w1.ok).toBe(true);
      if (w1.ok) {
        expect((w1.result as { version: number }).version).toBe(1);
      }

      // Stale expectedVersion (0) — server rejects, no mutation.
      const conflict = await router.dispatch({
        id: 'm0f-ev2',
        method: 'pane.setMetadata',
        params: {
          paneId: 'pane-ev',
          workspaceId: 'ws-1',
          label: 'two',
          expectedVersion: 0,
        },
      });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) {
        // Error message embeds the current version for retry — see
        // RPC_VERSION_CONFLICT comment in src/shared/rpc.ts.
        expect(conflict.error).toMatch(/VERSION_CONFLICT/);
        expect(conflict.error).toMatch(/currentVersion=1/);
      }

      // Correct expectedVersion (1) — succeeds, version bumps to 2.
      const w2 = await router.dispatch({
        id: 'm0f-ev3',
        method: 'pane.setMetadata',
        params: {
          paneId: 'pane-ev',
          workspaceId: 'ws-1',
          label: 'three',
          expectedVersion: 1,
        },
      });
      expect(w2.ok).toBe(true);
      if (w2.ok) {
        const r = w2.result as { version: number; metadata: { label?: string } };
        expect(r.version).toBe(2);
        expect(r.metadata.label).toBe('three');
      }
    });

    it('mergeMode wins over the legacy merge boolean when both are provided', async () => {
      const { router, store } = setupWithStore();
      // Seed with prior label so `replace` has something to discard.
      store.set('pane-m', { label: 'OLD', role: 'svc' }, { workspaceId: 'ws-1' });

      // Caller passes merge: true (would normally mean merge) AND
      // mergeMode: 'replace'. Per the wire spec, mergeMode wins.
      const res = await router.dispatch({
        id: 'm0f-mm',
        method: 'pane.setMetadata',
        params: {
          paneId: 'pane-m',
          workspaceId: 'ws-1',
          status: 'idle',
          merge: true,
          mergeMode: 'replace',
        },
      });
      expect(res.ok).toBe(true);
      const after = store.get('pane-m');
      // Replace semantics — label/role wiped, only status survives.
      expect(after.metadata.label).toBeUndefined();
      expect(after.metadata.role).toBeUndefined();
      expect(after.metadata.status).toBe('idle');
    });

    it('legacy merge: false still maps to replace mode (v2.8.x regression guard)', async () => {
      const { router, store } = setupWithStore();
      // Seed with prior metadata so `replace` has something to discard.
      store.set('pane-l', { label: 'OLD', role: 'svc' }, { workspaceId: 'ws-1' });

      // v2.8.x client: only `merge: false`, no `mergeMode`. Must still
      // map to 'replace' semantics so existing tooling keeps working.
      const res = await router.dispatch({
        id: 'm0f-legacy',
        method: 'pane.setMetadata',
        params: {
          paneId: 'pane-l',
          workspaceId: 'ws-1',
          status: 'done',
          merge: false,
        },
      });
      expect(res.ok).toBe(true);
      const after = store.get('pane-l');
      expect(after.metadata.label).toBeUndefined();
      expect(after.metadata.role).toBeUndefined();
      expect(after.metadata.status).toBe('done');
    });

    it('mergeMode: "replaceShared" preserves base.custom while replacing shared fields', async () => {
      const { router, store } = setupWithStore();
      // Seed with shared fields + custom that another tool wrote.
      store.set(
        'pane-rs',
        { label: 'OLD', custom: { 'other.key': 'preserve-me' } },
        { workspaceId: 'ws-1' },
      );

      const res = await router.dispatch({
        id: 'm0f-rs',
        method: 'pane.setMetadata',
        params: {
          paneId: 'pane-rs',
          workspaceId: 'ws-1',
          label: 'NEW',
          mergeMode: 'replaceShared',
        },
      });
      expect(res.ok).toBe(true);
      const after = store.get('pane-rs');
      // label updated, but the other tool's custom key survived.
      expect(after.metadata.label).toBe('NEW');
      expect(after.metadata.custom?.['other.key']).toBe('preserve-me');
    });

    // codex P2: an earlier draft of pane.setMetadata silently coerced a
    // wrong-typed expectedVersion (e.g. the string "1" from a CLI/env
    // serialization path) to undefined. That dropped the optimistic-
    // concurrency guard on the floor and turned the call into an
    // unconditional write. The handler now rejects malformed values up
    // front so callers get a clear error instead of a stale-write race.
    it('rejects malformed expectedVersion (codex P2)', async () => {
      const { router, store } = setupWithStore();
      // Seed at version 1 so a "real" guarded write would be valid.
      store.set('pane-mv', { label: 'A' }, { workspaceId: 'ws-1' });

      // String "1" — looks like a version to a sloppy serializer but
      // would silently drop the guard. Must reject.
      const asString = await router.dispatch({
        id: 'mv-str',
        method: 'pane.setMetadata',
        params: {
          paneId: 'pane-mv',
          workspaceId: 'ws-1',
          label: 'B',
          expectedVersion: '1',
        },
      });
      expect(asString.ok).toBe(false);
      if (!asString.ok) {
        expect(asString.error).toMatch(/expectedVersion/);
      }

      // Negative integer — versions are non-negative.
      const asNegative = await router.dispatch({
        id: 'mv-neg',
        method: 'pane.setMetadata',
        params: {
          paneId: 'pane-mv',
          workspaceId: 'ws-1',
          label: 'C',
          expectedVersion: -1,
        },
      });
      expect(asNegative.ok).toBe(false);
      if (!asNegative.ok) {
        expect(asNegative.error).toMatch(/expectedVersion/);
      }

      // Non-integer float — versions are monotonic integers.
      const asFloat = await router.dispatch({
        id: 'mv-float',
        method: 'pane.setMetadata',
        params: {
          paneId: 'pane-mv',
          workspaceId: 'ws-1',
          label: 'D',
          expectedVersion: 1.5,
        },
      });
      expect(asFloat.ok).toBe(false);
      if (!asFloat.ok) {
        expect(asFloat.error).toMatch(/expectedVersion/);
      }

      // None of the rejected calls should have mutated the store —
      // version stays at 1 and label is still "A".
      const after = store.get('pane-mv');
      expect(after.version).toBe(1);
      expect(after.metadata.label).toBe('A');
    });

    // codex P2: same shape for mergeMode. Earlier draft fell back on
    // legacy `merge` boolean when mergeMode was wrong-typed, so
    // `mergeMode: 'foo'` was silently treated as 'merge'. Now: when the
    // field is provided it must be one of the three documented modes.
    // (undefined still falls back to the legacy boolean — that's the
    // v2.8.x compatibility path the legacy-fallback test guards.)
    it('rejects unknown mergeMode strings (codex P2)', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-mm', { label: 'A' }, { workspaceId: 'ws-1' });

      const res = await router.dispatch({
        id: 'mm-bad',
        method: 'pane.setMetadata',
        params: {
          paneId: 'pane-mm',
          workspaceId: 'ws-1',
          label: 'B',
          mergeMode: 'wrongMode',
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/mergeMode/);
      }

      // No mutation — label/version unchanged.
      const after = store.get('pane-mm');
      expect(after.version).toBe(1);
      expect(after.metadata.label).toBe('A');
    });
  });

  // === M0-d follow-up (codex P1) — cross-workspace metadata access ===
  //
  // M0-b moved metadata writes from useRpcBridge into MetadataStore.set()
  // (paneId-keyed). M0-d then removed the now-dead renderer handlers and
  // their workspace membership check. Without the follow-up validation in
  // `resolveTarget`, an MCP scoped to workspace A could pass workspace B's
  // paneId together with its own workspaceId and quietly read/mutate B's
  // metadata. These three guards lock the validation in via the new
  // `pane.validateWorkspace` IPC path.
  describe('cross-workspace access rejected (codex P1)', () => {
    it('setMetadata rejects paneId from a different workspace', async () => {
      const { router, store } = setupWithStore();
      // Renderer rejects the validation — paneId belongs elsewhere.
      sendToRendererMock.mockImplementation(
        (_w: unknown, method: string) => {
          if (method === 'pane.validateWorkspace') {
            return Promise.resolve({
              error: 'pane.validateWorkspace: leaf "b-pane" not in workspace "ws-a"',
            });
          }
          return Promise.resolve({ ok: true });
        },
      );

      const res = await router.dispatch({
        id: 'p1-set',
        method: 'pane.setMetadata',
        params: { paneId: 'b-pane', workspaceId: 'ws-a', label: 'Hijack' },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/not in workspace/);
      }
      // Store untouched — the attacker's payload must not have landed.
      const entry = store.get('b-pane');
      expect(entry.version).toBe(0);
      expect(entry.metadata).toEqual({});
    });

    it('getMetadata rejects paneId from a different workspace', async () => {
      const { router, store } = setupWithStore();
      // Seed legitimate metadata on b-pane under its real workspace —
      // an attacker scoped to ws-a must NOT be able to read it.
      store.set('b-pane', { label: 'Secret' }, { workspaceId: 'ws-b' });

      sendToRendererMock.mockImplementation(
        (_w: unknown, method: string) => {
          if (method === 'pane.validateWorkspace') {
            return Promise.resolve({
              error: 'pane.validateWorkspace: leaf "b-pane" not in workspace "ws-a"',
            });
          }
          return Promise.resolve({ ok: true });
        },
      );

      const res = await router.dispatch({
        id: 'p1-get',
        method: 'pane.getMetadata',
        params: { paneId: 'b-pane', workspaceId: 'ws-a' },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/not in workspace/);
      }
      // The seeded secret is still there — the attacker's read failed
      // BEFORE MetadataStore.get() ran, so no leak.
      expect(store.get('b-pane').metadata.label).toBe('Secret');
    });

    it('clearMetadata rejects paneId from a different workspace', async () => {
      const { router, store } = setupWithStore();
      // Seed metadata on b-pane under its real workspace — an attacker
      // scoped to ws-a must NOT be able to wipe it.
      store.set('b-pane', { label: 'Important' }, { workspaceId: 'ws-b' });

      sendToRendererMock.mockImplementation(
        (_w: unknown, method: string) => {
          if (method === 'pane.validateWorkspace') {
            return Promise.resolve({
              error: 'pane.validateWorkspace: leaf "b-pane" not in workspace "ws-a"',
            });
          }
          return Promise.resolve({ ok: true });
        },
      );

      const res = await router.dispatch({
        id: 'p1-clear',
        method: 'pane.clearMetadata',
        params: { paneId: 'b-pane', workspaceId: 'ws-a' },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/not in workspace/);
      }
      // The seeded metadata survives — clear() was never called.
      const entry = store.get('b-pane');
      expect(entry.metadata.label).toBe('Important');
      expect(entry.version).toBe(1);
    });
  });
});

// === X8: pane.list supervision join ===
describe('pane.rpc — pane.list supervision join (X8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Build a router whose pane.list joins supervision from a fake daemon. */
  function setupWithDaemon(sessions: unknown[] | (() => Promise<unknown>)) {
    const router = new RpcRouter();
    const rpc = vi.fn(async (method: string) => {
      if (method === 'daemon.listSessions') {
        return typeof sessions === 'function' ? sessions() : sessions;
      }
      return [];
    });
    const fakeDaemon = { isConnected: true, rpc } as unknown as import('../../../DaemonClient').DaemonClient;
    registerPaneRpc(router, () => ({} as BrowserWindow), {}, () => fakeDaemon);
    return { router, rpc };
  }

  it('attaches supervision to a pane whose surface ptyId matches a supervised session', async () => {
    sendToRendererMock.mockResolvedValueOnce([
      { id: 'pane-1', surfaceCount: 1, active: true, surfacePtyIds: ['daemon-aaa'] },
      { id: 'pane-2', surfaceCount: 1, active: false, surfacePtyIds: ['daemon-bbb'] },
    ]);
    const { router } = setupWithDaemon([
      {
        id: 'daemon-aaa',
        supervision: { restart: 'on-failure', status: 'armed' },
        supervisionRuntime: { status: 'armed', restartCount: 2, consecutiveFailures: 0 },
      },
      // daemon-bbb is unsupervised — no `supervision` field.
      { id: 'daemon-bbb' },
    ]);

    const res = await router.dispatch({ id: 'sv-1', method: 'pane.list', params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const panes = (res.result as { panes: Array<Record<string, unknown>> }).panes;
      expect(panes[0].supervision).toEqual({
        restart: 'on-failure',
        status: 'armed',
        restartCount: 2,
        consecutiveFailures: 0,
      });
      // Unsupervised pane carries no supervision field at all.
      expect(panes[1].supervision).toBeUndefined();
    }
  });

  it('prefers the volatile runtime status over the persisted meta status (guard trip)', async () => {
    sendToRendererMock.mockResolvedValueOnce([
      { id: 'pane-1', surfaceCount: 1, active: true, surfacePtyIds: ['daemon-aaa'] },
    ]);
    const { router } = setupWithDaemon([
      {
        id: 'daemon-aaa',
        // meta persisted armed, but the live runtime says stopped (guard tripped
        // this daemon lifetime before persistence caught up).
        supervision: { restart: 'always', status: 'armed' },
        supervisionRuntime: { status: 'stopped', restartCount: 5, consecutiveFailures: 5 },
      },
    ]);

    const res = await router.dispatch({ id: 'sv-2', method: 'pane.list', params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const panes = (res.result as { panes: Array<Record<string, unknown>> }).panes;
      expect(panes[0].supervision).toMatchObject({ status: 'stopped', restartCount: 5 });
    }
  });

  it('falls back to meta status when the runtime is absent (restartCount 0)', async () => {
    sendToRendererMock.mockResolvedValueOnce([
      { id: 'pane-1', surfaceCount: 1, active: true, surfacePtyIds: ['daemon-aaa'] },
    ]);
    const { router } = setupWithDaemon([
      { id: 'daemon-aaa', supervision: { restart: 'on-failure', status: 'armed' } },
    ]);

    const res = await router.dispatch({ id: 'sv-3', method: 'pane.list', params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const panes = (res.result as { panes: Array<Record<string, unknown>> }).panes;
      expect(panes[0].supervision).toMatchObject({ status: 'armed', restartCount: 0 });
    }
  });

  it('skips the join gracefully when daemon.listSessions throws', async () => {
    sendToRendererMock.mockResolvedValueOnce([
      { id: 'pane-1', surfaceCount: 1, active: true, surfacePtyIds: ['daemon-aaa'] },
    ]);
    const { router } = setupWithDaemon(() => Promise.reject(new Error('daemon offline')));

    const res = await router.dispatch({ id: 'sv-4', method: 'pane.list', params: {} });
    // pane.list still succeeds — the join is best-effort.
    expect(res.ok).toBe(true);
    if (res.ok) {
      const panes = (res.result as { panes: Array<Record<string, unknown>> }).panes;
      expect(panes[0].supervision).toBeUndefined();
      // metadata join still ran.
      expect(panes[0].metadata).toEqual({});
    }
  });

  it('emits no supervision field in local mode (no daemon client)', async () => {
    sendToRendererMock.mockResolvedValueOnce([
      { id: 'pane-1', surfaceCount: 1, active: true, surfacePtyIds: ['local-1'] },
    ]);
    // setupRouter() registers without a daemon-client accessor.
    const router = setupRouter();
    const res = await router.dispatch({ id: 'sv-5', method: 'pane.list', params: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const panes = (res.result as { panes: Array<Record<string, unknown>> }).panes;
      expect(panes[0].supervision).toBeUndefined();
    }
  });
});

describe('pane.rpc — pane.split workspaceId forwarding (#236)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendToRendererMock.mockResolvedValue({ ok: true, paneId: 'pane-new' });
  });

  it('forwards an explicit workspaceId to the renderer', async () => {
    const router = register();
    const res = await router.dispatch({
      id: 's1',
      method: 'pane.split',
      params: { direction: 'vertical', workspaceId: 'ws-bg' },
    });
    expect(res.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'pane.split',
      { direction: 'vertical', workspaceId: 'ws-bg' },
    );
  });

  it('omits workspaceId from the forwarded payload when the caller did not provide it', async () => {
    const router = register();
    await router.dispatch({ id: 's2', method: 'pane.split', params: { direction: 'horizontal' } });
    const payload = sendToRendererMock.mock.calls[0][2] as Record<string, unknown>;
    expect(payload).toEqual({ direction: 'horizontal' });
    expect('workspaceId' in payload).toBe(false);
  });

  it('rejects a non-string workspaceId before any renderer call', async () => {
    const router = register();
    const res = await router.dispatch({
      id: 's3',
      method: 'pane.split',
      params: { direction: 'vertical', workspaceId: 42 as unknown as string },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/string/);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('still rejects an invalid direction (regression)', async () => {
    const router = register();
    const res = await router.dispatch({
      id: 's4',
      method: 'pane.split',
      params: { direction: 'sideways' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/horizontal.*vertical/);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });
});
