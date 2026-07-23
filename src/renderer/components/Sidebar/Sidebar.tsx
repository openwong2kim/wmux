import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import WorkspaceItem from './WorkspaceItem';
import MissionsSection from './MissionsSection';
import PresetPicker from './PresetPicker';
import type { Pane } from '../../../shared/types';
import { useT } from '../../hooks/useT';
import { buildWorkspaceMarkdown } from '../../utils/sessionInfoMarkdown';
import { tokenAttrs } from '../../themes';
import { collapseDirection } from './sidebarGlyphs';
import { IconPlus, IconChevronDir, IconRobot, IconGitBranch } from '../icons';
import WebToggle from '../StatusBar/WebToggle';
import { FOCUS_RING } from '../focusRing';
import PluginPanels from '../../plugins/PluginPanels';
import CompanyPanel from './CompanyPanel';
import { sumUnread } from '../Channels/ChannelsPanel';
import { COMPANY_MODE_ENABLED } from '../../../shared/featureFlags';

// Dispose all leaf PTYs in the pane tree
function disposeAllPtys(pane: Pane) {
  if (pane.type === 'leaf') {
    for (const s of pane.surfaces) {
      if (s.ptyId) window.electronAPI.pty.dispose(s.ptyId);
    }
  } else {
    for (const child of pane.children) disposeAllPtys(child);
  }
}

export default function Sidebar() {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  // A1: drop whole-tree subscription. Sidebar subscribes only to list structure (id, name, order);
  // each WorkspaceItem self-subscribes to its ws. Background ws metadata/surface churn does not
  // re-render this component (only on rename/add/delete/reorder).
  const workspaces = useStore(useShallow(selectWorkspaceIdName));
  const [wsSearch, setWsSearch] = useState('');
  const wsSearchRef = useRef<HTMLInputElement>(null);
  const filteredWorkspaces = useMemo(() => {
    if (!wsSearch.trim()) return workspaces;
    const q = wsSearch.toLowerCase();
    return workspaces.filter((ws) => ws.name.toLowerCase().includes(q));
  }, [workspaces, wsSearch]);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const duplicateWorkspace = useStore((s) => s.duplicateWorkspace);
  const reorderWorkspace = useStore((s) => s.reorderWorkspace);
  const toggleMultiviewWorkspace = useStore((s) => s.toggleMultiviewWorkspace);
  const multiviewIds = useStore((s) => s.multiviewIds);
  const toggleFileTree = useStore((s) => s.toggleFileTree);
  const fileTreeVisible = useStore((s) => s.fileTreeVisible);
  const company = useStore((s) => s.company);
  // sidebarMode toggles the sidebar's central content between the workspace
  // list and the company tree (CompanyPanel). The palette's "Company: …"
  // commands flip this to 'company'; without a consumer here the flip was a
  // no-op (the bug: company commands appeared to do nothing). The header
  // toggle below is the UI entry/exit point.
  const sidebarMode = useStore((s) => s.sidebarMode);
  const setSidebarMode = useStore((s) => s.setSidebarMode);
  const pushToast = useStore((s) => s.pushToast);

  // Channels toggle — relocated from the status bar to the sidebar foot (owner
  // 2026-07-16: the bare `#` glyph in the status strip was too easy to miss).
  // It now sits at the bottom of the workspace list as a labeled, full-width
  // affordance.
  const channelUnread = useStore((s) => s.channelUnread);
  const channelDockVisible = useStore((s) => s.channelDockVisible);
  const toggleChannelDock = useStore((s) => s.toggleChannelDock);
  const channelUnreadTotal = useMemo(() => sumUnread(channelUnread), [channelUnread]);

  // Git button (below Agent) — open deck on Git tab. Toggle closed if Git tab already open.
  // Dirty badge = count of workspaces with uncommitted changes (reuses gitSync meta from
  // traffic lights, zero new polling).
  const activeDeckTab = useStore((s) => s.activeDeckTab);
  const setActiveDeckTab = useStore((s) => s.setActiveDeckTab);
  const setChannelDockVisible = useStore((s) => s.setChannelDockVisible);
  const dirtyWsCount = useStore(
    (s) => s.workspaces.filter((w) => (w.metadata?.gitSync?.dirty ?? 0) > 0).length,
  );
  const gitOpen = channelDockVisible && activeDeckTab === 'git';
  const toggleGit = useCallback(() => {
    if (gitOpen) {
      setChannelDockVisible(false);
    } else {
      setActiveDeckTab('git');
      setChannelDockVisible(true);
    }
  }, [gitOpen, setActiveDeckTab, setChannelDockVisible]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const togglePicker = useCallback(() => setPickerOpen((v) => !v), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  // Ctrl+F → focus workspace search, but only while focus is already inside
  // the sidebar. A document-level listener would collide with the global
  // Ctrl+F terminal-search shortcut (useKeyboard), so this is scoped to the
  // sidebar root via onKeyDown and stops propagation so the global handler
  // does not also fire.
  const handleSidebarKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'f' && (e.ctrlKey || e.metaKey) && workspaces.length >= 3) {
      e.preventDefault();
      e.stopPropagation();
      wsSearchRef.current?.focus();
    }
  }, [workspaces.length]);

  // The search input hides below 3 workspaces; clear any leftover query so
  // the list can't stay filtered with no visible way to reset it.
  useEffect(() => {
    if (workspaces.length < 3) setWsSearch('');
  }, [workspaces.length]);

  // A1: stabilize callbacks with useCallback so memo(WorkspaceItem) is effective.
  // Summary-only subscription; individual ws read imperatively via getState() (subscription diet).
  const handleCtrlSelect = useCallback((wsId: string) => {
    toggleMultiviewWorkspace(wsId);
  }, [toggleMultiviewWorkspace]);

  const handleCopySessionInfo = useCallback(async (wsId: string) => {
    const ws = useStore.getState().workspaces.find((w) => w.id === wsId);
    if (!ws) return;

    await window.clipboardAPI.writeText(buildWorkspaceMarkdown(ws));

    // Feedback via canonical toast (toastSlice) — old manual DOM toast bypassed the store.
    pushToast({ level: 'info', message: t('workspace.copied') });
  }, [t, pushToast]);

  const handleClose = useCallback((wsId: string) => {
    // Dispose all PTYs for this workspace before deletion
    const ws = useStore.getState().workspaces.find((w) => w.id === wsId);
    if (ws) disposeAllPtys(ws.rootPane);

    removeWorkspace(wsId);
  }, [removeWorkspace]);

  return (
    <div
      className={`flex flex-col h-full bg-[var(--bg-mantle)] ${sidebarPosition === 'right' ? 'border-l' : 'border-r'} border-[var(--bg-surface)]`}
      style={{ width: 240, borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgMantle', 'bg')} {...tokenAttrs('bgSurface', 'border')}
      onKeyDown={handleSidebarKeyDown}
    >
      {pickerOpen && <PresetPicker onClose={closePicker} />}

      {/* Workspace search input — only visible when 3+ workspaces */}
      {workspaces.length >= 3 && (
        <div className="px-2 pt-2">
          <input
            ref={wsSearchRef}
            type="text"
            value={wsSearch}
            onChange={(e) => setWsSearch(e.target.value)}
            placeholder="Search workspaces…"
            className="w-full px-2 py-1 text-xs bg-[var(--bg-surface)] text-[var(--text-main)] border border-[var(--bg-surface)] rounded outline-none focus:border-[var(--text-muted)] placeholder:text-[var(--text-muted)]"
          />
        </div>
      )}

      {/* Central content: company tree when in company mode, else the
          workspace list. This is the consumer of `sidebarMode` that was
          missing — CompanyPanel was orphaned (never rendered) so the
          palette's company commands had no visible surface. */}
      {COMPANY_MODE_ENABLED && sidebarMode === 'company' ? (
        <CompanyPanel />
      ) : (
      /* The list container absorbs dragover for sidebar-internal reorder
          drags so the gaps between WorkspaceItem rows (and the empty area
          below the last row) don't paint a 🚫 cursor mid-drag. External
          drags hover-through the container untouched. */
      <div
        className="flex-1 overflow-y-auto py-2 space-y-0.5"
        onDragOver={(e) => {
          if (useStore.getState().draggedWorkspaceIndex !== null) {
            e.preventDefault();
          }
        }}
      >
        {/* Cycle C — fan-out mission section. When no missions (normal workspace), renders
            nothing and occupies no space (MissionsSection returns null). Coexists with worktree
            badge (⊕) — badge is low-level fact, this section is higher-level concept. */}
        <MissionsSection />
        {/* A1/A2: pass only id + stable callbacks to each item. Callbacks take id args via
            store actions/useCallback handlers, not recreated each render, so memo(WorkspaceItem)
            works. Item content updated by WorkspaceItem self-subscribe. */}
        {/* index must be the position in the UNFILTERED list — reorder and
            the Ctrl+number labels are defined against it. */}
        {filteredWorkspaces.map((ws) => (
          <WorkspaceItem
            key={ws.id}
            workspaceId={ws.id}
            isActive={ws.id === activeWorkspaceId}
            isMultiview={multiviewIds.includes(ws.id)}
            index={workspaces.indexOf(ws)}
            onSelect={setActiveWorkspace}
            onCtrlSelect={handleCtrlSelect}
            onRename={renameWorkspace}
            onClose={handleClose}
            onCopyInfo={handleCopySessionInfo}
            onDuplicate={duplicateWorkspace}
            onReorder={reorderWorkspace}
          />
        ))}
      </div>
      )}

      {/* Plugin sidebar panels (B-1 ui.sidebar contribution point) */}
      <PluginPanels />

      {/* Agent toggle — the reopen affordance for the right-side ChannelDock
          (agents + their channels), moved here from the status bar so it lives at
          the foot of the workspace list. Steel-blue when the dock is open
          (DESIGN.md: navigation = cool accent); a full-width labeled row so it
          reads as an obvious control. */}
      <button
        type="button"
        onClick={toggleChannelDock}
        aria-pressed={channelDockVisible}
        title={t('sidebar.agentTooltip') || 'Toggle agent panel'}
        className={`flex items-center gap-2 shrink-0 h-9 px-4 border-t border-[var(--bg-surface)] text-[11px] font-mono transition-colors ${FOCUS_RING} ${
          channelDockVisible
            ? 'text-[var(--accent-blue)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)]'
        }`}
        style={{ borderColor: 'var(--border-soft)' }}
        data-sidebar-agent
      >
        <IconRobot size={14} />
        <span>{t('sidebar.agent') || 'Agent'}</span>
        {channelUnreadTotal > 0 && (
          <span className="ml-auto text-[var(--text-sub)]" data-sidebar-agent-unread {...tokenAttrs('textSub', 'text')}>
            {channelUnreadTotal > 99 ? '99+' : channelUnreadTotal}
          </span>
        )}
      </button>

      {/* Git toggle — below Agent. Open deck on Git tab (close deck if Git already open).
          open=steel (navigation) · dirty=warm (with count) · else muted. Git traffic lights live
          on left row, so entry point in left footer too (owner decision 2026-07-20). */}
      <button
        type="button"
        onClick={toggleGit}
        aria-pressed={gitOpen}
        title={t('sidebar.gitTooltip') || 'Toggle the Git panel'}
        className={`flex items-center gap-2 shrink-0 h-9 px-4 border-t border-[var(--bg-surface)] text-[11px] font-mono transition-colors ${FOCUS_RING} ${
          gitOpen
            ? 'text-[var(--accent-blue)]'
            : dirtyWsCount > 0
              ? 'text-[var(--accent)] hover:opacity-80'
              : 'text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)]'
        }`}
        style={{ borderColor: 'var(--border-soft)' }}
        data-sidebar-git
      >
        <IconGitBranch size={14} />
        <span>{t('sidebar.git') || 'Git'}</span>
        {dirtyWsCount > 0 && (
          <span className="ml-auto" data-sidebar-git-dirty>
            {dirtyWsCount > 99 ? '99+' : dirtyWsCount}
          </span>
        )}
      </button>

      {/* wmux web toggle — the third entry in this footer cluster (Agent · Git ·
          web). Serving panes to a browser is a workspace-level capability like
          the other two, so it belongs on the same rail rather than in the status
          strip. Amber while the server is running (alive); the popover opens
          upward from here. */}
      <WebToggle variant="sidebar" />

      {/* Footer — when docked right, mirror the row so the collapse arrow sits
          on the inner edge facing the content area (issue #151). */}
      <div className={`flex items-center justify-between h-9 shrink-0 px-4 border-t border-[var(--bg-surface)] text-[11px] font-mono text-[var(--text-muted)] ${sidebarPosition === 'right' ? 'flex-row-reverse' : ''}`} style={{ borderColor: 'var(--border-soft)' }} {...tokenAttrs('textMuted', 'text')}>
        <span>{workspaces.length} {t('sidebar.workspaces')}</span>
        <button
          className={`flex items-center justify-center w-5 h-5 rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
          onClick={() => useStore.getState().toggleSidebar()}
          title={t('sidebar.hideTooltip')}
        >
          <IconChevronDir dir={collapseDirection(sidebarPosition)} />
        </button>
      </div>
    </div>
  );
}
