// ─── Renderer channels barrel ──────────────────────────────────────────
// Public surface for the renderer's channel delivery transports. The
// daemon-side `ChannelService` lives under `src/daemon/channels/`. This
// renderer barrel exposes the local transport + the format helpers so
// other renderer modules (`channelsSlice` in U6, sidebar panels in U7,
// composer in U8) can wire them in without reaching into the
// implementation file.
//
// Plan reference: U2 (a2a-channels).

export {
  LocalPtyDelivery,
  defaultChannelMessage,
  defaultChannelNudge,
  type LocalPtyDeps,
  type ResolveRecipient,
  type FormatChannelMessage,
  type FormatChannelNudge,
  type WritePty,
  type ResolvedRecipient,
} from './LocalPtyDelivery';