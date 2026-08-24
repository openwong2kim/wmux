import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import type { AgentStatus, Surface, Workspace } from '../../../shared/types';
import { useT } from '../../hooks/useT';
import { useDaemonModeActive } from '../../hooks/useDaemonMode';
import { useStore } from '../../stores';
import {
  buildExportPayload,
  buildPaneMarkdown,
} from '../../utils/sessionInfoMarkdown';
import { tokenAttrs } from '../../themes';
import { computePaneAutoName, paneDisplayName } from '../../utils/paneNaming';
import { findPane } from '../../../shared/paneUtils';
import PaneDragGrip from './PaneDragGrip';
import { FOCUS_RING } from '../focusRing';
import { IconSplitRight, IconSplitDown, IconBrowser, IconEyeOff } from '../icons';
import { displayPath } from '../../utils/displayPath';
import PaneActionsMenu, { type PaneActionItem } from './PaneActionsMenu';

/** Rendered width (px) of the pane-action half of the cluster (split / browser /
 *  stash / zoom).
 *  Deterministic because every child is fixed-size. Tracing the markup below
 *  (split-right, split-down, new-browser, stash, zoom):
 *    outer div  border-l 1 + pl-1 4 ................................. 5
 *    5 × w-6 buttons (24 each) ..................................... 120
 *    4 × gap-0.5 (2 each, between the 5 flex children) ............... 8
 *    zoom wrapper  ml-0.5 2 + border-l 1 + pl-1 4 ................... 7
 *    outer div  pr-0.5 2 ............................................. 2
 *                                                             total = 142
 *  (The button gaps + the wrapper's own ml-0.5 both apply between the browser
 *  button and the divider — flex `gap` and `margin` stack.) Exported so
 *  Pane.tsx can offset the absolute supervision badge just left of the cluster
 *  instead of hardcoding a magic pixel guess. Keep in sync with the cluster
 *  markup below if the button count, padding, or divider spacing changes.
 *
 *  The tab-strip `+` is NOT part of this cluster and does not affect the
 *  width: it is opt-in (see the note at its render site) and lives on the
 *  left, with the tabs. */
export const PANE_ACTIONS_CLUSTER_WIDTH = 142;

/** Rendered width (px) of the COLLAPSED cluster: the ⋮ trigger alone, which
 *  opens the same actions as a vertical menu. Same outer box as the full
 *  cluster, one child instead of five and no zoom divider:
 *    outer div  border-l 1 + pl-1 4 ................................. 5
 *    1 × w-6 button ................................................ 24
 *    outer div  pr-0.5 2 ............................................. 2
 *                                                    overflow total = 31 */
export const PANE_ACTIONS_OVERFLOW_WIDTH = 31;

/** How the pane header renders its actions at a given width.
 *  - `full`     — the five-button cluster.
 *  - `overflow` — one ⋮ that opens them as a vertical menu.
 *  - `none`     — not even ⋮ fits; the hover-revealed corner ⤢ is all that's
 *                 left. Also what the "hide pane actions" setting produces. */
export type PaneActionsMode = 'full' | 'overflow' | 'none';

/** Cluster width for the current chrome matrix. The agent verbs went back to
 *  the bottom toolbar (2026-08-18), so the cluster is the action half only. */
export function paneClusterWidth(opts: { mode: PaneActionsMode }): number {
  if (opts.mode === 'full') return PANE_ACTIONS_CLUSTER_WIDTH;
  if (opts.mode === 'overflow') return PANE_ACTIONS_OVERFLOW_WIDTH;
  return 0;
}

/** The narrowest tab strip that still says which pane you are looking at: the
 *  coordinate, a truncated title, and the ✕. Below this the strip is not small,
 *  it is absent — flex-1 min-w-0 collapses it to nothing and the header becomes
 *  100% buttons, 0% identity. */
export const MIN_TAB_STRIP_WIDTH = 80;

/**
 * The pane width at which the full action cluster stops being affordable.
 *
 * Derived, never a second hardcoded number: the cluster is fixed-width and
 * shrink-0, so every pixel below this comes out of the tab strip.
 */
export const PANE_ACTIONS_MIN_PANE_WIDTH = PANE_ACTIONS_CLUSTER_WIDTH + MIN_TAB_STRIP_WIDTH;

/**
 * The pane width at which even the ⋮ trigger stops being affordable.
 *
 * The gap between this and PANE_ACTIONS_MIN_PANE_WIDTH is why ⋮ exists: 111px
 * to 222px is a real, reachable band (a 1536px screen with the deck open gives
 * the grid ~996px, so a five-way horizontal split lands at ~199px, and the
 * resize handles go lower still — Panel minSize is 10%). Dropping every action
 * there took them away exactly when a crowded layout needs stash and zoom most,
 * and one of them — "add a browser tab to THIS pane" — had no other entry point
 * at all: the palette's Open Browser passes forceNew, which splits off another
 * pane and makes the cramped layout worse.
 */
export const PANE_ACTIONS_OVERFLOW_MIN_PANE_WIDTH = PANE_ACTIONS_OVERFLOW_WIDTH + MIN_TAB_STRIP_WIDTH;

/**
 * How a pane of `width` should render its actions.
 *
 * `null` means "not measured yet" and answers `full`: most panes are wide, and
 * assuming otherwise would flash collapsed chrome on every mount. A measured
 * 0 is a genuinely hidden pane (a background workspace), which also keeps the
 * cluster so it is correct the instant it becomes visible.
 */
export function paneActionsMode(width: number | null): PaneActionsMode {
  if (width === null || width === 0) return 'full';
  if (width >= PANE_ACTIONS_MIN_PANE_WIDTH) return 'full';
  if (width >= PANE_ACTIONS_OVERFLOW_MIN_PANE_WIDTH) return 'overflow';
  return 'none';
}

/** Whether a pane of `width` can afford the full cluster. Kept as its own
 *  predicate because that is the question the badge offset and the tests ask;
 *  it is the `full` arm of paneActionsMode, never a second threshold. */
export function paneFitsActionCluster(width: number | null): boolean {
  return paneActionsMode(width) === 'full';
}

/** Ctrl on Windows/Linux, ⌘ on macOS — mirrors the OS-aware mapping in
 *  useKeyboard.ts so a tooltip advertises the shortcut the user can actually
 *  press. Read lazily (electronAPI is absent under jsdom tests). */
const IS_MAC = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
/** Append a keyboard hint to a tooltip label, e.g. "New terminal (Ctrl+T)". */
function withShortcut(label: string, keys: string): string {
  return `${label} (${keys})`;
}
const SC_SPLIT_RIGHT = IS_MAC ? '⌘D' : 'Ctrl+D';
const SC_SPLIT_DOWN = IS_MAC ? '⇧⌘D' : 'Ctrl+Shift+D';
/** Mirrors the `cmdOrCtrl && key === 't'` binding in useKeyboard.ts. */
const SC_NEW_TERMINAL = IS_MAC ? '⌘T' : 'Ctrl+T';

/** Human-readable form of the prefix chord bound to an action, e.g. "Ctrl+B !".
 *  Read from the live config rather than hardcoded: the prefix key and the
 *  binding are both user-editable, and a tooltip advertising a chord the user
 *  rebound is worse than no tooltip. Returns null when nothing is bound. */
function prefixChordFor(
  config: { key: string; bindings: Record<string, string> },
  actionId: string,
): string | null {
  const bound = Object.entries(config.bindings).find(([, id]) => id === actionId)?.[0];
  if (!bound) return null;
  const m = /^Key([A-Z])$/.exec(config.key);
  const prefix = IS_MAC ? `⌘${m ? m[1] : config.key}` : `Ctrl+${m ? m[1] : config.key}`;
  return `${prefix} ${bound}`;
}

/** B8: dot color for a completed/awaiting surface tab. Status-dot vocabulary
 *  (DESIGN.md): green = complete, red = needs-you (awaiting/waiting). */
function statusDotColor(status: AgentStatus): string {
  return status === 'complete' ? 'var(--accent-green)' : 'var(--accent-red)';
}

/** B8 blink dot for a BACKGROUND tab, extracted so each tab subscribes to its
 *  OWN `surfaceAgentStatus[ptyId]` entry (a primitive). The parent used to
 *  subscribe to the whole map, so any pane's status change re-rendered every
 *  tab strip in the app. */
function SurfaceTabStatusDot({ ptyId, active }: { ptyId?: string; active: boolean }) {
  const t = useT();
  const status = useStore((s) => (ptyId ? s.surfaceAgentStatus[ptyId] : undefined));
  if (!status || active) return null;
  return (
    <span
      className="tab-status-blink inline-block w-1.5 h-1.5 rounded-full shrink-0"
      style={{ backgroundColor: statusDotColor(status) }}
      title={t('surface.terminal')}
      aria-hidden="true"
    />
  );
}

interface SurfaceTabsProps {
  surfaces: Surface[];
  activeSurfaceId: string;
  /** Whether the OWNING PANE is the focused pane — paints the steel underline
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
  /** Split this pane side-by-side (a new pane to the right — 'horizontal'). */
  onSplitHorizontal: () => void;
  /** Split this pane stacked (a new pane below — 'vertical'). */
  onSplitVertical: () => void;
  /** New terminal surface (tab) in this pane. */
  onAddTerminal: () => void;
  /** New browser surface (tab) in this pane. */
  onAddBrowser: () => void;
  /**
   * How the pane-action cluster renders. Pane.tsx owns this because it is the
   * Settings toggle AND the width check — the cluster is fixed-width and
   * shrink-0, so on a narrow pane it eats the tab strip whole. Optional so the
   * component keeps working standalone (tests mount it directly); omitted falls
   * back to the setting alone, at full width.
   */
  actionsMode?: PaneActionsMode;
}

export default function SurfaceTabs({
  surfaces,
  activeSurfaceId,
  workspace,
  paneId,
  paneActive = false,
  onSelect,
  onClose,
  onSplitHorizontal,
  onSplitVertical,
  onAddTerminal,
  onAddBrowser,
  actionsMode,
}: SurfaceTabsProps) {
  const t = useT();
  // Same 200ms threshold pattern WorkspaceItem uses so a fast click never
  // gets eaten by a click-after-dragend race.
  const dragStartTimeRef = useRef<number>(0);
  // B8 per-surface status dots live in SurfaceTabStatusDot (per-tab
  // subscription) — subscribing to the whole map here re-rendered every tab
  // strip on any pane's status change.
  const setTerminalTextDropDragActive = useStore((s) => s.setTerminalTextDropDragActive);
  // Opt-in `+` for a second terminal in THIS pane. Off unless the user turned
  // it on — see the note at its render site and the experimental label in
  // Settings.
  const newTerminalButtonVisible = useStore((s) => s.paneNewTerminalButton);
  // Right-aligned pane action cluster (split right / split down / new browser
  // / stash / zoom). Gated by a Settings toggle (default ON) for minimal-chrome
  // setups, AND by the pane being wide enough to afford it — Pane.tsx combines
  // the two and passes the answer down.
  const paneActionsSetting = useStore((s) => s.paneActionsVisible);
  const mode: PaneActionsMode = actionsMode ?? (paneActionsSetting ? 'full' : 'none');
  // Zoom/maximize state for this pane — the cluster's fifth button toggles it
  // and reflects the current state (pressed when zoomed). Subscribing here (same
  // pattern as Pane.tsx) keeps the button in sync without prop threading.
  const isZoomed = useStore((s) => s.zoomedPaneId === paneId);
  // #977 — stash needs a live daemon connection (it is what holds the session
  // and replays it), and it needs a sibling to be left behind.
  const daemonConnected = useDaemonModeActive();
  const prefixConfig = useStore((s) => s.prefixConfig);
  const stashDisabled = !daemonConnected;

  // The two actions the cluster drives through the store rather than a prop.
  // Named so the buttons and the menu invoke the SAME thing — a menu that
  // reimplements an action is a menu that drifts from it.
  const stashThisPane = useCallback(() => {
    if (stashDisabled) return;
    useStore.getState().stashPane(paneId, workspace.id);
  }, [stashDisabled, paneId, workspace.id]);
  const toggleZoom = useCallback(() => {
    useStore.getState().togglePaneZoom(paneId);
  }, [paneId]);
  const stashChord = prefixChordFor(prefixConfig, 'stashPane');
  const stashTooltip = stashDisabled
    ? t('pane.stashNoDaemon')
    : `${t('pane.stash')} — ${t('pane.stashHint')}`;

  // ── Overflow menu ─────────────────────────────────────────────────────────
  // Open either from the ⋮ trigger (narrow panes) or by right-clicking the
  // header (any width). One anchor rect covers both: a button's own rect, or a
  // zero-size rect at the pointer.
  const [menuAnchor, setMenuAnchor] = useState<
    { top: number; left: number; right: number; bottom: number } | null
  >(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const openMenuAt = useCallback((rect: { top: number; left: number; right: number; bottom: number }) => {
    setMenuAnchor(rect);
    setMenuOpen(true);
  }, []);

  const menuItems: PaneActionItem[] = useMemo(() => [
    {
      key: 'split-right',
      label: t('pane.splitRight'),
      shortcut: SC_SPLIT_RIGHT,
      icon: <IconSplitRight size={14} />,
      onSelect: onSplitHorizontal,
    },
    {
      key: 'split-down',
      label: t('pane.splitDown'),
      shortcut: SC_SPLIT_DOWN,
      icon: <IconSplitDown size={14} />,
      onSelect: onSplitVertical,
    },
    {
      key: 'new-browser',
      label: t('pane.newBrowser'),
      icon: <IconBrowser size={14} />,
      onSelect: onAddBrowser,
    },
    {
      key: 'stash',
      label: t('pane.stash'),
      shortcut: stashChord ?? undefined,
      icon: <IconEyeOff size={14} />,
      disabled: stashDisabled,
      title: stashTooltip,
      onSelect: stashThisPane,
    },
    {
      key: 'zoom',
      label: t('settings.prefix.toggleZoom'),
      icon: (
        <span aria-hidden="true" className="font-mono text-[13px] leading-none">
          {isZoomed ? '⤡' : '⤢'}
        </span>
      ),
      active: isZoomed,
      separatorBefore: true,
      onSelect: toggleZoom,
    },
  ], [
    t, onSplitHorizontal, onSplitVertical, onAddBrowser,
    stashChord, stashDisabled, stashTooltip, stashThisPane, isZoomed, toggleZoom,
  ]);

  // Right-click anywhere on the header opens the same menu. Free at any width,
  // and the only reason the `none` mode (a pane too narrow even for ⋮, or the
  // "hide pane actions" setting) is not a dead end for the mouse.
  const handleHeaderContextMenu = useCallback((e: React.MouseEvent) => {
    if (mode === 'none' && !paneActionsSetting) return;
    // A tab's own right-click is not claimed here; only empty header space and
    // the action area open the menu.
    e.preventDefault();
    e.stopPropagation();
    openMenuAt({ top: e.clientY, left: e.clientX, right: e.clientX, bottom: e.clientY });
  }, [mode, paneActionsSetting, openMenuAt]);
  // P2: pane-level identity + rename (distinct from the per-surface tab rename
  // below). The pane's display name is its user label (paneLabel mirror) or the
  // stable auto coordinate `w<ws>-<pane>(<agent>)`. Narrowed to THIS pane's
  // label / THIS pane's active-surface slug (primitives) so unrelated panes'
  // label or agent changes don't re-render this strip.
  const paneLabel = useStore((s) => s.paneLabel[paneId]);
  const activeSurface = surfaces.find((s) => s.id === activeSurfaceId) ?? surfaces[0];
  const activeSurfacePtyId = activeSurface?.ptyId;
  const activeSlug = useStore((s) =>
    activeSurfacePtyId ? s.surfaceAgent[activeSurfacePtyId]?.slug : undefined,
  );
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
  const paneAutoName = computePaneAutoName(workspace.wsOrdinal ?? 0, paneOrdinal, activeSlug);
  const paneDisplay = paneDisplayName(paneLabel, paneAutoName);

  const startPaneRename = () => {
    // Suppress the rename a double-click triggers right after a tab drag.
    if (Date.now() - dragStartTimeRef.current < 300) return;
    // Clear any stale cancel flag from a prior edit whose unmount-blur didn't
    // fire (e.g. parent unmounted) — else this rename would refuse to save (GLM).
    paneRenameCancelRef.current = false;
    setPaneEditName(paneLabel ?? '');
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
      // changed color at the pane↔deck seam). Focused pane adds the steel
      // underline on top (inset so it never shifts layout) — the single focus
      // signal in the design system.
      style={{
        borderColor: 'var(--border-soft)',
        ...(paneActive ? { boxShadow: 'inset 0 -2px 0 var(--accent-blue)' } : {}),
      }}
      data-pane-tabs-active={paneActive ? 'true' : undefined}
      // Right-click the header for the same actions at any width. This is what
      // keeps a pane too narrow even for ⋮ from being a dead end for the mouse.
      onContextMenu={handleHeaderContextMenu}
      {...tokenAttrs('bgMantle', 'bg')}
      {...tokenAttrs('bgSurface', 'border')}
    >
      {/* #645 — pane move grip. First in the strip, OUTSIDE the scroll region,
          so it stays reachable however many tabs there are. Never on a tab
          itself: tabs own an HTML5 drag that exports terminal text. */}
      <PaneDragGrip paneId={paneId} workspaceId={workspace.id} />

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
          className="ui-mini-input text-[var(--text-main)] text-[10px] font-mono px-1 py-0 mx-1 border border-[var(--accent-blue)] max-w-[150px] shrink-0"
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
          title={editingId === s.id ? undefined : (displayPath(s.cwd) || s.title || t('surface.terminal'))}
        >
          <SurfaceTabStatusDot ptyId={s.ptyId} active={s.id === activeSurfaceId} />
          {editingId === s.id ? (
            <input
              ref={inputRef}
              className="ui-mini-input text-[var(--text-main)] text-xs font-mono px-1 py-0 border border-[var(--text-muted)] max-w-[120px]"
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
      {/* OFF by default, and deliberately so. #451 removed the discoverable
          new-terminal button because one pane = one terminal is the shape we
          recommend — splitting is the answer to "I want another terminal", and
          it already has two buttons in the cluster. A second terminal in the
          SAME pane stays reachable (Ctrl+T, now listed in the shortcuts panel)
          without being offered on the surface.
          This opt-in exists for the people who asked for it and is labelled
          experimental in Settings for exactly that reason: turning it on is
          choosing to break the rule for your own layout. */}
      {newTerminalButtonVisible && (
        <button
          className={`ui-icon-btn ${FOCUS_RING} w-6 h-6 shrink-0`}
          onClick={(e) => { e.stopPropagation(); onAddTerminal(); }}
          title={withShortcut(t('pane.newTerminal'), SC_NEW_TERMINAL)}
          aria-label={t('pane.newTerminal')}
          data-pane-action="new-terminal"
        >
          +
        </button>
      )}
      </div>

      {/* Right-aligned pane action cluster. Native next to the per-tab close
          button (same quiet chrome): boxless at rest, a subtle surface lift on
          hover, a keyboard-focus ring, and monochrome line icons from the
          shared system. Each button drives an EXISTING store action and its
          tooltip carries the same shortcut the keyboard already binds. */}
      {mode === 'full' && (
        <div
          className="flex items-center shrink-0 h-full pl-1 pr-0.5 gap-0.5 border-l border-[var(--border-soft)]"
          data-pane-actions
        >
          {/* The "new terminal (tab in this pane)" button is not here: it lives
              in the tab strip above, behind the opt-in paneNewTerminalButton
              setting, because a second terminal in one pane breaks the one pane
              = one terminal concept. Ctrl+T stays bound either way. */}
          <button
            className={`ui-icon-btn ${FOCUS_RING} w-6 h-6`}
            onClick={(e) => { e.stopPropagation(); onSplitHorizontal(); }}
            title={withShortcut(t('pane.splitRight'), SC_SPLIT_RIGHT)}
            aria-label={t('pane.splitRight')}
            data-pane-action="split-right"
          >
            <IconSplitRight size={14} />
          </button>
          <button
            className={`ui-icon-btn ${FOCUS_RING} w-6 h-6`}
            onClick={(e) => { e.stopPropagation(); onSplitVertical(); }}
            title={withShortcut(t('pane.splitDown'), SC_SPLIT_DOWN)}
            aria-label={t('pane.splitDown')}
            data-pane-action="split-down"
          >
            <IconSplitDown size={14} />
          </button>
          <button
            className={`ui-icon-btn ${FOCUS_RING} w-6 h-6`}
            onClick={(e) => { e.stopPropagation(); onAddBrowser(); }}
            title={t('pane.newBrowser')}
            aria-label={t('pane.newBrowser')}
            data-pane-action="new-browser"
          >
            <IconBrowser size={14} />
          </button>
          {/* Stash — take this pane out of the layout, keep the session (#977).
              It sits next to ✕ with the same visual weight while one is fully
              reversible and the other kills an agent, so the tooltip says what
              happens rather than naming the verb: "the session keeps running"
              is the whole difference between the two buttons.

              Eye-off, not an archive box: the sidebar roster marks the stashed
              rows with the same eye pair (off = out of view, on = bring back),
              and this app already spends the archive glyph on channel archive —
              a one-way DEACTIVATION, which is the opposite of what stashing
              does. One pair, one meaning. */}
          <button
            className={`ui-icon-btn ${FOCUS_RING} w-6 h-6 ${stashDisabled ? 'opacity-40' : ''}`}
            // aria-disabled, not disabled: a disabled button drops out of the
            // tab order, so a keyboard user cannot reach it to READ why it is
            // unavailable. It stays focusable and explains itself.
            aria-disabled={stashDisabled || undefined}
            onClick={(e) => { e.stopPropagation(); stashThisPane(); }}
            title={
              !stashDisabled && stashChord
                ? withShortcut(stashTooltip, stashChord)
                : stashTooltip
            }
            aria-label={t('pane.stash')}
            data-pane-action="stash"
          >
            <IconEyeOff size={14} />
          </button>
          {/* Zoom/maximize — fourth action, visually separated from the surface
              actions by the same border-l divider the cluster uses against the
              tabs. Consolidates the old absolute-positioned corner maximize/
              restore controls (Pane.tsx) that overlapped this cluster. Pressed
              (accent) styling + aria-pressed convey the zoomed state. */}
          <div className="flex items-center border-l border-[var(--border-soft)] ml-0.5 pl-1">
            <button
              className={`ui-icon-btn ${FOCUS_RING} w-6 h-6 ${isZoomed ? 'ui-icon-btn-active' : ''}`}
              onClick={(e) => { e.stopPropagation(); toggleZoom(); }}
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

      {/* Collapsed cluster — 31px instead of 142px. The same five actions, one
          click deeper, on a pane that cannot afford to show them side by side.
          Kept OUTSIDE the tab strip's scroll region and shrink-0 like the full
          cluster, so it stays pinned to the right edge. */}
      {mode === 'overflow' && (
        <div
          className="flex items-center shrink-0 h-full pl-1 pr-0.5 border-l border-[var(--border-soft)]"
          data-pane-actions="overflow"
        >
          <button
            ref={overflowBtnRef}
            className={`ui-icon-btn ${FOCUS_RING} w-6 h-6 ${menuOpen ? 'ui-icon-btn-active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (menuOpen) { closeMenu(); return; }
              openMenuAt(e.currentTarget.getBoundingClientRect());
            }}
            title={t('pane.moreActions')}
            aria-label={t('pane.moreActions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-pane-overflow-trigger
          >
            <span aria-hidden="true" className="font-mono text-[13px] leading-none">⋮</span>
          </button>
        </div>
      )}

      {menuOpen && (
        <PaneActionsMenu
          anchor={menuAnchor}
          triggerRef={overflowBtnRef}
          items={menuItems}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
