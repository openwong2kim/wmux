import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatCancelReceiptStore } from '../ChatCancelReceiptStore';
import { ChatSendReceiptStore } from '../ChatSendReceiptStore';

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
    expect(store.progress('device:a', cid)).toBeUndefined();
    expect(store.complete('device:a', cid, { effect: 'interrupt-requested', turnId: 't1:n.1' }, { state: 'requested', at: 5_000 })).toBe(true);
    expect(store.progress('device:a', cid)).toEqual({ state: 'requested', turnId: 't1:n.1', requestedAt: 5_000, at: 5_000 });
    expect(store.progress('device:b', cid)).toBeUndefined();
    expect(store.setProgress('device:a', cid, { state: 'ended', endedAs: 'interrupted', evidence: 'transcript', at: 6_000 })).toBe(true);
    expect(store.setProgress('device:a', cid, { state: 'not-ended', at: 7_000 })).toBe(false);
    expect(store.progress('device:a', cid)).toEqual({ state: 'ended', turnId: 't1:n.1', endedAs: 'interrupted', evidence: 'transcript', requestedAt: 5_000, at: 6_000 });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'chat-cancel-receipts.json'), 'utf8'));
    expect(saved.version).toBe(1);
    expect(Object.values(saved.entries)[0]).toMatchObject({ state: 'final', outcome: { effect: 'interrupt-requested' },
      progress: { state: 'ended', endedAs: 'interrupted', evidence: 'transcript', at: 6_000 } });
  });

  it('a daemon restart turns requested and crashed pending entries into unknown (daemon-restart); settled ones stay', () => {
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
    expect(reloaded.setProgress('operator', requested, { state: 'ended', at: 9_500 })).toBe(false);
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
    // Every stored effect is one of the two v1 values.
    for (const value of Object.values(saved.entries)) {
      const outcome = (value as { outcome?: { effect: string } }).outcome;
      if (outcome) expect(EFFECTS).toContain(outcome.effect);
    }
  });

  it('refuses a malformed progress', () => {
    const dir = tmp();
    const store = new ChatCancelReceiptStore(dir);
    const cid = id();
    store.insertPending('operator', cid, { paneId: 'pane', fingerprint: fp });
    store.complete('operator', cid, { effect: 'interrupt-requested' }, { state: 'requested', at: 1 });
    const file = path.join(dir, 'chat-cancel-receipts.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const progress of [{ state: 'done', at: 1 }, { state: 'ended', at: 'x' }, { state: 'ended', evidence: 'hook', at: 1 }]) {
      const entries = Object.fromEntries(Object.entries(saved.entries).map(([k, v]) => [k, { ...(v as object), progress }]));
      fs.writeFileSync(file, JSON.stringify({ version: 1, entries }));
      expect(() => new ChatCancelReceiptStore(dir)).toThrow();
    }
  });

  it('refuses a corrupt file rather than forgetting ids that may have pressed ESC', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'chat-cancel-receipts.json'), JSON.stringify({ version: 1, entries: { bad: {} } }));
    expect(() => new ChatCancelReceiptStore(dir)).toThrow();
  });
});
