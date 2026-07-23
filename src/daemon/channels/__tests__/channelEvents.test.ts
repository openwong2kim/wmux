// ─── channelEvents (PR3) ──────────────────────────────────────────────
// Locks down channel-domain replay applier contract: determinism + **idempotency**
// (at-least-once §2.6 and stale snapshot-marker absorption — channelEvents.ts header invariants).

import { describe, it, expect } from 'vitest';
import { applyChannelEvent } from '../channelEvents';
import type { ChannelEventPayload } from '../channelEvents';
import {
  CHANNEL_MESSAGES_MAX,
  type Channel,
  type ChannelMember,
  type ChannelMessage,
  type ChannelState,
} from '../../../shared/channels';

function freshState(): ChannelState {
  return { version: 1, channels: [], members: {}, messages: {}, idempotency: {} };
}

function ch(id: string): Channel {
  return {
    id,
    companyId: 'co',
    name: `name-${id}`,
    visibility: 'public',
    status: 'active',
    createdAt: 1000,
    createdBy: 'ws-1',
    nextSeq: 1,
  };
}

function member(ws: string, mid: string): ChannelMember {
  return { workspaceId: ws, memberId: mid, joinedAt: 1000, historyFromSeq: 0, lastReadSeq: 0 };
}

function msg(channelId: string, seq: number, ws = 'ws-1', mid = 'm-1'): ChannelMessage {
  return {
    channelId,
    seq,
    workspaceId: ws,
    memberId: mid,
    memberName: mid,
    text: `t${seq}`,
    postedAt: 1000 + seq,
    deliveryStatus: 'pending',
    recipientSnapshot: [{ workspaceId: 'ws-2', memberId: 'm-2', status: 'pending' }],
  };
}

/** Applying the same payload twice == applying once (idempotency contract). */
function expectIdempotent(state: ChannelState, payload: ChannelEventPayload): void {
  applyChannelEvent(state, payload);
  const after = JSON.parse(JSON.stringify(state));
  applyChannelEvent(state, payload);
  expect(state).toEqual(after);
}

describe('applyChannelEvent — Idempotent replay applicator', () => {
  it('create: Channel/initial member application, reapply no-op', () => {
    const s = freshState();
    expectIdempotent(s, { kind: 'create', channel: ch('c1'), members: [member('ws-1', 'm-1')] });
    expect(s.channels).toHaveLength(1);
    expect(s.members['c1']).toHaveLength(1);
    expect(s.messages['c1']).toEqual([]);
  });

  it('join/invite: Add member + emptySince clear, Reapply duplicate rows no-op', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: { ...ch('c1'), emptySince: 500 }, members: [] });
    expectIdempotent(s, { kind: 'join', channelId: 'c1', member: member('ws-2', 'm-2') });
    expect(s.members['c1']).toHaveLength(1);
    expect(s.channels[0].emptySince).toBeUndefined();
    expectIdempotent(s, { kind: 'invite', channelId: 'c1', member: member('ws-3', 'm-3') });
    expect(s.members['c1']).toHaveLength(2);
  });

  it('leave/kick: remove row + Apply determined emptySince, reapply no-op', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [member('ws-2', 'm-2')] });
    expectIdempotent(s, {
      kind: 'leave', channelId: 'c1', workspaceId: 'ws-2', memberId: 'm-2', emptySince: 2000,
    });
    expect(s.members['c1']).toHaveLength(0);
    expect(s.channels[0].emptySince).toBe(2000);
  });

  it('purge: matcher isomorphism(principalId first of all), reapply no-op', () => {
    const s = freshState();
    const m = { ...member('ws-2', 'm-2'), principalId: 'p-2' };
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [m, member('ws-2', 'other')] });
    expectIdempotent(s, { kind: 'purge', channelId: 'c1', workspaceId: 'ws-2', principalId: 'p-2' });
    // Only principalId-matched row removed — other rows in same ws survive.
    expect(s.members['c1'].map((r) => r.memberId)).toEqual(['other']);
  });

  it('archive: state transition, reapply no-op', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [] });
    expectIdempotent(s, { kind: 'archive', channelId: 'c1', archivedAt: 3000, archivedBy: 'ws-1' });
    expect(s.channels[0].status).toBe('archived');
    expect(s.channels[0].archivedAt).toBe(3000);
  });

  it('post: message push + nextSeq advance + cursor ride + idempotent index, Reapply the same seq no-op', () => {
    const s = freshState();
    applyChannelEvent(s, {
      kind: 'create', channel: ch('c1'), members: [{ ...member('ws-1', 'm-1'), lastReadSeq: 0 }],
    });
    const m = { ...msg('c1', 1), clientMsgId: 'cli-1' };
    expectIdempotent(s, {
      kind: 'post', channelId: 'c1', message: m,
      cursorRide: { workspaceId: 'ws-1', memberId: 'm-1' },
    });
    expect(s.messages['c1']).toHaveLength(1);
    expect(s.channels[0].nextSeq).toBe(2);
    expect(s.members['c1'][0].lastReadSeq).toBe(1); // ride applied, re-apply harmless
    expect(s.idempotency['c1'][JSON.stringify(['ws-1', 'cli-1'])]).toBe(1);
  });

  it('post: When history cap is exceeded trim + Idempotent entry drop for truncated seq(Isomorphic to Live A2)', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [] });
    // clientMsgId only on first/last message — isolate trim-prune from LRU cap eviction.
    for (let i = 1; i <= CHANNEL_MESSAGES_MAX + 1; i++) {
      const withKey = i === 1 || i === CHANNEL_MESSAGES_MAX + 1;
      applyChannelEvent(s, {
        kind: 'post', channelId: 'c1',
        message: { ...msg('c1', i), ...(withKey ? { clientMsgId: `cli-${i}` } : {}) },
      });
    }
    expect(s.messages['c1']).toHaveLength(CHANNEL_MESSAGES_MAX);
    expect(s.messages['c1'][0].seq).toBe(2); // seq 1 trimmed
    // Idempotency entry for trimmed seq(1) dropped; preserved-range entry survives.
    expect(s.idempotency['c1'][JSON.stringify(['ws-1', 'cli-1'])]).toBeUndefined();
    expect(
      s.idempotency['c1'][JSON.stringify(['ws-1', `cli-${CHANNEL_MESSAGES_MAX + 1}`])],
    ).toBe(CHANNEL_MESSAGES_MAX + 1);
  });

  it('ack: pending→delivered flip + advance-only cursor(head clam), reapply no-op', () => {
    const s = freshState();
    applyChannelEvent(s, {
      kind: 'create', channel: ch('c1'), members: [{ ...member('ws-2', 'm-2'), lastReadSeq: 0 }],
    });
    applyChannelEvent(s, { kind: 'post', channelId: 'c1', message: msg('c1', 1) });
    expectIdempotent(s, {
      kind: 'ack', channelId: 'c1', workspaceId: 'ws-2', memberId: 'm-2',
      uptoSeq: 99, ackedAt: 5000, // also exercises head(1) clamp
    });
    const m = s.messages['c1'][0];
    expect(m.deliveryStatus).toBe('delivered');
    expect(m.recipientSnapshot?.[0].status).toBe('delivered');
    expect(m.recipientSnapshot?.[0].lastAttemptAt).toBe(5000);
    expect(s.members['c1'][0].lastReadSeq).toBe(1); // min(99, nextSeq-1)
  });

  it('ack: Cursor cannot move back(advance-only)', () => {
    const s = freshState();
    applyChannelEvent(s, {
      kind: 'create', channel: { ...ch('c1'), nextSeq: 6 },
      members: [{ ...member('ws-2', 'm-2'), lastReadSeq: 5 }],
    });
    applyChannelEvent(s, {
      kind: 'ack', channelId: 'c1', workspaceId: 'ws-2', memberId: 'm-2', uptoSeq: 3, ackedAt: 1,
    });
    expect(s.members['c1'][0].lastReadSeq).toBe(5); // no regression
  });

  it('legacy-reseed Marker, unknown kind, non-object payload: All passed without action', () => {
    const s = freshState();
    const before = JSON.parse(JSON.stringify(s));
    applyChannelEvent(s, { kind: 'legacy-reseed', reseedNumber: 1, stateHash: 'h', detectedAt: 1 });
    applyChannelEvent(s, { kind: 'future-unknown-kind', whatever: true });
    applyChannelEvent(s, null);
    applyChannelEvent(s, 'garbage');
    expect(s).toEqual(before);
  });

  it('Absent Channel Target Event(Remaining records of channels pruned by ripper): no action', () => {
    const s = freshState();
    const before = JSON.parse(JSON.stringify(s));
    applyChannelEvent(s, { kind: 'post', channelId: 'gone', message: msg('gone', 1) });
    applyChannelEvent(s, { kind: 'ack', channelId: 'gone', workspaceId: 'ws-1', uptoSeq: 1, ackedAt: 1 });
    applyChannelEvent(s, { kind: 'archive', channelId: 'gone', archivedAt: 1, archivedBy: 'w' });
    expect(s).toEqual(before);
  });
});
