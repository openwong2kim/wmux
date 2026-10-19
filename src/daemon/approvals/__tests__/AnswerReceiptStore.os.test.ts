import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnswerReceiptStore, ANSWER_RECEIPT_RETENTION_MS, receiptHash } from '../AnswerReceiptStore';

let dir: string;
const BODY = receiptHash(['ap-1', { action: 'approve' }]);
const OTHER = receiptHash(['ap-1', { action: 'deny' }]);
const FINAL = { status: 200, body: { state: 'resolved', effect: 'complete', durable: true } };

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-answer-receipts-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('AnswerReceiptStore', () => {
  it('in flight → 202 for a retry, then the stored final response', async () => {
    const store = new AnswerReceiptStore(dir);
    expect(await store.begin('device:d1', 'answer-0000000001', 'ap-1', BODY)).toEqual({ kind: 'new' });
    expect(await store.begin('device:d1', 'answer-0000000001', 'ap-1', BODY)).toEqual({ kind: 'in-flight' });
    await store.finish('device:d1', 'answer-0000000001', 'done', FINAL);
    expect(await store.begin('device:d1', 'answer-0000000001', 'ap-1', BODY)).toEqual({ kind: 'replay', response: FINAL, state: 'done' });
    expect(store.lookup('device:d1', 'answer-0000000001')).toMatchObject({ approvalId: 'ap-1', state: 'done', result: FINAL });
  });

  it('the same id with another body, or for another approval, is answer-id-reused', async () => {
    const store = new AnswerReceiptStore(dir);
    await store.begin('device:d1', 'answer-0000000001', 'ap-1', BODY);
    expect(await store.begin('device:d1', 'answer-0000000001', 'ap-1', OTHER)).toEqual({ kind: 'reused' });
    expect(await store.begin('device:d1', 'answer-0000000001', 'ap-2', BODY)).toEqual({ kind: 'reused' });
  });

  it('ids are per owner: another device\'s id is its own, and not readable by the first', async () => {
    const store = new AnswerReceiptStore(dir);
    await store.begin('device:d1', 'answer-0000000001', 'ap-1', BODY);
    expect(await store.begin('device:d2', 'answer-0000000001', 'ap-1', OTHER)).toEqual({ kind: 'new' });
    expect(store.lookup('operator', 'answer-0000000001')).toBeNull();
  });

  it('an answer in flight when the daemon stopped comes back uncertain and is never re-run', async () => {
    const store = new AnswerReceiptStore(dir);
    await store.begin('device:d1', 'answer-0000000001', 'ap-1', BODY);
    await store.begin('device:d1', 'answer-0000000002', 'ap-1', OTHER);
    await store.finish('device:d1', 'answer-0000000002', 'refused', { status: 410, body: { error: 'expired', effect: 'none' } });
    const reloaded = new AnswerReceiptStore(dir);
    expect(await reloaded.begin('device:d1', 'answer-0000000001', 'ap-1', BODY)).toEqual({ kind: 'uncertain' });
    expect(reloaded.lookup('device:d1', 'answer-0000000001')).toMatchObject({ state: 'uncertain' });
    expect(await reloaded.begin('device:d1', 'answer-0000000002', 'ap-1', OTHER)).toMatchObject({ kind: 'replay', state: 'refused' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, 'phone-answer-receipts.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('a final result that cannot reach disk reads back as uncertain, never done', async () => {
    if (process.platform === 'win32') return;
    const store = new AnswerReceiptStore(dir);
    await store.begin('device:d1', 'answer-0000000001', 'ap-1', BODY);
    fs.chmodSync(dir, 0o500);
    try {
      await store.finish('device:d1', 'answer-0000000001', 'done', FINAL);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(store.peek('device:d1', 'answer-0000000001', 'ap-1', BODY)).toEqual({ kind: 'uncertain' });
  });

  it('a released id is checked again; the answer text itself is never written', async () => {
    const store = new AnswerReceiptStore(dir);
    await store.begin('device:d1', 'answer-0000000001', 'ap-1', BODY);
    await store.release('device:d1', 'answer-0000000001');
    expect(await store.begin('device:d1', 'answer-0000000001', 'ap-1', BODY)).toEqual({ kind: 'new' });
    expect(fs.readFileSync(path.join(dir, 'phone-answer-receipts.json'), 'utf8')).not.toContain('approve');
  });

  it('a full owner refuses new ids without evicting old ones; receipts age out after 24h', async () => {
    const clock = { now: 1_000_000 };
    const store = new AnswerReceiptStore(dir, () => clock.now, 2);
    await store.begin('operator', 'answer-0000000001', 'ap-1', BODY);
    await store.begin('operator', 'answer-0000000002', 'ap-1', BODY);
    await store.finish('operator', 'answer-0000000001', 'done', FINAL);
    await store.finish('operator', 'answer-0000000002', 'done', FINAL);
    expect(await store.begin('operator', 'answer-0000000003', 'ap-1', BODY)).toEqual({ kind: 'full' });
    expect(await store.begin('operator', 'answer-0000000001', 'ap-1', BODY)).toMatchObject({ kind: 'replay' });
    clock.now += ANSWER_RECEIPT_RETENTION_MS + 1;
    expect(await store.begin('operator', 'answer-0000000003', 'ap-1', BODY)).toEqual({ kind: 'new' });
  });
});
