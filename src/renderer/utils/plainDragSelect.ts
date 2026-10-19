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

import type { AgentSlug } from '../../shared/agentIdentity';
import { isAltScreen } from '../terminal/altScreenWheel';

/**
 * Agents that select and copy on a drag themselves. Claude Code's fullscreen
 * view tracks the mouse to run its own selection: it survives redraws and
 * scrolling, copies on release (its `copyOnSelect`, on by default) and says
 * "Copied". Turning that drag into an xterm selection took all of it away, so
 * the drag reached neither the agent's copy nor a confirmation the user knew.
 * A plain drag goes to these agents as it did before #1947.
 */
const AGENTS_WITH_OWN_SELECTION: ReadonlySet<AgentSlug> = new Set<AgentSlug>(['claude']);

export function agentSelectsOnDrag(slug: AgentSlug | undefined): boolean {
  return slug !== undefined && AGENTS_WITH_OWN_SELECTION.has(slug);
}

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
  modes?: { mouseTrackingMode?: string };
  focus(): void;
  element?: HTMLElement;
  hasSelection?(): boolean;
}

/**
 * Should this buttonless mousemove be kept from xterm so it does not clear a
 * live selection?
 *
 * Under any-event tracking (`?1003`, which Codex enables) xterm reports every
 * buttonless move as hover motion, and every mouse report goes through
 * `coreService.triggerDataEvent(report, true)` — user input, which makes the
 * SelectionService clear the selection. Windows also delivers a buttonless
 * mousemove at the release point right after every mouseup (the capture
 * release), so a drag selection vanished about 20 ms after the button came up,
 * before the debounced copy-on-select could read it. While a selection is
 * alive, hover reports are paused instead; the next click, key or wheel clears
 * the selection as before, and hover reporting resumes.
 */
export function shouldHoldHoverMove(
  e: { buttons: number },
  trackingMode: string,
  enabled: boolean,
  hasSelection: boolean,
): boolean {
  return enabled && trackingMode === 'any' && e.buttons === 0 && hasSelection;
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

  let pending: { origin: Point; target: EventTarget; detail: number } | null = null;

  const replay = (target: EventTarget, type: string, at: Point, buttons: number, force: boolean, detail: number): void => {
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: at.clientX,
      clientY: at.clientY,
      button: 0,
      buttons,
      // At least 1: xterm only starts a selection for detail 1-3, and a
      // double/triple press keeps its count so drag-select goes by word/line.
      detail: Math.max(1, detail),
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
    const { origin, target, detail } = pending;
    stop();
    const t = replayTarget(target);
    replay(t, 'mousedown', origin, 1, true, detail);
    replay(t, 'mousemove', { clientX: e.clientX, clientY: e.clientY }, 1, true, detail);
  };

  const onUp = (e: MouseEvent): void => {
    if (!pending || replays.has(e) || e.button !== 0) return;
    const { origin, target, detail } = pending;
    stop();
    // A click: the app gets the press and release it would have had. The real
    // release is replaced by the replayed one so it is not reported twice.
    e.stopImmediatePropagation();
    const t = replayTarget(target);
    // The release is reported where it happened, not at the press.
    replay(t, 'mousedown', origin, 1, false, detail);
    replay(t, 'mouseup', { clientX: e.clientX, clientY: e.clientY }, 0, false, detail);
  };

  const onBlur = (): void => stop();

  const onDown = (e: MouseEvent): void => {
    if (replays.has(e)) return;
    if (pending) stop();
    // Only presses on the text area: the scrollbar beside it is a control,
    // and a drag on it must scroll, not start a selection.
    if (!(e.target instanceof Element) || !e.target.closest('.xterm-screen')) return;
    if (!shouldInterceptMouseDown(e, term.modes?.mouseTrackingMode ?? 'none', deps.isEnabled())) return;
    // Hold the press back from xterm (which would report it to the app) and
    // from the browser's native selection. xterm focuses on mousedown, so do
    // it here instead: a slow drag must not leave the terminal unfocused.
    e.stopImmediatePropagation();
    e.preventDefault();
    term.focus();
    pending = { origin: { clientX: e.clientX, clientY: e.clientY }, target: e.target, detail: e.detail };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('blur', onBlur);
  };

  // Capture phase on the container runs before xterm's own mousemove listener
  // on its element, which is the one that turns a hover into a report.
  const onHoverMove = (e: MouseEvent): void => {
    if (replays.has(e)) return;
    if (!shouldHoldHoverMove(e, term.modes?.mouseTrackingMode ?? 'none', deps.isEnabled(), term.hasSelection?.() ?? false)) return;
    e.stopImmediatePropagation();
  };

  container.addEventListener('mousedown', onDown, true);
  container.addEventListener('mousemove', onHoverMove, true);
  return () => {
    container.removeEventListener('mousedown', onDown, true);
    container.removeEventListener('mousemove', onHoverMove, true);
    stop();
  };
}

export interface WheelSelectionTerminal {
  buffer?: { active?: { type?: string } };
  modes?: { mouseTrackingMode?: string };
  hasSelection?(): boolean;
  /** xterm's selection event: fired synchronously when the selection clears. */
  onSelectionChange(listener: () => void): { dispose(): void };
}

export interface WheelClearsSelectionHintDeps {
  /** Surface the hint. Called at most once per pane. */
  show: () => void;
  /** The pane's pty id: the hint is said once per pane, so a terminal
   *  re-mounted or adopted into another layout stays quiet. */
  paneId: () => string | null;
  /** True for an agent that keeps its own selection while it scrolls
   *  (Claude Code, agentSelectsOnDrag): no xterm selection to lose there. */
  isExempt: () => boolean;
}

/** Panes that were told already (by pty id), across mounts. */
const wheelHintedPanes = new Set<string>();

/**
 * #2293: say why a selection vanished when the wheel scrolled a mouse-tracking
 * alternate-screen app (Codex's fullscreen view).
 *
 * The alternate screen has no scrollback: the app keeps its transcript and
 * redraws other text into the same cells when it scrolls. With mouse tracking
 * on, xterm sends the wheel to the app (as a mouse report, or as arrow keys
 * under X10), which is user input, so the SelectionService clears the
 * selection. That is kept on purpose (a selection kept across the scroll
 * would copy text that is no longer there); this only tells the user once per
 * pane that the app scrolls its own transcript and that Shift+drag
 * (Option+drag on macOS) selects what is on screen.
 *
 * Only a clear that happens while the wheel event is being dispatched counts
 * (its `eventPhase` is not NONE yet): xterm fires its selection event
 * synchronously inside its own wheel handler. A wheel xterm ignores (Shift+wheel, a delta too small for a line)
 * clears nothing, and a clear from anything else lands outside the window.
 * Nothing is swallowed: the listener only reads state.
 */
export function installWheelClearsSelectionHint(
  container: HTMLElement,
  term: WheelSelectionTerminal,
  deps: WheelClearsSelectionHintDeps,
): () => void {
  let wheel: { event: Event; pane: string } | null = null;
  const onWheel = (e: Event): void => {
    wheel = null;
    const pane = deps.paneId();
    if (!pane || wheelHintedPanes.has(pane)) return;
    if ((term.modes?.mouseTrackingMode ?? 'none') === 'none' || !isAltScreen(term)) return;
    if (!term.hasSelection?.() || deps.isExempt()) return;
    wheel = { event: e, pane };
  };
  const selection = term.onSelectionChange(() => {
    if (!wheel || wheel.event.eventPhase === Event.NONE || term.hasSelection?.()) return;
    const { pane } = wheel;
    wheel = null;
    wheelHintedPanes.add(pane);
    deps.show();
  });
  // Capture: xterm's own wheel handler cancels the event under tracking, so a
  // bubbling listener here would never run.
  container.addEventListener('wheel', onWheel, { capture: true, passive: true });
  return () => {
    wheel = null;
    selection.dispose();
    container.removeEventListener('wheel', onWheel, true);
  };
}

/** Test-only: forget which panes were told. */
export function __resetWheelHintedPanesForTests(): void {
  wheelHintedPanes.clear();
}
