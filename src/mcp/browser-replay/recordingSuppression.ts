/**
 * A scoped "do not record" switch for the action ring.
 *
 * The browser handlers close over their deps at registration, so a caller
 * that reaches them through the collector cannot hand them a ring-less deps
 * object. `repl_run` scripts compute values from files, network, and secrets
 * that a replay could never reproduce, so their browser calls must stay out
 * of the ring; this AsyncLocalStorage flag carries that decision into the
 * handler without touching its signature. Kept in its own module so the
 * bridge can import it without pulling in the recorder's page helpers.
 */
import { AsyncLocalStorage } from 'async_hooks';

const suppressed = new AsyncLocalStorage<true>();

/** Run `fn` with action recording off for everything it awaits. */
export function withoutActionRecording<T>(fn: () => T): T {
  return suppressed.run(true, fn);
}

export function isActionRecordingSuppressed(): boolean {
  return suppressed.getStore() === true;
}
