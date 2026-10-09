/**
 * Plain left-drag selects text even while the foreground app tracks the mouse
 * (#1947).
 *
 * Codex CLI turns on full mouse tracking (`?1000h ?1002h ?1003h ?1006h`) at
 * startup, so xterm hands every plain left-drag to the app and the user cannot
 * select text in that pane. xterm's own escape hatch is a modifier
 * (`SelectionService.shouldForceSelection`: Option on macOS with
 * `macOptionClickForcesSelection`, Shift elsewhere), which nobody discovers.
 *
 * This makes a plain drag select by default, without taking clicks away from
 * the app. A trusted plain left mousedown under tracking is held back: xterm
 * never sees it, so nothing is reported yet. What happens next decides it:
 *   - the pointer moves past a small threshold → it was a drag: a synthetic
 *     mousedown carrying the platform's force-selection modifier is replayed
 *     at the original point, and xterm's SelectionService takes the rest of
 *     the real gesture from there (its document listeners follow the real
 *     mousemoves and mouseup);
 *   - the button comes up first → it was a click: a plain mousedown + mouseup
 *     pair is replayed at the original point, so the app gets its press and
 *     release exactly as before (only the press arrives at release time).
 *
 * xterm only starts a selection for `event.detail === 1`, and a default
 * synthetic MouseEvent has `detail: 0`, so every replay sets it explicitly.
 *
 * Everything with a modifier, any non-left button, a shell prompt (tracking
 * off) and the setting being off fall through untouched, so the existing
 * modifier overrides keep working: on macOS Shift+drag reaches the app and
 * Option+drag selects; elsewhere Alt/Ctrl+drag reach the app and Shift+drag
 * selects. The wheel is never touched.
 */

/** Movement (CSS px) that turns a held press into a drag. */
export const PLAIN_DRAG_THRESHOLD_PX = 5;

export interface PlainDragMouseDown {
  button: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * Should this mousedown be held back as a possible plain-drag selection?
 * `trackingMode` is xterm's `terminal.modes.mouseTrackingMode`.
 */
export function shouldInterceptMouseDown(
  e: PlainDragMouseDown,
  trackingMode: string,
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  if (trackingMode === 'none') return false;
  if (e.button !== 0) return false;
  return !(e.shiftKey || e.altKey || e.ctrlKey || e.metaKey);
}

export interface Point {
  clientX: number;
  clientY: number;
}

/** True once the pointer has moved far enough from `origin` to be a drag. */
export function isDrag(origin: Point, now: Point, thresholdPx = PLAIN_DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(now.clientX - origin.clientX, now.clientY - origin.clientY) >= thresholdPx;
}

/**
 * The "app owns the mouse — hold Shift/Option to select" hint only teaches
 * anything when plain drags do NOT select, i.e. with this setting off.
 */
export function mouseOwnedHintApplies(trackingMode: string, plainDragSelectEnabled: boolean): boolean {
  return !plainDragSelectEnabled && trackingMode !== 'none';
}

export interface PlainDragTerminal {
  modes: { mouseTrackingMode: string };
  focus(): void;
  element?: HTMLElement;
}

export interface PlainDragSelectDeps {
  /** Read at every mousedown so a Settings toggle applies immediately. */
  isEnabled: () => boolean;
  /** macOS forces a selection with Option (altKey); everything else with Shift. */
  isMac: boolean;
  thresholdPx?: number;
}

/** Wires the interceptor to `container`; returns the teardown. */
export function installPlainDragSelect(
  container: HTMLElement,
  term: PlainDragTerminal,
  deps: PlainDragSelectDeps,
): () => void {
  const threshold = deps.thresholdPx ?? PLAIN_DRAG_THRESHOLD_PX;
  // Our own replays must pass through untouched. `isTrusted` cannot tell them
  // apart from other untrusted events (and is always false under jsdom), so
  // they are marked explicitly.
  const replays = new WeakSet<Event>();

  let pending: { origin: Point; target: EventTarget } | null = null;

  const replay = (target: EventTarget, type: string, at: Point, buttons: number, force: boolean): void => {
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: at.clientX,
      clientY: at.clientY,
      button: 0,
      buttons,
      detail: 1,
      altKey: force && deps.isMac,
      shiftKey: force && !deps.isMac,
    });
    replays.add(ev);
    target.dispatchEvent(ev);
  };

  // The element under the press may have been re-rendered away (DOM renderer
  // rows) while it was held; a detached node never reaches xterm.
  const replayTarget = (target: EventTarget): EventTarget => {
    if (target instanceof Node && target.isConnected && container.contains(target)) return target;
    return term.element?.querySelector('.xterm-screen') ?? term.element ?? container;
  };

  const stop = (): void => {
    pending = null;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('blur', onBlur);
  };

  // Not swallowed: with the press held back, xterm has not armed its document
  // drag listeners, and its always-on element mousemove ignores moves with a
  // button down, so the app sees no motion while this is undecided.
  const onMove = (e: MouseEvent): void => {
    if (!pending || replays.has(e)) return;
    if ((e.buttons & 1) === 0) {
      // The button came up where no mouseup reached us (outside the window).
      stop();
      return;
    }
    if (!isDrag(pending.origin, e, threshold)) return;
    const { origin, target } = pending;
    stop();
    const t = replayTarget(target);
    replay(t, 'mousedown', origin, 1, true);
    replay(t, 'mousemove', { clientX: e.clientX, clientY: e.clientY }, 1, true);
  };

  const onUp = (e: MouseEvent): void => {
    if (!pending || replays.has(e) || e.button !== 0) return;
    const { origin, target } = pending;
    stop();
    // A click: the app gets the press and release it would have had. The real
    // release is replaced by the replayed one so it is not reported twice.
    e.stopImmediatePropagation();
    const t = replayTarget(target);
    replay(t, 'mousedown', origin, 1, false);
    replay(t, 'mouseup', origin, 0, false);
  };

  const onBlur = (): void => stop();

  const onDown = (e: MouseEvent): void => {
    if (replays.has(e)) return;
    if (pending) stop();
    if (!shouldInterceptMouseDown(e, term.modes.mouseTrackingMode, deps.isEnabled())) return;
    // Hold the press back from xterm (which would report it to the app) and
    // from the browser's native selection. xterm focuses on mousedown, so do
    // it here instead: a slow drag must not leave the terminal unfocused.
    e.stopImmediatePropagation();
    e.preventDefault();
    term.focus();
    pending = { origin: { clientX: e.clientX, clientY: e.clientY }, target: e.target ?? container };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('blur', onBlur);
  };

  container.addEventListener('mousedown', onDown, true);
  return () => {
    container.removeEventListener('mousedown', onDown, true);
    stop();
  };
}
