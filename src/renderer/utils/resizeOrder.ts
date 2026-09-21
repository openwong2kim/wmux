/**
 * Which side of the pipe learns about a shrink first.
 *
 * The bug this exists for (#1436): a full-screen TUI that draws in the NORMAL
 * buffer repaints its frame as `CSI H` followed by `rows - 1` CRLFs. A raw PTY
 * trace of Codex v0.155.1 over ConPTY shows exactly that — no alt screen
 * (`?1049` is never sent), a repaint per frame anchored at home, 29 CRLFs at
 * 30 rows and 18-19 at 20 rows. Well behaved: the app never writes a newline on
 * its last row, so nothing scrolls.
 *
 * Nothing scrolls *as long as the emulator has at least as many rows as the app
 * does*. Invert that and every frame overflows: a 29-CRLF repaint written into
 * a 20-row xterm pushes 9 lines of the app's own frame into scrollback, and the
 * user sees the whole pane content scroll away. One frame per repaint, i.e.
 * continuously while the app is drawing.
 *
 * `runFit` used to open exactly that window on every shrink. It called
 * `fitAddon.fit()` first — xterm shrinks synchronously — and only then sent the
 * new geometry over IPC to the daemon, which resizes ConPTY, which signals the
 * app, which repaints. Until that round trip completes, the app is still
 * painting frames sized for the OLD, taller terminal into the new, shorter one.
 *
 * Growing is safe in the old order: a frame sized for fewer rows lands inside a
 * taller viewport and scrolls nothing. So only a shrink needs the swap, and
 * keeping growth on the local-first path preserves today's latency for the
 * common case (opening space, un-maximizing, closing a neighbour).
 *
 * Columns are deliberately not part of the decision. A narrower terminal
 * reflows — it does not push lines past the bottom — and that reflow is
 * xterm's own, not something the app's in-flight bytes can make worse.
 */

export type ResizeOrder = 'pty-first' | 'local-first';

export function resizeOrderFor(currentRows: number, proposedRows: number): ResizeOrder {
  return proposedRows < currentRows ? 'pty-first' : 'local-first';
}

export interface OrderedFitDeps {
  order: ResizeOrder;
  /** Hand the PTY the new geometry; resolves once the daemon has applied it. */
  sendGeometry: () => Promise<unknown>;
  /** `fit()` and everything that must follow it locally. Runs exactly once. */
  applyLocalFit: () => void;
  /**
   * Ceiling on how long the local fit waits for the PTY. A daemon that is
   * down, rate-limiting, or simply slow must not leave xterm pinned at the old
   * geometry forever — that is #747's failure mode wearing a different hat.
   */
  settleTimeoutMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** Cancels a pending deferred fit (teardown, or a newer resize superseding it). */
export type CancelOrderedFit = () => void;

const DEFAULT_SETTLE_TIMEOUT_MS = 150;

export function runOrderedFit(deps: OrderedFitDeps): CancelOrderedFit {
  if (deps.order === 'local-first') {
    deps.applyLocalFit();
    return () => { /* nothing deferred */ };
  }

  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const timeoutMs = deps.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;

  let done = false;
  let handle: unknown = null;
  // Whichever comes first — the daemon's acknowledgement or the ceiling — and
  // only once. A rejected resize still settles: the fit must happen either way,
  // and `sendResize`'s own rate-limit retry owns re-sending the geometry.
  const settle = () => {
    if (done) return;
    done = true;
    if (handle !== null) cancel(handle);
    handle = null;
    deps.applyLocalFit();
  };

  handle = schedule(settle, timeoutMs);
  void Promise.resolve(deps.sendGeometry()).then(settle, settle);

  return () => {
    if (done) return;
    done = true;
    if (handle !== null) cancel(handle);
    handle = null;
  };
}
