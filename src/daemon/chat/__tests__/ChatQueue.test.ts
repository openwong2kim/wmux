import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_QUEUE_MAX_ITEMS, ChatQueueStore } from '../ChatQueue';
import { ChatSendReceiptStore } from '../ChatSendReceiptStore';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-queue-')); dirs.push(dir); return dir; };
const id = () => `${Date.now()}-${randomUUID()}`;

describe('ChatQueueStore', () => {
  it('keeps FIFO order per pane and caps active items per pane and owner', () => {
    const store = new ChatQueueStore(tmp());
    const ids = Array.from({ length: CHAT_QUEUE_MAX_ITEMS }, id);
    for (const cmid of ids) expect(store.insert('device:a', 'pane', cmid)).toBe('inserted');
    expect(store.insert('device:a', 'pane', id())).toBe('full');
    // Another owner and another pane have their own cap.
    expect(store.insert('device:b', 'pane', id())).toBe('inserted');
    expect(store.insert('device:a', 'other', id())).toBe('inserted');
    expect(store.head('pane')?.clientMessageId).toBe(ids[0]);
    store.transition('device:a', ids[0], 'delivered');
    expect(store.head('pane')?.clientMessageId).toBe(ids[1]);
    expect(store.insert('device:a', 'pane', id())).toBe('inserted');
    expect(store.get('device:b', ids[1])).toBeUndefined();
  });

  it('never writes the prompt text, and a restart cancels queued and marks delivering uncertain', () => {
    const dir = tmp();
    const store = new ChatQueueStore(dir);
    const [queued, delivering, delivered] = [id(), id(), id()];
    store.insert('device:a', 'pane', queued);
    store.insert('device:a', 'pane', delivering);
    store.insert('device:a', 'pane', delivered);
    store.transition('device:a', delivering, 'delivering', undefined, { strict: true });
    store.transition('device:a', delivered, 'delivered');
    const raw = fs.readFileSync(path.join(dir, 'chat-queue.json'), 'utf8');
    expect(Object.keys(JSON.parse(raw).entries[0]).sort()).toEqual(['at', 'clientMessageId', 'owner', 'paneId', 'queuedAt', 'state']);

    const reloaded = new ChatQueueStore(dir);
    expect(reloaded.get('device:a', queued)).toMatchObject({ state: 'canceled', reason: 'daemon-restart' });
    expect(reloaded.get('device:a', delivering)).toMatchObject({ state: 'uncertain', reason: 'restart-uncertain' });
    expect(reloaded.get('device:a', delivered)).toMatchObject({ state: 'delivered' });
    expect(reloaded.hasActive('pane')).toBe(false);
  });

  it('a strict transition that cannot persist leaves the record as it was', () => {
    let fail = false;
    const store = new ChatQueueStore(tmp(), { write: (file, data) => {
      if (fail) throw new Error('disk full');
      fs.writeFileSync(file, JSON.stringify(data));
    } });
    const cmid = id();
    store.insert('operator', 'pane', cmid);
    fail = true;
    expect(store.transition('operator', cmid, 'delivering', undefined, { strict: true })).toBeUndefined();
    expect(store.get('operator', cmid)?.state).toBe('queued');
    expect(store.transition('operator', cmid, 'canceled', 'user')?.state).toBe('canceled');
  });

  it('rollback: the queue file sits beside send receipts the existing loader still reads', () => {
    const dir = tmp();
    const receipts = new ChatSendReceiptStore(dir);
    const store = new ChatQueueStore(dir);
    const cmid = id();
    store.insert('device:a', 'pane', cmid);
    const fp = ChatSendReceiptStore.fingerprint('pane', 'conv', 'h1:x', 'hello');
    expect(receipts.insertPending('device:a', cmid, { paneId: 'pane', fingerprint: fp, agentSessionId: 'conv', historyEpoch: 'h1:x' })).toBe('inserted');
    receipts.complete('device:a', cmid, { result: 'sent', effect: 'submitted' });
    store.transition('device:a', cmid, 'delivered');
    // An older daemon has no queue loader: it reads only the send receipts,
    // whose vocabulary the queue never extends.
    expect(new ChatSendReceiptStore(dir).view('device:a', 'pane', cmid)).toMatchObject({ state: 'submitted', result: 'sent' });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'chat-send-receipts.json'), 'utf8'));
    expect(saved.version).toBe(1);
  });

  it('refuses a corrupt file', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'chat-queue.json'), JSON.stringify({ version: 1, entries: [{ state: 'queued' }] }));
    expect(() => new ChatQueueStore(dir)).toThrow();
  });
});
