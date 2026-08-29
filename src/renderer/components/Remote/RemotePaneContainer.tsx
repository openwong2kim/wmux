import { Fragment, useCallback, useRef, type ReactNode } from 'react';
import { Panel, Group, Separator, useGroupRef } from 'react-resizable-panels';
import type { Layout } from 'react-resizable-panels';
import type { RemotePaneLeaf, RemotePaneNode } from './remotePaneTree';

interface RemotePaneContainerProps {
  node: RemotePaneNode;
  renderLeaf: (leaf: RemotePaneLeaf) => ReactNode;
  onResize: (branchId: string, sizes: number[]) => void;
}

/**
 * Recursive resizable-split renderer for a remote workspace's pane tree
 * (#1091) — the same `react-resizable-panels` primitives (`Group`/`Panel`/
 * `Separator`) the local `PaneContainer` uses, so drag-to-resize behaves
 * identically. Deliberately simpler than `PaneContainer`: this tree only
 * changes from THIS component's own resize/split/close actions (never from
 * an external write racing a live drag), so there is no need for
 * `PaneContainer`'s programmatic-vs-user layout reconciliation — a
 * structural change (split/close) always mounts a fresh branch id, which
 * naturally gets a fresh `Group` with the right `defaultSize`s.
 */
export default function RemotePaneContainer({ node, renderLeaf, onResize }: RemotePaneContainerProps) {
  const groupRef = useGroupRef();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleLayoutChanged = useCallback((layout: Layout) => {
    if (node.type !== 'branch') return;
    const branch = node;
    const sizes = branch.children.map((c) => layout[c.id] ?? 100 / branch.children.length);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onResize(branch.id, sizes), 200);
  }, [node, onResize]);

  if (node.type === 'leaf') {
    return <>{renderLeaf(node)}</>;
  }

  return (
    <Group
      groupRef={groupRef}
      orientation={node.direction}
      className="h-full w-full"
      resizeTargetMinimumSize={{ coarse: 37, fine: 16 }}
      onLayoutChanged={handleLayoutChanged}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <Separator
              className={`${node.direction === 'horizontal' ? 'w-px' : 'h-px'} bg-[var(--border-soft)] hover:bg-[var(--accent-blue)] transition-colors`}
            />
          )}
          <Panel id={child.id} defaultSize={node.sizes?.[i] ?? 100 / node.children.length} minSize={10}>
            <RemotePaneContainer node={child} renderLeaf={renderLeaf} onResize={onResize} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}
