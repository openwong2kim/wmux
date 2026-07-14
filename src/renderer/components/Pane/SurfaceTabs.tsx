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
import { FOCUS_RING } from '../focusRing';
import { IconTerminal, IconSplitRight, IconSplitDown, IconBrowser } from '../icons';

/** Rendered width (px) of the pane action cluster when `paneActionsVisible`.
 *  Deterministic because every child is fixed-size. Tracing the markup below:
 *    outer div  border-l 1 + pl-1 4 ................................. 5
 *    5 × w-6 buttons (24 each) ..................................... 120
 *    4 × gap-0.5 (2 each, between the 5 flex children) ............... 8
 *    zoom wrapper  ml-0.5 2 + border-l 1 + pl-1 4 ................... 7
 *    outer div  pr-0.5 2 ............................................. 2
 *                                                             total = 142
 *  (The four button gaps + the wrapper's own ml-0.5 both apply between the
 *  browser button and the divider — flex `gap` and `margin` stack.) Exported so
 *  Pane.tsx can offset the absolute supervision badge just left of the cluster
 *  instead of hardcoding a magic pixel guess. Keep in sync with the cluster
 *  markup below if the button count, padding, or divider spacing changes. */
export const PANE_ACTIONS_CLUSTER_WIDTH = 142;

/** Ctrl on Windows/Linux, ⌘ on macOS — mirrors the OS-aware mapping in
 *  useKeyboard.ts so a tooltip advertises the shortcut the user can actually
 *  press. Read lazily (electronAPI is absent under jsdom tests). */
const IS_MAC = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
/** Append a keyboard hint to a tooltip label, e.g. "New terminal (Ctrl+T)". */
function withShortcut(label: string, keys: string): string {
  return `${label} (${keys})`;
}
const SC_NEW_TERMINAL = IS_MAC ? '⌘T' : 'Ctrl+T';
const SC_SPLIT_RIGHT = IS_MAC ? '⌘D' : 'Ctrl+D';
const SC_SPLIT_DOWN = IS_MAC ? '⇧⌘D' : 'Ctrl+Shift+D';

/** B8: dot color for a completed/awaiting surface tab. Status-dot vocabulary
 *  (DESIGN.md): green = complete, red = needs-you (awaiting/waiting). */
function statusDotColor(status: AgentStatus): string {
  return status === 'complete' ? 'var(--accent-green)' : 'var(--accent-red)';
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
  /** New terminal surface (tab) in this pane. */
  onAdd: () => void;
  /** Split this pane side-by-side (a new pane to the right — 'horizontal'). */
  onSplitHorizontal: () => void;
  /** Split this pane stacked (a new pane below — 'vertical'). */
  onSplitVertical: () => void;
  /** New browser surface (tab) in this pane. */
  onAddBrowser: () => void;
}

export default function SurfaceTabs({
  surfaces,
  activeSurfaceId,
  workspace,
  paneId,
  paneActive = false,
  onSelect,
  onClose,
  onAdd,
  onSplitHorizontal,
  onSplitVertical,
  onAddBrowser,
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
  // Right-aligned pane action cluster (new terminal / split / new browser).
  // Gated by a Settings toggle (default ON) for minimal-chrome setups.
  const paneActionsVisible = useStore((s) => s.paneActionsVisible);
  // Zoom/maximize state for this pane — the cluster's fifth button toggles it
  // and reflects the current state (pressed when zoomed). Subscribing here (same
  // pattern as Pane.tsx) keeps the button in sync without prop threading.
  const isZoomed = useStore((s) => s.zoomedPaneId === paneId);
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
      className="flex items-center bg-[var(--bg-mantle)] border-b border-[var(--bg-surface)] h-9"
      // borderColor → --border-soft so this strip's bottom hairline matches the
      // deck tabs / sidebar / titlebar seams (they all override to border-soft;
      // this one was left on the opaque --bg-surface, so the top-chrome line
      // changed color at the pane↔deck seam). Focused pane adds the amber
      // underline on top (inset so it never shifts layout) — the single focus
      // signal in the design system.
      style={{
        borderColor: 'var(--border-soft)',
        ...(paneActive ? { boxShadow: 'inset 0 -2px 0 var(--accent-cursor)' } : {}),
      }}
      data-pane-tabs-active={paneActive ? 'true' : undefined}
      {...tokenAttrs('bgMantle', 'bg')}
      {...tokenAttrs('bgSurface', 'border')}
    >
      {/* Scroll region: pane label + tabs share the horizontal overflow so the
          action cluster below stays pinned to the right on narrow panes. */}
      <div className="flex items-center flex-1 min-w-0 overflow-x-auto h-full">
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

      {/* Right-aligned pane action cluster. Native next to the per-tab close
          button (same quiet chrome): boxless at rest, a subtle surface lift on
          hover, a keyboard-focus ring, and monochrome line icons from the
          shared system. Each button drives an EXISTING store action and its
          tooltip carries the same shortcut the keyboard already binds. */}
      {paneActionsVisible && (
        <div
          className="flex items-center shrink-0 h-full pl-1 pr-0.5 gap-0.5 border-l border-[var(--border-soft)]"
          data-pane-actions
        >
          <button
            className={`flex items-center justify-center w-6 h-6 rounded text-[var(--text-subtle)] hover:text-[var(--text-main)] hover:bg-[var(--bg-surface)] transition-colors ${FOCUS_RING}`}
            onClick={(e) => { e.stopPropagation(); onAdd(); }}
            title={withShortcut(t('pane.newTerminal'), SC_NEW_TERMINAL)}
            aria-label={t('pane.newTerminal')}
            data-pane-action="new-terminal"
          >
            <IconTerminal size={14} />
          </button>
          <button
            className={`flex items-center justify-center w-6 h-6 rounded text-[var(--text-subtle)] hover:text-[var(--text-main)] hover:bg-[var(--bg-surface)] transition-colors ${FOCUS_RING}`}
            onClick={(e) => { e.stopPropagation(); onSplitHorizontal(); }}
            title={withShortcut(t('pane.splitRight'), SC_SPLIT_RIGHT)}
            aria-label={t('pane.splitRight')}
            data-pane-action="split-right"
          >
            <IconSplitRight size={14} />
          </button>
          <button
            className={`flex items-center justify-center w-6 h-6 rounded text-[var(--text-subtle)] hover:text-[var(--text-main)] hover:bg-[var(--bg-surface)] transition-colors ${FOCUS_RING}`}
            onClick={(e) => { e.stopPropagation(); onSplitVertical(); }}
            title={withShortcut(t('pane.splitDown'), SC_SPLIT_DOWN)}
            aria-label={t('pane.splitDown')}
            data-pane-action="split-down"
          >
            <IconSplitDown size={14} />
          </button>
          <button
            className={`flex items-center justify-center w-6 h-6 rounded text-[var(--text-subtle)] hover:text-[var(--text-main)] hover:bg-[var(--bg-surface)] transition-colors ${FOCUS_RING}`}
            onClick={(e) => { e.stopPropagation(); onAddBrowser(); }}
            title={t('pane.newBrowser')}
            aria-label={t('pane.newBrowser')}
            data-pane-action="new-browser"
          >
            <IconBrowser size={14} />
          </button>
          {/* Zoom/maximize — fifth action, visually separated from the surface
              actions by the same border-l divider the cluster uses against the
              tabs. Consolidates the old absolute-positioned corner maximize/
              restore controls (Pane.tsx) that overlapped this cluster. Pressed
              (accent) styling + aria-pressed convey the zoomed state. */}
          <div className="flex items-center border-l border-[var(--border-soft)] ml-0.5 pl-1">
            <button
              className={`flex items-center justify-center w-6 h-6 rounded transition-colors ${FOCUS_RING} ${
                isZoomed
                  ? 'text-[var(--accent-cursor)] bg-[var(--bg-surface)]'
                  : 'text-[var(--text-subtle)] hover:text-[var(--text-main)] hover:bg-[var(--bg-surface)]'
              }`}
              onClick={(e) => { e.stopPropagation(); useStore.getState().togglePaneZoom(paneId); }}
              title={t('settings.prefix.toggleZoom')}
              aria-label={t('settings.prefix.toggleZoom')}
              aria-pressed={isZoomed}
              data-pane-action="zoom"
            >
              {/* Same ⤢/⤡ glyphs as the corner controls in Pane.tsx so zoom keeps
                  one visual identity whether the cluster is shown or hidden. */}
              <span aria-hidden="true" className="font-mono text-[13px] leading-none">
                {isZoomed ? '⤡' : '⤢'}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
