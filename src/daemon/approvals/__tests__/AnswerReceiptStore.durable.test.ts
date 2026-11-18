// A receipt store asked to be durable fsyncs every write (atomicWrite's
// `durable`) before it resolves; one that is not asked writes as before.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => [] as Array<unknown[]>);
vi.mock('../../util/atomicWrite', () => ({
  atomicReadJSONSync: () => null,
  atomicWriteJSON: async (...args: unknown[]) => { writes.push(args); },
}));

import { AnswerReceiptStore } from '../AnswerReceiptStore';

beforeEach(() => { writes.length = 0; });

describe('AnswerReceiptStore durable', () => {
  it('passes durable on every write when asked', async () => {
    const store = new AnswerReceiptStore('/nowhere', () => 1_000, undefined, 'a2a-remote-approval-receipts.json', true);
    expect(await store.begin('remote:h', 'ap-1', 'task:p:allow', 'a'.repeat(64))).toEqual({ kind: 'new' });
    await store.finish('remote:h', 'ap-1', 'done', { status: 200, body: { outcome: 'done' } });
    expect(writes).toHaveLength(2);
    for (const w of writes) expect(w[2]).toEqual({ durable: true });
  });

  it('does not otherwise', async () => {
    const store = new AnswerReceiptStore('/nowhere', () => 1_000);
    await store.begin('device', 'c-1', 'appr-1', 'b'.repeat(64));
    expect(writes[0]?.[2]).toEqual({});
  });
});
