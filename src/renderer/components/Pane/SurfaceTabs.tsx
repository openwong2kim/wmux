import { useRef } from 'react';
import type { Surface, Workspace } from '../../../shared/types';
import { useT } from '../../hooks/useT';
import {
  buildExportPayload,
  buildPaneMarkdown,
} from '../../utils/sessionInfoMarkdown';

interface SurfaceTabsProps {
  surfaces: Surface[];
  activeSurfaceId: string;
  // Owning workspace and pane id, used to build the drag-export payload.
  // These are now always provided by the PaneContainer prop chain so the
  // payload always names the correct workspace, even in multiview where
  // global active state would lie (codex P1).
  workspace: Workspace;
  paneId: string;
  onSelect: (surfaceId: string) => void;
  onClose: (surfaceId: string) => void;
  onAdd: () => void;
}

export default function SurfaceTabs({
  surfaces,
  activeSurfaceId,
  workspace,
  paneId,
  onSelect,
  onClose,
}: SurfaceTabsProps) {
  const t = useT();
  // Same 200ms threshold pattern WorkspaceItem uses so a fast click never
  // gets eaten by a click-after-dragend race.
  const dragStartTimeRef = useRef<number>(0);

  // Always render the strip — even for a single surface — so the X button is
  // reachable. Pane.tsx's handleCloseSurface cascades into closePane when the
  // last surface is removed, so this is also the only mouse path to dismantle
  // a split. Hiding it left users unable to close split panes (the keyboard
  // shortcut Ctrl+W now mirrors the same cascade, but the X must exist too).

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    // Abort early if this pane cannot produce a useful payload (codex P1 #2).
    const payload = buildExportPayload(workspace, paneId);
    if (payload.surfaceIds.length === 0) {
      e.preventDefault();
      return;
    }
    dragStartTimeRef.current = Date.now();
    // Keep the dataTransfer surface minimal — text/plain only. Adding
    // non-standard MIMEs (application/x-wmux-export+json) or File items
    // pushed Claude Desktop's drop handler into "attachment" mode, where
    // an in-memory File cannot cross the process boundary, so the drop
    // silently failed. text/plain alone behaves like a paste and is
    // accepted by every chat client we have tested.
    const md = buildPaneMarkdown(workspace, paneId);
    e.dataTransfer.setData('text/plain', md);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleTabClick = (surfaceId: string) => {
    // Suppress click-after-dragend so a drop on an external surface does not
    // also switch the active tab on return. Mirrors WorkspaceItem.handleClick.
    if (Date.now() - dragStartTimeRef.current < 200) return;
    onSelect(surfaceId);
  };

  return (
    <div className="flex items-center bg-[var(--bg-mantle)] border-b border-[var(--bg-surface)] h-7 overflow-x-auto">
      {surfaces.map((s) => (
        <div
          key={s.id}
          draggable
          onDragStart={handleDragStart}
          className={`group flex items-center gap-1 px-3 h-full cursor-pointer text-xs border-r border-[var(--bg-surface)] transition-colors ${
            s.id === activeSurfaceId
              ? 'bg-[var(--bg-base)] text-[var(--text-main)]'
              : 'text-[var(--text-subtle)] hover:text-[var(--text-sub)] hover:bg-[rgba(var(--bg-base-rgb),0.5)]'
          }`}
          onClick={() => handleTabClick(s.id)}
        >
          <span className="truncate max-w-[120px]">{s.title || t('surface.terminal')}</span>
          {/* X close button — always visible, not just on hover */}
          <button
            className="text-[var(--text-subtle)] hover:text-[var(--accent-red)] transition-colors ml-1 leading-none"
            onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
            title={t('surface.closeTab')}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
