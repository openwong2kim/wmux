import { useState, useRef, useEffect } from 'react';
import type { AgentStatus, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { AGENT_STATUS_ICON } from './agentStatusIcon';
import { buildWorkspaceMarkdown } from '../../utils/sessionInfoMarkdown';
import { collectTerminalSurfaces } from '../../utils/paneTraversal';
import WorkspaceProfileModal from './WorkspaceProfileModal';

interface WorkspaceItemProps {
  workspace: Workspace;
  isActive: boolean;
  isMultiview: boolean;
  index: number;
  onSelect: () => void;
  onCtrlSelect: () => void;
  onRename: (name: string) => void;
  onClose: () => void;
  onCopyInfo: () => void;
  onDuplicate: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

function AgentStatusDot({ status, agentName }: { status: AgentStatus; agentName?: string }): React.ReactElement {
  const t = useT();
  const icon = AGENT_STATUS_ICON[status];
  const label = t(icon.labelKey);
  return (
    <span
      className={`text-[8px] leading-none flex-shrink-0 ${icon.className} ${status === 'running' ? 'animate-pulse' : ''}`}
      title={agentName ? `${agentName} — ${label}` : label}
    >
      {icon.dot}
    </span>
  );
}

/**
 * Brief bottom-center toast. Mirrors Sidebar.handleCopySessionInfo so the
 * "Copied!" feedback is visually identical wherever a copy happens.
 */
function showCopyToast(text: string): void {
  const toast = document.createElement('div');
  toast.textContent = text;
  toast.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);background:var(--bg-surface);color:var(--text-main);padding:4px 12px;border-radius:4px;font-size:12px;z-index:9999;opacity:0;transition:opacity .2s';
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 200); }, 1500);
}

function shortenPath(path: string, maxLen = 25): string {
  if (!path || path.length <= maxLen) return path;
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join('/')}`;
}

export default function WorkspaceItem({ workspace, isActive, isMultiview, index, onSelect, onCtrlSelect, onRename, onClose, onCopyInfo, onDuplicate, onReorder }: WorkspaceItemProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(workspace.name);
  const [dropIndicator, setDropIndicator] = useState<'above' | 'below' | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [wdOpen, setWdOpen] = useState(false);
  const [closeConfirmPos, setCloseConfirmPos] = useState<{ x: number; y: number } | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragStartTimeRef = useRef<number>(0);

  const unreadCount = useStore((s) =>
    s.notifications.filter((n) => !n.read && n.workspaceId === workspace.id).length,
  );
  // Sidebar reorder source index lives in the store, not in dataTransfer.
  // See uiSlice.draggedWorkspaceIndex for why this is out-of-band.
  const setDraggedWorkspaceIndex = useStore((s) => s.setDraggedWorkspaceIndex);
  const setTerminalTextDropDragActive = useStore((s) => s.setTerminalTextDropDragActive);

  const metadata = workspace.metadata;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Listen for the global rename trigger dispatched by Ctrl+Shift+R and the
  // tmux prefix `,` action. Only the active workspace's item responds, so the
  // input lands on the row the user actually meant to rename.
  useEffect(() => {
    if (!isActive) return;
    const handler = () => setEditing(true);
    document.addEventListener('wmux:rename-workspace', handler);
    return () => document.removeEventListener('wmux:rename-workspace', handler);
  }, [isActive]);

  const commitRename = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== workspace.name) {
      onRename(trimmed);
    } else {
      setEditName(workspace.name);
    }
    setEditing(false);
  };

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    dragStartTimeRef.current = Date.now();
    // dataTransfer carries ONLY the markdown so external chat composers
    // see a clean text drop. The source index for sidebar reorder is
    // stashed in zustand (cleared in dragend) — see uiSlice
    // setDraggedWorkspaceIndex. Mirrors what SurfaceTabs does for pane
    // export, where there is no internal-drop sibling at all.
    const md = buildWorkspaceMarkdown(workspace);
    e.dataTransfer.setData('text/plain', md);
    // copyMove (not copy): the sibling onDragOver below sets
    // dropEffect='move' for reorder, which is only valid against an
    // effectAllowed that includes 'move'. External chat composers
    // accept the 'copy' half of 'copyMove' just as well.
    e.dataTransfer.effectAllowed = 'copyMove';
    setDraggedWorkspaceIndex(index);
    setTerminalTextDropDragActive(true);
    // Apply the "being dragged" visual synchronously by mutating the
    // element's inline style. The previous setTimeout(setIsDragging) +
    // className toggle caused a React re-render right after dragstart
    // returned, which mutated the live drag source DOM. Chromium's drag
    // engine then lost track of the source and the OS painted 🚫 on the
    // cursor immediately. SurfaceTabs has no equivalent state which is
    // why its path always worked. Inline style avoids React entirely.
    e.currentTarget.style.opacity = '0.4';
  };

  const handleDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    e.currentTarget.style.opacity = '';
    setDropIndicator(null);
    setTerminalTextDropDragActive(false);
    // Always clear, including the "drag dropped outside any drop target"
    // path. dragend always fires, drop does not.
    setDraggedWorkspaceIndex(null);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const reorderFrom = useStore.getState().draggedWorkspaceIndex;
    if (reorderFrom === null) return;
    // Codex P1: do NOT force dropEffect='move' on the source row itself.
    // While the pointer is still over the row that started the drag,
    // the operation must stay 'copy' (the effectAllowed='copyMove'
    // default) so an external chat composer the user is about to drop
    // onto sees a clean copy text drag. Forcing 'move' here poisoned
    // every subsequent drop target into believing this was a reorder
    // and external text composers rejected it with 🚫.
    if (reorderFrom === index) return;
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropIndicator(e.clientY < midY ? 'above' : 'below');
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // currentTarget 밖으로 나갈 때만 인디케이터 제거
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropIndicator(null);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropIndicator(null);
    // Reorder source comes from the store, not dataTransfer. A null
    // value means the drop originated from outside the sidebar (or the
    // user dragged a workspace out and back in) — silently ignore so
    // foreign markdown drops never reshuffle the list.
    const fromIndex = useStore.getState().draggedWorkspaceIndex;
    if (fromIndex === null || fromIndex === index) return;

    // 드롭 위치를 아이템 중간 기준으로 결정
    // 위 절반 → 현재 index 앞으로, 아래 절반 → 현재 index 뒤로
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const toIndex = e.clientY < midY
      ? (fromIndex < index ? index - 1 : index)
      : (fromIndex > index ? index + 1 : index);
    onReorder(fromIndex, toIndex);
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // 드래그 직후 클릭 이벤트 무시 (200ms 이내)
    if (Date.now() - dragStartTimeRef.current < 200) return;
    if (e.ctrlKey) {
      e.preventDefault();
      onCtrlSelect();
    } else {
      onSelect();
    }
  };

  const handleDoubleClick = () => {
    // 드래그 직후 더블클릭 이벤트 무시
    if (Date.now() - dragStartTimeRef.current < 300) return;
    setEditName(workspace.name);
    setEditing(true);
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setWdOpen(false);
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  // Close the context menu on any outside click or Escape.
  useEffect(() => {
    if (!menuPos) return;
    const close = () => setMenuPos(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuPos(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuPos]);

  // Same outside-click / Escape dismissal for the close-confirmation popover.
  useEffect(() => {
    if (!closeConfirmPos) return;
    const close = () => setCloseConfirmPos(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCloseConfirmPos(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [closeConfirmPos]);

  const hasProfile = workspace.profile !== undefined;

  return (
    <div
      className="relative mx-2"
      // Allow the drag cursor to pass through the 8px horizontal margin
      // around each row. Without preventDefault here the OS sees no
      // drop target on the margin and paints a 🚫 cursor the moment
      // the pointer leaves the inner row, which the user reads as
      // "drag is rejected".
      onDragOver={(e) => {
        if (useStore.getState().draggedWorkspaceIndex !== null) {
          e.preventDefault();
        }
      }}>
      {/* 드롭 인디케이터 - 위. pointer-events-none so it never participates
          in drag hit-testing (codex P3). */}
      {dropIndicator === 'above' && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-[var(--accent-blue)] rounded-full z-10 -translate-y-px pointer-events-none" />
      )}

      <div
        draggable
        className={`group flex items-start gap-2 px-3 py-1.5 cursor-pointer rounded-md transition-colors select-none ${
          isActive
            ? 'bg-[var(--bg-surface)] text-[var(--text-main)]'
            : 'text-[var(--text-subtle)] hover:bg-[rgba(var(--bg-surface-rgb),0.5)] hover:text-[var(--text-sub)]'
        }`}
        style={isMultiview ? { borderLeft: '2px solid var(--accent-blue)' } : undefined}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Status indicator */}
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${isActive ? 'bg-[var(--accent-green)]' : 'bg-[var(--text-muted)]'}`} />

        {/* Name + Metadata */}
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              ref={inputRef}
              className="w-full bg-[var(--bg-base)] text-[var(--text-main)] text-[11px] font-mono px-1 py-0 rounded border border-[var(--text-muted)] outline-none"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') { setEditName(workspace.name); setEditing(false); }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <div className="flex items-center gap-1">
                <span className="text-[11px] font-mono truncate">{workspace.name}</span>
                {hasProfile && (
                  <span
                    className="text-[8px] leading-none flex-shrink-0 text-[var(--accent-blue)]"
                    title={t('workspaceProfile.title')}
                  >
                    ⚙
                  </span>
                )}
                {metadata?.agentStatus && metadata.agentStatus !== 'idle' && (
                  <AgentStatusDot status={metadata.agentStatus} agentName={metadata.agentName} />
                )}
                {unreadCount > 0 && (
                  <span className="bg-[var(--accent-blue)] text-[var(--bg-base)] text-[9px] font-bold min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 flex-shrink-0">
                    {unreadCount}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* Shortcut hint */}
        <span className="text-[8px] font-mono text-[var(--text-muted)] flex-shrink-0 mt-0.5">
          {index < 9 ? `^${index + 1}` : ''}
        </span>

        {/* Copy session info button */}
        <button
          className="opacity-0 group-hover:opacity-100 text-[var(--text-subtle)] hover:text-[var(--accent-blue)] text-[10px] font-mono flex-shrink-0 mt-0.5 transition-opacity"
          onClick={(e) => { e.stopPropagation(); onCopyInfo(); }}
          title={t('workspace.copyInfo')}
        >
          ⧉
        </button>

        {/* Close button — asks for confirmation first (anti-misclick). */}
        <button
          className="opacity-0 group-hover:opacity-100 text-[var(--text-subtle)] hover:text-[var(--accent-red)] text-[10px] font-mono flex-shrink-0 mt-0.5 transition-opacity"
          onClick={(e) => { e.stopPropagation(); setMenuPos(null); setCloseConfirmPos({ x: e.clientX, y: e.clientY }); }}
          title={t('workspace.close')}
        >
          ✕
        </button>
      </div>

      {/* 드롭 인디케이터 - 아래. pointer-events-none so it never participates
          in drag hit-testing (codex P3). */}
      {dropIndicator === 'below' && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent-blue)] rounded-full z-10 translate-y-px pointer-events-none" />
      )}

      {/* Right-click context menu */}
      {menuPos && (
        <div
          className="fixed z-[9999] w-max flex flex-col py-1 rounded-md shadow-xl"
          style={{ left: menuPos.x, top: menuPos.y, background: 'var(--bg-surface)', border: '1px solid var(--bg-overlay)' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
            style={{ color: 'var(--text-main)' }}
            onClick={() => { setMenuPos(null); setEditName(workspace.name); setEditing(true); }}
          >
            {t('workspace.rename')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
            style={{ color: 'var(--text-main)' }}
            onClick={() => { setMenuPos(null); setProfileModalOpen(true); }}
          >
            {t('workspace.configureProfile')}
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
            style={{ color: 'var(--text-main)' }}
            onClick={() => { setMenuPos(null); onDuplicate(); }}
          >
            {t('workspace.duplicate')}
          </button>

          {/* Working directories — hover to reveal each terminal's cwd. Flips to
              the left when the menu is opened near the right screen edge. */}
          <div
            className="relative"
            onMouseEnter={() => setWdOpen(true)}
            onMouseLeave={() => setWdOpen(false)}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
              style={{ color: 'var(--text-main)' }}
            >
              <span>{t('workspace.workingDirs')}</span>
              <span className="text-[var(--text-muted)]">▸</span>
            </button>
            {wdOpen && (
              <div
                className={`absolute top-0 ${menuPos.x > window.innerWidth * 0.6 ? 'right-full mr-0.5' : 'left-full ml-0.5'} min-w-[240px] max-w-[420px] py-1 rounded-md shadow-xl`}
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-overlay)' }}
              >
                {(() => {
                  const terminals = collectTerminalSurfaces(workspace.rootPane);
                  if (terminals.length === 0) {
                    return (
                      <div className="px-3 py-1.5 text-xs text-[var(--text-muted)]">
                        {t('workspace.noWorkingDirs')}
                      </div>
                    );
                  }
                  return terminals.map((s) => {
                    const label = s.title || t('surface.terminal');
                    const path = s.cwd || '—';
                    return (
                      <div key={s.id} className="flex items-center gap-2 px-3 py-1 text-xs">
                        <span className="font-medium text-[var(--accent-blue)] truncate max-w-[110px] shrink-0" title={label}>{label}</span>
                        <span className="text-[var(--text-subtle)] truncate flex-1 font-mono text-[11px]" title={path}>{path}</span>
                        <button
                          className="text-[var(--text-subtle)] hover:text-[var(--accent-blue)] shrink-0 transition-colors disabled:opacity-30 disabled:hover:text-[var(--text-subtle)]"
                          disabled={!s.cwd}
                          title={t('workspace.copyPath')}
                          onClick={() => {
                            setMenuPos(null);
                            window.clipboardAPI.writeText(s.cwd)
                              .then(() => showCopyToast(t('workspace.copied')))
                              .catch(() => { /* clipboard denied — silent, non-critical */ });
                          }}
                        >
                          ⧉
                        </button>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Close-workspace confirmation (anti-misclick). */}
      {closeConfirmPos && (
        <div
          className="fixed z-[9999] w-[220px] py-2 rounded-md shadow-xl"
          style={{ left: Math.min(closeConfirmPos.x, window.innerWidth - 232), top: closeConfirmPos.y, background: 'var(--bg-surface)', border: '1px solid var(--bg-overlay)' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-3 pb-1 text-xs text-[var(--text-main)]">
            {t('workspace.closeConfirm', { name: workspace.name })}
          </div>
          {(() => {
            const count = collectTerminalSurfaces(workspace.rootPane).length;
            if (count === 0) return null;
            return (
              <div className="px-3 pb-2 text-[11px] text-[var(--text-muted)]">
                {t('workspace.closeConfirmDetail', { count })}
              </div>
            );
          })()}
          <div className="flex justify-end gap-2 px-3 pt-1">
            <button
              className="px-2 py-0.5 text-[11px] rounded transition-colors text-[var(--text-subtle)] hover:bg-[var(--bg-overlay)]"
              onClick={() => setCloseConfirmPos(null)}
            >
              {t('workspace.closeCancel')}
            </button>
            <button
              className="px-2 py-0.5 text-[11px] rounded transition-colors text-[var(--accent-red)] hover:bg-[var(--bg-overlay)]"
              onClick={() => { setCloseConfirmPos(null); onClose(); }}
            >
              {t('workspace.closeConfirmYes')}
            </button>
          </div>
        </div>
      )}

      {/* Profile editor modal */}
      {profileModalOpen && (
        <WorkspaceProfileModal workspace={workspace} onClose={() => setProfileModalOpen(false)} />
      )}
    </div>
  );
}
