// ─── Daemon channels barrel ───────────────────────────────────────────
// Re-exports for the daemon-side channel subsystem. The renderer-side
// barrel lives at `src/renderer/channels/index.ts`; this one is the
// daemon's perspective (state writer + service), with no UI or transport
// dependencies.
//
// Plan reference: U3 (a2a-channels service layer).

export {
  ChannelService,
  type ChannelError,
  type ChannelErrorCode,
  type ChannelMessageEvent,
  type ChannelCatalogEvent,
  type ChannelServiceDeps,
  type ChannelServiceEmit,
  type ArchiveChannelParams,
  type CreateChannelParams,
  type JoinChannelParams,
  type LeaveChannelParams,
  type PostMessageParams,
  type SenderRef,
} from './ChannelService';

export { ChannelStateWriter } from './ChannelStateWriter';
export {
  wrapChannelMessageEnvelope,
  wrapChannelCatalogEnvelope,
  type ChannelMessageDaemonEvent,
  type ChannelCatalogDaemonEvent,
} from './channelEventEnvelope';
