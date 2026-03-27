import { Panel, Group, Separator } from 'react-resizable-panels';
import type { Pane as PaneType } from '../../../shared/types';
import { useStore } from '../../stores';
import PaneComponent from './Pane';

interface PaneContainerProps {
  pane: PaneType;
  isWorkspaceVisible?: boolean;
}

export default function PaneContainer({ pane, isWorkspaceVisible = true }: PaneContainerProps) {
  const activePaneId = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.activePaneId || '';
  });

  if (pane.type === 'leaf') {
    return <PaneComponent pane={pane} isActive={pane.id === activePaneId} isWorkspaceVisible={isWorkspaceVisible} />;
  }

  const orientation = pane.direction === 'horizontal' ? 'horizontal' : 'vertical';

  return (
    <Group orientation={orientation} className="h-full w-full">
      {pane.children.map((child, i) => (
        <div key={child.id} className="contents">
          {i > 0 && (
            <Separator
              className={`${
                orientation === 'horizontal' ? 'w-1' : 'h-1'
              } bg-[var(--bg-surface)] hover:bg-[var(--accent-blue)] transition-colors`}
            />
          )}
          <Panel defaultSize={pane.sizes?.[i] ?? 100 / pane.children.length} minSize={10}>
            <PaneContainer pane={child} isWorkspaceVisible={isWorkspaceVisible} />
          </Panel>
        </div>
      ))}
    </Group>
  );
}
