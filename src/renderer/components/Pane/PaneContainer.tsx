import { Fragment, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Panel, Group, Separator, useGroupRef } from 'react-resizable-panels';
import type { Layout } from 'react-resizable-panels';
import type { Pane as PaneType, Workspace } from '../../../shared/types';
import { findLeaf } from '../../../shared/paneUtils';
import { useStore } from '../../stores';
import PaneComponent from './Pane';

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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const programmaticRef = useRef(false);

  const paneSizes = pane.type === 'branch' ? pane.sizes : undefined;
  const paneChildren = pane.type === 'branch' ? pane.children : undefined;

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
      const sizes = paneChildren.map((child) => layout[child.id] ?? 100 / paneChildren.length);

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
      orientation={orientation}
      className="h-full w-full"
      resizeTargetMinimumSize={{ coarse: 37, fine: 16 }}
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
              defaultSize={pane.sizes?.[i] ?? 100 / pane.children.length}
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
