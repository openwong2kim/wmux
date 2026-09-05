import { useEffect } from 'react';
import { useStore } from '../stores';
import { HOOK_RUNNING_TTL_MS } from '../stores/selectors/fleet';

/** Bump cadence — matches the competitor's 2 s status tick. */
const TICK_MS = 2_000;
/** Keep ticking a little past the TTL so the final fresh→stale flip renders. */
const DECAY_GRACE_MS = TICK_MS * 2;
/**
 * Cadence while the only thing left to decide is the 30-min `unverifiable`
 * flip on a pane with an OPEN TURN LATCH. That flip is a single boolean an hour
 * of silence away; at 2 s it would cost 900 app-wide bumps to render it.
 */
const SLOW_TICK_MS = 30_000;

/**
 * Drives the hook-driven 'running' decay (orca-style). The fleet status
 * derivation reads `agentClockMs` from the store so a pane whose last
 * PostToolUse aged past HOOK_RUNNING_TTL_MS flips to idle — but a pure store
 * read never re-fires on its own, so this ticks the clock ~every 2 s.
 *
 * It only ticks WHILE something can still change: once every agent has settled
 * there is nothing left to decay, so the interval stays mounted but does no
 * `set` (no wasteful app-wide re-render at rest). A fresh PostToolUse stamp
 * re-enters the ticking window on the next interval. Mount once (AppLayout).
 *
 * Two speeds, and the SECOND one is gated on the turn latch, not on the age of
 * a stamp. Inside TTL + grace it bumps every tick, as before — that window owns
 * the running dot. Beyond it, the only pane whose rendition can still change is
 * one holding an OPEN LATCH (a latch never decays, so its `unverifiable` flip
 * is the last event left); it bumps every SLOW_TICK_MS until the latch closes,
 * and then the clock freezes exactly as it did before. Every latch is bounded:
 * a turn end closes it, and main's HookSignalRouter expiry broadcasts idle at
 * 30 minutes of hook silence, so this cannot tick forever.
 */
export function useAgentActivityClock(): void {
  const bumpAgentClock = useStore((s) => s.bumpAgentClock);

  useEffect(() => {
    let lastSlowBumpAt = 0;
    const id = setInterval(() => {
      const { surfaceActivityAt, surfaceTurnOpenAt } = useStore.getState();
      const now = Date.now();
      let anyFresh = false;
      for (const ptyId in surfaceActivityAt) {
        if (now - surfaceActivityAt[ptyId] <= HOOK_RUNNING_TTL_MS + DECAY_GRACE_MS) {
          anyFresh = true;
          break;
        }
      }
      if (anyFresh) {
        bumpAgentClock();
        return;
      }
      let anyLatch = false;
      for (const ptyId in surfaceTurnOpenAt) {
        if (surfaceTurnOpenAt[ptyId] > 0) { anyLatch = true; break; }
      }
      if (anyLatch && now - lastSlowBumpAt >= SLOW_TICK_MS) {
        lastSlowBumpAt = now;
        bumpAgentClock();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [bumpAgentClock]);
}
