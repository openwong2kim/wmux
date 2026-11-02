/**
 * TASK-10: initial-attach flushes at or above this size go through the
 * daemon-side HeadlessSnapshot instead of shipping raw bytes. Below it the
 * renderer parses the raw replay faster than a snapshot round would cost.
 *
 * Shared by the daemon's SessionPipe (which flushes a smaller ring without the
 * snapshot queue, #2585) and the renderer (which keeps a smaller replay that
 * reached a hidden new pane instead of re-requesting it through that queue on
 * reveal). Import-free, so the renderer and main bundles can read it without
 * pulling in SessionPipe and @xterm/headless.
 */
export const ATTACH_SNAPSHOT_MIN_BYTES = 256 * 1024;

/**
 * Lossless upper bound on serialized scrollback (the daemon's HeadlessSnapshot
 * MAX_SCROLLBACK). Aligned with the Settings ceiling for `scrollbackLines`
 * (SettingsPanel.tsx — the slider maxes at 100k). The attach flush snapshots
 * at this bound because it has no renderer config; main asks for the same
 * when it replays a screen in place of an attach flush.
 */
export const SNAPSHOT_MAX_SCROLLBACK = 100_000;
