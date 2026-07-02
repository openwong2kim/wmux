/**
 * v2 RCA fix (reboot-reattach, axis A): event-driven immediate session persistence.
 *
 * The renderer must flush session.json the INSTANT a surface's ptyId changes
 * (Terminal self-create, empty-pane addSurface, reconcile completion) — not wait
 * for the 5s periodic tick. An OS reboot inside that window loses the freshly
 * created ptyId, so session.json keeps a stale/fossil ptyId and the next boot
 * fails to reattach (clears → self-creates a new session, orphaning the live one).
 *
 * The actual saver (`session.save(buildSessionData(dumpScrollbackBuffersSync()))`)
 * lives in AppLayout, whose helpers pull heavy deps (terminalRegistry, store,
 * scrollback serialization). Exporting them would create an
 * AppLayout → PaneContainer → Pane → AppLayout import cycle. Instead AppLayout
 * registers its saver closure here on mount, and teardown/creation sites call
 * `saveSessionNow()`. No import cycle: this module imports nothing.
 *
 * Single-window app → a single module-level slot is sufficient. `saveSessionNow`
 * is a no-op before registration (early boot) and after teardown.
 */

let saver: (() => void) | null = null;

/** AppLayout registers (mount) / clears (unmount) its synchronous saver closure. */
export function registerSessionSaver(fn: (() => void) | null): void {
  saver = fn;
}

/** Persist the current session.json snapshot right now. Best-effort immediate:
 *  the saver fires an async `session.save` IPC (fire-and-forget) and MAIN writes
 *  synchronously on receipt — so the in-flight window is milliseconds, versus
 *  the 5 s periodic tick this exists to pre-empt. Not a durability ack. Safe
 *  no-op if no saver is registered yet. Never throws to its caller. */
export function saveSessionNow(): void {
  if (!saver) return;
  try {
    saver();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[saveSessionNow] immediate session save failed:', err);
  }
}
