// @wmux-lane unit
// One delivery at a time into a pane, across main and the daemon
// (paneDeliveryLock.ts): FIFO with a bounded wait, a hold that ends on
// release, on its client's pipe closing, on the session ending or on its
// lease, and a held write that the daemon refuses once the hold has ended.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import {
  PANE_LOCK_LEASE_MS,
  PANE_LOCK_STICKY_MS,
  PaneDeliveryLocks,
  writeUnderLock,
  type HeldWriteTarget,
} from '../paneDeliveryLock';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';

const MAIN = { key: 'main:c1', clientId: 'c1', nonce: 'n1' };

function target(): HeldWriteTarget & { written: string[]; noted: string[] } {
  const t = {
    written: [] as string[],
    noted: [] as string[],
    write: (data: string) => { t.written.push(data); },
    noteInput: (data: string) => { t.noted.push(data); },
  };
  return t;
}

describe('PaneDeliveryLocks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('grants a free pane at once and queues the next holder until the first releases', async () => {
    const locks = new PaneDeliveryLocks();
    const first = await locks.acquire('s', MAIN, 1_000);
    expect(first).toBeTruthy();
    const second = locks.acquire('s', { key: 'daemon:scheduled prompt' }, 1_000);
    expect(locks.holderOf('s')).toBe('main:c1');
    locks.release('s', first as string);
    expect(await second).toBeTruthy();
    expect(locks.holderOf('s')).toBe('daemon:scheduled prompt');
  });

  it('a waiter not granted in time is busy (null) and gives up its place', async () => {
    const locks = new PaneDeliveryLocks();
    await locks.acquire('s', MAIN, 0);
    const late = locks.acquire('s', { key: 'daemon:x' }, 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await late).toBeNull();
    expect(locks.busyFor('s', 'main:c1')).toBe(false);
  });

  it("a held write: refused once the lease ended with no write, and the daemon writer's paste stays intact", async () => {
    const locks = new PaneDeliveryLocks();
    const token = await locks.acquire('s', MAIN, 0) as string;
    const t = target();
    expect(writeUnderLock(locks, 's', token, 'c1', t, 'one')).toEqual({ ok: true });
    // Hung: no write renews it, and the lease reclaims the pane.
    await vi.advanceTimersByTimeAsync(PANE_LOCK_LEASE_MS);
    const daemon = await locks.acquire('s', { key: 'daemon:scheduled prompt' }, 0);
    expect(daemon).toBeTruthy();
    t.write('DAEMON PASTE');
    expect(writeUnderLock(locks, 's', token, 'c1', t, '\r')).toEqual({ ok: false, error: 'not held' });
    expect(t.written).toEqual(['one', 'DAEMON PASTE']);
  });

  it('every held write renews the lease', async () => {
    const locks = new PaneDeliveryLocks();
    const token = await locks.acquire('s', MAIN, 0) as string;
    const t = target();
    await vi.advanceTimersByTimeAsync(PANE_LOCK_LEASE_MS - 1_000);
    expect(writeUnderLock(locks, 's', token, 'c1', t, 'a').ok).toBe(true);
    await vi.advanceTimersByTimeAsync(PANE_LOCK_LEASE_MS - 1_000);
    expect(writeUnderLock(locks, 's', token, 'c1', t, 'b').ok).toBe(true);
  });

  it("main's control pipe closing ends its hold: a reconnect with the old token is refused, even on the same client id", async () => {
    const locks = new PaneDeliveryLocks();
    const token = await locks.acquire('s', MAIN, 0) as string;
    locks.releaseClient('c1');
    const t = target();
    expect(writeUnderLock(locks, 's', token, 'c2', t, 'x')).toEqual({ ok: false, error: 'not held' });
    expect(writeUnderLock(locks, 's', token, 'c1', t, 'x')).toEqual({ ok: false, error: 'not held' });
    expect(t.written).toEqual([]);
  });

  it("a write from another client than the holder's is refused", async () => {
    const locks = new PaneDeliveryLocks();
    const token = await locks.acquire('s', MAIN, 0) as string;
    expect(writeUnderLock(locks, 's', token, 'c9', target(), 'x')).toEqual({ ok: false, error: 'not held' });
  });

  it("a lost acquire reply: release by nonce, and a daemon writer waiting behind it goes at once", async () => {
    const locks = new PaneDeliveryLocks();
    await locks.acquire('s', MAIN, 0);
    const daemon = locks.acquire('s', { key: 'daemon:scheduled prompt' }, 4_000);
    locks.releaseNonce('s', 'c1', 'n1');
    expect(await daemon).toBeTruthy();
    // A nonce still waiting in the queue gives up its place too.
    const mainWaiting = locks.acquire('s', { ...MAIN, nonce: 'n2' }, 4_000);
    locks.releaseNonce('s', 'c1', 'n2');
    expect(await mainWaiting).toBeNull();
  });

  it('the session ending drops its hold and its queue', async () => {
    const locks = new PaneDeliveryLocks();
    const token = await locks.acquire('s', MAIN, 0) as string;
    const waiting = locks.acquire('s', { key: 'daemon:x' }, 4_000);
    locks.dropSession('s');
    expect(await waiting).toBeNull();
    expect(locks.holds('s', token, 'c1')).toBe(false);
  });

  it('a daemon writer runs under the lock and answers null (busy) when the pane stays held', async () => {
    const locks = new PaneDeliveryLocks();
    expect(await locks.runLocked('s', 'daemon:a', 0, async () => {
      expect(locks.holderOf('s')).toBe('daemon:a');
      return 'sent';
    })).toBe('sent');
    expect(locks.holderOf('s')).toBeUndefined();
    await locks.acquire('s', MAIN, 0);
    const busy = locks.runLocked('s', 'daemon:a', 300, async () => 'sent');
    await vi.advanceTimersByTimeAsync(300);
    expect(await busy).toBeNull();
  });

  it('a per-write writer holds the pane stickily, and is refused while another holds it', async () => {
    const locks = new PaneDeliveryLocks();
    expect(locks.holdSticky('s', 'chat-v2')).toBe(true);
    expect(locks.holdSticky('s', 'chat-v2')).toBe(true);
    const main = locks.acquire('s', MAIN, 5_000);
    // Main waits for the chat send's writes to go quiet.
    await vi.advanceTimersByTimeAsync(PANE_LOCK_STICKY_MS);
    expect(await main).toBeTruthy();
    expect(locks.holdSticky('s', 'chat-v2')).toBe(false);
  });

  it('nothing is written past the high-water mark or on the adapter backpressure', async () => {
    const locks = new PaneDeliveryLocks();
    const token = await locks.acquire('s', MAIN, 0) as string;
    const full = { ...target(), pendingInputBytes: 6 * 1024 * 1024 };
    expect(writeUnderLock(locks, 's', token, 'c1', full, 'x')).toEqual({ ok: false, error: 'backpressure' });
    expect(full.written).toEqual([]);
    const refusing = { ...target(), write: () => { throw new Error('PTY_BACKPRESSURE: full'); } };
    expect(writeUnderLock(locks, 's', token, 'c1', refusing, 'x')).toEqual({ ok: false, error: 'backpressure' });
    expect(refusing.noted).toEqual([]);
  });
});

describe('writeUnderLock accounting', () => {
  it("moves the pane's revisions exactly as the session pipe's input does (one large paste = +1, the Enter +1)", async () => {
    const bridge = (): DaemonPTYBridge => {
      const b = new DaemonPTYBridge();
      b.setupDataForwarding({ onData: () => ({ dispose: () => undefined }), onExit: () => ({ dispose: () => undefined }) } as unknown as IPty, new RingBuffer(65536), 'sess');
      return b;
    };
    const viaPipe = bridge();
    const viaHeld = bridge();
    const locks = new PaneDeliveryLocks();
    const token = await locks.acquire('s', MAIN, 0) as string;
    const paste = `\x1b[200~${'x'.repeat(64 * 1024)}\x1b[201~`;
    for (const data of [paste, '\r']) {
      viaPipe.noteInput(data);
      expect(writeUnderLock(locks, 's', token, 'c1', { write: () => undefined, noteInput: (d) => viaHeld.noteInput(d) }, data)).toEqual({ ok: true });
    }
    expect(viaHeld.getKeyInputRevision()).toBe(viaPipe.getKeyInputRevision());
    expect(viaHeld.getInputRevision()).toBe(viaPipe.getInputRevision());
    expect(viaHeld.getKeyInputRevision()).toBe(2);
    viaPipe.cleanup();
    viaHeld.cleanup();
  });
});
