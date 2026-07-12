import { useEffect } from 'react';
import { useStore } from '../stores';
import { HOOK_RUNNING_TTL_MS } from '../stores/selectors/fleet';

/** Bump cadence — matches the competitor's 2 s status tick. */
const TICK_MS = 2_000;
/** Keep ticking a little past the TTL so the final fresh→stale flip renders. */
const DECAY_GRACE_MS = TICK_MS * 2;

/**
 * Drives the hook-driven 'running' decay (orca-style). The fleet status
 * derivation reads `agentClockMs` from the store so a pane whose last
 * PostToolUse aged past HOOK_RUNNING_TTL_MS flips to idle — but a pure store
 * read never re-fires on its own, so this ticks the clock ~every 2 s.
 *
 * It only ticks WHILE at least one pane's activity stamp is within
 * TTL + grace: once every agent has settled to idle there is nothing left to
 * decay, so the interval stays mounted but does no `set` (no wasteful app-wide
 * re-render at rest). A fresh PostToolUse stamp re-enters the ticking window on
 * the next interval. Mount once (AppLayout).
 */
export function useAgentActivityClock(): void {
  const bumpAgentClock = useStore((s) => s.bumpAgentClock);

  useEffect(() => {
    const id = setInterval(() => {
      const { surfaceActivityAt } = useStore.getState();
      const now = Date.now();
      let anyFresh = false;
      for (const ptyId in surfaceActivityAt) {
        if (now - surfaceActivityAt[ptyId] <= HOOK_RUNNING_TTL_MS + DECAY_GRACE_MS) {
          anyFresh = true;
          break;
        }
      }
      if (anyFresh) bumpAgentClock();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [bumpAgentClock]);
}
