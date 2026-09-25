import { describe, it, expect } from 'vitest';
import { ChatLaunchReceiptStore } from '../chatLaunchReceipts';
import { decodeChatCursor, encodeChatCursor } from '../chatCursor';

describe('ChatLaunchReceiptStore', () => {
  it('ages out final receipts after the TTL but never a pending one', () => {
    const store = new ChatLaunchReceiptStore(1000, 8);
    expect(store.begin('operator', 'a', 's1', 'fp', 0)).toEqual({ kind: 'new' });
    expect(store.begin('operator', 'b', 's1', 'fp', 0)).toEqual({ kind: 'new' });
    store.finish('operator', 'a', 'submitted', 202, { ok: true });
    expect(store.state('operator', 's1', 'a', 999)).toBe('submitted');
    expect(store.state('operator', 's1', 'a', 1000)).toBe('unknown');
    // Still running: a retry with the same id must not dispatch again.
    expect(store.state('operator', 's1', 'b', 5000)).toBe('pending');
    expect(store.begin('operator', 'b', 's1', 'fp', 5000)).toEqual({ kind: 'pending' });
  });

  it('maps effects to states and keeps owners apart', () => {
    const store = new ChatLaunchReceiptStore();
    store.begin('device:a', 'x', 's1', 'fp', 0);
    store.finish('device:a', 'x', 'none', 409, { error: 'launch-not-ready' });
    store.begin('device:a', 'y', 's1', 'fp', 0);
    store.finish('device:a', 'y', 'uncertain', 502, { error: 'launch-unconfirmed' });
    expect(store.state('device:a', 's1', 'x', 1)).toBe('refused');
    expect(store.state('device:a', 's1', 'y', 1)).toBe('uncertain');
    expect(store.state('device:b', 's1', 'x', 1)).toBe('unknown');
    expect(store.begin('device:b', 'x', 's1', 'fp', 1)).toEqual({ kind: 'new' });
    expect(store.begin('device:a', 'x', 's2', 'fp', 1)).toEqual({ kind: 'conflict' });
  });

  it('evicts the oldest final receipt at the cap, and refuses when every slot is pending', () => {
    const store = new ChatLaunchReceiptStore(60_000, 2);
    store.begin('operator', 'a', 's1', 'fp', 0);
    store.finish('operator', 'a', 'submitted', 202, {});
    store.begin('operator', 'b', 's1', 'fp', 0);
    expect(store.begin('operator', 'c', 's1', 'fp', 0)).toEqual({ kind: 'new' });
    expect(store.state('operator', 's1', 'a', 0)).toBe('unknown');
    expect(store.begin('operator', 'd', 's1', 'fp', 0)).toEqual({ kind: 'full' });
  });
});

describe('chat cursor v2', () => {
  it('round-trips and refuses v1, unknown sources and malformed offsets', () => {
    const c = { v: 2 as const, src: 'file' as const, a: 's', e: 'h1:x', head: 1, tail: 2, fileSize: 3 };
    expect(decodeChatCursor(encodeChatCursor(c))).toEqual(c);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(decodeChatCursor(enc({ head: 0, tail: 5 }))).toBeNull();
    expect(decodeChatCursor(enc({ ...c, src: 'acp' }))).toBeNull();
    expect(decodeChatCursor(enc({ ...c, head: -1 }))).toBeNull();
    expect(decodeChatCursor(enc({ ...c, tail: 'x' }))).toBeNull();
    expect(decodeChatCursor(enc([1]))).toBeNull();
    expect(decodeChatCursor('%%%')).toBeNull();
  });
});
