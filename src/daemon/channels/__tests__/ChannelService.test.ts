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
import { CHANNEL_MENTIONS_MAX } from '../../../shared/channels';

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
  describe('catalog events (A1)', () => {
    it('create emits channel.catalog (created); a PUBLIC channel broadcasts via "*"', async () => {
      const { svc, emit } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      expect(created.ok).toBe(true);
      const evt = emit.mock.calls.at(-1)?.[0];
      expect(evt?.type).toBe('channel.catalog');
      if (evt?.type === 'channel.catalog') {
        expect(evt.reason).toBe('created');
        // A1: a public channel is discoverable by all → '*' broadcast sentinel.
        expect(evt.recipientWorkspaceIds).toContain('*');
      }
    });

    it('create emits channel.catalog (created); a PRIVATE channel notifies only members', async () => {
      const { svc, emit } = makeService();
      const created = await svc.create({
        name: 'secret',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      expect(created.ok).toBe(true);
      const evt = emit.mock.calls.at(-1)?.[0];
      if (evt?.type === 'channel.catalog') {
        expect(evt.recipientWorkspaceIds).toContain('ws-1');
        expect(evt.recipientWorkspaceIds).not.toContain('*');
      }
    });

    it('kick emits channel.catalog (membership) including the ejected workspace', async () => {
      const { svc, emit } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('create failed');
      await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      await svc.kick({
        channelId: created.channel.id,
        targetWorkspaceId: 'ws-2',
        targetMemberId: 'm-2',
        verifiedWorkspaceId: 'ws-1',
      });
      const evt = emit.mock.calls.at(-1)?.[0];
      expect(evt?.type).toBe('channel.catalog');
      if (evt?.type === 'channel.catalog') {
        expect(evt.reason).toBe('membership');
        // the ejected ws-2 is included so its own mirror can drop the channel.
        expect(evt.recipientWorkspaceIds).toContain('ws-2');
      }
    });
  });

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

    it('rejects archive by a NON-MEMBER, non-CEO workspace (NOT_AUTHORIZED)', async () => {
      // Archive is membership-gated (mirrors kick), not creator-only. ws-9 is
      // neither a member (only ws-1 is, added by create) nor the CEO (none
      // wired), so its verified id must be rejected.
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

    it('lets a non-creator MEMBER archive (membership-gated, not creator-only)', async () => {
      // Operator-model rule: archive is gated on MEMBERSHIP, not authorship.
      // createdBy is metadata only — any member may archive. Here ws-2 joins a
      // channel ws-1 created, then archives it successfully.
      const { svc } = makeService();
      const created = await svc.create({
        name: 'shared-room',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const joined = await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'local-ui', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      if (!joined.ok) throw new Error(`expected join ok, got ${joined.error.code}: ${joined.error.message}`);
      const r = await svc.archive({
        channelId: created.channel.id,
        archivedBy: 'ws-2',
        verifiedWorkspaceId: 'ws-2',
      });
      expect(r.ok).toBe(true);
      const ch = svc.get(created.channel.id, 'ws-2');
      expect(ch?.status).toBe('archived');
      expect(ch?.archivedBy).toBe('ws-2');
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

    it('rejects a join on an archived channel (CHANNEL_ARCHIVED) — read-only, mirrors invite/kick (A10)', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const arch = await svc.archive({
        channelId: created.channel.id,
        archivedBy: 'ws-1',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(arch.ok).toBe(true);
      const r = await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('CHANNEL_ARCHIVED');
      // The archived gate rejects before any mutation — ws-2 never joined.
      const members = svc.getMembers(created.channel.id, 'ws-1');
      expect(members.some((m) => m.workspaceId === 'ws-2')).toBe(false);
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

  describe('kick (humans-only eject of another member)', () => {
    async function makeChannelWith(extra: Array<{ ws: string; m: string }>) {
      const { svc, writer } = makeService();
      const created = await svc.create({
        name: 'team',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}`);
      for (const e of extra) {
        const j = await svc.join({
          channelId: created.channel.id,
          member: { workspaceId: e.ws, memberId: e.m, memberName: e.m },
          verifiedWorkspaceId: e.ws,
        });
        if (!j.ok) throw new Error(`join failed: ${j.error.code}`);
      }
      return { svc, writer, channelId: created.channel.id };
    }

    it('removes the target member row (not self-pinned, unlike leave)', async () => {
      const { svc, channelId } = await makeChannelWith([{ ws: 'ws-2', m: 'm-2' }]);
      const r = await svc.kick({
        channelId,
        targetWorkspaceId: 'ws-2',
        targetMemberId: 'm-2',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(true);
      const members = svc.getMembers(channelId, 'ws-1');
      expect(members.some((m) => m.workspaceId === 'ws-2')).toBe(false);
      expect(members).toHaveLength(1);
    });

    it('stamps emptySince when the last member is kicked', async () => {
      const { svc, channelId } = await makeChannelWith([]);
      const r = await svc.kick({
        channelId,
        targetWorkspaceId: 'ws-1',
        targetMemberId: 'm-1',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(true);
      expect(svc.get(channelId, 'ws-1')?.emptySince).toEqual(expect.any(Number));
    });

    it('returns NOT_A_MEMBER when the target is absent', async () => {
      const { svc, channelId } = await makeChannelWith([]);
      const r = await svc.kick({
        channelId,
        targetWorkspaceId: 'ws-ghost',
        targetMemberId: 'm-ghost',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NOT_A_MEMBER');
    });

    it('returns CHANNEL_NOT_FOUND for an unknown channel', async () => {
      const { svc } = makeService();
      const r = await svc.kick({
        channelId: 'ch-nope',
        targetWorkspaceId: 'ws-2',
        targetMemberId: 'm-2',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('CHANNEL_NOT_FOUND');
    });

    it('removes the EXACT (workspace, member) row — a same-memberId sibling in another workspace survives', async () => {
      const { svc, channelId } = await makeChannelWith([
        { ws: 'ws-2', m: 'agent' },
        { ws: 'ws-3', m: 'agent' },
      ]);
      const r = await svc.kick({
        channelId,
        targetWorkspaceId: 'ws-2',
        targetMemberId: 'agent',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(true);
      const members = svc.getMembers(channelId, 'ws-1');
      expect(members.some((m) => m.workspaceId === 'ws-2' && m.memberId === 'agent')).toBe(false);
      expect(members.some((m) => m.workspaceId === 'ws-3' && m.memberId === 'agent')).toBe(true);
    });

    it('PERSIST_FAILED rolls back the removal', async () => {
      const { svc, writer, channelId } = await makeChannelWith([{ ws: 'ws-2', m: 'm-2' }]);
      writer.setFailNext();
      const r = await svc.kick({
        channelId,
        targetWorkspaceId: 'ws-2',
        targetMemberId: 'm-2',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('PERSIST_FAILED');
      const members = svc.getMembers(channelId, 'ws-1');
      expect(members.some((m) => m.workspaceId === 'ws-2' && m.memberId === 'm-2')).toBe(true);
    });

    it('rejects a kick on an archived channel (CHANNEL_ARCHIVED) — read-only, mirrors invite', async () => {
      const { svc, channelId } = await makeChannelWith([{ ws: 'ws-2', m: 'm-2' }]);
      const arch = await svc.archive({ channelId, archivedBy: 'ws-1', verifiedWorkspaceId: 'ws-1' });
      expect(arch.ok).toBe(true);
      const r = await svc.kick({
        channelId,
        targetWorkspaceId: 'ws-2',
        targetMemberId: 'm-2',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('CHANNEL_ARCHIVED');
      // The member survives — the archived gate rejected before any mutation.
      const members = svc.getMembers(channelId, 'ws-1');
      expect(members.some((m) => m.workspaceId === 'ws-2' && m.memberId === 'm-2')).toBe(true);
    });

    it('B5: a non-member cannot kick (actor must be a member)', async () => {
      const { svc, channelId } = await makeChannelWith([{ ws: 'ws-2', m: 'm-2' }]);
      // ws-9 is NOT a member; it must not be able to eject ws-2.
      const r = await svc.kick({
        channelId,
        targetWorkspaceId: 'ws-2',
        targetMemberId: 'm-2',
        verifiedWorkspaceId: 'ws-9',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NOT_AUTHORIZED');
      // ws-2 survives — the actor gate rejected before any mutation.
      expect(svc.getMembers(channelId, 'ws-1').some((m) => m.workspaceId === 'ws-2')).toBe(true);
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

    it('A11: same clientMsgId from different senders does not collide', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('expected create ok');
      await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      const p1 = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'from ws-1',
        clientMsgId: 'shared',
        verifiedWorkspaceId: 'ws-1',
      });
      const p2 = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        text: 'from ws-2',
        clientMsgId: 'shared',
        verifiedWorkspaceId: 'ws-2',
      });
      expect(p1.ok).toBe(true);
      expect(p2.ok).toBe(true);
      if (p1.ok && p2.ok) {
        // ws-2's post is NOT idempotent-suppressed by ws-1's identical clientMsgId.
        expect(p2.message.seq).not.toBe(p1.message.seq);
        expect(p2.message.text).toBe('from ws-2');
        expect(p2.idempotent).toBeUndefined();
      }
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

    it('accepts a post from a member workspace even when memberId differs from create (subscription-level membership; NOT_A_MEMBER regression)', async () => {
      // The agent `member_id` is a client-supplied label (the MCP `member_id`
      // param), NOT a server-verified key. A creator who creates with member_id
      // "lead" and later posts with member_id "backend" (or any other value) is
      // still the SAME verified workspace — membership is keyed on the
      // subscription (workspaceId), so the post must succeed. Previously the
      // (workspaceId, memberId) composite gate rejected this as NOT_A_MEMBER —
      // the live dogfood bug (#2): a channel creator hit NOT_A_MEMBER on first
      // post because its post memberId differed from its create memberId.
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'lead', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`expected create ok, got ${created.error.code}: ${created.error.message}`);
      const r = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'backend', memberName: 'Alice' },
        text: 'same ws, different memberId',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(`expected post ok, got ${r.error.code}: ${r.error.message}`);
      expect(r.message.text).toBe('same ws, different memberId');
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

  describe('post mentions (member-validated, deduped)', () => {
    it('keeps member mentions, drops non-members, dedupes by workspace — on the message AND the event', async () => {
      const { svc, emit } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
      const chId = created.channel.id;
      // ws-2 joins so it is a valid mention target; ws-ghost never joins.
      const joined = await svc.join({
        channelId: chId,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      if (!joined.ok) throw new Error(`join failed: ${joined.error.code}`);

      const post = await svc.post({
        channelId: chId,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hey @Bob — see @Ghost',
        verifiedWorkspaceId: 'ws-1',
        mentions: [
          { workspaceId: 'ws-2', name: 'Bob' }, // member → kept
          { workspaceId: 'ws-2', name: 'Bob (dup)' }, // duplicate workspace → dropped
          { workspaceId: 'ws-ghost', name: 'Ghost' }, // non-member → dropped
        ],
      });

      expect(post.ok).toBe(true);
      if (!post.ok) throw new Error(`post failed: ${post.error.code}`);
      expect(post.message.mentions).toEqual([{ workspaceId: 'ws-2', name: 'Bob' }]);
      // The emitted channel.message event carries the same validated set.
      const evt = emit.mock.calls.at(-1)?.[0];
      // post emits channel.message (the six non-post mutations emit channel.catalog).
      if (evt?.type !== 'channel.message') throw new Error(`expected channel.message emit, got ${evt?.type}`);
      expect(evt.message.mentions).toEqual([{ workspaceId: 'ws-2', name: 'Bob' }]);
      // A2: the non-member mention is reported back to the sender (not silently
      // dropped). The deduped member mention (ws-2 dup) is NOT a drop.
      expect(post.droppedMentions).toEqual([
        { workspaceId: 'ws-ghost', name: 'Ghost', reason: 'not_a_member' },
      ]);
    });

    it('omits the mentions field entirely when none are valid (no empty array)', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('create failed');
      const post = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'no valid mentions',
        verifiedWorkspaceId: 'ws-1',
        mentions: [{ workspaceId: 'ws-ghost', name: 'Ghost' }], // non-member only
      });
      expect(post.ok).toBe(true);
      if (!post.ok) throw new Error('post failed');
      expect(post.message.mentions).toBeUndefined();
      // A2: even when NO mention is valid, the sender still gets feedback.
      expect(post.droppedMentions).toEqual([
        { workspaceId: 'ws-ghost', name: 'Ghost', reason: 'not_a_member' },
      ]);
    });

    it('returns no droppedMentions when every mention is a member (clean post)', async () => {
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('create failed');
      const joined = await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      if (!joined.ok) throw new Error('join failed');
      const post = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'hi @Bob',
        verifiedWorkspaceId: 'ws-1',
        mentions: [{ workspaceId: 'ws-2', name: 'Bob' }],
      });
      expect(post.ok).toBe(true);
      if (!post.ok) throw new Error('post failed');
      expect(post.droppedMentions).toBeUndefined();
    });

    it('replays droppedMentions on an idempotent retry (same client_msg_id)', async () => {
      // Review P1: a retry after a missed first response must still tell the
      // sender the mention was dropped — not a silent drop on the replay.
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('create failed');
      const args = {
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'see @Ghost',
        verifiedWorkspaceId: 'ws-1',
        clientMsgId: 'k1',
        mentions: [{ workspaceId: 'ws-ghost', name: 'Ghost' }],
      };
      const post1 = await svc.post({ ...args });
      expect(post1.ok).toBe(true);
      if (!post1.ok) throw new Error('post1 failed');
      expect(post1.droppedMentions).toEqual([
        { workspaceId: 'ws-ghost', name: 'Ghost', reason: 'not_a_member' },
      ]);
      const post2 = await svc.post({ ...args }); // same clientMsgId → idempotent
      expect(post2.ok).toBe(true);
      if (!post2.ok) throw new Error('post2 failed');
      expect(post2.idempotent).toBe(true);
      expect(post2.droppedMentions).toEqual([
        { workspaceId: 'ws-ghost', name: 'Ghost', reason: 'not_a_member' },
      ]);
    });

    it('rejects a post with more than CHANNEL_MENTIONS_MAX mentions', async () => {
      // Review P2: cap mentions to bound O(mentions x members) under the lock
      // and the droppedMentions response size.
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('create failed');
      const tooMany = Array.from({ length: CHANNEL_MENTIONS_MAX + 1 }, (_, i) => ({
        workspaceId: `ws-${i}`,
        name: `w${i}`,
      }));
      const post = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: 'spam',
        verifiedWorkspaceId: 'ws-1',
        mentions: tooMany,
      });
      expect(post.ok).toBe(false);
      if (post.ok) throw new Error('expected rejection');
      expect(post.error.code).toBe('CHANNEL_MENTIONS_TOO_MANY');
    });

    it('mentions two panes in the same workspace (split) without merging; preserves paneId/ptyId', async () => {
      // Agent-pane redesign: (workspaceId, paneId) dedup lets two agents in ONE
      // workspace (split panes) both be mentioned in a single post. paneId/ptyId
      // pass through opaquely — the receiving renderer owns live-pane resolution.
      const { svc } = makeService();
      const created = await svc.create({
        name: 'general',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
      const joined = await svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      if (!joined.ok) throw new Error(`join failed: ${joined.error.code}`);
      const post = await svc.post({
        channelId: created.channel.id,
        sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        text: '@claude and @codex',
        verifiedWorkspaceId: 'ws-1',
        mentions: [
          { workspaceId: 'ws-2', paneId: 'pane-a', ptyId: 'pty-a', name: 'claude' },
          { workspaceId: 'ws-2', paneId: 'pane-b', ptyId: 'pty-b', name: 'codex' },
          { workspaceId: 'ws-2', paneId: 'pane-a', ptyId: 'pty-a', name: 'claude dup' }, // same (ws,pane) → dropped
        ],
      });
      expect(post.ok).toBe(true);
      if (!post.ok) throw new Error(`post failed: ${post.error.code}`);
      expect(post.message.mentions).toEqual([
        { workspaceId: 'ws-2', paneId: 'pane-a', ptyId: 'pty-a', name: 'claude' },
        { workspaceId: 'ws-2', paneId: 'pane-b', ptyId: 'pty-b', name: 'codex' },
      ]);
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
      // #288: Bob (ws-2) becomes a member of the private channel the ONLY
      // legitimate way — seeded at create time via `members` (the create path
      // bypasses the join visibility gate by design). A post-hoc stranger
      // self-join is now rejected (see the join-gate tests below), so this
      // test must seed membership rather than rely on the old hole.
      const priv = await svc.create({
        name: 'secret',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
        members: [{ workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' }],
      });
      if (!priv.ok) throw new Error('expected create ok');
      // Bob — a seeded member of the private channel — must see it.
      expect(svc.list('ws-2').map((c) => c.name)).toEqual(['secret']);
      // Eve — never a member — must NOT see it.
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

    it('getMessages on a private channel returns full history to a create-seeded member', async () => {
      // #288: after the join visibility gate, a workspace becomes a member of a
      // PRIVATE channel only at create time (`members[]`), and create-seeded
      // members always get historyFromSeq:0 — so they see the FULL history.
      //
      // The "late joiner sees no history" (historyFromSeq>0) scenario is no
      // longer reachable for a private channel via the public API: a stranger
      // can't self-join (gate), and the only includeHistory:false join that
      // passes the gate is a 2nd agent of an ALREADY-member ws — whose floor is
      // masked because getMessages finds the viewer by workspaceId (first match
      // = the ws's create-seeded floor-0 member, ChannelService.ts:322). The
      // getMessages floor-apply branch stays as defensive code for a future
      // invite model; the historyFromSeq SET path is covered by the public
      // includeHistory:false test in `describe('join / leave')`.
      const { svc } = makeService();
      const priv = await svc.create({
        name: 'team',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
        members: [{ workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' }],
      });
      if (!priv.ok) throw new Error('expected create ok');
      // Post a few messages as Alice.
      for (let i = 0; i < 3; i++) {
        await svc.post({
          channelId: priv.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: `msg-${i}`,
          verifiedWorkspaceId: 'ws-1',
        });
      }
      // Alice (creator, floor 0) and Bob (seeded member, floor 0) both see all 3.
      expect(svc.getMessages(priv.channel.id, undefined, 'ws-1')).toHaveLength(3);
      expect(svc.getMessages(priv.channel.id, undefined, 'ws-2')).toHaveLength(3);
      // A stranger still sees nothing (visibility gate on the read path).
      expect(svc.getMessages(priv.channel.id, undefined, 'ws-9')).toEqual([]);
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

    it('getMessages pages: newest-N display without sinceSeq, oldest-N consume with it (undefined limit = full history)', async () => {
      const { svc } = makeService();
      const pub = await svc.create({
        name: 'busy',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!pub.ok) throw new Error('expected create ok');
      for (let i = 1; i <= 5; i++) {
        await svc.post({
          channelId: pub.channel.id,
          sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
          text: `msg-${i}`,
          verifiedWorkspaceId: 'ws-1',
        });
      }
      // Regression guard: omitting limit returns the FULL history (the human
      // ChannelView relies on this — the default-50 lives in the MCP tool, not here).
      expect(svc.getMessages(pub.channel.id, undefined, 'ws-1')).toHaveLength(5);
      // No sinceSeq → display semantics: the most recent N, in seq order.
      expect(svc.getMessages(pub.channel.id, undefined, 'ws-1', 2).map((m) => m.seq)).toEqual([4, 5]);
      // limit >= length returns everything; limit 0 returns nothing.
      expect(svc.getMessages(pub.channel.id, undefined, 'ws-1', 100)).toHaveLength(5);
      expect(svc.getMessages(pub.channel.id, undefined, 'ws-1', 0)).toEqual([]);
      // sinceSeq given → CONSUME semantics: the OLDEST N from the cursor, so
      // paging forward is contiguous and "ack the highest seq you read" can
      // never jump over unseen messages (Codex re-review P1).
      expect(svc.getMessages(pub.channel.id, 3, 'ws-1', 1).map((m) => m.seq)).toEqual([3]);
      expect(svc.getMessages(pub.channel.id, 3, 'ws-1', 0)).toEqual([]);
    });
  });

  // ── P1b: invite (a member adds ANOTHER workspace) ────────────────
  describe('invite', () => {
    const alice = { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' };
    const bob = { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' };

    it('a member invites a non-member into a PRIVATE channel; invitee then sees it + full history', async () => {
      const { svc } = makeService();
      const priv = await svc.create({
        name: 'team',
        visibility: 'private',
        createdBy: alice,
        verifiedWorkspaceId: 'ws-1',
      });
      if (!priv.ok) throw new Error('expected create ok');
      await svc.post({ channelId: priv.channel.id, sender: alice, text: 'hi', verifiedWorkspaceId: 'ws-1' });
      // Bob can't see the private channel yet.
      expect(svc.get(priv.channel.id, 'ws-2')).toBeNull();
      // Alice (member) invites Bob.
      const r = await svc.invite({
        channelId: priv.channel.id,
        invitedMember: bob,
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(true);
      // Bob now sees the channel AND its prior history (includeHistory default = full).
      expect(svc.get(priv.channel.id, 'ws-2')?.id).toBe(priv.channel.id);
      expect(svc.getMessages(priv.channel.id, undefined, 'ws-2')).toHaveLength(1);
    });

    it('rejects a non-member inviter with NOT_AUTHORIZED (public channel)', async () => {
      const { svc } = makeService();
      const pub = await svc.create({ name: 'general', visibility: 'public', createdBy: alice, verifiedWorkspaceId: 'ws-1' });
      if (!pub.ok) throw new Error('expected create ok');
      const r = await svc.invite({
        channelId: pub.channel.id,
        invitedMember: { workspaceId: 'ws-3', memberId: 'm-3', memberName: 'Carol' },
        verifiedWorkspaceId: 'ws-9', // not a member
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('NOT_AUTHORIZED');
    });

    it('hides a PRIVATE channel from a non-member inviter (CHANNEL_NOT_FOUND — no existence leak)', async () => {
      const { svc } = makeService();
      const priv = await svc.create({ name: 'secret', visibility: 'private', createdBy: alice, verifiedWorkspaceId: 'ws-1' });
      if (!priv.ok) throw new Error('expected create ok');
      const r = await svc.invite({
        channelId: priv.channel.id,
        invitedMember: bob,
        verifiedWorkspaceId: 'ws-9',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('CHANNEL_NOT_FOUND');
    });

    it('rejects a duplicate invitee (DUPLICATE_MEMBER)', async () => {
      const { svc } = makeService();
      const pub = await svc.create({ name: 'general', visibility: 'public', createdBy: alice, verifiedWorkspaceId: 'ws-1' });
      if (!pub.ok) throw new Error('expected create ok');
      const first = await svc.invite({ channelId: pub.channel.id, invitedMember: bob, verifiedWorkspaceId: 'ws-1' });
      expect(first.ok).toBe(true);
      const dup = await svc.invite({ channelId: pub.channel.id, invitedMember: bob, verifiedWorkspaceId: 'ws-1' });
      expect(dup.ok).toBe(false);
      if (dup.ok) throw new Error('expected !ok');
      expect(dup.error.code).toBe('DUPLICATE_MEMBER');
    });

    it('includeHistory:false starts the invitee at the current seq (no older history)', async () => {
      const { svc } = makeService();
      const priv = await svc.create({ name: 'team', visibility: 'private', createdBy: alice, verifiedWorkspaceId: 'ws-1' });
      if (!priv.ok) throw new Error('expected create ok');
      await svc.post({ channelId: priv.channel.id, sender: alice, text: 'old', verifiedWorkspaceId: 'ws-1' });
      const r = await svc.invite({
        channelId: priv.channel.id,
        invitedMember: bob,
        includeHistory: false,
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(true);
      expect(svc.getMessages(priv.channel.id, undefined, 'ws-2')).toHaveLength(0);
    });

    it('rejects invites to an archived channel (CHANNEL_ARCHIVED)', async () => {
      const { svc } = makeService();
      const pub = await svc.create({ name: 'general', visibility: 'public', createdBy: alice, verifiedWorkspaceId: 'ws-1' });
      if (!pub.ok) throw new Error('expected create ok');
      await svc.archive({ channelId: pub.channel.id, archivedBy: 'ws-1', verifiedWorkspaceId: 'ws-1' });
      const r = await svc.invite({ channelId: pub.channel.id, invitedMember: bob, verifiedWorkspaceId: 'ws-1' });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('CHANNEL_ARCHIVED');
    });
  });

  describe('#288: join visibility gate (fail-closed private join)', () => {
    it('rejects a non-member self-join of a private channel with CHANNEL_NOT_FOUND (no membership, no persist)', async () => {
      const { svc, writer } = makeService();
      const priv = await svc.create({
        name: 'secret',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!priv.ok) throw new Error('expected create ok');
      const callsBefore = writer.saveImmediate.mock.calls.length;
      // ws-2 is NOT a member and was never invited — the escalation #288 closes.
      const r = await svc.join({
        channelId: priv.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      // CHANNEL_NOT_FOUND (NOT NOT_AUTHORIZED) so a non-member cannot distinguish
      // a private channel they're locked out of from a non-existent id —
      // symmetric with get()/getMembers()/getMessages().
      expect(r.error.code).toBe('CHANNEL_NOT_FOUND');
      // No membership was written (verified from the creator's POV).
      expect(svc.getMembers(priv.channel.id, 'ws-1').map((m) => m.workspaceId)).toEqual(['ws-1']);
      // The gate returned before any mutation → no extra persist call.
      expect(writer.saveImmediate.mock.calls.length).toBe(callsBefore);
    });

    it('still allows a non-member self-join of a PUBLIC channel (gate does not over-tighten)', async () => {
      const { svc } = makeService();
      const pub = await svc.create({
        name: 'lobby',
        visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!pub.ok) throw new Error('expected create ok');
      const r = await svc.join({
        channelId: pub.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
        verifiedWorkspaceId: 'ws-2',
      });
      expect(r.ok).toBe(true);
      expect(svc.getMembers(pub.channel.id, 'ws-2').map((m) => m.workspaceId).sort()).toEqual(['ws-1', 'ws-2']);
    });

    it('an existing member re-joining a private channel gets DUPLICATE_MEMBER (not CHANNEL_NOT_FOUND)', async () => {
      const { svc } = makeService();
      const priv = await svc.create({
        name: 'team',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!priv.ok) throw new Error('expected create ok');
      // ws-1 is already a member (creator) → passes the visibility gate, then
      // hits the precise DUPLICATE_MEMBER — proving the gate doesn't mask it.
      const r = await svc.join({
        channelId: priv.channel.id,
        member: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('DUPLICATE_MEMBER');
    });

    it('allows a 2nd agent of an already-member workspace to join a private channel (read/join symmetry)', async () => {
      // D1: the gate keys on workspaceId (isVisibleTo). If ws-2 already has an
      // agent member, ws-2 can already READ the private channel, so a 2nd ws-2
      // agent joining is consistent — not a new hole. Proves no over-rejection.
      const { svc } = makeService();
      const priv = await svc.create({
        name: 'squad',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
        members: [{ workspaceId: 'ws-2', memberId: 'lead', memberName: 'Lead' }],
      });
      if (!priv.ok) throw new Error('expected create ok');
      // A different agent (memberId 'backend') of the SAME ws-2 joins.
      const r = await svc.join({
        channelId: priv.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'backend', memberName: 'Backend' },
        verifiedWorkspaceId: 'ws-2',
      });
      expect(r.ok).toBe(true);
      const ws2Members = svc
        .getMembers(priv.channel.id, 'ws-2')
        .filter((m) => m.workspaceId === 'ws-2')
        .map((m) => m.memberId)
        .sort();
      expect(ws2Members).toEqual(['backend', 'lead']);
    });

    it('a rejected private join performs no mutation (empty private channel keeps emptySince)', async () => {
      const { svc, writer } = makeService();
      const priv = await svc.create({
        name: 'ghost',
        visibility: 'private',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!priv.ok) throw new Error('expected create ok');
      // Creator leaves → channel is empty, emptySince stamped (reaper-eligible).
      const left = await svc.leave({
        channelId: priv.channel.id,
        workspaceId: 'ws-1',
        memberId: 'm-1',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(left.ok).toBe(true);
      const callsBefore = writer.saveImmediate.mock.calls.length;
      // A stranger tries to join the now-empty private channel. The gate must
      // reject BEFORE the emptySince-clear so the channel stays reapable.
      const r = await svc.join({
        channelId: priv.channel.id,
        member: { workspaceId: 'ws-9', memberId: 'm-9', memberName: 'Eve' },
        verifiedWorkspaceId: 'ws-9',
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected !ok');
      expect(r.error.code).toBe('CHANNEL_NOT_FOUND');
      // No mutation happened → no extra persist (emptySince is untouched).
      expect(writer.saveImmediate.mock.calls.length).toBe(callsBefore);
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
      // A11: the persisted idempotency key is sender-scoped (JSON [ws, clientMsgId]).
      expect(persisted.idempotency[created.channel.id]).toEqual({ '["ws-1","cmid-1"]': originalSeq });
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

describe('ack (A1: delivery receipt makes deliveryStatus real)', () => {
  it('flips the caller recipient + the message to delivered; a repeat ack is a no-op', async () => {
    const { svc } = makeService();
    const created = await svc.create({
      name: 'general',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('create failed');
    const chId = created.channel.id;
    const joined = await svc.join({
      channelId: chId,
      member: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
      verifiedWorkspaceId: 'ws-2',
    });
    if (!joined.ok) throw new Error('join failed');
    const post = await svc.post({
      channelId: chId,
      sender: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      text: 'hi',
      verifiedWorkspaceId: 'ws-1',
    });
    if (!post.ok) throw new Error('post failed');
    expect(post.message.deliveryStatus).toBe('pending'); // nobody received it yet
    const seq = post.message.seq;

    const ack1 = await svc.ack({ channelId: chId, verifiedWorkspaceId: 'ws-2', uptoSeq: seq });
    expect(ack1.ok).toBe(true);
    if (!ack1.ok) throw new Error('ack1 failed');
    expect(ack1.acked).toBe(1);

    const m = svc.getMessages(chId, 0, 'ws-1').find((x) => x.seq === seq);
    expect(m?.deliveryStatus).toBe('delivered');
    expect(m?.recipientSnapshot?.find((r) => r.workspaceId === 'ws-2')?.status).toBe('delivered');

    const ack2 = await svc.ack({ channelId: chId, verifiedWorkspaceId: 'ws-2', uptoSeq: seq });
    expect(ack2.ok).toBe(true);
    if (!ack2.ok) throw new Error('ack2 failed');
    expect(ack2.acked).toBe(0); // already delivered → no change
  });

  it('a non-member ack on a private channel returns CHANNEL_NOT_FOUND (existence hidden)', async () => {
    const { svc } = makeService();
    const created = await svc.create({
      name: 'priv',
      visibility: 'private',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1', memberName: 'Alice' },
      verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('create failed');
    const ack = await svc.ack({
      channelId: created.channel.id,
      verifiedWorkspaceId: 'ws-stranger',
      uptoSeq: 99,
    });
    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected CHANNEL_NOT_FOUND');
    expect(ack.error.code).toBe('CHANNEL_NOT_FOUND');
  });
});

// Keep the imports referenced for type-checking the test file in isolation.
void ({} as ChannelMessage);
