/**
 * The WMUX_RUST_SNAPSHOT override as the snapshot backends read it. The
 * removed comparison mode `shadow` reads as unset, so a value saved in an
 * environment before its removal selects the default for the terminal engine
 * instead of forcing xterm.
 */
export function snapshotModeOverride(): string | undefined {
  const mode = process.env.WMUX_RUST_SNAPSHOT;
  return mode === 'shadow' ? undefined : mode;
}
