import { Fragment, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Panel, Group, Separator, useGroupRef } from 'react-resizable-panels';
import type { Layout } from 'react-resizable-panels';
import type { Pane as PaneType, Workspace } from '../../../shared/types';
import { findLeaf } from '../../../shared/paneUtils';
import { useStore } from '../../stores';
import PaneComponent from './Pane';

/**
 * How far around a divider's 1px line the library lets the pointer grab it
 * (`resizeTargetMinimumSize`). Shared with the double-click hit test below so
 * a double-click lands on exactly the band a drag grabs.
 */
const SEPARATOR_HIT_TARGET = { coarse: 37, fine: 16 };

/** The band the library grabs with — it picks coarse or fine from this same
 *  media query, not per event. */
function separatorBand(): number {
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return coarse ? SEPARATOR_HIT_TARGET.coarse : SEPARATOR_HIT_TARGET.fine;
}

function rectContains(r: DOMRect, x: number, y: number): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Whether `layout` describes exactly these children — i.e. the library has
 *  registered this panel set, not the one before it. */
function layoutMatchesChildren(layout: Layout, children: readonly { id: string }[]): boolean {
  return Object.keys(layout).length === children.length && children.every((c) => layout[c.id] !== undefined);
}

/**
 * #1233 — the sizes a double-clicked separator commits: the space of the two
 * panes it separates, split evenly between them. The two-pane case is the
 * 50/50 the issue asks for; in a three-plus group only the flanking pair is
 * touched, so the gesture stays local to the divider under the cursor. Pure so
 * the arithmetic is testable without mounting the panel tree.
 */
export function separatorEqualizePair(sizes: number[], index: number): number[] {
  const next = [...sizes];
  if (index < 1 || index >= next.length) return next;
  const pair = next[index - 1] + next[index];
  next[index - 1] = pair / 2;
  next[index] = pair / 2;
  return next;
}

/**
 * #1233 — which of `groupEl`'s OWN dividers (direct children only; a nested
 * group tests its own) the point (x, y) is on, as the index
 * `separatorEqualizePair` takes (the child after it), or -1.
 *
 * By coordinates, because that is how the library grabs a divider: anywhere in
 * a `band`-wide strip centred on the 1px line. Where two strips overlap (panes
 * near their floor) the nearest line wins. A 0x0 divider is display:none —
 * zoom-hidden, or in a background workspace — and never matches.
 */
export function separatorIndexAt(groupEl: Element, x: number, y: number, band: number): number {
  let best = -1;
  let bestDistance = Infinity;
  const separators = Array.from(groupEl.children).filter((el) => el.getAttribute('role') === 'separator');
  separators.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    // A divider is a line: taller than wide between side-by-side panes, wider
    // than tall between stacked ones.
    const vertical = r.width <= r.height;
    const distance = vertical ? Math.abs(x - (r.left + r.width / 2)) : Math.abs(y - (r.top + r.height / 2));
    const reach = Math.max(vertical ? r.width : r.height, band) / 2;
    const alongLine = vertical ? y >= r.top && y <= r.bottom : x >= r.left && x <= r.right;
    if (alongLine && distance <= reach && distance < bestDistance) {
      best = i + 1;
      bestDistance = distance;
    }
  });
  return best;
}

/** Whether a group nested inside `groupEl` has a divider band at (x, y): at a
 *  T-junction the innermost group handles the double-click, so one pair is
 *  evened out, not both. */
function nestedGroupClaims(groupEl: Element, x: number, y: number, band: number): boolean {
  for (const nested of Array.from(groupEl.querySelectorAll('[data-group]'))) {
    if (rectContains(nested.getBoundingClientRect(), x, y) && separatorIndexAt(nested, x, y, band) > 0) return true;
  }
  return false;
}

interface PaneContainerProps {
  pane: PaneType;
  // The workspace this pane tree belongs to. Threaded through PaneContainer's
  // recursion so leaf panes (and their SurfaceTabs) always know their owning
  // workspace, even in multiview where multiple workspace trees mount at the
  // same time and useStore(activeWorkspaceId) would point at the wrong one
  // (codex P1).
  workspace: Workspace;
  isWorkspaceVisible?: boolean;
  /** True when an ANCESTOR branch hid this subtree because another pane in the
   *  same tree is zoomed (#517, codex P2). Computed here from the actual
   *  render tree — the global zoomedPaneId alone cannot tell whether a pane
   *  in a DIFFERENT (still visible) workspace tree is affected. */
  isZoomHidden?: boolean;
}

export default function PaneContainer({ pane, workspace, isWorkspaceVisible = true, isZoomHidden = false }: PaneContainerProps) {
  const activePaneId = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.activePaneId || '';
  });

  // Pane zoom (issue #182): when a leaf in THIS subtree is zoomed, hide every
  // sibling Panel that is not on the path to the zoomed leaf. The library
  // sizes panels with flexGrow over flexBasis:0, so once the off-path
  // siblings (and separators) are display:none, the on-path panel is the only
  // grow item left and naturally fills 100% — no layout state is touched, so
  // un-zooming restores the exact previous split. All panes stay mounted
  // (same hide-don't-unmount pattern as inactive workspaces in AppLayout).
  const zoomedPaneId = useStore((s) => s.zoomedPaneId);

  const updatePaneSizes = useStore((s) => s.updatePaneSizes);

  // useGroupRef is the v4 way to get an imperative handle for setLayout/getLayout
  const groupRef = useGroupRef();
  const groupElementRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Set when the store's sizes could not be pushed because the library had
  // not registered the current panel set yet; its next report re-applies them.
  const resyncPendingRef = useRef(false);

  const paneSizes = pane.type === 'branch' ? pane.sizes : undefined;
  const paneChildren = pane.type === 'branch' ? pane.children : undefined;
  const paneDirection = pane.type === 'branch' ? pane.direction : undefined;
  const workspaceId = workspace.id;

  // The library keys its layout by CHILD ID, so the set and order of children
  // is as much an input to the sync below as `sizes` is. Issue #645 made this
  // load-bearing: swapping two panes exchanges the ids without touching
  // `sizes`, and a `[paneSizes]`-only dependency would skip the re-sync — the
  // widths would then travel with the panes instead of staying with the slots.
  const childIdKey = paneChildren?.map((c) => c.id).join('|');

  // Latest children, readable from a stale timer callback (see below). Written
  // in a layout effect rather than during render: a render can be thrown away
  // (StrictMode, a concurrent re-render), and a ref written during one would
  // then describe children that were never committed.
  const childIdKeyRef = useRef(childIdKey);
  useLayoutEffect(() => {
    childIdKeyRef.current = childIdKey;
  }, [childIdKey]);

  const clearPendingWrite = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
  }, []);

  // Store → library. The store is the one source of truth for sizes; the
  // library's layout is a view of it, and the only library → store writes are
  // the user's own gestures (handleLayoutChanged below).
  useEffect(() => {
    if (!paneSizes || !paneChildren || !groupRef.current) return;

    const current = groupRef.current.getLayout();
    if (!layoutMatchesChildren(current, paneChildren)) {
      // The library registers a changed panel set a commit AFTER this effect
      // runs. A setLayout now would land on the PREVIOUS registration: it
      // throws when the child count changed, and otherwise leaves the library
      // holding a layout keyed by ids that are gone (the returning pane renders
      // at flexGrow 1 and every later drag reports the stale ids). Its
      // registration report re-applies the store instead.
      resyncPendingRef.current = true;
      return;
    }

    const layout: Layout = {};
    paneChildren.forEach((child, i) => {
      layout[child.id] = paneSizes[i] ?? 100 / paneChildren.length;
    });
    const isDifferent = paneChildren.some((child) => Math.abs(layout[child.id] - current[child.id]) > 0.5);
    if (isDifferent) {
      // The store moved under a pending drag write: that write describes a
      // superseded layout and would land 200ms later over this one.
      clearPendingWrite();
      groupRef.current.setLayout(layout);
    }
    // paneChildren is intentionally not a dependency: childIdKey already
    // encodes the child set, and the array identity changes on unrelated
    // store writes.
  }, [paneSizes, childIdKey]);

  // A resize that ends just before the tree is restructured would otherwise
  // land AFTER it: the 200ms timer below fires, writes the pre-move sizes onto
  // a branch whose children have changed, and the panes visibly snap to the
  // wrong widths — looking, to the user, like the move failed. Drop any
  // pending write when this branch unmounts.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // Library → store: every layout the library reports, sorted into what it is.
  const handleLayoutChanged = useCallback(
    (layout: Layout) => {
      if (!paneChildren) return;
      // Keyed by other ids: the library describing a panel set this branch no
      // longer has, while it catches up. Never persisted; the report for the
      // current set follows.
      if (!layoutMatchesChildren(layout, paneChildren)) return;

      const stored = paneChildren.map((_, i) => paneSizes?.[i] ?? 100 / paneChildren.length);
      const sizes = paneChildren.map((child) => layout[child.id]);

      if (sizes.every((size, i) => Math.abs(size - stored[i]) <= 0.5)) {
        // The screen already shows the store: the echo of our own setLayout, or
        // a drag that ended where it began. Anything pending is superseded.
        resyncPendingRef.current = false;
        clearPendingWrite();
        return;
      }

      if (resyncPendingRef.current) {
        // The first report after the panel set changed. It comes from the
        // library's per-panel-set cache or its defaults — never from the user —
        // and a snap / split / close just wrote the real sizes to the store.
        // Push those back rather than persisting the cache over them. Deferred:
        // this runs inside the library's own change notification.
        resyncPendingRef.current = false;
        clearPendingWrite();
        const target: Layout = {};
        paneChildren.forEach((child, i) => { target[child.id] = stored[i]; });
        const expectedKey = paneChildren.map((child) => child.id).join('|');
        queueMicrotask(() => {
          const group = groupRef.current;
          if (!group || childIdKeyRef.current !== expectedKey) return;
          if (!layoutMatchesChildren(group.getLayout(), paneChildren)) return;
          group.setLayout(target);
        });
        return;
      }

      // A user's drag. Persisted after the debounce, and only if the branch
      // still has the children these sizes describe: a branch that survives a
      // restructure (same node, different children) would not unmount, so the
      // cleanup above cannot catch that case — compare instead.
      const scheduledFor = paneChildren.map((child) => child.id).join('|');
      clearPendingWrite();
      debounceRef.current = setTimeout(() => {
        if (childIdKeyRef.current !== scheduledFor) return; // stale: the branch changed under us
        updatePaneSizes(pane.id, sizes, workspaceId);
      }, 200);
    },
    [pane.id, paneChildren, paneSizes, updatePaneSizes, workspaceId, groupRef, clearPendingWrite],
  );

  // #1233 — double-click a separator to even out the two panes it separates
  // (separatorEqualizePair above). Goes through the store, not setLayout
  // directly, so the change persists like a drag and the sync effect above
  // drives the visual resize. The pair is read from the LIVE layout when the
  // library has this exact panel set: a drag on another divider may still be
  // inside its 200ms debounce, and the store would put it back. That pending
  // write is dropped for the same reason — the live layout already holds it.
  const handleSeparatorDoubleClick = useCallback(
    (index: number) => {
      if (!paneChildren) return;
      const live = groupRef.current?.getLayout();
      const sizes = live && layoutMatchesChildren(live, paneChildren)
        ? paneChildren.map((child) => live[child.id])
        : paneChildren.map((_, i) => paneSizes?.[i] ?? 100 / paneChildren.length);
      clearPendingWrite();
      // This tile's workspace, not the active one: a multiview tile that is
      // not active is still on screen and still double-clickable.
      updatePaneSizes(pane.id, separatorEqualizePair(sizes, index), workspaceId);
    },
    [pane.id, paneSizes, paneChildren, updatePaneSizes, workspaceId, groupRef, clearPendingWrite],
  );

  // #1233 — the double-click itself. On window, CAPTURE phase: that runs before
  // the library's own document-capture dblclick handler, which resets the
  // first panel of the pair to its defaultSize and would otherwise race this
  // write. That handler returns early on defaultPrevented, so preventDefault()
  // here keeps the two from both applying.
  //
  // Decided by coordinates, never by e.target: a double-click exactly on the
  // line has its pointerdown on the divider and its pointerup on a panel, so
  // the browser dispatches the dblclick to their common ancestor (BODY). A
  // target in an unrelated subtree — a popover portalled over the band — is
  // still ignored: it is neither inside this group nor one of its ancestors.
  useEffect(() => {
    if (!paneDirection) return;
    const onDoubleClick = (e: MouseEvent) => {
      const groupEl = groupElementRef.current;
      if (!groupEl) return;
      const target = e.target;
      if (target instanceof Node && !groupEl.contains(target) && !target.contains(groupEl)) return;
      const { clientX: x, clientY: y } = e;
      if (!rectContains(groupEl.getBoundingClientRect(), x, y)) return;
      const band = separatorBand();
      const index = separatorIndexAt(groupEl, x, y, band);
      if (index < 1 || nestedGroupClaims(groupEl, x, y, band)) return;
      e.preventDefault();
      handleSeparatorDoubleClick(index);
    };
    window.addEventListener('dblclick', onDoubleClick, true);
    return () => window.removeEventListener('dblclick', onDoubleClick, true);
  }, [paneDirection, handleSeparatorDoubleClick]);

  if (pane.type === 'leaf') {
    return (
      <PaneComponent
        pane={pane}
        workspace={workspace}
        isActive={pane.id === activePaneId}
        isWorkspaceVisible={isWorkspaceVisible}
        isZoomHidden={isZoomHidden}
      />
    );
  }

  const orientation = pane.direction === 'horizontal' ? 'horizontal' : 'vertical';

  // Zoom only affects this branch when the zoomed leaf lives somewhere below
  // it; a zoomed pane in another workspace (or none) leaves rendering as-is.
  const zoomInSubtree = zoomedPaneId !== null && findLeaf(pane, zoomedPaneId) !== null;

  return (
    <Group
      groupRef={groupRef}
      elementRef={groupElementRef}
      orientation={orientation}
      className="h-full w-full"
      resizeTargetMinimumSize={SEPARATOR_HIT_TARGET}
      onLayoutChanged={handleLayoutChanged}
    >
      {pane.children.map((child, i) => {
        // Off the zoom path → hide (keep mounted). The data attribute is
        // spread onto the Panel's OUTER flex-item div (className would land
        // on the inner one), and the globals.css rule beats the library's
        // inline display with !important.
        const zoomHidden = zoomInSubtree && findLeaf(child, zoomedPaneId) === null;
        return (
          <Fragment key={child.id}>
            {i > 0 && (
              <Separator
                className={`${
                  orientation === 'horizontal' ? 'w-px' : 'h-px'
                } bg-[var(--border-soft)] hover:bg-[var(--accent-blue)] transition-colors ${
                  zoomInSubtree ? 'wmux-zoom-hidden' : ''
                }`}
              />
            )}
            <Panel
              id={child.id}
              // A PERCENT string: v4 reads a bare number as pixels, so the
              // stored 81 became 81px (~17% of a 485px group) wherever the
              // library falls back to defaultSize — its double-click reset and
              // the default layout of a panel set it has no cached layout for.
              defaultSize={`${pane.sizes?.[i] ?? 100 / pane.children.length}%`}
              minSize={10}
              {...(zoomHidden ? { 'data-wmux-zoom-hidden': true } : {})}
            >
              <PaneContainer
                pane={child}
                workspace={workspace}
                isWorkspaceVisible={isWorkspaceVisible}
                isZoomHidden={isZoomHidden || zoomHidden}
              />
            </Panel>
          </Fragment>
        );
      })}
    </Group>
  );
}
