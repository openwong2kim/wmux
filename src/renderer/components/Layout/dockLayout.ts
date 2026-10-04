// Where the right dock (Moa's panel) sits, so the sheet never runs past the
// window. Inline, it is a flex sibling of the panes. When inline would leave
// the panes under PANE_MIN_WIDTH, the dock collapses and the titlebar Moa
// button reopens it as an overlay on the far edge instead, so the panes keep
// their width and nothing overflows horizontally.
import { useEffect, useState } from 'react';

export const DOCK_MIN_WIDTH = 248;
export const DOCK_MAX_WIDTH = 320;
/** The panes' floor beside an inline dock: the agent toolbar's icon-only row
 *  (≈396px) still fits at this width. */
export const PANE_MIN_WIDTH = 400;
/** The dock's width rule (ChannelDock's inline style): 26vw within its bounds. */
export const DOCK_WIDTH_CSS = `clamp(${DOCK_MIN_WIDTH}px, 26vw, ${DOCK_MAX_WIDTH}px)`;

export type DockMode = 'inline' | 'overlay';

/** DOCK_WIDTH_CSS for a viewport width. */
export function dockWidthFor(viewportWidth: number): number {
  return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, viewportWidth * 0.26));
}

/**
 * Inline only while the panes keep PANE_MIN_WIDTH beside the sidebar and the
 * dock. `shellWidth` is the sheet (sidebar + panes + dock); `sidebarWidth` is
 * 0 while the sidebar is hidden.
 */
export function dockMode(shellWidth: number, sidebarWidth: number, viewportWidth: number): DockMode {
  return shellWidth - sidebarWidth - dockWidthFor(viewportWidth) >= PANE_MIN_WIDTH ? 'inline' : 'overlay';
}

/**
 * The dock mode for the sheet element (window width as a fallback). Returns
 * the mode and a callback ref for the sheet: the sheet mounts after the first
 * render, so a plain ref would leave nothing to observe.
 */
export function useDockMode(sidebarWidth: number): [DockMode, (el: HTMLElement | null) => void] {
  const [shell, setShell] = useState<HTMLElement | null>(null);
  const measure = (): DockMode => {
    const viewport = typeof window === 'undefined' ? 1280 : window.innerWidth;
    const width = shell?.getBoundingClientRect().width || viewport;
    return dockMode(width, sidebarWidth, viewport);
  };
  const [mode, setMode] = useState<DockMode>(measure);
  useEffect(() => {
    const update = () => setMode(measure());
    update();
    window.addEventListener('resize', update);
    const observer = shell && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (shell) observer?.observe(shell);
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
    // measure reads the sheet and the sidebar width at call time.
  }, [shell, sidebarWidth]);
  return [mode, setShell];
}
