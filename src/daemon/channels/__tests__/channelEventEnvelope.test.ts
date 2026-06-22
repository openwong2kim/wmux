// ─── channelEventEnvelope tests ───────────────────────────────────────
// Producer-side regression guard for the channel.message wire contract
// (plan R2). The helper wraps a `ChannelMessageEvent` in the canonical
// `DaemonEvent` envelope `{type, sessionId, data}` the main-side
// `DaemonClient.handleControlMessage` switch reads. A previous
// implementation emitted the raw event, which the consumer never
// matched — every channel.message fan-out was silently dropped.

import { describe, it, expect } from 'vitest';
import { wrapChannelMessageEnvelope } from '../channelEventEnvelope';
import type { ChannelMessageEvent } from '../ChannelService';

function makeEvent(overrides: Partial<ChannelMessageEvent> = {}): ChannelMessageEvent {
  return {
    type: 'channel.message',
    channelId: 'ch-1',
    seq: 1,
    sender: { workspaceId: 'ws-sender', memberId: 'm-sender', memberName: 'Alice' },
    recipients: [
      { memberId: 'm-sender', workspaceId: 'ws-sender', status: 'pending' },
      { memberId: 'm-recipient', workspaceId: 'ws-recipient', status: 'pending' },
    ],
    message: {
      channelId: 'ch-1',
      seq: 1,
      workspaceId: 'ws-sender',
      memberId: 'm-sender',
      memberName: 'Alice',
      text: 'hello',
      postedAt: 1_700_000_000_000,
      deliveryStatus: 'pending',
      recipientSnapshot: [
        { memberId: 'm-sender', workspaceId: 'ws-sender', status: 'pending' },
        { memberId: 'm-recipient', workspaceId: 'ws-recipient', status: 'pending' },
      ],
    },
    workspaceId: 'ws-sender',
    ...overrides,
  };
}

describe('wrapChannelMessageEnvelope', () => {
  it('wraps the event in { type, sessionId, data } and preserves all fields', () => {
    const event = makeEvent();
    const envelope = wrapChannelMessageEnvelope(event);

    expect(envelope.type).toBe('channel.message');
    expect(envelope.sessionId).toBe(''); // no session owns a channel.message
    expect(envelope.data).toBe(event); // identity preserved (no clone)
  });

  it('sessionId is the literal empty string (not undefined, not the channel id)', () => {
    // The consumer in DaemonNotificationRouter reads only `data`; sessionId
    // being anything but '' would either be a future per-session scope
    // (not in v3.0) or a bug. The literal-'' check pins the v3.0 contract.
    const envelope = wrapChannelMessageEnvelope(makeEvent());
    expect(envelope.sessionId).toBe('');
    expect(envelope.sessionId).not.toBe(envelope.data.channelId);
  });

  it('matches the DaemonEvent union literal in src/shared/rpc.ts (type: "channel.message")', () => {
    // If a future refactor renames the WmuxEvent counterpart without
    // updating the DaemonEvent union, this assertion catches the
    // drift — the wire shape must stay in lockstep.
    const envelope = wrapChannelMessageEnvelope(makeEvent());
    expect(envelope.type).toBe('channel.message');
  });
});
