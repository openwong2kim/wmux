import { describe, it, expect } from 'vitest';
import type { ChannelMessage } from '../../../../shared/channels';
import {
  ownMessageDeliveryState,
  DELIVERY_UNCONFIRMED_AFTER_MS,
  DELIVERY_LABEL_KEY,
  DELIVERY_LABEL_FALLBACK,
} from '../deliveryStatus';

const T0 = 1_700_000_000_000;

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channelId: 'ch-1',
    seq: 1,
    workspaceId: 'ws-1',
    memberId: 'me',
    memberName: 'me',
    text: 'hi',
    postedAt: T0,
    deliveryStatus: 'pending',
    ...overrides,
  };
}

describe('ownMessageDeliveryState (C-2)', () => {
  it("says nothing about someone else's message", () => {
    expect(
      ownMessageDeliveryState({ message: message({ memberId: 'other' }), viewerMemberId: 'me', now: T0 }),
    ).toBeUndefined();
    expect(ownMessageDeliveryState({ message: message(), viewerMemberId: null, now: T0 })).toBeUndefined();
  });

  it('reports delivered when ANY other recipient got it — the old code read the absent self row', () => {
    const m = message({
      recipientSnapshot: [
        { memberId: 'a', workspaceId: 'ws-a', status: 'delivered' },
        { memberId: 'b', workspaceId: 'ws-b', status: 'target_gone' },
      ],
    });
    expect(ownMessageDeliveryState({ message: m, viewerMemberId: 'me', now: T0 })).toBe('delivered');
  });

  it('reports target_gone only when every recipient is gone', () => {
    const m = message({
      recipientSnapshot: [
        { memberId: 'a', workspaceId: 'ws-a', status: 'target_gone' },
        { memberId: 'b', workspaceId: 'ws-b', status: 'target_gone' },
      ],
    });
    expect(ownMessageDeliveryState({ message: m, viewerMemberId: 'me', now: T0 })).toBe('target_gone');
  });

  it('an exhausted nudge episode outranks a delivered write', () => {
    const m = message({
      recipientSnapshot: [{ memberId: 'a', workspaceId: 'ws-a', status: 'delivered' }],
    });
    expect(
      ownMessageDeliveryState({
        message: m,
        viewerMemberId: 'me',
        now: T0,
        exhaustedMemberIds: new Set(['a']),
      }),
    ).toBe('nudge_exhausted');
  });

  it('stops the eternal "… sending": an aged pending becomes unconfirmed', () => {
    const m = message({ recipientSnapshot: [{ memberId: 'a', workspaceId: 'ws-a', status: 'pending' }] });
    expect(ownMessageDeliveryState({ message: m, viewerMemberId: 'me', now: T0 + 1_000 })).toBe('pending');
    expect(
      ownMessageDeliveryState({ message: m, viewerMemberId: 'me', now: T0 + DELIVERY_UNCONFIRMED_AFTER_MS + 1 }),
    ).toBe('unconfirmed');
  });

  it('ages the optimistic row too (no snapshot yet), and keeps a non-pending message-level status', () => {
    expect(
      ownMessageDeliveryState({
        message: message(),
        viewerMemberId: 'me',
        now: T0 + DELIVERY_UNCONFIRMED_AFTER_MS + 1,
      }),
    ).toBe('unconfirmed');
    expect(
      ownMessageDeliveryState({
        message: message({ deliveryStatus: 'delivered' }),
        viewerMemberId: 'me',
        now: T0 + DELIVERY_UNCONFIRMED_AFTER_MS + 1,
      }),
    ).toBe('delivered');
  });

  it('says nothing when the frozen recipient set holds nobody but the sender', () => {
    const m = message({ recipientSnapshot: [{ memberId: 'me', workspaceId: 'ws-1', status: 'pending' }] });
    expect(ownMessageDeliveryState({ message: m, viewerMemberId: 'me', now: T0 })).toBeUndefined();
  });

  it('has a locale key and an English fallback for every state', () => {
    for (const state of Object.keys(DELIVERY_LABEL_KEY) as (keyof typeof DELIVERY_LABEL_KEY)[]) {
      expect(DELIVERY_LABEL_KEY[state]).toMatch(/^channels\./);
      expect(DELIVERY_LABEL_FALLBACK[state].length).toBeGreaterThan(0);
    }
  });
});
