import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  RemoteInboxBridge,
  __resetLanlinkCursorForTest,
  __getLanlinkCursorForTest,
} from '../RemoteInboxBridge';
import { IPC } from '../../../shared/constants';
import type { InboxRecord } from '../../../shared/lanlink';
import type { DaemonClient } from '../../DaemonClient';
import type { BrowserWindow } from 'electron';

function rec(seq: number, id = `id-${seq}`): InboxRecord {
  return { id, seq, origin: 'remote', peerName: 'Peer', text: `msg ${seq}`, receivedAt: seq };
}

/** Minimal DaemonClient stand-in: an EventEmitter + isConnected + inboxPoll. */
type MockClient = DaemonClient & { _connected: boolean; inboxPoll: ReturnType<typeof vi.fn> };
function makeClient(): MockClient {
  const ee = new EventEmitter() as EventEmitter & {
    _connected: boolean;
    inboxPoll: ReturnType<typeof vi.fn>;
  };
  ee._connected = true;
  Object.defineProperty(ee, 'isConnected', { get: () => ee._connected });
  ee.inboxPoll = vi.fn(async (cursor: number) => ({ items: [] as InboxRecord[], nextCursor: cursor }));
  return ee as unknown as MockClient;
}

function makeWindow() {
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
  return { win, send };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('RemoteInboxBridge', () => {
  let bridges: RemoteInboxBridge[] = [];
  beforeEach(() => {
    __resetLanlinkCursorForTest();
    bridges = [];
  });
  afterEach(() => {
    for (const b of bridges) b.stop();
  });
  function track(b: RemoteInboxBridge): RemoteInboxBridge {
    bridges.push(b);
    return b;
  }

  it('M1: materializes pulled items over IPC.LANLINK_REMOTE and advances the cursor', async () => {
    const client = makeClient();
    client.inboxPoll = vi.fn(async (cursor: number) =>
      cursor < 2 ? { items: [rec(1), rec(2)], nextCursor: 2 } : { items: [], nextCursor: cursor },
    );
    const { win, send } = makeWindow();
    const bridge = track(new RemoteInboxBridge(() => win));
    bridge.start(client);
    await flush();

    const lanlinkSends = send.mock.calls.filter((c) => c[0] === IPC.LANLINK_REMOTE);
    expect(lanlinkSends).toHaveLength(2);
    expect(lanlinkSends[0][1].recordId).toBe('id-1');
    expect(lanlinkSends[0][1].origin).toBe('remote');
    expect(lanlinkSends[1][1].seq).toBe(2);
    expect(__getLanlinkCursorForTest()).toBe(2);
    // NEVER the RPC_COMMAND paste path
    expect(send.mock.calls.some((c) => c[0] === IPC.RPC_COMMAND)).toBe(false);
  });

  it('M1b: a re-pull of an already-acked cursor returns empty → no duplicate send (dup-0)', async () => {
    const client = makeClient();
    client.inboxPoll = vi.fn(async (cursor: number) =>
      cursor < 1 ? { items: [rec(1)], nextCursor: 1 } : { items: [], nextCursor: cursor },
    );
    const { win, send } = makeWindow();
    const bridge = track(new RemoteInboxBridge(() => win));
    bridge.start(client);
    await flush();
    // A nudge re-pulls from cursor=1 → empty → no second materialize.
    client.emit('lanlink:nudge', { seq: 1 });
    await flush();
    const lanlinkSends = send.mock.calls.filter((c) => c[0] === IPC.LANLINK_REMOTE);
    expect(lanlinkSends).toHaveLength(1);
  });

  it('M2: concurrent pulls are guarded — only one inboxPoll in flight', async () => {
    const client = makeClient();
    let release!: (v: { items: InboxRecord[]; nextCursor: number }) => void;
    client.inboxPoll = vi.fn(
      () => new Promise<{ items: InboxRecord[]; nextCursor: number }>((r) => { release = r; }),
    );
    const { win } = makeWindow();
    const bridge = track(new RemoteInboxBridge(() => win));
    bridge.start(client); // immediate pull → inFlight
    // Fire nudges while the first pull is pending — they must be dropped.
    client.emit('lanlink:nudge', { seq: 1 });
    client.emit('lanlink:nudge', { seq: 1 });
    expect(client.inboxPoll).toHaveBeenCalledTimes(1);
    release({ items: [], nextCursor: 0 });
    await flush();
  });

  it('M5: a disconnected client is never polled', async () => {
    const client = makeClient();
    client._connected = false;
    const { win } = makeWindow();
    const bridge = track(new RemoteInboxBridge(() => win));
    bridge.start(client);
    await flush();
    expect(client.inboxPoll).not.toHaveBeenCalled();
  });

  it('M5b: a missing window is never polled — cursor stays put for a later retry', async () => {
    const client = makeClient();
    client.inboxPoll = vi.fn(async () => ({ items: [rec(1)], nextCursor: 1 }));
    const bridge = track(new RemoteInboxBridge(() => null));
    bridge.start(client);
    await flush();
    expect(client.inboxPoll).not.toHaveBeenCalled();
    expect(__getLanlinkCursorForTest()).toBe(0);
  });

  it('stop() unsubscribes the nudge listener (no pull after stop)', async () => {
    const client = makeClient();
    const { win } = makeWindow();
    const bridge = new RemoteInboxBridge(() => win);
    bridge.start(client);
    await flush();
    const before = client.inboxPoll.mock.calls.length;
    bridge.stop();
    client.emit('lanlink:nudge', { seq: 1 });
    await flush();
    expect(client.inboxPoll.mock.calls.length).toBe(before);
  });

  it('resync() resets the cursor to 0 and re-materializes the full inbox (renderer reload / cold start)', async () => {
    const client = makeClient();
    const all = [rec(1), rec(2), rec(3)];
    client.inboxPoll = vi.fn(async (cursor: number) => ({
      items: all.filter((r) => r.seq > cursor),
      nextCursor: all.length ? all[all.length - 1].seq : cursor,
    }));
    const { win, send } = makeWindow();
    const bridge = track(new RemoteInboxBridge(() => win));
    bridge.start(client);
    await flush();
    expect(send.mock.calls.filter((c) => c[0] === IPC.LANLINK_REMOTE)).toHaveLength(3);
    expect(__getLanlinkCursorForTest()).toBe(3);

    // Simulate a renderer reload: the store is wiped, the renderer re-mounts and
    // calls requestResync → bridge.resync(). The cursor resets and all 3 records
    // re-materialize (the slice's isNew guard would dedup in the real renderer).
    send.mockClear();
    bridge.resync();
    await flush();
    const resent = send.mock.calls.filter((c) => c[0] === IPC.LANLINK_REMOTE);
    expect(resent).toHaveLength(3);
    expect(resent.map((c) => c[1].seq)).toEqual([1, 2, 3]);
  });

  it('a mid-batch send failure holds the cursor at the last delivered seq (no skip)', async () => {
    const client = makeClient();
    const batch = [rec(1), rec(2), rec(3)];
    client.inboxPoll = vi.fn(async (cursor: number) => ({
      items: batch.filter((r) => r.seq > cursor),
      nextCursor: 3,
    }));
    let sends = 0;
    const send = vi.fn(() => {
      sends++;
      if (sends === 2) throw new Error('Render frame was disposed'); // seq 2 drops
    });
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
    const bridge = track(new RemoteInboxBridge(() => win));
    bridge.start(client);
    await flush();
    // seq 1 delivered, seq 2 threw → loop breaks → cursor held at 1 (NOT advanced
    // past the undelivered seq 2/3). They are re-pulled on the next nudge/interval.
    expect(__getLanlinkCursorForTest()).toBe(1);
    expect(send).toHaveBeenCalledTimes(2); // attempted 1 and 2, stopped before 3
  });
});
