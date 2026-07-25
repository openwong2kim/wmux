import type { IDisposable, Terminal } from '@xterm/xterm';

// fmux#13 — which scroll affordance a terminal pane should show.
//
// Root cause of #13, confirmed by reading live state out of a running app:
// xterm's Viewport feeds the Monaco scrollbar widget
//   height      = renderService.dimensions.css.canvas.height
//   scrollHeight = renderService.dimensions.css.cell.height * buffer.lines.length
// and Monaco's ScrollbarState treats the bar as *needed* only when
// scrollHeight > height. On the ALTERNATE buffer — which is what every
// full-screen TUI uses (Claude Code, vim, less) — there is no scrollback by
// definition, so buffer.lines.length === rows and the two are equal. Monaco
// then correctly renders a full-track slider with a zero scroll range and tags
// the bar `invisible`.
//
// Upstream b4c8441c (#317) forces `.scrollbar { visibility: visible !important }`
// and `.scrollbar.invisible { opacity: 1 !important; pointer-events: auto }` to
// defeat Monaco's idle auto-hide. That override cannot tell "hidden because
// idle" from "hidden because there is nothing to scroll", so it also pins the
// dead full-track slider on screen — the reported symptom. The normal buffer
// was never broken: measured at 3002 lines / 80 rows the slider is 34px and
// tracks the buffer exactly in both directions.
//
// So the affordance is chosen from public xterm state:
//   'native' — xterm owns a real scroll range; show the Monaco bar persistently
//              (what #317 wanted) and let it drag normally.
//   'jog'    — alternate buffer: xterm has nothing to scroll, but the hosted
//              app does. Neither the slider's size nor its position is knowable
//              (no terminal protocol reports an app's scroll offset), so a
//              position-shaped control would be a lie. Show a rate control
//              instead — see altScrollJog.ts.
//   'none'   — normal buffer that fits in the viewport; show nothing.
export type ScrollAffordance = 'native' | 'jog' | 'none';

/** Set on `terminal.element` while xterm owns a real scroll range. */
export const NATIVE_SCROLL_CLASS = 'fmux-scroll-native';
/** Set on `terminal.element` while the hosted app owns scrolling. */
export const JOG_SCROLL_CLASS = 'fmux-scroll-jog';

export function resolveScrollAffordance(terminal: Terminal): ScrollAffordance {
  const buffer = terminal.buffer.active;
  // The alternate buffer never accumulates scrollback, so Monaco can never
  // produce a usable slider for it however long the session runs.
  if (buffer.type === 'alternate') return 'jog';
  // Mirrors Monaco's own `scrollSize > visibleSize` test: both sides are the
  // same cell height multiplied by lines vs rows.
  return buffer.length > terminal.rows ? 'native' : 'none';
}

export interface ScrollAffordanceBinding {
  /** Re-evaluate now (e.g. after a fit that changed rows). */
  refresh(): void;
  dispose(): void;
}

/**
 * Keeps `terminal.element`'s affordance classes in sync with terminal state,
 * and reports every change to `onChange`.
 *
 * The class is what gates the always-visible scrollbar CSS, so a pane that has
 * nothing to scroll falls back to Monaco's own (correct) hidden state instead
 * of displaying an inert full-track slider.
 */
export function bindScrollAffordance(
  terminal: Terminal,
  onChange?: (mode: ScrollAffordance) => void,
): ScrollAffordanceBinding {
  let disposed = false;
  let current: ScrollAffordance | null = null;

  const apply = (): void => {
    if (disposed) return;
    const element = terminal.element;
    if (!element) return;
    const next = resolveScrollAffordance(terminal);
    if (next === current) return;
    current = next;
    element.classList.toggle(NATIVE_SCROLL_CLASS, next === 'native');
    element.classList.toggle(JOG_SCROLL_CLASS, next === 'jog');
    onChange?.(next);
  };

  // onScroll covers the normal-buffer transition: lines.length can only grow
  // past rows by scrolling, which is exactly when this event fires. onResize
  // covers a pane shrinking below its line count without any scroll, and
  // onBufferChange covers entering/leaving a full-screen TUI.
  const subscriptions: IDisposable[] = [
    terminal.onScroll(apply),
    terminal.onResize(apply),
    terminal.buffer.onBufferChange(apply),
  ];
  apply();

  return {
    refresh: apply,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      const element = terminal.element;
      element?.classList.remove(NATIVE_SCROLL_CLASS, JOG_SCROLL_CLASS);
    },
  };
}
