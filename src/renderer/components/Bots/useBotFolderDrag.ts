// Dragging bot rows onto a folder (or the unfiled rows): native drag and drop
// as the Sidebar's workspace rows do it. The source is held here, not read back
// from `dataTransfer` (which a foreign drag fills too), the dragged look is
// inline `opacity` so the source is never re-rendered mid-drag, and a click
// within 200 ms of a drag is not a click.
import { useRef, useState } from 'react';
import { botConversationId } from './botsModel';

/** `dropOn` while the unfiled rows are the drop target. */
export const UNFILED_DROP = '';

export function useBotFolderDrag({ selection, selectedIds, order, folderOfBot, moveBots }: {
  selection: ReadonlySet<string>;
  selectedIds: () => string[];
  order: readonly string[];
  folderOfBot: (botId: string) => string | null;
  moveBots: (botIds: string[], folderId: string | null) => void;
}) {
  const dragIds = useRef<string[] | null>(null);
  const dragStartedAt = useRef(0);
  const dimmed = useRef<HTMLElement[]>([]);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const dragStart = (e: React.DragEvent<HTMLElement>, botId: string) => {
    const ids = selection.has(botId) && selection.size > 1 ? selectedIds() : [botId];
    dragIds.current = ids;
    dragStartedAt.current = Date.now();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-wmux-bots', ids.join(' '));
    dimmed.current = [];
    for (const id of ids) {
      const el = rowsRef.current?.querySelector<HTMLElement>(`[data-bots-entry="${botConversationId(id)}"]`);
      if (!el) continue;
      el.style.opacity = '0.4';
      dimmed.current.push(el);
    }
  };
  const dragEnd = () => {
    for (const el of dimmed.current) el.style.opacity = '';
    dimmed.current = [];
    dragIds.current = null;
    dragStartedAt.current = Date.now();
    setDropOn(null);
  };
  /** Handlers for a drop target: a folder id, or null for the unfiled rows. */
  const dropTarget = (folderId: string | null) => {
    const key = folderId ?? UNFILED_DROP;
    // Only our own drag, and only when it would change something.
    const accepts = () => !!dragIds.current?.some((id) => folderOfBot(id) !== folderId);
    return {
      onDragOver: (e: React.DragEvent<HTMLElement>) => {
        if (!accepts()) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropOn((cur) => (cur === key ? cur : key));
      },
      onDragLeave: (e: React.DragEvent<HTMLElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropOn((cur) => (cur === key ? null : cur));
      },
      onDrop: (e: React.DragEvent<HTMLElement>) => {
        if (!accepts()) return;
        e.preventDefault();
        e.stopPropagation();
        const live = new Set(order);
        const ids = (dragIds.current ?? []).filter((id) => live.has(id) && folderOfBot(id) !== folderId);
        dragEnd();
        moveBots(ids, folderId);
      },
    };
  };
  return { rowsRef, dropOn, dragStartedAt, dragStart, dragEnd, dropTarget };
}
