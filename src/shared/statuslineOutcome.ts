// ─── What a statusline install did, per settings.json target ─────────────────
//
// The vocabulary lives here rather than next to the installer because three
// surfaces judge it and they must agree: the CLI printer, the Settings card,
// and the first-run wizard. When `replaced` was added for the forced install
// (#1102) the wizard still tested `outcome === 'installed'` on its own, so a
// successful replace would have read as a failure there the moment anyone
// threaded `force` through it. One predicate, imported by all three.
//
// Nothing in this module touches the filesystem — the renderer imports it, and
// pulling `fs` into the renderer bundle to ask "did this take?" is not a trade
// worth making.

export type StatuslineTargetOutcome =
  | 'installed'       // statusLine written (fresh or refreshed)
  | 'replaced'        // a foreign statusLine was overwritten (explicit force)
  | 'skipped-foreign' // user has their own statusLine — untouched
  | 'skipped-corrupt' // settings.json unparseable — untouched
  | 'removed'
  | 'restored'        // wmux entry removed AND the replaced one put back
  | 'nothing';

/** True when this target actually took the install. `replaced` counts: the
 *  forced overwrite is what was asked for, not a no-op. */
export function isInstallTake(outcome: string): boolean {
  return outcome === 'installed' || outcome === 'replaced';
}
