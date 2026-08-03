import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { t } from '../../i18n';
import {
  DRAG_THRESHOLD_PX,
  collectDropRects,
  resolveDropTarget,
  type DropTarget,
  type PaneRect,
} from './paneDrag';

interface PaneDragGripProps {
  paneId: string;
  workspaceId: string;
}

/**
 * Issue #645 — the handle you grab to move a pane.
 *
 * Sits in the tab strip row, never on a tab: tabs own their own HTML5 drag
 * (terminal text export), and this uses pointer events precisely so the two
 * never meet. Under the movement threshold the gesture is left alone as a
 * click, so tapping the grip still just focuses the pane.
 *
 * Drop feedback is published to the store rather than drawn here, because the
 * indicator belongs to the pane being hovered, not to the pane being dragged.
 */
export default function PaneDragGrip({ paneId, workspaceId }: PaneDragGripProps) {
  const movePane = useStore((s) => s.movePane);
  const swapPanes = useStore((s) => s.swapPanes);
  const setPaneDropTarget = useStore((s) => s.setPaneDropTarget);
  const setPaneDragSource = useStore((s) => s.setPaneDragSource);
  const setActivePane = useStore((s) => s.setActivePane);

  const [armed, setArmed] = useState(false);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const rectsRef = useRef<PaneRect[]>([]);
  const targetRef = useRef<DropTarget | null>(null);
  /** Did the gesture that just ended actually drag? Read by the click handler. */
  const wasDragRef = useRef(false);
  const gripRef = useRef<HTMLDivElement>(null);
  const capturedPointerRef = useRef<number | null>(null);

  const endDrag = useCallback(() => {
    // Escape ends the drag while the button is still held, so the capture
    // would otherwise stay on this grip and swallow every other pane's
    // pointer events until the user lets go.
    const el = gripRef.current;
    if (el && capturedPointerRef.current !== null) {
      try { el.releasePointerCapture(capturedPointerRef.current); } catch { /* already gone */ }
      capturedPointerRef.current = null;
    }
    draggingRef.current = false;
    originRef.current = null;
    rectsRef.current = [];
    targetRef.current = null;
    setArmed(false);
    setPaneDragSource(null);
    setPaneDropTarget(null);
  }, [setPaneDragSource, setPaneDropTarget]);

  // Escape aborts mid-drag, leaving the tree untouched. Bound only while armed
  // so the app's other Escape handling is unaffected the rest of the time.
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        endDrag();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [armed, endDrag]);

  // A pane can vanish under the user: an agent or the daemon may close it
  // mid-drag, and then this grip unmounts without ever seeing pointerup,
  // pointercancel, or Escape. Without this, paneDropTarget stays set and the
  // drop indicator is painted on some pane forever. endDrag is read through a
  // ref so the cleanup runs ONLY on unmount, not whenever its identity changes.
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;
  useEffect(() => () => {
    if (draggingRef.current || originRef.current) endDragRef.current();
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // Keep the pane's own click-to-focus from firing when this turns into a
      // drag — otherwise "Escape cancelled the drag" would still have moved
      // focus, and the cancel would not be a true no-op.
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      capturedPointerRef.current = e.pointerId;
      originRef.current = { x: e.clientX, y: e.clientY };
      // Fresh gesture: only a real drag may set this, and only the trailing
      // click clears it.
      wasDragRef.current = false;
      setArmed(true);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const origin = originRef.current;
      if (!origin) return;

      if (!draggingRef.current) {
        const moved = Math.hypot(e.clientX - origin.x, e.clientY - origin.y);
        if (moved < DRAG_THRESHOLD_PX) return; // still a click
        draggingRef.current = true;
        // Latch it here rather than at pointerup: Escape ends the drag first,
        // so by the time pointerup runs draggingRef is already false and a
        // cancelled drag would look like a plain click (and steal focus).
        wasDragRef.current = true;
        // Measure once at drag start: the layout cannot change mid-drag (no
        // pane is created or closed), and re-measuring every move would thrash.
        rectsRef.current = collectDropRects({
          root: document,
          sourcePaneId: paneId,
          workspaceId,
        });
        setPaneDragSource(paneId);
      }

      const target = resolveDropTarget(rectsRef.current, e.clientX, e.clientY);
      targetRef.current = target;
      setPaneDropTarget(target);
    },
    [paneId, workspaceId, setPaneDragSource, setPaneDropTarget],
  );

  // A `click` still fires after the gesture, and pointer capture sends it to
  // the GRIP — so it bubbles into the pane root's click-to-focus. Stopping
  // pointerdown does not prevent that (click is a separate event). Left alone,
  // a cancelled drag would still move focus and "Escape changes nothing" would
  // be a lie. Swallow the click here and do the focusing ourselves, only when
  // the gesture really was a click.
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (!wasDragRef.current) setActivePane(paneId);
      wasDragRef.current = false;
    },
    [paneId, setActivePane],
  );

  const handlePointerUp = useCallback(() => {
    const wasDragging = draggingRef.current;
    const target = targetRef.current;
    endDrag();
    if (!wasDragging || !target) return;

    if (target.edge === null) {
      swapPanes(workspaceId, paneId, target.paneId);
    } else {
      // The user grabbed this pane, so it keeps focus after landing.
      movePane(workspaceId, paneId, target.paneId, target.edge, { focusSource: true });
    }
  }, [endDrag, movePane, swapPanes, paneId, workspaceId]);

  return (
    <div
      data-pane-drag-grip
      role="button"
      tabIndex={-1}
      aria-label={t('pane.dragGrip')}
      title={t('pane.dragGrip')}
      ref={gripRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={handleClick}
      onPointerCancel={endDrag}
      style={{
        width: 14,
        height: 18,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: armed ? 'grabbing' : 'grab',
        // Quiet by default; the grip is an affordance, not an instrument.
        color: armed ? 'var(--accent-blue)' : 'var(--text-muted)',
        opacity: armed ? 1 : 0.55,
        transition: 'opacity 120ms ease-out, color 120ms ease-out',
        userSelect: 'none',
        touchAction: 'none', // let pointermove through instead of scrolling
      }}
    >
      {/* Six-dot grip: the conventional "this is draggable" mark. */}
      <svg width="6" height="12" viewBox="0 0 6 12" aria-hidden="true">
        {[2, 6, 10].map((cy) =>
          [1, 5].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1" fill="currentColor" />),
        )}
      </svg>
    </div>
  );
}
