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

  it('refuses a corrupt file rather than forgetting ids that may have pressed ESC', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'chat-cancel-receipts.json'), JSON.stringify({ version: 1, entries: { bad: {} } }));
    expect(() => new ChatCancelReceiptStore(dir)).toThrow();
  });
});
