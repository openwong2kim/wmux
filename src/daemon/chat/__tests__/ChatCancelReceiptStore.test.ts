import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatCancelReceiptStore } from '../ChatCancelReceiptStore';
import { ChatSendReceiptStore } from '../ChatSendReceiptStore';
import { normalizeCancelProgress } from '../../../shared/phoneChatCancelOutcome';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cancel-')); dirs.push(dir); return dir; };
const id = () => `${Date.now()}-${randomUUID()}`;
const fp = ChatCancelReceiptStore.fingerprint('pane', 'conv', 'h1:x', 't1:n.1');

describe('ChatCancelReceiptStore', () => {
  it('is owner-bound, and a pending found after a restart reads as uncertain', () => {
    const dir = tmp();
    const store = new ChatCancelReceiptStore(dir);
    const done = id(); const open = id();
    expect(store.insertPending('device:a', done, { paneId: 'pane', fingerprint: fp })).toBe('inserted');
    expect(store.complete('device:a', done, { effect: 'interrupt-requested', turnId: 't1:n.1' })).toBe(true);
    expect(store.insertPending('device:a', done, { paneId: 'pane', fingerprint: fp })).toBe('exists');
    expect(store.lookup('device:b', done)).toBeUndefined();
    expect(store.insertPending('device:a', open, { paneId: 'pane', fingerprint: fp })).toBe('inserted');
    const reloaded = new ChatCancelReceiptStore(dir);
    expect(reloaded.lookup('device:a', done)).toMatchObject({ state: 'final', outcome: { effect: 'interrupt-requested', turnId: 't1:n.1' } });
    expect(reloaded.lookup('device:a', open)).toMatchObject({ state: 'final', outcome: { effect: 'uncertain' } });
  });

  it('discard drops a pending receipt only, and the send receipt file is untouched', () => {
    const dir = tmp();
    const store = new ChatCancelReceiptStore(dir);
    const refused = id();
    store.insertPending('operator', refused, { paneId: 'pane', fingerprint: fp });
    store.discard('operator', refused);
    expect(store.lookup('operator', refused)).toBeUndefined();
    expect(new ChatCancelReceiptStore(dir).lookup('operator', refused)).toBeUndefined();
    expect(fs.readdirSync(dir).some((name) => name.startsWith('chat-send-receipts'))).toBe(false);
    // The send store still loads next to it.
    expect(() => new ChatSendReceiptStore(dir)).not.toThrow();
  });

  it('stores progress with the outcome in one write and never revises a final progress', () => {
    const dir = tmp();
    const store = new ChatCancelReceiptStore(dir, { now: () => 5_000 });
    const cid = id();
    store.insertPending('device:a', cid, { paneId: 'pane', fingerprint: fp });
    // In flight: the write is under way.
    expect(store.progress('device:a', cid)).toMatchObject({ state: 'requested' });
    expect(store.complete('device:a', cid, { effect: 'interrupt-requested', turnId: 't1:n.1' }, { state: 'requested', at: 5_000 })).toBe(true);
    expect(store.progress('device:a', cid)).toEqual({ state: 'requested', turnId: 't1:n.1', requestedAt: 5_000, at: 5_000 });
    expect(store.progress('device:b', cid)).toBeUndefined();
    expect(store.setProgress('device:a', cid, { state: 'ended', endedAs: 'interrupted', evidence: 'transcript', at: 6_000 })).toBe('saved');
    expect(store.setProgress('device:a', cid, { state: 'not-ended', at: 7_000 })).toBe('final');
    expect(store.progress('device:a', cid)).toEqual({ state: 'ended', turnId: 't1:n.1', endedAs: 'interrupted', evidence: 'transcript', requestedAt: 5_000, at: 6_000 });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'chat-cancel-receipts.json'), 'utf8'));
    expect(saved.version).toBe(1);
    expect(Object.values(saved.entries)[0]).toMatchObject({ state: 'final', outcome: { effect: 'interrupt-requested' },
      progress: { state: 'ended', endedAs: 'interrupted', evidence: 'transcript', at: 6_000 } });
  });

  it('keeps the restored-prompt check on an ended progress across a reload, and drops it anywhere else', () => {
    const dir = tmp();
    const store = new ChatCancelReceiptStore(dir, { now: () => 5_000 });
    const [cleared, odd] = [id(), id()];
    for (const cid of [cleared, odd]) {
      store.insertPending('device:a', cid, { paneId: 'pane', fingerprint: fp });
      store.complete('device:a', cid, { effect: 'interrupt-requested' }, { state: 'requested', at: 5_000 });
    }
    store.setProgress('device:a', cleared, { state: 'ended', endedAs: 'unspecified', evidence: 'screen', promptRestored: true, inputCleared: true, restoredMessageId: 'm-1', at: 6_000 });
    // `inputCleared` and `restoredMessageId` mean nothing without a restored prompt.
    store.setProgress('device:a', odd, { state: 'ended', endedAs: 'unspecified', evidence: 'screen', promptRestored: false, inputCleared: true, restoredMessageId: 'm-1', at: 6_000 });
    const reloaded = new ChatCancelReceiptStore(dir, { now: () => 7_000 });
    expect(reloaded.progress('device:a', cleared)).toEqual({ state: 'ended', endedAs: 'unspecified', evidence: 'screen', promptRestored: true, inputCleared: true, restoredMessageId: 'm-1', at: 6_000 });
    expect(reloaded.progress('device:a', odd)).toEqual({ state: 'ended', endedAs: 'unspecified', evidence: 'screen', promptRestored: false, at: 6_000 });
    expect(normalizeCancelProgress({ state: 'ended', promptRestored: true, restoredMessageId: 'bad id!', at: 1 }, 0)).toEqual({ state: 'ended', promptRestored: true, at: 1 });
    expect(normalizeCancelProgress({ state: 'unknown', promptRestored: true, inputCleared: true, at: 1 }, 0)).toEqual({ state: 'unknown', at: 1 });
  });

  // Eleven durable writes (including restart settlement) fsync real files; loaded CI disks can exceed 5 s.
  it('a daemon restart turns requested and crashed pending entries into unknown (daemon-restart); settled ones stay', { timeout: 30_000 }, () => {
    const dir = tmp();
    const store = new ChatCancelReceiptStore(dir, { now: () => 5_000 });
    const [requested, ended, crashed, uncertain, legacy] = [id(), id(), id(), id(), id()];
    for (const cid of [requested, ended, crashed, uncertain, legacy]) store.insertPending('operator', cid, { paneId: 'pane', fingerprint: fp });
    store.complete('operator', requested, { effect: 'interrupt-requested' }, { state: 'requested', at: 5_000 });
    store.complete('operator', ended, { effect: 'interrupt-requested' }, { state: 'requested', at: 5_000 });
    store.setProgress('operator', ended, { state: 'ended', endedAs: 'completed', evidence: 'screen', at: 5_500 });
    store.complete('operator', uncertain, { effect: 'uncertain' }, { state: 'unknown', reason: 'write-uncertain', at: 5_000 });
    // Written by a daemon that predates `progress`.
    store.complete('operator', legacy, { effect: 'interrupt-requested' });
    const reloaded = new ChatCancelReceiptStore(dir, { now: () => 9_000 });
    expect(reloaded.progress('operator', requested)).toEqual({ state: 'unknown', reason: 'daemon-restart', at: 9_000 });
    expect(reloaded.progress('operator', legacy)).toEqual({ state: 'unknown', reason: 'daemon-restart', at: 9_000 });
    expect(reloaded.lookup('operator', crashed)).toMatchObject({ state: 'final', outcome: { effect: 'uncertain' },
      progress: { state: 'unknown', reason: 'daemon-restart' } });
    expect(reloaded.progress('operator', uncertain)).toEqual({ state: 'unknown', reason: 'write-uncertain', at: 5_000 });
    expect(reloaded.progress('operator', ended)).toMatchObject({ state: 'ended', endedAs: 'completed', evidence: 'screen', at: 5_500 });
    expect(reloaded.setProgress('operator', requested, { state: 'ended', at: 9_500 })).toBe('final');
  });

  it('downgrade: a file written with progress still loads under the shipped v1 validator', () => {
    const dir = tmp();
    const store = new ChatCancelReceiptStore(dir);
    const [a, b, c] = [id(), id(), id()];
    for (const cid of [a, b, c]) store.insertPending('device:x', cid, { paneId: 'pane', fingerprint: fp });
    store.complete('device:x', a, { effect: 'interrupt-requested', turnId: 't1:n.1' }, { state: 'requested', at: Date.now() });
    store.setProgress('device:x', a, { state: 'ended', endedAs: 'interrupted', evidence: 'transcript', at: Date.now() });
    store.complete('device:x', b, { effect: 'uncertain' }, { state: 'unknown', reason: 'write-uncertain', at: Date.now() });
    // c stays pending on disk (a crash between the receipt and the ESC).
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'chat-cancel-receipts.json'), 'utf8'));
    expect(saved.version).toBe(1);
    expect(Object.values(saved.entries).some((row) => (row as { progress?: unknown }).progress !== undefined)).toBe(true);
    // The loader's checks as shipped before `progress` existed, verbatim.
    const EFFECTS: readonly string[] = ['interrupt-requested', 'uncertain'];
    const validOutcome = (value: unknown): boolean => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const row = value as Record<string, unknown>;
      return EFFECTS.includes(String(row.effect)) &&
        (row.turnId === undefined || typeof row.turnId === 'string' && row.turnId.length <= 128);
    };
    const validEntry = (key: string, value: unknown): boolean => {
      if (!/^[a-f0-9]{64}$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
      const row = value as Record<string, unknown>;
      return Number.isSafeInteger(row.createdAt) && typeof row.paneId === 'string' && row.paneId.length > 0 && row.paneId.length <= 256 &&
        typeof row.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.fingerprint) &&
        (row.state === 'pending' && row.outcome === undefined || row.state === 'final' && validOutcome(row.outcome));
    };
    for (const [key, value] of Object.entries(saved.entries)) expect(validEntry(key, value)).toBe(true);
    // And back up: this build reads what it wrote, plus a value only a newer daemon knows.
    const firstKey = Object.keys(saved.entries)[0];
    saved.entries[firstKey].progress = { state: 'rerouted', at: 1 };
    fs.writeFileSync(path.join(dir, 'chat-cancel-receipts.json'), JSON.stringify(saved));
    expect(() => new ChatCancelReceiptStore(dir)).not.toThrow();
    // Every stored effect is one of the two v1 values.
    for (const value of Object.values(saved.entries)) {
      const outcome = (value as { outcome?: { effect: string } }).outcome;
      if (outcome) expect(EFFECTS).toContain(outcome.effect);
    }
  });

  it('a progress from a newer daemon never disables the store: it reads through the shared normalizer', () => {
    const dir = tmp();
    const store = new ChatCancelReceiptStore(dir);
    const ids = [id(), id(), id(), id()];
    for (const cid of ids) {
      store.insertPending('operator', cid, { paneId: 'pane', fingerprint: fp });
      store.complete('operator', cid, { effect: 'interrupt-requested' }, { state: 'requested', at: 1 });
    }
    const file = path.join(dir, 'chat-cancel-receipts.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const stored = [
      { state: 'ended', endedAs: 'handed-off', evidence: 'telepathy', reason: 'later', at: 7 },
      { state: 'cancelled-natively', at: 8 },
      { state: 'unknown', reason: 'agent-restarted', at: 9 },
      { state: 'ended', at: 'x' },
    ];
    Object.keys(saved.entries).forEach((key, i) => { saved.entries[key].progress = stored[i]; });
    fs.writeFileSync(file, JSON.stringify(saved));
    const reloaded = new ChatCancelReceiptStore(dir, { now: () => 9_000 });
    // Which id got which row follows key order; compare as a set.
    const views = ids.map((cid) => reloaded.progress('operator', cid));
    expect(views).toEqual(expect.arrayContaining([
      // Unknown values and fields that do not belong to the state are dropped.
      { state: 'ended', at: 7 },
      // A state outside the union reads unknown.
      { state: 'unknown', at: 8 },
      // `reason` is an open set.
      { state: 'unknown', reason: 'agent-restarted', at: 9 },
    ]));
    // A malformed `at` falls back to the entry's own time.
    expect(views.some((v) => v?.state === 'ended' && v.at > 1_000_000_000_000)).toBe(true);
    expect(reloaded.insertPending('operator', id(), { paneId: 'pane', fingerprint: fp })).toBe('inserted');
  });

  it('writes the restart settlement once, so its time is stable across later restarts', () => {
    const dir = tmp();
    const store = new ChatCancelReceiptStore(dir, { now: () => 5_000 });
    const cid = id();
    store.insertPending('operator', cid, { paneId: 'pane', fingerprint: fp });
    store.complete('operator', cid, { effect: 'interrupt-requested' }, { state: 'requested', at: 5_000 });
    expect(new ChatCancelReceiptStore(dir, { now: () => 9_000 }).progress('operator', cid)).toMatchObject({ state: 'unknown', at: 9_000 });
    expect(new ChatCancelReceiptStore(dir, { now: () => 12_000 }).progress('operator', cid)).toMatchObject({ state: 'unknown', at: 9_000 });
  });

  it('a failed progress write changes nothing and reports unsaved', () => {
    const dir = tmp();
    let fail = false;
    const store = new ChatCancelReceiptStore(dir, { write: (file, data) => { if (fail) throw new Error('ENOSPC'); fs.writeFileSync(file, JSON.stringify(data)); } });
    const cid = id();
    store.insertPending('operator', cid, { paneId: 'pane', fingerprint: fp });
    store.complete('operator', cid, { effect: 'interrupt-requested' }, { state: 'requested', at: 1 });
    fail = true;
    expect(store.setProgress('operator', cid, { state: 'ended', at: 2 })).toBe('unsaved');
    expect(store.progress('operator', cid)).toMatchObject({ state: 'requested' });
    fail = false;
    expect(store.setProgress('operator', cid, { state: 'ended', at: 3 })).toBe('saved');
    expect(store.setProgress('operator', cid, { state: 'not-ended', at: 4 })).toBe('final');
  });

  it('forgets the write time of a receipt it drops', () => {
    const dir = tmp();
    let clock = Date.now();
    const store = new ChatCancelReceiptStore(dir, { now: () => clock });
    const old = id();
    store.insertPending('operator', old, { paneId: 'pane', fingerprint: fp });
    store.complete('operator', old, { effect: 'interrupt-requested' }, { state: 'requested', at: clock });
    const times = (store as unknown as { requestedAt: Map<string, number> }).requestedAt;
    expect(times.size).toBe(1);
    clock += 25 * 3600_000;
    store.insertPending('operator', `${clock}-${randomUUID()}`, { paneId: 'pane', fingerprint: fp });
    expect(times.size).toBe(0);
  });

  it('refuses a corrupt file rather than forgetting ids that may have pressed ESC', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'chat-cancel-receipts.json'), JSON.stringify({ version: 1, entries: { bad: {} } }));
    expect(() => new ChatCancelReceiptStore(dir)).toThrow();
  });
});
