import { Fragment, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Panel, Group, Separator, useGroupRef } from 'react-resizable-panels';
import type { Layout } from 'react-resizable-panels';
import type { Pane as PaneType, Workspace } from '../../../shared/types';
import { findLeaf } from '../../../shared/paneUtils';
import { useStore } from '../../stores';
import PaneComponent from './Pane';

/**
 * How far around a separator's 1px line the library lets the pointer grab it
 * (`resizeTargetMinimumSize`). Shared with the double-click hit test below so
 * a double-click lands on exactly the band a drag grabs.
 */
const SEPARATOR_HIT_TARGET = { coarse: 37, fine: 16 };

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
 * #1233 — which of `groupEl`'s own separators a pointer at (x, y) is on, as the
 * index `separatorEqualizePair` takes (the child after it), or -1.
 *
 * The library grabs a separator anywhere in a band `fine` px wide centred on
 * the 1px line, so a real double-click usually lands on the neighbouring panel,
 * not on the separator element — an onDoubleClick on the element never sees it.
 * Hit-testing the band sees the same double-click the library sees. Only direct
 * children are this group's separators; a nested group tests its own.
 */
export function separatorIndexAt(
  groupEl: Element,
  orientation: 'horizontal' | 'vertical',
  x: number,
  y: number,
): number {
  const separators = Array.from(groupEl.children).filter((el) => el.getAttribute('role') === 'separator');
  for (let i = 0; i < separators.length; i++) {
    const r = separators[i].getBoundingClientRect();
    // display:none (zoom-hidden, a background workspace) measures 0x0.
    if (r.width === 0 && r.height === 0) continue;
    const hit = orientation === 'horizontal'
      ? Math.abs(x - (r.left + r.width / 2)) <= Math.max(r.width, SEPARATOR_HIT_TARGET.fine) / 2
        && y >= r.top && y <= r.bottom
      : Math.abs(y - (r.top + r.height / 2)) <= Math.max(r.height, SEPARATOR_HIT_TARGET.fine) / 2
        && x >= r.left && x <= r.right;
    if (hit) return i + 1;
  }
  return -1;
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
  const programmaticRef = useRef(false);

  const paneSizes = pane.type === 'branch' ? pane.sizes : undefined;
  const paneChildren = pane.type === 'branch' ? pane.children : undefined;
  const paneDirection = pane.type === 'branch' ? pane.direction : undefined;

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

  useEffect(() => {
    if (!paneSizes || !paneChildren || !groupRef.current) return;

    const layout: Layout = {};
    paneChildren.forEach((child, i) => {
      layout[child.id] = paneSizes[i] ?? 100 / paneChildren.length;
    });

    const current = groupRef.current.getLayout();
    const isDifferent = paneChildren.some((child) => {
      const stored = layout[child.id];
      const visual = current[child.id];
      return visual === undefined || Math.abs(stored - visual) > 0.5;
    });

    if (isDifferent) {
      // The store moved under a pending write — a snap, a double-click, or the
      // library reporting its cached layout for this panel set when it
      // re-registered. That write describes a superseded layout; left armed it
      // lands 200ms later and puts the old widths back over the new ones.
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }
      programmaticRef.current = true;
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

  const handleLayoutChanged = useCallback(
    (layout: Layout) => {
      if (programmaticRef.current) {
        programmaticRef.current = false;
        return;
      }
      if (!paneChildren) return;
      // A layout that does not describe every current child belongs to a panel
      // set in transition. Filling the gaps with a default would persist sizes
      // that do not sum to 100.
      const sizes: number[] = [];
      for (const child of paneChildren) {
        const size = layout[child.id];
        if (size === undefined) return;
        sizes.push(size);
      }

      // Which children these sizes describe. A branch that survives the
      // restructure (same node, different children) would not unmount, so the
      // cleanup above cannot catch that case — compare instead.
      const scheduledFor = paneChildren.map((child) => child.id).join('|');

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (childIdKeyRef.current !== scheduledFor) return; // stale: the branch changed under us
        updatePaneSizes(pane.id, sizes);
      }, 200);
    },
    [pane.id, paneChildren, updatePaneSizes],
  );

  // #1233 — double-click a separator to even out the two panes it separates
  // (separatorEqualizePair above). Goes through the store, not setLayout
  // directly, so the change persists like a drag and the sync effect above
  // drives the visual resize. A pending drag-write is dropped first: it would
  // land ~200ms later and snap the widths back to the arrangement the
  // double-click just reset.
  const handleSeparatorDoubleClick = useCallback(
    (index: number) => {
      if (!paneChildren) return;
      const sizes = paneChildren.map(
        (_, i) => paneSizes?.[i] ?? 100 / paneChildren.length,
      );
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }
      updatePaneSizes(pane.id, separatorEqualizePair(sizes, index));
    },
    [pane.id, paneSizes, paneChildren, updatePaneSizes],
  );

  // #1233 — the double-click itself. On window, CAPTURE phase: that runs before
  // the library's own document-capture dblclick handler, which resets the
  // first panel of the pair to its defaultSize and would otherwise race this
  // write through onLayoutChanged. That handler returns early on
  // defaultPrevented, so preventDefault() here is what keeps the two from both
  // applying. The target must be inside this group: a popover floating over
  // the band is not a double-click on the divider.
  useEffect(() => {
    if (!paneDirection) return;
    const orientation = paneDirection === 'horizontal' ? 'horizontal' : 'vertical';
    const onDoubleClick = (e: MouseEvent) => {
      const groupEl = groupElementRef.current;
      if (!groupEl || !(e.target instanceof Node) || !groupEl.contains(e.target)) return;
      const index = separatorIndexAt(groupEl, orientation, e.clientX, e.clientY);
      if (index < 1) return;
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
