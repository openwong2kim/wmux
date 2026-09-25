import { describe, it, expect } from 'vitest';
import { ChatLaunchReceiptStore } from '../chatLaunchReceipts';
import { decodeChatCursor, encodeChatCursor } from '../chatCursor';

const T = 1_700_000_000_000;
const SKEW = 60_000;
/** A well-formed `<13-digit ms>-<uuid>` id minted at `at`. */
const lid = (at: number, n = 0) => `${at}-${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

describe('ChatLaunchReceiptStore', () => {
  it('ages final receipts by the id time plus the clock-skew allowance, never a pending one', () => {
    const store = new ChatLaunchReceiptStore(1000, 8);
    const a = lid(T, 1), b = lid(T, 2), late = lid(T, 3);
    expect(store.begin('operator', a, 's1', 'fp', T)).toEqual({ kind: 'new' });
    expect(store.begin('operator', b, 's1', 'fp', T)).toEqual({ kind: 'new' });
    // Received well after its id was minted: still aged from the id, not receipt.
    expect(store.begin('operator', late, 's1', 'fp', T + 900)).toEqual({ kind: 'new' });
    store.finish('operator', a, 'submitted', 202, { ok: true });
    store.finish('operator', late, 'submitted', 202, { ok: true });
    expect(store.state('operator', 's1', a, T + 999 + SKEW)).toBe('submitted');
    expect(store.state('operator', 's1', a, T + 1000 + SKEW)).toBe('unknown');
    expect(store.state('operator', 's1', late, T + 1000 + SKEW)).toBe('unknown');
    // Still running: a retry with the same id must not dispatch again.
    expect(store.state('operator', 's1', b, T + 5_000_000)).toBe('pending');
    expect(store.begin('operator', b, 's1', 'fp', T + 5_000_000)).toEqual({ kind: 'pending' });
  });

  it('maps effects to states and keeps owners apart', () => {
    const store = new ChatLaunchReceiptStore();
    const x = lid(T, 1), y = lid(T, 2);
    store.begin('device:a', x, 's1', 'fp', T);
    store.finish('device:a', x, 'none', 409, { error: 'launch-not-ready' });
    store.begin('device:a', y, 's1', 'fp', T);
    store.finish('device:a', y, 'uncertain', 502, { error: 'launch-unconfirmed' });
    expect(store.state('device:a', 's1', x, T + 1)).toBe('refused');
    expect(store.state('device:a', 's1', y, T + 1)).toBe('uncertain');
    expect(store.state('device:b', 's1', x, T + 1)).toBe('unknown');
    expect(store.begin('device:b', x, 's1', 'fp', T + 1)).toEqual({ kind: 'new' });
    expect(store.begin('device:a', x, 's2', 'fp', T + 1)).toEqual({ kind: 'conflict' });
  });

  it('refuses at the cap instead of evicting a receipt inside its window', () => {
    const store = new ChatLaunchReceiptStore(60_000, 2);
    const a = lid(T, 1);
    store.begin('operator', a, 's1', 'fp', T);
    store.finish('operator', a, 'submitted', 202, { ok: true });
    store.begin('operator', lid(T, 2), 's1', 'fp', T);
    expect(store.begin('operator', lid(T, 3), 's1', 'fp', T)).toEqual({ kind: 'full' });
    // The retry of `a` still replays rather than typing the launcher again.
    expect(store.begin('operator', a, 's1', 'fp', T + 1)).toEqual({ kind: 'replay', status: 202, body: { ok: true } });
    // Once `a` has aged out its slot frees up; the pending one never does.
    expect(store.begin('operator', lid(T + 60_000 + SKEW, 4), 's1', 'fp', T + 60_000 + SKEW)).toEqual({ kind: 'new' });
    expect(store.begin('operator', lid(T + 60_000 + SKEW, 5), 's1', 'fp', T + 60_000 + SKEW)).toEqual({ kind: 'full' });
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
