import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';

// Hoisted handles so the module mocks can read values set per-test.
const { sendToRendererMock, dirRef } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  dirRef: { current: '' as string },
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

vi.mock('../../../../shared/constants', () => ({
  getPidMapDir: () => dirRef.current,
}));

const fakeWindow = {} as BrowserWindow;

function makeWorker(): ClaudeWorker {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockReturnValue(true),
    isFull: false,
    stop: vi.fn(),
  } as unknown as ClaudeWorker;
}

function setupRouter(): RpcRouter {
  const router = new RpcRouter();
  registerA2aRpc(router, () => fakeWindow, makeWorker());
  return router;
}

async function resolveIdentity(router: RpcRouter): Promise<Record<string, string>> {
  const res = await router.dispatch({ id: 'r1', method: 'a2a.resolve.identity', params: {} });
  expect(res.ok).toBe(true);
  return (res as { result: { mappings: Record<string, string> } }).result.mappings;
}

function listFiles(): string[] {
  return fs.existsSync(dirRef.current) ? fs.readdirSync(dirRef.current).sort() : [];
}

describe('a2a.resolve.identity — live ownership resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dirRef.current = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dirRef.current, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('maps a PID→ptyId entry to the CURRENT owning workspace (not a frozen id)', async () => {
    // pid-map stores PID(filename) → ptyId(content). The renderer reports the
    // live owner, which may differ from whatever workspace existed at create.
    fs.writeFileSync(path.join(dirRef.current, '1111'), 'daemon-aaaa');
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, params: { ptyId: string }) => {
        if (method === 'input.findOwnerWorkspace' && params.ptyId === 'daemon-aaaa') {
          return Promise.resolve({ workspaceId: 'ws-live-current' });
        }
        return Promise.resolve({ workspaceId: null });
      },
    );

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({ '1111': 'ws-live-current' });
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.findOwnerWorkspace',
      { ptyId: 'daemon-aaaa' },
    );
  });

  it('omits a ptyId whose pane no longer exists (owner === null) without deleting the file', async () => {
    // A dead/recycled current-format entry resolves to null and is excluded from
    // the map — so it can never produce a ghost. It is left on disk (harmless);
    // accretion is bounded at the write boundary, not on this read hot-path.
    fs.writeFileSync(path.join(dirRef.current, '2222'), 'daemon-gone');
    sendToRendererMock.mockResolvedValue({ workspaceId: null });

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({});
    expect(listFiles()).toEqual(['2222']); // not pruned on the read path
  });

  it('DROPS legacy PID→workspaceId entries (ws- prefix) and deletes the file', async () => {
    // Legacy entries have no ptyId anchor, cannot be live-resolved, and on a
    // recycled PID surface as a ghost workspace. They must be purged, not passed
    // through (the old passthrough behavior was the root cause of the ghost bug).
    fs.writeFileSync(path.join(dirRef.current, '3333'), 'ws-legacy-frozen');

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({});
    expect(sendToRendererMock).not.toHaveBeenCalled();
    expect(listFiles()).toEqual([]); // file purged
  });

  it('skips an entry when the renderer lookup throws (early boot / reload)', async () => {
    fs.writeFileSync(path.join(dirRef.current, '4444'), 'daemon-bbbb');
    sendToRendererMock.mockRejectedValue(new Error('renderer not ready'));

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({});
    // Not pruned: a renderer error is not proof the entry is stale.
    expect(listFiles()).toEqual(['4444']);
  });

  it('resolves a mix of live, legacy, and dead-owner entries in one pass', async () => {
    fs.writeFileSync(path.join(dirRef.current, '10'), 'daemon-live');
    fs.writeFileSync(path.join(dirRef.current, '20'), 'ws-legacy');
    fs.writeFileSync(path.join(dirRef.current, '30'), 'daemon-dead');
    sendToRendererMock.mockImplementation(
      (_w: unknown, _method: string, params: { ptyId: string }) =>
        Promise.resolve({
          workspaceId: params.ptyId === 'daemon-live' ? 'ws-A' : null,
        }),
    );

    const mappings = await resolveIdentity(setupRouter());

    // Legacy '20' is dropped; '30' resolves to null (dead owner) and is omitted.
    expect(mappings).toEqual({ '10': 'ws-A' });
    expect(listFiles()).toEqual(['10', '30']); // legacy file purged, others kept
  });

  it('purges multiple legacy files in one pass without any renderer call', async () => {
    fs.writeFileSync(path.join(dirRef.current, '40'), 'ws-old-a');
    fs.writeFileSync(path.join(dirRef.current, '50'), 'ws-old-b');
    fs.writeFileSync(path.join(dirRef.current, '60'), 'ws-old-c');

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({});
    expect(sendToRendererMock).not.toHaveBeenCalled();
    expect(listFiles()).toEqual([]);
  });

  it('returns an empty map when no pid-map dir exists', async () => {
    fs.rmSync(dirRef.current, { recursive: true, force: true });

    const mappings = await resolveIdentity(setupRouter());

    expect(mappings).toEqual({});
  });
});
