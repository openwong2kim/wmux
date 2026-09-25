import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatSendReceiptStore } from '../ChatSendReceiptStore';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-chat-receipts-')); dirs.push(dir); return dir; };

const NOW = 1_758_712_400_000;
const id = (n: number, at = NOW - 1000) => `${at}-6f1d2c3b-4a59-4e87-9b10-${String(n).padStart(12, '0')}`;
const receipt = (paneId = 'pane-1') => ({ paneId, agentSessionId: 'conv', historyEpoch: 'h1:abc',
  fingerprint: ChatSendReceiptStore.fingerprint(paneId, 'conv', 'h1:abc', 'hello') });

describe('ChatSendReceiptStore', () => {
  it('inserts once, persists pending before returning, and answers exists afterwards', () => {
    const dir = tempDir();
    const store = new ChatSendReceiptStore(dir, { now: () => NOW });
    expect(store.insertPending('desktop', id(1), receipt())).toBe('inserted');
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'chat-send-receipts.json'), 'utf8'));
    expect(Object.values(disk.entries)).toEqual([expect.objectContaining({ state: 'pending', paneId: 'pane-1' })]);
    expect(store.insertPending('desktop', id(1), receipt())).toBe('exists');
    expect(store.view('desktop', 'pane-1', id(1))).toMatchObject({ state: 'pending', agentSessionId: 'conv', historyEpoch: 'h1:abc', at: NOW - 1000 });
  });

  it('leaves no entry when the pending write fails', () => {
    const store = new ChatSendReceiptStore(tempDir(), { now: () => NOW, write: () => { throw new Error('disk full'); } });
    expect(store.insertPending('operator', id(1), receipt())).toBe('persist-failed');
    expect(store.lookup('operator', id(1))).toBeUndefined();
    expect(store.view('operator', 'pane-1', id(1)).state).toBe('unknown');
  });

  it('turns every pending receipt into uncertain after a restart, never pending again', () => {
    const dir = tempDir();
    const first = new ChatSendReceiptStore(dir, { now: () => NOW });
    first.insertPending('device:a', id(1), receipt());
    first.insertPending('device:a', id(2), receipt());
    first.complete('device:a', id(2), { result: 'sent', effect: 'submitted' });
    const second = new ChatSendReceiptStore(dir, { now: () => NOW });
    expect(second.view('device:a', 'pane-1', id(1))).toMatchObject({ state: 'uncertain', result: 'unconfirmed', error: 'delivery-unconfirmed' });
    expect(second.lookup('device:a', id(1))).toMatchObject({ state: 'final', outcome: { effect: 'uncertain' } });
    expect(second.view('device:a', 'pane-1', id(2))).toMatchObject({ state: 'submitted', result: 'sent' });
  });

  it('keeps which limit a text-too-long hit across a restart', () => {
    const dir = tempDir();
    const first = new ChatSendReceiptStore(dir, { now: () => NOW });
    first.insertPending('device:a', id(1), receipt());
    first.complete('device:a', id(1), { result: 'error', effect: 'none', error: 'text-too-long', limit: 'bytes', maxSendBytes: 23000 });
    expect(new ChatSendReceiptStore(dir, { now: () => NOW }).lookup('device:a', id(1)))
      .toMatchObject({ outcome: { error: 'text-too-long', limit: 'bytes', maxSendBytes: 23000 } });
  });

  it('keeps owners and panes apart', () => {
    const store = new ChatSendReceiptStore(tempDir(), { now: () => NOW });
    store.insertPending('device:a', id(1), receipt());
    store.complete('device:a', id(1), { result: 'busy', effect: 'none', error: 'chat-busy' });
    expect(store.view('device:a', 'pane-1', id(1))).toMatchObject({ state: 'refused', error: 'chat-busy' });
    expect(store.view('device:b', 'pane-1', id(1)).state).toBe('unknown');
    expect(store.view('desktop', 'pane-1', id(1)).state).toBe('unknown');
    expect(store.view('device:a', 'pane-2', id(1)).state).toBe('unknown');
    expect(store.lookup('device:b', id(1))).toBeUndefined();
  });

  it('forgets receipts after 24 h', () => {
    let now = NOW;
    const store = new ChatSendReceiptStore(tempDir(), { now: () => now });
    store.insertPending('operator', id(1), receipt());
    now = NOW - 1000 + 24 * 60 * 60 * 1000;
    expect(store.view('operator', 'pane-1', id(1)).state).toBe('unknown');
    expect(store.lookup('operator', id(1))).toBeUndefined();
  });

  it('refuses a new receipt at capacity instead of evicting a retained one', () => {
    const store = new ChatSendReceiptStore(tempDir(), { now: () => NOW, limit: 2 });
    expect(store.insertPending('operator', id(1), receipt())).toBe('inserted');
    expect(store.insertPending('operator', id(2), receipt())).toBe('inserted');
    expect(store.insertPending('operator', id(3), receipt())).toBe('full');
    expect(store.lookup('operator', id(1))).toBeDefined();
  });

  it('refuses to load a corrupt store rather than forgetting what may have been typed', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'chat-send-receipts.json'), JSON.stringify({ version: 1, entries: { nothex: { state: 'final' } } }));
    expect(() => new ChatSendReceiptStore(dir)).toThrow(/Invalid/);
  });

  it('fingerprints the pane, identity, epoch and text but not the pane incarnation', () => {
    const base = ChatSendReceiptStore.fingerprint('p', 'conv', 'h1:x', 'hi');
    expect(ChatSendReceiptStore.fingerprint('p', 'conv', 'h1:x', 'hi')).toBe(base);
    expect(ChatSendReceiptStore.fingerprint('p', 'conv', undefined, 'hi')).not.toBe(base);
    expect(ChatSendReceiptStore.fingerprint('q', 'conv', 'h1:x', 'hi')).not.toBe(base);
    expect(ChatSendReceiptStore.fingerprint('p', 'conv', 'h1:x', 'hi!')).not.toBe(base);
  });
});
