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
// WHERE THE LATCH IS REQUIRED, AND WHY IT IS PLATFORM-SCOPED.
//
// Electron's `powerMonitor` 'resume' exists as an API everywhere but is not
// reliably emitted on some Linux session setups, and on such a machine
// visibility is the only wake backstop there is. So the latch is required only
// where the resume signal is trustworthy:
//
//   win32 / darwin — required IMMEDIATELY. `powerMonitor` resume is dependable
//                    on both, and on Windows we have field evidence
//                    (#1234) that visibility fires on an ordinary alt-tab, so
//                    an unarmed visibility change is known to be noise.
//   linux          — keeps the pre-#1234 unconditional behaviour until a resume
//                    has actually been DELIVERED once. That first delivery
//                    proves the signal works on this machine and the latch is
//                    required from then on. The cost is one unjustified wipe
//                    per visibility change until its first sleep, accepted in
//                    exchange for never leaving a platform with no wake
//                    recovery at all.
//
// A first draft gated purely on first delivery, on every platform. Live dogfood
// killed it: it left #1234 UNFIXED on the reporter's machine until that machine
// happened to sleep once, and their report is 15 minutes of alt-tabbing with no
// reason to think it ever slept. A bug fix that waits for a suspend to take
// effect is not a fix.
//
// The rejected alternative was to stop trusting the event and detect the wake
// directly — compare wall-clock elapsed against expected elapsed and treat a
// large unexplained jump as a sleep. It is the more honest signal in principle
// and would cover Linux too, but its discriminator is unsound in exactly the
// state it has to work in: a hidden renderer has its timers throttled (and can
// have them frozen outright), so an ordinary alt-tab away produces the same
// unexplained wall-clock jump as a real suspend and would re-arm the wipe on
// every app switch — the bug this module is fixing. The monotonic-clock variant
// trades that for a different unknown, since whether the monotonic clock
// advances across suspend differs by platform; if it pauses, the jump never
// appears and wake recovery dies silently everywhere. A platform gate rests on
// something we have actually measured.
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
  /** The renderer's platform (`window.electronAPI.platform`). Decides whether
   *  the resume latch is required immediately or only after a first delivered
   *  resume — see the header. Unknown platforms are treated like linux, the
   *  conservative side (recovery is kept, not dropped). */
  platform?: string;
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
    platform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined,
    recoverNow = (reason) => atlasGuard.recoverNow(reason),
    documentRef = document,
    now = Date.now,
  } = deps;

  let lastRecoverAt = -Infinity;
  // One-shot latch: a resume delivered while the window was hidden owes us one
  // visibility recovery. Cleared the moment it is used.
  let visibilityArmed = false;
  // Platforms whose powerMonitor resume we trust without having seen one. The
  // latch is required from the first visibility change there; everywhere else
  // it takes a delivered resume to prove the signal works (see the header).
  const resumeSignalTrusted = platform === 'win32' || platform === 'darwin';
  // Has main's resume push ever actually fired on this machine? Only consulted
  // on the untrusted platforms.
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
    if (resumeSignalTrusted || resumeEverDelivered) {
      // #1234: on Windows this fires on every alt-tab. Nothing invalidated GPU
      // texture memory, so there is nothing to rebuild and a wipe is pure risk.
      // Logged at Verbose so the next field report can tell "the guard never
      // ran" from "the guard ran and did not repair it".
      console.debug('[wmux:atlas-wake] visibility ignored — unarmed (no pending system-resumed)');
      return;
    }
    // A platform whose resume push has never been seen to fire; visibility is
    // the only wake signal we can trust here. Pre-#1234 behaviour.
    recover('visibility');
  };
  documentRef.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    unsubscribeResumed();
    documentRef.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
