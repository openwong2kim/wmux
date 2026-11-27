/**
 * Whether the daemon's event loop is saturated: a 20 ms timer that fires more
 * than 10 ms late marks it, one under 5 ms late clears it (hysteresis, so the
 * state does not flap at the edge).
 *
 * DaemonPTYBridge reads it: a chunk is normally forwarded first and analysed
 * on the next turn of the loop, which cuts output latency when the loop has
 * room. When every turn is long (an uncapped flood on many panes), that wait
 * is a whole turn and the analysis then runs behind the next reads, so the
 * bridge analyses inline before the forward again, as it did before.
 *
 * The thresholds were tuned on one machine (an M-series Mac mini, 20 flooding
 * sessions): agent load never reached them, a capped flood crossed them about
 * 6% of the time, an uncapped one about 94%.
 */

/** A tick this late (ms) marks the loop saturated. */
export const LOOP_SATURATED_ENTER_MS = 10;
/** A tick less late than this (ms) clears it. */
export const LOOP_SATURATED_EXIT_MS = 5;
const TICK_MS = 20;

let saturated = false;
let timer: NodeJS.Timeout | null = null;

export function isLoopSaturated(): boolean {
  return saturated;
}

/** One tick's lateness (ms). */
export function noteLoopLag(lagMs: number): void {
  if (lagMs > LOOP_SATURATED_ENTER_MS) saturated = true;
  else if (lagMs < LOOP_SATURATED_EXIT_MS) saturated = false;
}

/** Start the timer once per process; it never keeps the process alive. */
export function startLoopSaturationMonitor(): void {
  if (timer) return;
  let last = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    noteLoopLag(now - last - TICK_MS);
    last = now;
  }, TICK_MS);
  timer.unref();
}

/** Tests: stop the timer and clear the state. */
export function resetLoopSaturationForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  saturated = false;
}
