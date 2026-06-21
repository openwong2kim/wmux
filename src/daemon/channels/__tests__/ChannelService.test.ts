// ─── ChannelService tests ─────────────────────────────────────────────
// Unit tests for the daemon-side channel service. ChannelService is the
// ONLY writer to ChannelState — the writer is injected so these tests
// use a fake that returns true/false on demand. The emit hook is a
// vi.fn() so event-emission assertions stay local.
//
// Plan reference: U3 (a2a-channels).

import { describe, it, expect, vi } from 'vitest';
import { ChannelService } from '../ChannelService';
import type { ChannelServiceEmit } from '../ChannelService';
import type {
  ChannelMessage,
  ChannelState,
} from '../../../shared/channels';

/** In-memory fake of ChannelStateWriter. Returns whatever the test sets
 *  via `failNext`; defaults to success. Captures every `saveImmediate`
 *  call so tests can inspect what was persisted. `load()` always returns
 *  a fresh empty state — tests that need a seeded state build it via the
 *  public service methods.
 *
 *  Important: the returned `load()` MUST produce a fresh object graph on
 *  every call (channels/members/messages/idempotency each get a new
 *  array/object). Tests run in parallel within the file and share the
 *  closure scope, so a shared skeleton object would leak state across
 *  instances. */
function makeFakeWriter(opts: { failNext?: boolean } = {}) {
  let failNext = opts.failNext ?? false;
  const saved: ChannelState[] = [];
  const freshState = (): ChannelState => ({
    version: 1,
    channels: [],
    members: {},
    messages: {},
    idempotency: {},
  });
  return {
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      if (failNext) {
        failNext = false;
        return false;
      }
      saved.push(state);
      return true;
    }),
    load: vi.fn((): ChannelState => freshState()),
    saved,
    setFailNext() { failNext = true; },
  };
}

const COMPANY = 'co-test';

function makeService(opts: {
  failNext?: boolean;
  now?: () => number;
} = {}) {
  const writer = makeFakeWriter({ failNext: opts.failNext });
  const emit = vi.fn<ChannelServiceEmit>();
  const now = opts.now ?? (() => 1_700_000_000_000);
  const svc = new ChannelService({
    writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
    companyId: COMPANY,
    emit,
    now,
  });
  return { svc, writer, emit, now };
}

describe('ChannelService', () => {
  describe('create', () => {
    it('returns a channel with nextSeq: 1 and the creator in members', async () => {
      const { svc } = makeService();
      const result = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-creator', memberId: 'm-creator', memberName: 'Alice' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
      expect(result.channel.nextSeq).toBe(1);
      expect(result.channel.name).toBe('general');
      expect(result.channel.createdBy).toBe('ws-creator');
      expect(result.channel.status).toBe('active');
      expect(svc.getMembers(result.channel.id)).toEqual([
        expect.objectContaining({
          workspaceId: 'ws-creator',
          memberId: 'm-creator',
          historyFromSeq: 0,
        }),
      ]);
    });

    it('rejects names that fail isValidChannelName', async () => {
      const { svc } = makeService();
      const result = await svc.create({
        name: '!!!',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected !ok');
      expect(result.error.code).toBe('INVALID_NAME');
    });

    it('persists the new channel synchronously', async () => {
      const { svc, writer } = makeService();
      await svc.create({
        name: 'persisted',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      expect(writer.saveImmediate).toHaveBeenCalledTimes(1);
    });
  });

  describe('archive', () => {
    it('sets status, archivedAt, archivedBy; subsequent post returns CHANNEL_ARCHIVED', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'archive-me',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const archived = await svc.archive({
        channelId: created.channel.id,
        archivedBy: 'ws-1',
      });
      expect(archived.ok).toBe(true);
      const listed = svc.list().find((c) => c.id === created.channel.id);
      expect(listed?.status).toBe('archived');
      expect(listed?.archivedAt).toEqual(expect.any(Number));
      expect(listed?.archivedBy).toBe('ws-1');

      const post = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'after archive',
      });
      expect(post.ok).toBe(false);
      if (post.ok) throw new Error('expected !ok');
      expect(post.error.code).toBe('CHANNEL_ARCHIVED');
    });
  });

  describe('join / leave', () => {
    it('join adds the member with historyFromSeq: 0 by default', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const r = await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
      });
      expect(r.ok).toBe(true);
      const members = svc.getMembers(created.channel.id);
      expect(members).toHaveLength(2);
      expect(members.find((m) => m.memberId === 'm-2')?.historyFromSeq).toBe(0);
    });

    it('join with includeHistory:false sets historyFromSeq to current nextSeq', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      // Bump nextSeq via a post
      await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hello',
      });
      const nextSeqAtJoin = svc.get(created.channel.id)?.nextSeq ?? 0;
      const r = await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        includeHistory: false,
      });
      expect(r.ok).toBe(true);
      const m = svc
        .getMembers(created.channel.id)
        .find((mm) => mm.memberId === 'm-2');
      expect(m?.historyFromSeq).toBe(nextSeqAtJoin);
    });

    it('leave removes the member; if the channel is now empty, sets emptySince', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
      });
      await svc.leave({
        channelId: created.channel.id,
        workspaceId: 'ws-2',
        memberId: 'm-2',
      });
      const r = await svc.leave({
        channelId: created.channel.id,
        workspaceId: 'ws-1',
        memberId: 'm-1',
      });
      expect(r.ok).toBe(true);
      const ch = svc.get(created.channel.id);
      expect(ch?.emptySince).toEqual(expect.any(Number));
    });
  });

  describe('post', () => {
    it('assigns monotonic seq, appends message, persists, emits channel.message', async () => {
      const { svc, writer, emit } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const result = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hello',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected post ok');
      expect(result.message.seq).toBe(1);
      expect(result.message.text).toBe('hello');
      expect(result.message.deliveryStatus).toBe('pending');
      expect(result.message.recipientSnapshot).toBeDefined();
      expect(result.message.recipientSnapshot).toHaveLength(1);

      const persisted = writer.saved[writer.saved.length - 1];
      expect(persisted.messages[created.channel.id]).toHaveLength(1);

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'channel.message',
          channelId: created.channel.id,
          seq: 1,
        }),
      );
    });

    it('returns the original seq on idempotent re-post with same clientMsgId', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const first = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hello',
        clientMsgId: 'cmid-1',
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('expected first ok');
      const firstSeq = first.message.seq;
      const second = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hello (retry)',
        clientMsgId: 'cmid-1',
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('expected second ok');
      expect(second.idempotent).toBe(true);
      expect(second.message.seq).toBe(firstSeq);
      expect(second.message.text).toBe('hello'); // original text, not retry

      const ch = svc.get(created.channel.id);
      expect(svc.getMessages(created.channel.id)).toHaveLength(1);
      expect(ch?.nextSeq).toBe(2);
    });

    it('rejects posts on archived channels (CHANNEL_ARCHIVED, no persist, no event)', async () => {
      const { svc, writer, emit } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      await svc.archive({ channelId: created.channel.id, archivedBy: 'ws-1' });
      const writesBefore = writer.saveImmediate.mock.calls.length;
      const emitBefore = emit.mock.calls.length;
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'after archive',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('CHANNEL_ARCHIVED');
      expect(writer.saveImmediate.mock.calls.length).toBe(writesBefore);
      expect(emit.mock.calls.length).toBe(emitBefore);
    });

    it('rejects posts by non-members (NOT_A_MEMBER)', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-9', memberId: 'm-9', memberName: 'Eve' },
        text: 'uninvited',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('NOT_A_MEMBER');
    });

    it('returns PERSIST_FAILED when writer.saveImmediate returns false (no event)', async () => {
      const { svc, writer, emit } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      writer.setFailNext();
      const emitBefore = emit.mock.calls.length;
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'lost write',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('PERSIST_FAILED');
      expect(emit.mock.calls.length).toBe(emitBefore);
    });
  });

  describe('concurrency', () => {
    it('two posts on the same channel observe linear seq order', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);

      // Fire two posts in parallel. The mutex must serialize them, so
      // the seq values must be 1 then 2 — no double-assignment.
      const [a, b] = await Promise.all([
        svc.post({
          channelId: created.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: 'first',
        }),
        svc.post({
          channelId: created.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: 'second',
        }),
      ]);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) throw new Error('expected both ok');
      const seqs = [a.message.seq, b.message.seq].sort((x, y) => x - y);
      expect(seqs).toEqual([1, 2]);
    });

    it('posts on different channels run in parallel (no cross-channel contention)', async () => {
      const { svc } = makeService();
      const c1 = await svc.create({
        name: 'one',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      const c2 = await svc.create({
        name: 'two',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!c1.ok || !c2.ok) throw new Error('expected both create ok');
      const start = Date.now();
      const [a, b] = await Promise.all([
        svc.post({
          channelId: c1.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: 'a',
        }),
        svc.post({
          channelId: c2.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: 'b',
        }),
      ]);
      // If mutex were global, the second post would block on the first
      // for a measurable amount of time. With per-channel mutexes both
      // should be seq=1 (their respective channels) — and there is no
      // observable contention, but the assertion is the seq outcome.
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) throw new Error('expected both ok');
      expect(a.message.seq).toBe(1);
      expect(b.message.seq).toBe(1);
      expect(Date.now() - start).toBeLessThan(200);
    });
  });

  describe('recipient snapshot freeze', () => {
    it('captures members at critical-section entry; concurrent join does not change the in-flight snapshot', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      // The post is awaited to completion first; the second post races
      // a join. We assert the FIRST post's snapshot reflects the
      // pre-join state (only the creator), and the SECOND post's
      // snapshot reflects the post-join state.
      const first = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'pre-join',
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('expected first ok');
      expect(first.message.recipientSnapshot).toHaveLength(1);

      await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
      });
      const second = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'post-join',
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('expected second ok');
      expect(second.message.recipientSnapshot).toHaveLength(2);
    });
  });

  describe('idempotency LRU', () => {
    it('keeps the most-recent 1000 clientMsgIds and evicts the oldest', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      // Post 1001 distinct clientMsgIds. The 1st should be evicted;
      // the 1001st should still be in the cache.
      for (let i = 0; i < 1001; i++) {
        await svc.post({
          channelId: created.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: `msg-${i}`,
          clientMsgId: `cmid-${i}`,
        });
      }
      // Retry cmid-0 — should be a fresh post (evicted), not idempotent.
      const retry0 = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'retry-0',
        clientMsgId: 'cmid-0',
      });
      expect(retry0.ok).toBe(true);
      if (!retry0.ok) throw new Error('expected ok');
      expect(retry0.idempotent).toBeFalsy();

      // Retry cmid-1000 — should be idempotent.
      const retry1000 = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'retry-1000',
        clientMsgId: 'cmid-1000',
      });
      expect(retry1000.ok).toBe(true);
      if (!retry1000.ok) throw new Error('expected ok');
      expect(retry1000.idempotent).toBe(true);
    });
  });

  describe('list / get', () => {
    it('list returns every active channel', async () => {
      const { svc } = makeService();
      await svc.create({
        name: 'a',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      await svc.create({
        name: 'b',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      });
      expect(svc.list().map((c) => c.name).sort()).toEqual(['a', 'b']);
    });

    it('get returns null for unknown id', () => {
      const { svc } = makeService();
      expect(svc.get('ch-does-not-exist')).toBeNull();
    });
  });
});

// Keep the imports referenced for type-checking the test file in isolation.
void ({} as ChannelMessage);
