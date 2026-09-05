import { useEffect } from 'react';
import { useStore } from '../stores';
import { HOOK_RUNNING_TTL_MS, UNVERIFIABLE_AFTER_MS } from '../stores/selectors/fleet';

/** Bump cadence — matches the competitor's 2 s status tick. */
const TICK_MS = 2_000;
/** Keep ticking a little past the TTL so the final fresh→stale flip renders. */
const DECAY_GRACE_MS = TICK_MS * 2;
/**
 * Past the running TTL the only thing still decaying is the 30-min
 * `unverifiable` flip, whose label is minute-granular — so the clock keeps
 * moving out to that horizon, but at a fraction of the cadence. At 2 s it would
 * cost 900 app-wide bumps to render one flip.
 */
const SLOW_TICK_MS = 30_000;
/** Last stamp age worth ticking for at all — the unverifiable flip plus grace. */
const DECAY_HORIZON_MS = UNVERIFIABLE_AFTER_MS + SLOW_TICK_MS;

/**
 * Drives the hook-driven 'running' decay (orca-style). The fleet status
 * derivation reads `agentClockMs` from the store so a pane whose last
 * PostToolUse aged past HOOK_RUNNING_TTL_MS flips to idle — but a pure store
 * read never re-fires on its own, so this ticks the clock ~every 2 s.
 *
 * It only ticks WHILE at least one pane's activity stamp is within the decay
 * horizon: once every agent has settled there is nothing left to decay, so the
 * interval stays mounted but does no `set` (no wasteful app-wide re-render at
 * rest). A fresh PostToolUse stamp re-enters the ticking window on the next
 * interval. Mount once (AppLayout).
 *
 * Two speeds. Inside TTL + grace it bumps every tick, as before — that window
 * owns the running dot. Between there and the unverifiable horizon it bumps
 * every SLOW_TICK_MS, which is all a minute-granular "No update for 34m" can
 * show; the clock then freezes again, so that label plateaus at the horizon
 * (its claim, "≥30m of silence", stays true).
 */
export function useAgentActivityClock(): void {
  const bumpAgentClock = useStore((s) => s.bumpAgentClock);

  useEffect(() => {
    let lastSlowBumpAt = 0;
    const id = setInterval(() => {
      const { surfaceActivityAt } = useStore.getState();
      const now = Date.now();
      let anyFresh = false;
      let anyDecaying = false;
      for (const ptyId in surfaceActivityAt) {
        const age = now - surfaceActivityAt[ptyId];
        if (age <= HOOK_RUNNING_TTL_MS + DECAY_GRACE_MS) {
          anyFresh = true;
          break;
        }
        if (age <= DECAY_HORIZON_MS) anyDecaying = true;
      }
      if (anyFresh) {
        bumpAgentClock();
        return;
      }
      if (anyDecaying && now - lastSlowBumpAt >= SLOW_TICK_MS) {
        lastSlowBumpAt = now;
        bumpAgentClock();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [bumpAgentClock]);
}
