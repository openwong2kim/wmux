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
import { NOT_FIRST_PARTY } from '../../shared/daemonFirstParty';
import { DAEMON_RPC_TIMEOUT_MS } from '../../shared/timeouts';
import { PANE_LOCK_DAEMON_WAIT_MS } from '../../daemon/paneDeliveryLock';

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
    expect(await c.writeHeld('s', 'tok', paste)).toEqual({ ok: true, written: 3 });
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
    expect(await refuseSecond.writeHeld('s', 'tok', 'q'.repeat(HELD_WRITE_CHUNK_MAX + 1))).toMatchObject({ ok: false, uncertain: true, written: 1 });
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

describe('DaemonClient held writes under pressure', () => {
  it('a held write refused for backpressure is tried again, and the paste goes on', async () => {
    let refusals = 2;
    const datas: string[] = [];
    const c = client(async (_method, params) => {
      datas.push(params['data'] as string);
      return refusals-- > 0 ? { ok: false, error: 'backpressure' } : { ok: true };
    });
    expect(await c.writeHeld('s', 'tok', 'x')).toEqual({ ok: true, written: 1 });
    expect(datas).toEqual(['x', 'x', 'x']);
  });

  it('a bracketed paste cut off after its first chunk is closed, best effort, and reported as maybe pasted', async () => {
    const datas: string[] = [];
    const c = client(async (_method, params) => {
      datas.push(params['data'] as string);
      if (datas.length === 2) throw new Error('rate limited (delivery)');
      return { ok: true };
    });
    const paste = `\x1b[200~${'p'.repeat(HELD_WRITE_CHUNK_MAX * 2)}\x1b[201~`;
    // The first chunk and the closing ESC[201~ landed: both moved the pane's key count.
    expect(await c.writeHeld('s', 'tok', paste)).toMatchObject({ ok: false, uncertain: true, written: 2 });
    expect(datas.at(-1)).toBe('\x1b[201~');
    expect(datas).toHaveLength(3);
  });

  it("the daemon writer funnel's RPCs wait for the pane's lock on top of the usual timeout", async () => {
    const timeouts: Array<number | undefined> = [];
    const c = client(async () => ({ result: 'sent' }));
    (c as unknown as { rpc: (m: string, p: unknown, o?: { timeoutMs?: number }) => Promise<unknown> }).rpc = async (_m, _p, o) => {
      timeouts.push(o?.timeoutMs);
      return { result: 'sent', pasted: true };
    };
    await c.deliverScheduledPrompt({ id: 's', agentSlug: 'claude', incarnationId: 'i', prompt: 'p' });
    await c.deliverCallerNudge({ id: 's', agentSlug: 'claude', incarnationId: 'i', prompt: 'p' });
    expect(timeouts).toEqual([DAEMON_RPC_TIMEOUT_MS + PANE_LOCK_DAEMON_WAIT_MS, DAEMON_RPC_TIMEOUT_MS + PANE_LOCK_DAEMON_WAIT_MS]);
  });
});

describe("DaemonClient pane lock on a connection that is not the app's yet", () => {
  /** The real rpc() over a stubbed send: the daemon's answers, in order, and whether an identify lands. */
  function onPipe(answers: () => unknown, identified: boolean) {
    const c = new DaemonClient('unused', 'token');
    Object.defineProperty(c, 'isConnected', { get: () => true });
    Object.assign(c as unknown as Record<string, unknown>, { controlPipe: {}, connected: true });
    const sent: string[] = [];
    (c as unknown as { send: (m: string) => Promise<unknown> }).send = async (method) => {
      sent.push(method);
      const answer = answers();
      if (answer instanceof Error) throw answer;
      return answer;
    };
    (c as unknown as { identifyAgain: () => Promise<boolean> }).identifyAgain = async () => { sent.push('identify'); return identified; };
    return { c, sent };
  }
  const notFirstParty = (): Error => Object.assign(new Error(`${NOT_FIRST_PARTY}: refused`), { code: NOT_FIRST_PARTY });

  it('a NOT_FIRST_PARTY answer identifies again, and the retried acquire takes the lock', async () => {
    let first = true;
    const { c, sent } = onPipe(() => (first ? ((first = false), notFirstParty()) : { ok: true, token: 'tok' }), true);
    expect(await c.acquirePaneLock('s', 'n1', 1_000)).toEqual({ held: true, token: 'tok' });
    expect(sent).toEqual(['daemon.session.deliveryLockV1', 'identify', 'daemon.session.deliveryLockV1']);
  });

  it('standing that identifying cannot restore: unavailable (gate_unavailable), and one log line for the connection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { c } = onPipe(() => notFirstParty(), true);
    for (let i = 0; i < 4; i++) {
      // eslint-disable-next-line no-await-in-loop -- one acquire after another, as main's chain makes them
      expect(await c.acquirePaneLock('s', `n${i}`, 0)).toMatchObject({ held: false, why: 'unavailable' });
    }
    expect(warn.mock.calls.filter(([line]) => String(line).includes('lost first-party'))).toHaveLength(1);
    warn.mockRestore();
  });
});
