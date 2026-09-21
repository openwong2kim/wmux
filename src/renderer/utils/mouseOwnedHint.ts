/**
 * "The app owns the mouse — hold Shift to select" hint.
 *
 * Background:
 * A foreground TUI that enables mouse tracking (DECSET ?1000/?1002/?1003,
 * usually with ?1006) takes every button press. Claude Code does exactly this
 * — its binary emits `ESC[?1000h` + `ESC[?1006h` while its input box is live —
 * so a left-drag over the pane is delivered to the agent instead of starting an
 * xterm selection. Nothing is broken and nothing is logged: the highlight
 * simply never appears, and the user concludes wmux cannot copy from that pane.
 *
 * xterm already ships the escape hatch: `SelectionService.shouldForceSelection`
 * returns `event.shiftKey` off macOS, so Shift+drag selects even under mouse
 * tracking (this is also what Windows Terminal and iTerm2 do). wmux leans on
 * the same override for Shift+right-click paste. It is just invisible — there
 * is no moment where the product says so.
 *
 * This module is the trigger for saying it: a real drag attempt (button held
 * past a threshold, no Shift) in a pane whose app owns the mouse. A bare click
 * is not a selection attempt and must stay silent, and the hint is rate-limited
 * so an agent session that legitimately wants the mouse (a picker, a diff
 * viewer) does not nag on every click-drag.
 *
 * Deliberately pure: no DOM, no xterm, no timers of its own — the caller wires
 * the three events and supplies `show`. That keeps the decision unit-testable
 * without a renderer.
 */

export interface MouseOwnedHintDeps {
  /** True when the foreground app has mouse tracking enabled. */
  isMouseOwned: () => boolean;
  /** Surface the hint (toast, status line, …). */
  show: () => void;
  /** Injectable clock — tests drive the cooldown without waiting. */
  now?: () => number;
  /** Silence window after a shown hint. Default 20s. */
  cooldownMs?: number;
  /** Movement that turns a click into a drag attempt. Default 8px. */
  dragThresholdPx?: number;
}

export interface MousePoint {
  clientX: number;
  clientY: number;
}

export interface MouseDownLike extends MousePoint {
  button: number;
  shiftKey: boolean;
}

export interface MouseOwnedHint {
  onMouseDown(e: MouseDownLike): void;
  onMouseMove(e: MousePoint): void;
  onMouseUp(): void;
}

const DEFAULT_COOLDOWN_MS = 20_000;
const DEFAULT_DRAG_THRESHOLD_PX = 8;

export function createMouseOwnedHint(deps: MouseOwnedHintDeps): MouseOwnedHint {
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const threshold = deps.dragThresholdPx ?? DEFAULT_DRAG_THRESHOLD_PX;

  let origin: MousePoint | null = null;
  // -Infinity, not 0: with an injected clock starting at 0, a `0 - 0 >= cooldown`
  // comparison would swallow the very first hint.
  let lastShownAt = Number.NEGATIVE_INFINITY;

  return {
    onMouseDown(e) {
      // Left button only (right-click already has wmux's own Shift-aware menu
      // path), no Shift (that IS the override — nothing to teach), and only
      // while the app actually owns the mouse. The mode is read at mousedown
      // because it can flip mid-session: an agent enables tracking for its
      // input box and drops it while streaming.
      origin = e.button === 0 && !e.shiftKey && deps.isMouseOwned()
        ? { clientX: e.clientX, clientY: e.clientY }
        : null;
    },

    onMouseMove(e) {
      if (!origin) return;
      const dx = e.clientX - origin.clientX;
      const dy = e.clientY - origin.clientY;
      if (Math.hypot(dx, dy) < threshold) return;
      // One hint per drag: disarm before the cooldown check so a drag that is
      // rate-limited away does not keep re-testing on every mousemove.
      origin = null;
      const at = now();
      if (at - lastShownAt < cooldownMs) return;
      lastShownAt = at;
      deps.show();
    },

    onMouseUp() {
      origin = null;
    },
  };
}
