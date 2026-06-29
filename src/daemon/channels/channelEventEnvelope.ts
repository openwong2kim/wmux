// ─── channel.message envelope wrapping ────────────────────────────────
// Producer-side helper for the channel.message wire contract. The
// daemon-side `ChannelService.post` emits a raw `ChannelMessageEvent`
// (a plain ChannelMessageEvent shape — channelId, seq, sender,
// recipients, message, workspaceId). The transport layer wraps it in
// the canonical `DaemonEvent` envelope before broadcasting on the
// control pipe; the main-side `DaemonClient.handleControlMessage`
// switch reads `event.data` (case 'channel.message') and re-emits it as
// `channel:message` for the in-process bus bridge.
//
// `sessionId` is the empty string — no PTY session owns a channel
// message, and the consumer in `DaemonNotificationRouter` reads only
// `data` (per the doc comment in `src/shared/rpc.ts:DaemonEvent`).
//
// Extracted as a standalone helper so the envelope shape can be unit
// tested without spinning up the full daemon pipe plumbing. The fix
// history (plan R2) shows the prior producer emitted a raw event,
// which the main-side consumer never matched — production was silently
// dropping every channel.message fan-out.

import type { ChannelMessageEvent, ChannelCatalogEvent } from './ChannelService';

/** Canonical DaemonEvent envelope for a channel.message broadcast. */
export interface ChannelMessageDaemonEvent {
  type: 'channel.message';
  sessionId: '';
  data: ChannelMessageEvent;
}

/**
 * Wrap a `ChannelMessageEvent` in the DaemonEvent envelope the daemon
 * control pipe expects. The result is what `pipeServer.broadcast` must
 * receive — never the raw event.
 */
export function wrapChannelMessageEnvelope(
  event: ChannelMessageEvent,
): ChannelMessageDaemonEvent {
  return {
    type: 'channel.message',
    sessionId: '',
    data: event,
  };
}

/** Canonical DaemonEvent envelope for a channel.catalog broadcast (A1). Mirrors
 *  wrapChannelMessageEnvelope — the catalog/membership lifecycle signal rides
 *  the same control-pipe bridge (DaemonClient `case 'channel.catalog'` →
 *  re-emit `channel:catalog` → DaemonNotificationRouter tee). */
export interface ChannelCatalogDaemonEvent {
  type: 'channel.catalog';
  sessionId: '';
  data: ChannelCatalogEvent;
}

export function wrapChannelCatalogEnvelope(
  event: ChannelCatalogEvent,
): ChannelCatalogDaemonEvent {
  return {
    type: 'channel.catalog',
    sessionId: '',
    data: event,
  };
}
