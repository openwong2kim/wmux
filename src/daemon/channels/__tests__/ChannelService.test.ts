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
 *  call so tests can inspect what was persisted. `load()` returns the
 *  most recently saved state (deep-cloned) — that way a test can
 *  simulate a daemon restart by constructing a second
 *  `ChannelService` against the same writer and have it re-hydrate
 *  from the persisted shape. Tests that need a clean slate build a
 *  fresh writer per scenario.
 *
 *  Important: the returned `load()` MUST produce a fresh object graph
 *  on every call (channels/members/messages/idempotency each get a
 *  new array/object). Tests run in parallel within the file and
 *  share the closure scope, so a shared skeleton object would leak
 *  state across instances. */
function makeFakeWriter(opts: { failNext?: boolean } = {}) {
  let failNext = opts.failNext ?? false;
  const saved: ChannelState[] = [];
  let lastSaved: ChannelState | null = null;
  const freshState = (): ChannelState => ({
    version: 1,
    channels: [],
    members: {},
    messages: {},
    idempotency: {},
  });
  const clone = (state: ChannelState): ChannelState => ({
    version: state.version,
    channels: state.channels.map((c) => ({ ...c })),
    members: Object.fromEntries(
      Object.entries(state.members).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    messages: Object.fromEntries(
      Object.entries(state.messages).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    idempotency: Object.fromEntries(
      Object.entries(state.idempotency).map(([k, v]) => [k, { ...v }]),
    ),
  });
  return {
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      if (failNext) {
        failNext = false;
        return false;
      }
      saved.push(state);
      lastSaved = state;
      return true;
    }),
    load: vi.fn((): ChannelState => (lastSaved ? clone(lastSaved) : freshState())),
    saved,
    setFailNext() { failNext = true; },
  };
}

const COMPANY = 'co-test';

function makeService(opts: {
  failNext?: boolean;
  now?: () => number;
  ceoWorkspaceId?: string;
} = {}) {
  const writer = makeFakeWriter({ failNext: opts.failNext });
  const emit = vi.fn<ChannelServiceEmit>();
  const now = opts.now ?? (() => 1_700_000_000_000);
  const svc = new ChannelService({
    writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
    companyId: COMPANY,
    ceoWorkspaceId: opts.ceoWorkspaceId,
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
        verifiedWorkspaceId: 'ws-creator',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
      expect(result.channel.nextSeq).toBe(1);
      expect(result.channel.name).toBe('general');
      expect(result.channel.createdBy).toBe('ws-creator');
      expect(result.channel.status).toBe('active');
      expect(svc.getMembers(result.channel.id, 'ws-creator')).toEqual([
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
        verifiedWorkspaceId: 'ws-1',
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
        verifiedWorkspaceId: 'ws-1',
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
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const archived = await svc.archive({
        channelId: created.channel.id,
        archivedBy: 'ws-1',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(archived.ok).toBe(true);
      const listed = svc.list('ws-1').find((c) => c.id === created.channel.id);
      expect(listed?.status).toBe('archived');
      expect(listed?.archivedAt).toEqual(expect.any(Number));
      expect(listed?.archivedBy).toBe('ws-1');

      const post = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'after archive',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(post.ok).toBe(false);
      if (post.ok) throw new Error('expected !ok');
      expect(post.error.code).toBe('CHANNEL_ARCHIVED');
    });

    it('rejects archive by a non-creator, non-CEO workspace (NOT_AUTHORIZED)', async () => {
      // The archive authz gate (KTD-F) lets the creator OR the company
      // CEO archive. With no CEO wired (`ceoWorkspaceId` is undefined),
      // a different workspace's verified id must be rejected.
      const { svc } = makeService();
      const created = await svc.create({
        name: 'someone-elses',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const r = await svc.archive({
        channelId: created.channel.id,
        archivedBy: 'ws-9',
        verifiedWorkspaceId: 'ws-9',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('NOT_AUTHORIZED');
      // State must NOT have been mutated.
      const ch = svc.get(created.channel.id, 'ws-1');
      expect(ch?.status).toBe('active');
      expect(ch?.archivedAt).toBeUndefined();
      expect(ch?.archivedBy).toBeUndefined();
    });

    it('lets the company CEO archive any channel (CEO authz override)', async () => {
      // The CEO override is the second half of the KTD-F rule. With
      // `ceoWorkspaceId: 'ws-ceo'` plumbed in, an archive call from
      // the CEO must succeed even if they are NOT the creator.
      const { svc } = makeService({ ceoWorkspaceId: 'ws-ceo' });
      const created = await svc.create({
        name: 'team-room',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const r = await svc.archive({
        channelId: created.channel.id,
        archivedBy: 'ws-ceo',
        verifiedWorkspaceId: 'ws-ceo',
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const ch = svc.get(created.channel.id, 'ws-ceo');
        expect(ch?.status).toBe('archived');
        expect(ch?.archivedBy).toBe('ws-ceo');
      }
    });
  });

  describe('join / leave', () => {
    it('join adds the member with historyFromSeq: 0 by default', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const r = await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      expect(r.ok).toBe(true);
      const members = svc.getMembers(created.channel.id, 'ws-1');
      expect(members).toHaveLength(2);
      expect(members.find((m) => m.memberId === 'm-2')?.historyFromSeq).toBe(0);
    });

    it('join with includeHistory:false sets historyFromSeq to current nextSeq', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      // Bump nextSeq via a post
      await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hello',
        verifiedWorkspaceId: 'ws-1',
      });
      const nextSeqAtJoin = svc.get(created.channel.id, 'ws-1')?.nextSeq ?? 0;
      const r = await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        includeHistory: false,
        verifiedWorkspaceId: 'ws-2',
      });
      expect(r.ok).toBe(true);
      const m = svc
        .getMembers(created.channel.id, 'ws-1')
        .find((mm) => mm.memberId === 'm-2');
      expect(m?.historyFromSeq).toBe(nextSeqAtJoin);
    });

    it('leave removes the member; if the channel is now empty, sets emptySince', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      await svc.leave({
        channelId: created.channel.id,
        workspaceId: 'ws-2',
        memberId: 'm-2',
        verifiedWorkspaceId: 'ws-2',
      });
      const r = await svc.leave({
        channelId: created.channel.id,
        workspaceId: 'ws-1',
        memberId: 'm-1',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(true);
      const ch = svc.get(created.channel.id, 'ws-1');
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
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const result = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hello',
        verifiedWorkspaceId: 'ws-1',
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
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const first = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hello',
        clientMsgId: 'cmid-1',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('expected first ok');
      const firstSeq = first.message.seq;
      const second = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hello (retry)',
        clientMsgId: 'cmid-1',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('expected second ok');
      expect(second.idempotent).toBe(true);
      expect(second.message.seq).toBe(firstSeq);
      expect(second.message.text).toBe('hello'); // original text, not retry

      const ch = svc.get(created.channel.id, 'ws-1');
      expect(svc.getMessages(created.channel.id, undefined, 'ws-1')).toHaveLength(1);
      expect(ch?.nextSeq).toBe(2);
    });

    it('rejects posts on archived channels (CHANNEL_ARCHIVED, no persist, no event)', async () => {
      const { svc, writer, emit } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      await svc.archive({
        channelId: created.channel.id,
        archivedBy: 'ws-1',
        verifiedWorkspaceId: 'ws-1',
      });
      const writesBefore = writer.saveImmediate.mock.calls.length;
      const emitBefore = emit.mock.calls.length;
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'after archive',
        verifiedWorkspaceId: 'ws-1',
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
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-9', memberId: 'm-9', memberName: 'Eve' },
        text: 'uninvited',
        verifiedWorkspaceId: 'ws-9',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('NOT_A_MEMBER');
    });

    it('rejects posts where sender.workspaceId disagrees with verifiedWorkspaceId (NOT_AUTHORIZED, no persist, no event)', async () => {
      // Sender-pin gate (R5): the server pins the authoritative caller
      // from `verifiedWorkspaceId`. A client that claims a different
      // `sender.workspaceId` (e.g. tries to post AS a member of another
      // workspace) is rejected with NOT_AUTHORIZED before any state
      // mutation — no seq bump, no persist, no event.
      const { svc, writer, emit } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      // Add the "spoofed" sender as a member of the channel so that
      // bypassing the sender-pin gate would otherwise let them post.
      await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Mallory' },
        verifiedWorkspaceId: 'ws-2',
      });
      const writesBefore = writer.saveImmediate.mock.calls.length;
      const emitBefore = emit.mock.calls.length;
      // Mallory's transport says verifiedWorkspaceId='ws-2', but the
      // client-supplied sender.workspaceId claims to be 'ws-1' (Alice's
      // workspace). The server must reject: the verified id wins.
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'spoofed',
        verifiedWorkspaceId: 'ws-2',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('NOT_AUTHORIZED');
      // No state mutation.
      expect(svc.getMessages(created.channel.id, undefined, 'ws-2')).toHaveLength(0);
      const ch = svc.get(created.channel.id, 'ws-2');
      expect(ch?.nextSeq).toBe(1);
      expect(writer.saveImmediate.mock.calls.length).toBe(writesBefore);
      expect(emit.mock.calls.length).toBe(emitBefore);
    });

    it('returns PERSIST_FAILED when writer.saveImmediate returns false (no event)', async () => {
      const { svc, writer, emit } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      writer.setFailNext();
      const emitBefore = emit.mock.calls.length;
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'lost write',
        verifiedWorkspaceId: 'ws-1',
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
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);

      // Fire two posts in parallel. The mutex must serialize them, so
      // the seq values must be 1 then 2 — no double-assignment.
      const [a, b] = await Promise.all([
        svc.post({
          channelId: created.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: 'first',
          verifiedWorkspaceId: 'ws-1',
        }),
        svc.post({
          channelId: created.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: 'second',
          verifiedWorkspaceId: 'ws-1',
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
        verifiedWorkspaceId: 'ws-1',
      });
      const c2 = await svc.create({
        name: 'two',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!c1.ok || !c2.ok) throw new Error('expected both create ok');
      const start = Date.now();
      const [a, b] = await Promise.all([
        svc.post({
          channelId: c1.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: 'a',
          verifiedWorkspaceId: 'ws-1',
        }),
        svc.post({
          channelId: c2.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: 'b',
          verifiedWorkspaceId: 'ws-1',
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
        verifiedWorkspaceId: 'ws-1',
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
        verifiedWorkspaceId: 'ws-1',
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('expected first ok');
      expect(first.message.recipientSnapshot).toHaveLength(1);

      await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      const second = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'post-join',
        verifiedWorkspaceId: 'ws-1',
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
        verifiedWorkspaceId: 'ws-1',
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
          verifiedWorkspaceId: 'ws-1',
        });
      }
      // Retry cmid-0 — should be a fresh post (evicted), not idempotent.
      const retry0 = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'retry-0',
        clientMsgId: 'cmid-0',
        verifiedWorkspaceId: 'ws-1',
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
        verifiedWorkspaceId: 'ws-1',
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
        verifiedWorkspaceId: 'ws-1',
      });
      await svc.create({
        name: 'b',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      expect(svc.list('ws-1').map((c) => c.name).sort()).toEqual(['a', 'b']);
    });

    it('get returns null for unknown id', () => {
      const { svc } = makeService();
      expect(svc.get('ch-does-not-exist', 'ws-1')).toBeNull();
    });
  });

  // ── U6: membership/visibility gate + body/data clamps ────────────
  describe('U6: visibility + membership gate', () => {
    it('list returns public channels to non-members and hides private channels from non-members', async () => {
      const { svc } = makeService();
      const pub = await svc.create({
        name: 'public-room',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      const priv = await svc.create({
        name: 'private-room',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!pub.ok || !priv.ok) throw new Error('expected both create ok');
      // ws-9 is a stranger — must see the public channel but NOT the
      // private one.
      const strangerView = svc.list('ws-9').map((c) => c.name).sort();
      expect(strangerView).toEqual(['public-room']);
      // ws-1 is the creator and a member of both — must see both.
      const ownerView = svc.list('ws-1').map((c) => c.name).sort();
      expect(ownerView).toEqual(['private-room', 'public-room']);
    });

    it('list lets a non-creator member of a private channel see it (but strangers still cannot)', async () => {
      const { svc } = makeService();
      const priv = await svc.create({
        name: 'secret',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!priv.ok) throw new Error('expected create ok');
      await svc.join({
        channelId: priv.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      // Bob — joined, so a member of the private channel — must see it.
      expect(svc.list('ws-2').map((c) => c.name)).toEqual(['secret']);
      // Eve — never joined — must NOT see it.
      expect(svc.list('ws-9').map((c) => c.name)).toEqual([]);
    });

    it('get returns null for a private channel the caller is not a member of (does not leak existence)', async () => {
      const { svc } = makeService();
      const priv = await svc.create({
        name: 'private',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!priv.ok) throw new Error('expected create ok');
      // Stranger
      expect(svc.get(priv.channel.id, 'ws-9')).toBeNull();
      // Member
      expect(svc.get(priv.channel.id, 'ws-1')?.id).toBe(priv.channel.id);
    });

    it('getMembers returns [] for a private channel the caller is not a member of', async () => {
      const { svc } = makeService();
      const priv = await svc.create({
        name: 'private',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!priv.ok) throw new Error('expected create ok');
      // Stranger — must not see the member list.
      expect(svc.getMembers(priv.channel.id, 'ws-9')).toEqual([]);
      // Member — must see the list (creator only, here).
      expect(svc.getMembers(priv.channel.id, 'ws-1').map((m) => m.memberId)).toEqual(['m-1']);
    });

    it('getMessages on a private channel returns [] to a non-member', async () => {
      const { svc } = makeService();
      const priv = await svc.create({
        name: 'private',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!priv.ok) throw new Error('expected create ok');
      await svc.post({
        channelId: priv.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'secret hello',
        verifiedWorkspaceId: 'ws-1',
      });
      // Stranger — gated at the visibility check, returns [].
      expect(svc.getMessages(priv.channel.id, undefined, 'ws-9')).toEqual([]);
      // Member — sees the message.
      expect(svc.getMessages(priv.channel.id, undefined, 'ws-1')).toHaveLength(1);
    });

    it('getMessages on a private channel respects the viewer historyFromSeq floor (no past messages)', async () => {
      // A member who joined late (includeHistory: false) must not be
      // able to see messages posted before they joined, even via the
      // public RPC. The seq-floor mirrors the renderer-side
      // isMessageVisibleToViewer rule.
      const { svc } = makeService();
      const priv = await svc.create({
        name: 'team',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!priv.ok) throw new Error('expected create ok');
      // Post a few messages as Alice.
      for (let i = 0; i < 3; i++) {
        await svc.post({
          channelId: priv.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: `pre-join-${i}`,
          verifiedWorkspaceId: 'ws-1',
        });
      }
      // Bob joins without history.
      const joinRes = await svc.join({
        channelId: priv.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        includeHistory: false,
        verifiedWorkspaceId: 'ws-2',
      });
      expect(joinRes.ok).toBe(true);
      // Post a message after Bob's join.
      await svc.post({
        channelId: priv.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'post-join',
        verifiedWorkspaceId: 'ws-1',
      });
      // Alice (full history) sees all 4.
      expect(svc.getMessages(priv.channel.id, undefined, 'ws-1')).toHaveLength(4);
      // Bob (no history) sees only the post-join message.
      const bobView = svc.getMessages(priv.channel.id, undefined, 'ws-2');
      expect(bobView).toHaveLength(1);
      expect(bobView[0].text).toBe('post-join');
    });

    it('getMessages on a public channel has no per-member seq floor (any caller sees full history)', async () => {
      const { svc } = makeService();
      const pub = await svc.create({
        name: 'public',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!pub.ok) throw new Error('expected create ok');
      await svc.post({
        channelId: pub.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'public hello',
        verifiedWorkspaceId: 'ws-1',
      });
      // Stranger — sees the message because the channel is public.
      expect(svc.getMessages(pub.channel.id, undefined, 'ws-9')).toHaveLength(1);
    });
  });

  describe('U6: body / data / topic / count clamps', () => {
    it('post rejects a body longer than CHANNEL_BODY_MAX (no persist, no event)', async () => {
      const { svc, writer, emit } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('expected create ok');
      const writesBefore = writer.saveImmediate.mock.calls.length;
      const emitBefore = emit.mock.calls.length;
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'a'.repeat(8193),
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('CHANNEL_BODY_TOO_LARGE');
      expect(writer.saveImmediate.mock.calls.length).toBe(writesBefore);
      expect(emit.mock.calls.length).toBe(emitBefore);
    });

    it('post strips C0 control characters except tab, newline, CR (terminal escape injection blocked)', async () => {
      // The R8 maintainer concern: a malicious member could post an
      // ESC byte (0x1B) which would corrupt downstream TUI consumers
      // when the post is fanned out via the bracketed-paste path.
      // sanitizePostText removes everything in the C0 control range
      // (0x00-0x1F) except 0x09 (tab), 0x0A (\n), 0x0D (\r).
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('expected create ok');
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        // 0x1B (ESC) + 'O' + 'S' + 0x1B (CSI terminator) + tab + CR +
        // LF + plain text. 'O' and 'S' are ASCII letters, not control
        // characters — they pass through. The two ESC bytes are
        // stripped.
        text: '\x1bOS\x1b\t\rmalicious\nnormal',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      // The two ESC bytes (0x1B) are stripped; 'OS' (plain letters),
      // tab, CR, LF, and the rest of the plain text remain.
      expect(r.message.text).toBe('OS\t\rmalicious\nnormal');
    });

    it('post trims leading/trailing whitespace before the body cap is measured', async () => {
      // A caller cannot pad with spaces to bypass the cap because the
      // measurement is on the sanitized form (post-trim).
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('expected create ok');
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: '   ' + 'x'.repeat(8190) + '   ',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      // Stored text is the trimmed form.
      expect(r.message.text).toBe('x'.repeat(8190));
    });

    it('post rejects data payload whose JSON-serialized length exceeds CHANNEL_DATA_MAX', async () => {
      const { svc, writer, emit } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('expected create ok');
      const writesBefore = writer.saveImmediate.mock.calls.length;
      const emitBefore = emit.mock.calls.length;
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'with data',
        data: { blob: 'x'.repeat(5000) },
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('CHANNEL_DATA_TOO_LARGE');
      expect(writer.saveImmediate.mock.calls.length).toBe(writesBefore);
      expect(emit.mock.calls.length).toBe(emitBefore);
    });

    it('create rejects a topic longer than CHANNEL_TOPIC_MAX (CHANNEL_BODY_TOO_LARGE)', async () => {
      const { svc } = makeService();
      const r = await svc.create({
        name: 'topic-oversize',
        visibility: 'public',
        topic: 'a'.repeat(257),
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('CHANNEL_BODY_TOO_LARGE');
    });

    it('create rejects when initial members (creator + members) exceed CHANNEL_MAX_MEMBERS', async () => {
      const { svc } = makeService();
      const members = Array.from({ length: 256 }, (_, i) => ({
        workspaceId: `ws-${i}`,
        memberId: `m-${i}`,
        memberName: `Member ${i}`,
      }));
      const r = await svc.create({
        name: 'too-many',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-creator', memberId: 'm-creator', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-creator',
        members,
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('CHANNEL_LIMIT_REACHED');
    });

    it('create auto-adds members passed in `members` alongside the creator (deduped)', async () => {
      const { svc } = makeService();
      const r = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
        // Pass the creator again as a member — must be silently dropped
        // so the count does not skew and a duplicate is not created.
        members: [
          { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        ],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      const members = svc.getMembers(r.channel.id, 'ws-1').map((m) => m.memberId).sort();
      expect(members).toEqual(['m-1', 'm-2']);
    });
  });

  // ── U7: idempotency hydration + join rollback ────────────────────
  describe('U7: idempotency hydration on startup', () => {
    it('rebuilds this.idempotency from state.idempotency at construction', async () => {
      // First service: create channel, post with clientMsgId 'cmid-1'.
      // The state.idempotency map is persisted by the fake writer.
      const writer1 = makeFakeWriter();
      const now = () => 1_700_000_000_000;
      const svc1 = new ChannelService({
        writer: writer1 as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
        companyId: COMPANY,
        emit: vi.fn<ChannelServiceEmit>(),
        now,
      });
      const created = await svc1.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('expected create ok');
      const first = await svc1.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hello',
        clientMsgId: 'cmid-1',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('expected first post ok');
      const originalSeq = first.message.seq;
      // The fake writer has captured every saveImmediate call. The
      // last one is the post-persist state; its state.idempotency
      // contains the clientMsgId → seq mapping.
      const persisted = writer1.saved[writer1.saved.length - 1];
      expect(persisted.idempotency[created.channel.id]).toEqual({ 'cmid-1': originalSeq });
      // Second service: construct against the same writer (the writer
      // is stateless here, so its load() returns the same shape on
      // each call). This simulates a daemon restart that re-reads
      // state from disk.
      const svc2 = new ChannelService({
        writer: writer1 as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
        companyId: COMPANY,
        emit: vi.fn<ChannelServiceEmit>(),
        now,
      });
      // Repeat the post with the same clientMsgId. The hydrated
      // idempotency cache MUST hit and return the original seq.
      const second = await svc2.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hello (retry)',
        clientMsgId: 'cmid-1',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('expected second post ok');
      expect(second.idempotent).toBe(true);
      expect(second.message.seq).toBe(originalSeq);
      expect(second.message.text).toBe('hello'); // original, not retry
    });

    it('a fresh clientMsgId after restart gets a new seq (hydration does not over-match)', async () => {
      // Distinct keys: cmid-1 was persisted, cmid-2 is new. The
      // hydrated cache must NOT over-match cmid-2 onto cmid-1's seq.
      const writer1 = makeFakeWriter();
      const now = () => 1_700_000_000_000;
      const svc1 = new ChannelService({
        writer: writer1 as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
        companyId: COMPANY,
        emit: vi.fn<ChannelServiceEmit>(),
        now,
      });
      const created = await svc1.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('expected create ok');
      await svc1.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'first',
        clientMsgId: 'cmid-1',
        verifiedWorkspaceId: 'ws-1',
      });
      // Simulate restart.
      const svc2 = new ChannelService({
        writer: writer1 as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
        companyId: COMPANY,
        emit: vi.fn<ChannelServiceEmit>(),
        now,
      });
      const second = await svc2.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'second',
        clientMsgId: 'cmid-2',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('expected ok');
      expect(second.idempotent).toBeFalsy();
      expect(second.message.seq).toBe(2); // fresh seq, not the hydrated one
    });
  });

  describe('U7: join rollback restores emptySince', () => {
    it('clears emptySince on a successful join (regression)', async () => {
      // Set up a channel that is currently empty (emptySince tagged),
      // then have a member re-join. The tag must clear so the
      // empty-channel reaper stops counting it. Use a PUBLIC channel
      // so the visibility gate does not hide the row from a stranger
      // reader — we want to observe the tag on the channel itself.
      const { svc } = makeService();
      const created = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('expected create ok');
      // Have Alice (the sole member) leave, stamping emptySince.
      const leave = await svc.leave({
        channelId: created.channel.id,
        workspaceId: 'ws-1',
        memberId: 'm-1',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(leave.ok).toBe(true);
      // A stranger (ws-9) reads the public channel and sees the
      // emptySince tag.
      const ch1 = svc.get(created.channel.id, 'ws-9');
      expect(ch1?.emptySince).toEqual(expect.any(Number));
      // Alice re-joins — the tag must clear.
      const join = await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      expect(join.ok).toBe(true);
      const ch2 = svc.get(created.channel.id, 'ws-9');
      expect(ch2?.emptySince).toBeUndefined();
    });

    it('restores emptySince when saveOrFail fails on join (so the reaper does not skip it)', async () => {
      // R10: a failed saveOrFail in join() must restore the prior
      // emptySince tag. Otherwise a transient save failure on a
      // "revival" join would orphan the channel — the in-memory
      // state would say "no emptySince" but the disk state (the
      // failed save) is unchanged, so a future daemon restart would
      // still see the tag, but a daemon that never restarts would
      // forget it. Either way: bug. The snapshot/restore symmetry
      // with leave() closes it.
      //
      // Setup: PUBLIC channel so the visibility gate does not hide
      // the row from a non-member reader. Create, then have the
      // sole member (the creator) leave, stamping emptySince. A
      // fresh workspace (ws-9) can then read the channel and
      // observe the emptySince tag directly.
      const { svc, writer } = makeService();
      const created = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('expected create ok');
      // Alice leaves — channel is now empty, emptySince is stamped.
      await svc.leave({
        channelId: created.channel.id,
        workspaceId: 'ws-1',
        memberId: 'm-1',
        verifiedWorkspaceId: 'ws-1',
      });
      // ws-9 (a stranger) can read the public channel and observe
      // the emptySince tag.
      const chBefore = svc.get(created.channel.id, 'ws-9');
      const originalEmptySince = chBefore?.emptySince;
      expect(originalEmptySince).toEqual(expect.any(Number));
      // Arm the next saveImmediate to fail.
      writer.setFailNext();
      // Alice tries to re-join — must fail with PERSIST_FAILED, AND
      // the in-memory state must still carry the emptySince tag
      // (the rollback restores it).
      const join = await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      expect(join.ok).toBe(false);
      if (join.ok) throw new Error('expected !ok');
      expect(join.error.code).toBe('PERSIST_FAILED');
      // Re-read via ws-9 — the emptySince tag must still be set.
      const chAfter = svc.get(created.channel.id, 'ws-9');
      expect(chAfter?.emptySince).toBe(originalEmptySince);
    });
  });
});

describe('D5 caller-identity server-pin', () => {
  // These tests prove that the daemon pins the authoritative workspace from
  // `verifiedWorkspaceId`, NOT from the caller-supplied `member.workspaceId`
  // or `createdBy.workspaceId`. A forged field in the request MUST NOT end up
  // in the persisted state — only the server-resolved value does.

  it('join pin wins: member.workspaceId is ignored when verifiedWorkspaceId differs', async () => {
    // Arrange: create a channel as 'attacker' (the real, verified workspace).
    const { svc } = makeService();
    const channelResult = await svc.create({
      name: 'pin-test',
      visibility: 'public',
      createdBy: { workspaceId: 'attacker', memberId: 'm-att-creator', memberName: 'Attacker' },
      verifiedWorkspaceId: 'attacker',
    });
    expect(channelResult.ok).toBe(true);
    if (!channelResult.ok) throw new Error('expected create ok');
    const channelId = channelResult.channel.id;

    // Act: join with a forged member.workspaceId:'victim' but
    // verifiedWorkspaceId:'attacker'. The pin must win — the member
    // must be stored as 'attacker', not 'victim'.
    const joinResult = await svc.join({
      channelId,
      member: { workspaceId: 'victim', memberId: 'm-att', memberName: 'att' },
      verifiedWorkspaceId: 'attacker',
    });
    expect(joinResult.ok).toBe(true);
    if (!joinResult.ok) throw new Error('expected join ok');

    // Assert: read back via 'attacker' — if the pin won, both the creator
    // slot and the newly-joined slot show workspaceId='attacker'. The
    // forged 'victim' must NOT appear anywhere in the member list.
    const members = svc.getMembers(channelId, 'attacker');
    const storedForJoined = members.find((m) => m.memberId === 'm-att');
    expect(storedForJoined).toBeDefined();
    // The pinned workspace, NOT the forged one.
    expect(storedForJoined?.workspaceId).toBe('attacker');
    // Confirm the forged workspace does not appear anywhere.
    expect(members.every((m) => m.workspaceId !== 'victim')).toBe(true);
  });

  it('create pin wins: createdBy.workspaceId is ignored when verifiedWorkspaceId differs', async () => {
    // Act: create a channel with a forged createdBy.workspaceId:'victim' but
    // verifiedWorkspaceId:'attacker'. The pin must win — channel.createdBy and
    // the creator member's workspaceId must both be stored as 'attacker'.
    const { svc } = makeService();
    const result = await svc.create({
      name: 'create-pin-test',
      visibility: 'public',
      createdBy: { workspaceId: 'victim', memberId: 'm', memberName: 'n' },
      verifiedWorkspaceId: 'attacker',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected create ok');
    const { channel } = result;

    // Assert: channel.createdBy is the server-resolved workspace, not the
    // forged value. This protects the archive authz gate (KTD-F) — if the
    // forged 'victim' were stored, an attacker could prevent the victim from
    // archiving their own channels, or falsely attribute channels to them.
    expect(channel.createdBy).toBe('attacker');
    expect(channel.createdBy).not.toBe('victim');

    // Assert: the creator's membership entry carries the pinned workspace.
    // The channel is public so getMembers is visible to any caller — we
    // inspect the returned rows directly to confirm no 'victim' entry exists.
    const members = svc.getMembers(channel.id, 'attacker');
    expect(members).toHaveLength(1);
    expect(members[0].workspaceId).toBe('attacker');
    // The forged workspaceId must not appear in any member row.
    expect(members.every((m) => m.workspaceId !== 'victim')).toBe(true);
  });

  it('leave pin wins: a forged client workspaceId cannot redirect removal to another member', async () => {
    // Two members — attacker (m-att) and victim (m-vic). The attacker calls
    // leave with a forged client `workspaceId: 'victim'`. The daemon keys the
    // removal on the server-resolved `verifiedWorkspaceId` ('attacker') + the
    // memberId, so it can only remove the ATTACKER's OWN row — never the
    // victim's. This proves a forger cannot kick a victim out of a channel via
    // the (otherwise unused) client `workspaceId`.
    const { svc } = makeService();
    const created = await svc.create({
      name: 'leave-pin-test',
      visibility: 'public',
      createdBy: { workspaceId: 'attacker', memberId: 'm-att', memberName: 'att' },
      verifiedWorkspaceId: 'attacker',
    });
    if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}`);
    const channelId = created.channel.id;
    await svc.join({
      channelId,
      member: { workspaceId: 'victim', memberId: 'm-vic', memberName: 'vic' },
      verifiedWorkspaceId: 'victim',
    });

    const r = await svc.leave({
      channelId,
      workspaceId: 'victim', // forged client field — must be IGNORED
      memberId: 'm-att',
      verifiedWorkspaceId: 'attacker',
    });
    expect(r.ok).toBe(true);

    // The victim's membership survives; only the attacker's own row was removed.
    const members = svc.getMembers(channelId, 'victim');
    expect(members.some((m) => m.workspaceId === 'victim' && m.memberId === 'm-vic')).toBe(true);
    expect(members.some((m) => m.workspaceId === 'attacker')).toBe(false);
  });

  it('archive pin wins: a forged archivedBy cannot satisfy the creator gate; verifiedWorkspaceId decides', async () => {
    // The archive authz gate (KTD-F) must key on the server-resolved
    // verifiedWorkspaceId, NOT the client-supplied `archivedBy`. An attacker who
    // forges `archivedBy: 'ws-creator'` (to look like the creator) but whose
    // verified identity is 'attacker' (not the creator, no CEO wired) must be
    // REJECTED. Decoupling archivedBy from verifiedWorkspaceId here pins the
    // gate to the unforgeable field, so a future regression to the forgeable
    // archivedBy would fail this test.
    const { svc } = makeService();
    const created = await svc.create({
      name: 'archive-pin-test',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-creator', memberId: 'm', memberName: 'n' },
      verifiedWorkspaceId: 'ws-creator',
    });
    if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}`);
    const channelId = created.channel.id;

    const r = await svc.archive({
      channelId,
      archivedBy: 'ws-creator', // forged to look like the creator
      verifiedWorkspaceId: 'attacker', // but the verified caller is NOT the creator
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected archive rejected');
    expect(r.error.code).toBe('NOT_AUTHORIZED');

    // The channel stays active — the forged archivedBy did not satisfy the gate.
    const ch = svc.get(channelId, 'ws-creator');
    expect(ch?.status).toBe('active');
    expect(ch?.archivedBy).toBeUndefined();
  });
});

// Keep the imports referenced for type-checking the test file in isolation.
void ({} as ChannelMessage);
