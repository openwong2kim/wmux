// ─── Sidebar edge resize handle (#1481) ──────────────────────────────────────
//
// Drag the sidebar's inner edge to resize it (220–400px), double-click to go
// back to 264px, arrow keys when focused. Persisted through the store.
//
// The layout does NOT follow the pointer. While dragging, only a 1px guide is
// drawn at the would-be edge; the width is committed once, on release. Every
// terminal behind the sidebar refits on a width change, so a live drag would
// send a PTY resize per pointer move — a storm the shells and agents in those
// panes would all redraw for. One commit is one refit.

import { useCallback, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from '../../utils/sidebarLayout';

/** Pure: the width a drag lands on, given where it started and the pointer delta. */
export function widthForDrag(startWidth: number, deltaX: number, position: 'left' | 'right'): number {
  // Docked right, the inner edge is the LEFT one: moving it left widens.
  return clampSidebarWidth(startWidth + (position === 'right' ? -deltaX : deltaX));
}

const KEY_STEP = 16;

export default function SidebarResizeHandle() {
  const t = useT();
  const width = useStore((s) => s.sidebarWidth);
  const position = useStore((s) => s.sidebarPosition);
  const setWidth = useStore((s) => s.setSidebarWidth);
  const drag = useRef<{ startX: number; startWidth: number; edgeX: number } | null>(null);
  const [guideX, setGuideX] = useState<number | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const rect = e.currentTarget.parentElement?.getBoundingClientRect();
    const edgeX = rect ? (position === 'right' ? rect.left : rect.right) : e.clientX;
    drag.current = { startX: e.clientX, startWidth: width, edgeX };
    setGuideX(edgeX);
  }, [position, width]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = widthForDrag(d.startWidth, e.clientX - d.startX, position);
    const delta = next - d.startWidth;
    setGuideX(position === 'right' ? d.edgeX - delta : d.edgeX + delta);
  }, [position]);

  /** A cancelled gesture (pointercancel, capture lost to the OS or another
   *  element) ends the drag WITHOUT committing: the guide goes, the width stays. */
  const abort = useCallback(() => {
    drag.current = null;
    setGuideX(null);
  }, []);

  const finish = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setGuideX(null);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const next = widthForDrag(d.startWidth, e.clientX - d.startX, position);
    if (next !== d.startWidth) setWidth(next);
  }, [position, setWidth]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const grow = position === 'right' ? 'ArrowLeft' : 'ArrowRight';
    const shrink = position === 'right' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === grow) setWidth(width + KEY_STEP);
    else if (e.key === shrink) setWidth(width - KEY_STEP);
    else if (e.key === 'Home') setWidth(SIDEBAR_MIN_WIDTH);
    else if (e.key === 'End') setWidth(SIDEBAR_MAX_WIDTH);
    else if (e.key === 'Enter') setWidth(SIDEBAR_DEFAULT_WIDTH);
    else return;
    e.preventDefault();
  }, [position, setWidth, width]);

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.resize')}
        title={t('sidebar.resize')}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        data-sidebar-resize
        // Straddles the seam: 6px over the sidebar's edge, 4px over the
        // content's, so neither the row's close button nor the terminal's
        // first column loses its pointer.
        className={`absolute top-0 bottom-0 z-20 w-[10px] cursor-col-resize outline-none focus-visible:bg-[color-mix(in_srgb,var(--accent-blue)_35%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent-blue)_18%,transparent)] transition-colors duration-150 ${position === 'right' ? '-left-1' : '-right-1'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={abort}
        onLostPointerCapture={abort}
        onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={onKeyDown}
      />
      {guideX !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed top-0 bottom-0 z-[var(--z-popover-top)] w-px bg-[var(--accent-blue)]"
          style={{ left: guideX }}
          data-sidebar-resize-guide
        />
      )}
    </>
  );
}
