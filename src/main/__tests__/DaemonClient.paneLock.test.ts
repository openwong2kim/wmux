// main's side of the pane delivery lock (daemon/paneDeliveryLock.ts): a long
// paste goes as several held writes under one token, a write is "uncertain"
// only when bytes may have reached the pane, and a failed release is tried
// once more.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: () => undefined,
  getLastBroadcastAgentStatus: () => undefined,
  hasOutstandingRunningClaim: () => false,
}));

import { DaemonClient } from '../DaemonClient';
import { HELD_WRITE_CHUNK_MAX } from '../../shared/heldWrite';
import { waitFor } from '../../test-utils/waitFor';

type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function client(rpc: Rpc): DaemonClient {
  const c = new DaemonClient('unused', 'token');
  Object.defineProperty(c, 'isConnected', { get: () => true });
  (c as unknown as { rpc: Rpc }).rpc = rpc;
  return c;
}

describe('DaemonClient held writes', () => {
  it('a paste longer than one held write goes as chunks, each under the same token, joined back whole', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const c = client(async (_method, params) => {
      sent.push(params);
      return { ok: true };
    });
    const paste = 'p'.repeat(HELD_WRITE_CHUNK_MAX * 2 + 10);
    expect(await c.writeHeld('s', 'tok', paste)).toEqual({ ok: true });
    expect(sent).toHaveLength(3);
    expect(sent.every((p) => p['token'] === 'tok' && (p['data'] as string).length <= HELD_WRITE_CHUNK_MAX)).toBe(true);
    expect(sent.map((p) => p['data']).join('')).toBe(paste);
  });

  it('uncertain only when bytes may have reached the pane: a lost reply, or a refusal after an earlier chunk landed', async () => {
    const refuseFirst = client(async () => ({ ok: false, error: 'not held' }));
    expect(await refuseFirst.writeHeld('s', 'tok', 'x')).toMatchObject({ ok: false, uncertain: false });

    const errorReply = client(async () => { throw new Error('rate limited'); });
    expect(await errorReply.writeHeld('s', 'tok', 'x')).toMatchObject({ ok: false, uncertain: false });

    const lost = client(async () => { throw new Error('RPC timeout: daemon.session.writeHeldV1 (10000ms)'); });
    expect(await lost.writeHeld('s', 'tok', 'x')).toMatchObject({ ok: false, uncertain: true });

    let calls = 0;
    const refuseSecond = client(async () => (++calls === 1 ? { ok: true } : { ok: false, error: 'not held' }));
    expect(await refuseSecond.writeHeld('s', 'tok', 'q'.repeat(HELD_WRITE_CHUNK_MAX + 1))).toMatchObject({ ok: false, uncertain: true });
  });

  it('a release that fails is tried once more', async () => {
    const methods: string[] = [];
    const c = client(async (method) => {
      methods.push(method);
      if (methods.length === 1) throw new Error('RPC timeout: daemon.session.deliveryUnlockV1 (10000ms)');
      return { ok: true };
    });
    c.releasePaneLock('s', { token: 'tok' });
    await waitFor(() => methods.length === 2, 2_000);
    expect(methods).toEqual(['daemon.session.deliveryUnlockV1', 'daemon.session.deliveryUnlockV1']);
  });
});
