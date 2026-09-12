// Wake-boundary glyph-atlas recovery — the corruption class atlasGuard's poll
// cannot see.
//
// atlasGuard (#741) watches the shared atlas's PAGE STRUCTURES (count, fill)
// and repairs the page-merge corruption class. But macOS sleep→wake can trash
// the atlas's TEXTURE CONTENT on the GPU without firing webglcontextlost and
// without touching any page structure the poll reads: every pane then samples
// garbage pixels for perfectly consistent-looking pages, and no existing
// repair path fires (refresh() re-rasters from the same corrupted texture;
// PREVENT/CURE see nothing wrong). Observed in the field on v3.38.4, which
// already ships #741 — this module covers the residual class.
//
// Strategy (boundary-driven rebuild, adapted from Orca's wake-recovery design
// — idea only, no code imported; github.com/stablyai/orca,
// use-terminal-window-wake-recovery.ts): at the moments GPU state is suspect,
// unconditionally rebuild the shared atlas via atlasGuard.recoverNow — the
// same coherent clear+refresh-all PREVENT/CURE performs, so the #191
// stale-sibling hazard cannot occur.
//
// Triggers:
//   - system resume  — main's powerMonitor 'resume' over IPC. The decisive
//                      signal: texture memory is invalidated by sleep.
//   - visibility     — document became visible again. Backstop for the
//                      unlock-screen gap where the resume event can land
//                      while the window is still hidden and Chromium may
//                      re-jig GPU memory before first present.
//
// Window FOCUS is deliberately NOT a trigger: plain refocus (alt-tab) is
// frequent and often lands mid-stream, and wiping the shared atlas while
// output is flowing re-arms xterm's page-merge race (xterm.js #4480) — the
// same reason glyphRepaint's focus path never touches the atlas.
//
// The two triggers routinely fire together on a real wake; the throttle
// collapses them into one rebuild.
//
// THE VISIBILITY TRIGGER IS LATCHED BY RESUME, NOT FIRED ON ITS OWN (#1234).
//
// A previous measurement on Electron 41 concluded that Windows never fires
// `visibilitychange` while the window is covered or minimized, and the trigger
// above was written on that assumption — a harmless macOS-only backstop. The
// #1234 field log falsifies it: on Windows 10.0.19045 the renderer logged
// `recover (visibility)` 18 times in 15 minutes of ordinary alt-tabbing, 12 of
// them 13-26 ms after a `[wmux:glyph-repaint] focus`. (The reason string
// `visibility` can only be produced here, so the trigger firing is proven, not
// inferred.) Chromium's native window occlusion does flip `visibilityState` on
// that build, so on Windows the visibility trigger IS the window-focus trigger
// — the one trigger this module deliberately refuses to have, because wiping
// the shared atlas while output is flowing re-arms xterm's page-merge race (11
// of those 18 wipes landed within 1 s of a live output burst).
//
// So visibility alone no longer recovers. Its stated job is narrow: cover the
// unlock-screen gap where main's `resume` lands while the window is still
// hidden, i.e. where the rebuild it triggers can be undone by Chromium before
// first present. That is a ONE-SHOT LATCH, not a time window: a resume that
// arrives while the window is hidden arms exactly one visibility recovery,
// which fires on the next transition to visible and clears the latch. A time
// window would be wrong in both directions — unlock takes as long as the user
// takes to type a password (a 10 s window expires and the invalidated atlas
// stays broken until the next sleep, since the poll cannot see wake
// corruption), while any window at all leaves every alt-tab inside it firing a
// wipe. The latch is also exempt from the throttle below, so a fast unlock is
// not swallowed by the rebuild the resume itself just performed.
//
// A resume that arrives while the window is already VISIBLE does not arm the
// latch: its own rebuild is effective, and arming would only add a second wipe
// on the `visibilitychange` that may follow milliseconds later — exactly what
// the throttle was introduced to collapse.
//
// Until a resume has EVER been delivered, visibility keeps its old
// unconditional behaviour. Electron's `powerMonitor` 'resume' exists as an API
// on every platform but is not reliably emitted on some Linux session setups;
// gating on the API's PRESENCE (rather than on a delivery we have observed)
// would silently remove wake recovery there forever. So delivery is what flips
// the gate: the first real resume proves the signal works on this machine, and
// only from then on is the latch required. The cost is that such a machine
// keeps one unjustified wipe per visibility change until its first sleep —
// accepted, because the alternative is a platform with no wake recovery at all.
//
// Anything that needs to know whether the window can be seen must still ask
// main instead of reading `visibilityState` (see main/window/windowDisplayed.ts,
// which is how the #766 viewer-visibility report gets its answer since #882) —
// that path is right on every platform, whereas `visibilityState` is only
// occlusion-driven, as this issue's log shows.

import { atlasGuard } from './atlasGuard';

/** Minimum gap between rebuilds. Resume + visibilitychange arrive within
 *  milliseconds of each other on a real wake; one rebuild covers both. */
export const WAKE_RECOVER_THROTTLE_MS = 1_000;

export interface AtlasWakeRecoveryDeps {
  /** Subscribe to main's system-resumed push; returns the unsubscribe. */
  onSystemResumed(callback: () => void): () => void;
  recoverNow?: (reason: string) => void;
  documentRef?: Pick<Document, 'addEventListener' | 'removeEventListener'> & {
    visibilityState: DocumentVisibilityState;
  };
  now?: () => number;
}

/** Wire the wake triggers; returns the teardown. Called once from App. */
export function initAtlasWakeRecovery(deps: AtlasWakeRecoveryDeps): () => void {
  const {
    onSystemResumed,
    recoverNow = (reason) => atlasGuard.recoverNow(reason),
    documentRef = document,
    now = Date.now,
  } = deps;

  let lastRecoverAt = -Infinity;
  // One-shot latch: a resume delivered while the window was hidden owes us one
  // visibility recovery. Cleared the moment it is used.
  let visibilityArmed = false;
  // Has main's resume push ever actually fired on this machine? Until it has,
  // visibility stays unconditional (see the header — presence of the API is not
  // evidence of delivery).
  let resumeEverDelivered = false;

  const recover = (reason: string, ignoreThrottle = false): void => {
    const t = now();
    if (!ignoreThrottle && t - lastRecoverAt < WAKE_RECOVER_THROTTLE_MS) return;
    lastRecoverAt = t;
    recoverNow(reason);
  };

  const unsubscribeResumed = onSystemResumed(() => {
    resumeEverDelivered = true;
    // Only a resume that lands on a hidden window needs the visibility
    // backstop; one that lands while visible has already been repaired here.
    if (documentRef.visibilityState !== 'visible') visibilityArmed = true;
    recover('system-resumed');
  });
  const onVisibilityChange = (): void => {
    if (documentRef.visibilityState !== 'visible') return;
    if (visibilityArmed) {
      // Consume the latch first: the rebuild is one-shot per resume, and an
      // alt-tab storm right after a wake must not re-fire it. Throttle-exempt
      // so a fast unlock is not swallowed by the resume's own rebuild.
      visibilityArmed = false;
      recover('visibility', true);
      return;
    }
    if (resumeEverDelivered) {
      // #1234: on Windows this fires on every alt-tab. Nothing invalidated GPU
      // texture memory, so there is nothing to rebuild and a wipe is pure risk.
      // Logged at Verbose so the next field report can tell "the guard never
      // ran" from "the guard ran and did not repair it".
      console.debug('[wmux:atlas-wake] visibility ignored — unarmed (no pending system-resumed)');
      return;
    }
    // No resume has ever been delivered on this machine; visibility is the only
    // wake signal we can trust here. Pre-#1234 behaviour.
    recover('visibility');
  };
  documentRef.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    unsubscribeResumed();
    documentRef.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
