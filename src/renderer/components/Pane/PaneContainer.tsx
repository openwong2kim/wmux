import { Fragment, useCallback, useEffect, useRef } from 'react';
import { Panel, Group, Separator, useGroupRef } from 'react-resizable-panels';
import type { Layout } from 'react-resizable-panels';
import type { Pane as PaneType, Workspace } from '../../../shared/types';
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
}

export default function PaneContainer({ pane, workspace, isWorkspaceVisible = true }: PaneContainerProps) {
  const activePaneId = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.activePaneId || '';
  });

  const updatePaneSizes = useStore((s) => s.updatePaneSizes);

  // useGroupRef is the v4 way to get an imperative handle for setLayout/getLayout
  const groupRef = useGroupRef();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const programmaticRef = useRef(false);

  const paneSizes = pane.type === 'branch' ? pane.sizes : undefined;
  const paneChildren = pane.type === 'branch' ? pane.children : undefined;
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
  }, [paneSizes]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLayoutChanged = useCallback(
    (layout: Layout) => {
      if (programmaticRef.current) {
        programmaticRef.current = false;
        return;
      }
      if (!paneChildren) return;
      const sizes = paneChildren.map((child) => layout[child.id] ?? 100 / paneChildren.length);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
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
      />
    );
  }

  const orientation = pane.direction === 'horizontal' ? 'horizontal' : 'vertical';

  return (
    <Group
      groupRef={groupRef}
      orientation={orientation}
      className="h-full w-full"
      resizeTargetMinimumSize={{ coarse: 37, fine: 16 }}
      onLayoutChanged={handleLayoutChanged}
    >
      {pane.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <Separator
              className={`${
                orientation === 'horizontal' ? 'w-1.5' : 'h-1.5'
              } bg-[var(--bg-surface)] hover:bg-[var(--accent-blue)] transition-colors`}
            />
          )}
          <Panel
            id={child.id}
            defaultSize={pane.sizes?.[i] ?? 100 / pane.children.length}
            minSize={10}
          >
            <PaneContainer pane={child} workspace={workspace} isWorkspaceVisible={isWorkspaceVisible} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}
