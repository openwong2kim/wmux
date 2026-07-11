import { useRef, useState, useEffect } from 'react';
import type { AgentStatus, Surface, Workspace } from '../../../shared/types';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import {
  buildExportPayload,
  buildPaneMarkdown,
} from '../../utils/sessionInfoMarkdown';
import { tokenAttrs } from '../../themes';
import { computePaneAutoName, paneDisplayName } from '../../utils/paneNaming';
import { findPane } from '../../../shared/paneUtils';

/** B8: dot color for a completed/awaiting surface tab. */
function statusDotColor(status: AgentStatus): string {
  return status === 'complete' ? 'var(--accent-green)' : 'var(--accent-yellow)';
}

interface SurfaceTabsProps {
  surfaces: Surface[];
  activeSurfaceId: string;
  /** Whether the OWNING PANE is the focused pane — paints the amber underline
   *  under the strip (the design system's focus signal; the pane border stays
   *  a quiet hairline). */
  paneActive?: boolean;
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
  paneActive = false,
  onSelect,
  onClose,
}: SurfaceTabsProps) {
  const t = useT();
  // Same 200ms threshold pattern WorkspaceItem uses so a fast click never
  // gets eaten by a click-after-dragend race.
  const dragStartTimeRef = useRef<number>(0);
  // B8: per-surface completed/awaiting status. A blinking dot marks a
  // BACKGROUND tab (not the active surface) whose terminal finished, so a
  // completed agent is discoverable even when its tab isn't on top. The
  // active surface's completion is conveyed by the pane border blink instead.
  const surfaceAgentStatus = useStore((s) => s.surfaceAgentStatus);
  const setTerminalTextDropDragActive = useStore((s) => s.setTerminalTextDropDragActive);
  // P2: pane-level identity + rename (distinct from the per-surface tab rename
  // below). The pane's display name is its user label (paneLabel mirror) or the
  // stable auto coordinate `w<ws>-<pane>(<agent>)`.
  const paneLabelMap = useStore((s) => s.paneLabel);
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const [paneEditing, setPaneEditing] = useState(false);
  const [paneEditName, setPaneEditName] = useState('');
  const paneInputRef = useRef<HTMLInputElement>(null);
  // Escape must CANCEL the rename, but Escape exits edit mode by unmounting the
  // input, which fires onBlur=commitPaneRename first and would SAVE. This flag
  // lets that blur skip persistence so Escape discards (CodeRabbit review).
  const paneRenameCancelRef = useRef(false);

  // Double-click a tab to rename it (a free-text "mark" so a powershell is
  // easier to recognise). Edits surface.title directly — nothing auto-updates
  // it, so the user's name sticks. Mirrors the workspace double-click rename.
  const updateSurfaceTitle = useStore((s) => s.updateSurfaceTitle);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  const startRename = (s: Surface) => {
    // Suppress the rename that a double-click would trigger right after a drag.
    if (Date.now() - dragStartTimeRef.current < 300) return;
    setEditName(s.title || '');
    setEditingId(s.id);
  };

  const commitRename = (surfaceId: string) => {
    const trimmed = editName.trim();
    if (trimmed) updateSurfaceTitle(surfaceId, trimmed);
    setEditingId(null);
  };

  useEffect(() => {
    if (paneEditing) {
      paneInputRef.current?.focus();
      paneInputRef.current?.select();
    }
  }, [paneEditing]);

  // P2: resolve this pane's display name. Ordinals are layout state (find the
  // leaf in the workspace tree); the agent slug names the suffix off the active
  // surface; the user label (if any) overrides the auto coordinate.
  const leaf = findPane(workspace.rootPane, paneId);
  const paneOrdinal = leaf && leaf.type === 'leaf' ? (leaf.ordinal ?? 0) : 0;
  const activeSurface = surfaces.find((s) => s.id === activeSurfaceId) ?? surfaces[0];
  const activeSlug = activeSurface?.ptyId ? surfaceAgent[activeSurface.ptyId]?.slug : undefined;
  const paneAutoName = computePaneAutoName(workspace.wsOrdinal ?? 0, paneOrdinal, activeSlug);
  const paneDisplay = paneDisplayName(paneLabelMap[paneId], paneAutoName);

  const startPaneRename = () => {
    // Suppress the rename a double-click triggers right after a tab drag.
    if (Date.now() - dragStartTimeRef.current < 300) return;
    // Clear any stale cancel flag from a prior edit whose unmount-blur didn't
    // fire (e.g. parent unmounted) — else this rename would refuse to save (GLM).
    paneRenameCancelRef.current = false;
    setPaneEditName(paneLabelMap[paneId] ?? '');
    setPaneEditing(true);
  };
  const commitPaneRename = () => {
    // Escape set the cancel flag — discard without persisting and reset it.
    if (paneRenameCancelRef.current) {
      paneRenameCancelRef.current = false;
      setPaneEditing(false);
      return;
    }
    // Empty clears the custom label (reverts to the auto name). The renderer is
    // not the label authority — route through MetadataStore so the change
    // persists (metadata.json) and relays back via pane.metadata.changed.
    void window.electronAPI.metadata.setLabel(paneId, workspace.id, paneEditName.trim());
    setPaneEditing(false);
  };

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
    setTerminalTextDropDragActive(true);
  };

  const handleTabClick = (surfaceId: string) => {
    // Suppress click-after-dragend so a drop on an external surface does not
    // also switch the active tab on return. Mirrors WorkspaceItem.handleClick.
    if (Date.now() - dragStartTimeRef.current < 200) return;
    onSelect(surfaceId);
  };

  return (
    <div
      // Bridge P1.6 — h-9 (36px chrome module): matches sidebar header/footer,
      // deck tabs, and the agent toolbar so all top/bottom hairlines align.
      className="flex items-center bg-[var(--bg-mantle)] border-b border-[var(--bg-surface)] h-9 overflow-x-auto"
      // Focused pane = amber underline under the strip (inset so it never
      // shifts layout) — the single focus signal in the design system.
      style={paneActive ? { boxShadow: 'inset 0 -2px 0 var(--accent-cursor)' } : undefined}
      data-pane-tabs-active={paneActive ? 'true' : undefined}
      {...tokenAttrs('bgMantle', 'bg')}
      {...tokenAttrs('bgSurface', 'border')}
    >
      {/* P2 — pane identity + double-click rename. A distinct element/handler
          from the surface tabs (different store: pane label via MetadataStore vs
          surface.title), so the two renames never collide. */}
      {paneEditing ? (
        <input
          ref={paneInputRef}
          data-pane-label-input
          className="bg-[var(--bg-base)] text-[var(--text-main)] text-[10px] font-mono px-1 py-0 mx-1 rounded border border-[var(--accent)] outline-none max-w-[150px] shrink-0"
          value={paneEditName}
          maxLength={64}
          placeholder={paneAutoName}
          onChange={(e) => setPaneEditName(e.target.value)}
          onBlur={commitPaneRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitPaneRename();
            else if (e.key === 'Escape') {
              // Flag the cancel BEFORE exiting edit mode so the unmount-blur's
              // commitPaneRename discards instead of saving.
              paneRenameCancelRef.current = true;
              setPaneEditing(false);
            }
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          {...tokenAttrs('accent', 'border')}
        />
      ) : (
        <span
          data-pane-label
          className="shrink-0 px-2 h-full flex items-center text-[10px] font-mono text-[var(--text-muted)] hover:text-[var(--text-sub)] border-r border-[var(--bg-surface)] cursor-pointer select-none truncate max-w-[170px]"
          onDoubleClick={startPaneRename}
          title={paneDisplay}
          {...tokenAttrs('textMuted', 'text')}
        >
          {paneDisplay}
        </span>
      )}
      {surfaces.map((s) => (
        <div
          key={s.id}
          draggable={editingId !== s.id}
          onDragStart={handleDragStart}
          onDragEnd={() => setTerminalTextDropDragActive(false)}
          className={`group flex items-center gap-1 px-3 h-full cursor-pointer text-xs border-r border-[var(--bg-surface)] transition-colors ${
            s.id === activeSurfaceId
              ? 'bg-[var(--bg-base)] text-[var(--text-main)]'
              : 'text-[var(--text-subtle)] hover:text-[var(--text-sub)] hover:bg-[rgba(var(--bg-base-rgb),0.5)]'
          }`}
          {...tokenAttrs('bgBase', 'bg')}
          {...tokenAttrs('textMain', 'text')}
          onClick={() => handleTabClick(s.id)}
          onDoubleClick={() => startRename(s)}
          // Hover shows the terminal's working directory (cwd is always present
          // once the shell renders its first prompt; before that, the name).
          title={editingId === s.id ? undefined : (s.cwd || s.title || t('surface.terminal'))}
        >
          {(() => {
            const status = s.ptyId ? surfaceAgentStatus[s.ptyId] : undefined;
            if (!status || s.id === activeSurfaceId) return null;
            return (
              <span
                className="tab-status-blink inline-block w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: statusDotColor(status) }}
                title={t('surface.terminal')}
                aria-hidden="true"
              />
            );
          })()}
          {editingId === s.id ? (
            <input
              ref={inputRef}
              className="bg-[var(--bg-base)] text-[var(--text-main)] text-xs font-mono px-1 py-0 rounded border border-[var(--text-muted)] outline-none max-w-[120px]"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={() => commitRename(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(s.id);
                if (e.key === 'Escape') setEditingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="truncate max-w-[120px]">{s.title || t('surface.terminal')}</span>
          )}
          {/* X close button — always visible, not just on hover */}
          <button
            className="text-[var(--text-subtle)] hover:text-[var(--accent-red)] transition-colors ml-1 leading-none"
            onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
            title={t('surface.closeTab')}
            {...tokenAttrs('danger', 'accent')}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
