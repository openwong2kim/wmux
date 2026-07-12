import { useState, useRef, useEffect, memo } from 'react';
import type { PrStatus, WorkspaceMetadata } from '../../../shared/types';
import { useStore } from '../../stores';
import { selectWorkspaceById } from '../../stores/selectors/workspaceProjections';
import { selectWorkspaceAgentStatus } from '../../stores/selectors/fleet';
import { useT } from '../../hooks/useT';
import { AGENT_STATUS_ICON } from './agentStatusIcon';
import { IconCopy, IconX, IconGear, IconPlay, IconPause, IconChevron, IconBell } from '../icons';
import { tokenAttrs } from '../../themes';
import { buildWorkspaceMarkdown } from '../../utils/sessionInfoMarkdown';
import { collectTerminalSurfaces } from '../../utils/paneTraversal';
import { openUrlInBrowserPane } from '../../utils/browserPaneActions';
import WorkspaceProfileModal from './WorkspaceProfileModal';

interface WorkspaceItemProps {
  /** A1: 부모(Sidebar)는 id만 내리고, 이 컴포넌트가 자기 ws를 self-subscribe해
   *  자기 ws 변경에만 리렌더된다. 콜백은 모두 id 인자를 받아 부모에서 안정적으로
   *  한 번만 생성될 수 있게 한다(React.memo가 실효하도록). */
  workspaceId: string;
  isActive: boolean;
  isMultiview: boolean;
  index: number;
  onSelect: (id: string) => void;
  onCtrlSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onClose: (id: string) => void;
  onCopyInfo: (id: string) => void;
  onDuplicate: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

/**
 * X1 — PR badge for the current branch. Color encodes state; the trailing
 * dot encodes CI checks. Clicking opens the PR in the default browser.
 */
function PrBadge({ pr }: { pr: PrStatus }): React.ReactElement {
  const t = useT();
  const stateColor =
    pr.state === 'open' ? 'var(--accent-green)'
    : pr.state === 'merged' ? 'var(--accent-blue)'
    : pr.state === 'closed' ? 'var(--accent-red)'
    : 'var(--text-muted)'; // draft
  const checksGlyph =
    pr.checks === 'passing' ? '✓'
    : pr.checks === 'failing' ? '✗'
    : pr.checks === 'pending' ? '●'
    : '';
  const checksColor =
    pr.checks === 'passing' ? 'var(--accent-green)'
    : pr.checks === 'failing' ? 'var(--accent-red)'
    : 'var(--text-muted)';
  const stateLabel = t(`workspace.prState.${pr.state}`);
  const title = pr.checks
    ? `#${pr.number} — ${stateLabel}, ${t(`workspace.prChecks.${pr.checks}`)}`
    : `#${pr.number} — ${stateLabel}`;
  return (
    <span
      className="flex items-center gap-0.5 flex-shrink-0 cursor-pointer hover:underline"
      style={{ color: stateColor }}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        window.electronAPI.shell?.openExternal?.(pr.url);
      }}
    >
      #{pr.number}
      {checksGlyph && <span style={{ color: checksColor }}>{checksGlyph}</span>}
    </span>
  );
}

/**
 * X1 — one-line live context under the workspace name: git branch
 * (worktree-aware), PR badge, PID-tree-scoped listening ports, and the
 * latest terminal notification. Renders nothing until metadata arrives —
 * zero-config, no reserved blank space.
 */
function WorkspaceContextLine({ metadata, onPortClick }: {
  metadata: WorkspaceMetadata;
  /** X3 — open http://localhost:<port> in this workspace's browser pane. */
  onPortClick: (port: number) => void;
}): React.ReactElement | null {
  const t = useT();
  const ports = metadata.listeningPorts ?? [];
  const hasContext = Boolean(metadata.gitBranch) || Boolean(metadata.pr) || ports.length > 0;
  const note = metadata.lastNotificationText;
  if (!hasContext && !note) return null;
  return (
    <>
      {hasContext && (
        <div className="flex items-center gap-1.5 mt-0.5 text-[9px] font-mono text-[var(--text-muted)] min-w-0">
          {metadata.gitBranch && (
            <span
              className="truncate max-w-[120px]"
              title={`${t('workspace.gitBranch')}: ${metadata.gitBranch}${metadata.gitIsWorktree ? ` (${t('workspace.gitWorktree')})` : ''}`}
            >
              ⎇ {metadata.gitBranch}
              {metadata.gitIsWorktree ? <span className="text-[var(--accent-blue)]">⊕</span> : null}
            </span>
          )}
          {metadata.pr && <PrBadge pr={metadata.pr} />}
          {ports.length > 0 && (
            <span className="flex items-center gap-1 flex-shrink-0">
              {ports.slice(0, 3).map((p) => (
                <button
                  key={p}
                  type="button"
                  className="cursor-pointer hover:text-[var(--accent-blue)] hover:underline"
                  title={t('workspace.openPortTooltip', { port: p })}
                  aria-label={t('workspace.openPortTooltip', { port: p })}
                  onClick={(e) => { e.stopPropagation(); onPortClick(p); }}
                >
                  :{p}
                </button>
              ))}
              {ports.length > 3 ? (
                <span title={`${t('workspace.listeningPorts')}: ${ports.join(', ')}`}>
                  +{ports.length - 3}
                </span>
              ) : null}
            </span>
          )}
        </div>
      )}
      {note && (
        <div
          className="mt-0.5 flex items-center gap-1 text-[9px] text-[var(--text-muted)] truncate"
          title={`${t('workspace.lastNotification')}: ${note.title ? `${note.title} — ` : ''}${note.body}`}
        >
          <span className="shrink-0 opacity-70"><IconBell size={9} /></span>
          <span className="truncate">{note.title ? `${note.title}: ` : ''}{note.body}</span>
        </div>
      )}
    </>
  );
}

/**
 * "Copied!" 피드백. 정본 토스트(toastSlice)를 경유해 앱 전역 알림과 스타일을
 * 공유한다. (기존 수동 DOM 토스트는 store를 우회했다.)
 */
function showCopyToast(text: string): void {
  useStore.getState().pushToast({ level: 'info', message: text });
}

function shortenPath(path: string, maxLen = 25): string {
  if (!path || path.length <= maxLen) return path;
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join('/')}`;
}

function WorkspaceItem({ workspaceId, isActive, isMultiview, index, onSelect, onCtrlSelect, onRename, onClose, onCopyInfo, onDuplicate, onReorder }: WorkspaceItemProps) {
  const t = useT();
  // A1: 자기 ws만 구독 — 배경 ws churn/다른 항목 변경에는 리렌더되지 않는다.
  const workspace = useStore(selectWorkspaceById(workspaceId));
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(workspace?.name ?? '');
  const [dropIndicator, setDropIndicator] = useState<'above' | 'below' | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [wdOpen, setWdOpen] = useState(false);
  const [closeConfirmPos, setCloseConfirmPos] = useState<{ x: number; y: number } | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragStartTimeRef = useRef<number>(0);

  const unreadCount = useStore((s) =>
    s.notifications.filter((n) => !n.read && n.workspaceId === workspaceId).length,
  );
  // Sidebar reorder source index lives in the store, not in dataTransfer.
  // See uiSlice.draggedWorkspaceIndex for why this is out-of-band.
  const setDraggedWorkspaceIndex = useStore((s) => s.setDraggedWorkspaceIndex);
  const setTerminalTextDropDragActive = useStore((s) => s.setTerminalTextDropDragActive);

  const metadata = workspace?.metadata;

  // Sidebar dot source (agent-status-dot fix): the WHOLE workspace's most-urgent
  // agent status, rolled up over every pane's every surface — the same
  // derivation the deck Fleet roster + titlebar vitals use. Reading
  // `metadata.agentStatus` directly only ever saw the active pane and never
  // self-healed. Scalar return → Object.is subscription re-renders only on change.
  const agentStatus = useStore((s) => selectWorkspaceAgentStatus(s, workspaceId));
  // X5 wmux.json badge state for this workspace (transient, probe-driven).
  const projectState = useStore((s) => s.projectConfigs[workspaceId]);
  // J3 §4 — 태스크 워크스페이스의 페인 cwd가 worktree 경계 밖으로 이탈했는지(경고만).
  const departedCwd = useStore((s) => s.departedPaneGroups[workspaceId]);

  // X1→X3 bridge: a listening-port badge click jumps to the workspace and
  // shows http://localhost:<port> in its browser pane (reusing one if the
  // workspace already has it).
  const handlePortClick = (port: number) => {
    useStore.getState().setActiveWorkspace(workspaceId);
    openUrlInBrowserPane(`http://localhost:${port}`, { workspaceId });
  };

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
    if (trimmed && trimmed !== workspace?.name) {
      onRename(workspaceId, trimmed);
    } else {
      setEditName(workspace?.name ?? '');
    }
    setEditing(false);
  };

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (!workspace) return;
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
    // 멀티뷰 토글: 플랫폼 주 보조키 + 클릭 (useKeyboard의 cmdOrCtrl 패턴과 동일).
    // macOS=⌘, Win/Linux=Ctrl. macOS에서 Ctrl+클릭은 OS 우클릭(컨텍스트 메뉴)으로
    // 깔끔히 분리되고, Win/Linux에선 Super+클릭이 오작동하지 않는다.
    const cmdOrCtrl = window.electronAPI?.platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (cmdOrCtrl) {
      e.preventDefault();
      onCtrlSelect(workspaceId);
    } else {
      onSelect(workspaceId);
    }
  };

  const handleDoubleClick = () => {
    // 드래그 직후 더블클릭 이벤트 무시
    if (Date.now() - dragStartTimeRef.current < 300) return;
    setEditName(workspace?.name ?? '');
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

  // A1: 자기 ws가 (막 삭제되어) 없으면 렌더하지 않는다. 모든 훅 호출 이후에만
  // 반환해 훅 순서를 보존한다. Sidebar는 삭제와 동시에 이 항목을 map에서 제거
  // 하므로 이 창은 찰나다.
  if (!workspace) return null;

  const hasProfile = workspace.profile !== undefined;

  return (
    <div
      className="relative mx-2 sidebar-row-enter"
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
        <div className="absolute top-0 left-0 right-0 h-[3px] bg-[var(--accent-blue)] rounded-full z-10 -translate-y-px pointer-events-none sidebar-row-enter" />
      )}

      <div
        draggable
        {...tokenAttrs('bgSurface', 'bg')}
        className={`group sidebar-row flex items-start gap-2 px-3 py-1.5 cursor-pointer rounded-md select-none ${
          isActive
            ? 'sidebar-row-active text-[var(--text-main)]'
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
        {(() => {
          const st = agentStatus !== 'idle' ? AGENT_STATUS_ICON[agentStatus] : null;
          return (
            <div
              className={`sidebar-dot w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${st ? st.glowClass : ''}`}
              style={{ backgroundColor: st ? st.dotVar : isActive ? 'var(--accent-green)' : 'var(--text-muted)' }}
            />
          );
        })()}

        {/* Name + Metadata */}
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              ref={inputRef}
              className="w-full bg-[var(--bg-base)] text-[var(--text-main)] text-caption font-mono px-1 py-0 rounded border border-[var(--text-muted)] outline-none"
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
                <span className="text-caption font-mono truncate">{workspace.name}</span>
                {hasProfile && (
                  <span
                    className="text-[8px] leading-none flex-shrink-0 text-[var(--accent-blue)]"
                    title={t('workspaceProfile.title')}
                  >
                    <IconGear size={9} />
                  </span>
                )}
                {projectState?.found && (
                  // X5 wmux.json badge. Color encodes the trust verdict:
                  // blue=trusted (actions available), yellow=needs review
                  // (untrusted/stale/invalid), grey=denied. Click opens the
                  // review/actions dialog for THIS workspace.
                  <button
                    type="button"
                    className="text-[8px] leading-none flex-shrink-0 font-mono cursor-pointer hover:underline"
                    style={{
                      color: projectState.trust === 'trusted'
                        ? 'var(--accent-blue)'
                        : projectState.trust === 'denied'
                          ? 'var(--text-muted)'
                          : 'var(--accent-yellow)',
                    }}
                    title={t('project.badgeTooltip')}
                    aria-label={t('project.badgeTooltip')}
                    onClick={(e) => {
                      e.stopPropagation();
                      useStore.getState().setProjectDialogWsId(workspaceId);
                    }}
                  >
                    <IconGear size={9} />
                  </button>
                )}
                {unreadCount > 0 && (
                  <span className="bg-[var(--bg-surface)] text-[var(--text-sub)] ring-1 ring-[var(--border-soft)] text-[9px] font-bold min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 flex-shrink-0">
                    {unreadCount}
                  </span>
                )}
                {departedCwd && (
                  <span
                    className="text-[9px] text-[var(--accent-yellow,#f9e2af)] flex-shrink-0"
                    title={`페인 cwd가 태스크 worktree 경계 밖으로 이탈: ${departedCwd}`}
                  >
                    ⚠ 이탈
                  </span>
                )}
              </div>
              {metadata && <WorkspaceContextLine metadata={metadata} onPortClick={handlePortClick} />}
            </>
          )}
        </div>

        {/* Agent status mark (play/pause), right-aligned. */}
        {(() => {
          const st = AGENT_STATUS_ICON[agentStatus];
          if (!st?.mark) return null;
          return (
            <span className={`flex-shrink-0 mt-1 ${st.className}`} title={t(st.labelKey)}>
              {st.mark === 'play' ? <IconPlay size={9} /> : <IconPause size={9} />}
            </span>
          );
        })()}

        {/* Shortcut hint */}
        <span className="text-[8px] font-mono text-[var(--text-muted)] flex-shrink-0 mt-0.5">
          {index < 9 ? `^${index + 1}` : ''}
        </span>

        {/* Copy session info button */}
        <button
          className="opacity-0 group-hover:opacity-100 text-[var(--text-subtle)] hover:text-[var(--accent-blue)] text-[10px] font-mono flex-shrink-0 mt-0.5 transition-opacity duration-150"
          onClick={(e) => { e.stopPropagation(); onCopyInfo(workspaceId); }}
          title={t('workspace.copyInfo')}
          aria-label={t('workspace.copyInfo')}
        >
          <IconCopy size={11} />
        </button>

        {/* Close button — asks for confirmation first (anti-misclick). */}
        <button
          className="opacity-0 group-hover:opacity-100 text-[var(--text-subtle)] hover:text-[var(--accent-red)] text-[10px] font-mono flex-shrink-0 mt-0.5 transition-opacity"
          onClick={(e) => { e.stopPropagation(); setMenuPos(null); setCloseConfirmPos({ x: e.clientX, y: e.clientY }); }}
          title={t('workspace.close')}
          aria-label={t('workspace.close')}
        >
          <IconX size={11} />
        </button>
      </div>

      {/* 드롭 인디케이터 - 아래. pointer-events-none so it never participates
          in drag hit-testing (codex P3). */}
      {dropIndicator === 'below' && (
        <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-[var(--accent-blue)] rounded-full z-10 translate-y-px pointer-events-none sidebar-row-enter" />
      )}

      {/* Right-click context menu */}
      {menuPos && (
        <div
          className="fixed z-[var(--z-popover-top)] w-max flex flex-col py-1 rounded-[7px] shadow-xl sidebar-popover-enter"
          style={{ left: menuPos.x, top: menuPos.y, background: 'var(--bg-surface)', border: '1px solid color-mix(in srgb, var(--bg-overlay) 70%, transparent)' }}
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
            onClick={() => { setMenuPos(null); onDuplicate(workspaceId); }}
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
              <span className="text-[var(--text-muted)]"><IconChevron /></span>
            </button>
            {wdOpen && (
              <div
                className={`absolute top-0 ${menuPos.x > window.innerWidth * 0.6 ? 'right-full mr-0.5' : 'left-full ml-0.5'} min-w-[240px] max-w-[420px] py-1 rounded-[7px] shadow-xl sidebar-popover-enter`}
                style={{ background: 'var(--bg-surface)', border: '1px solid color-mix(in srgb, var(--bg-overlay) 70%, transparent)' }}
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
                        <span className="text-[var(--text-subtle)] truncate flex-1 font-mono text-caption" title={path}>{path}</span>
                        <button
                          className="text-[var(--text-subtle)] hover:text-[var(--accent-blue)] shrink-0 transition-colors disabled:opacity-30 disabled:hover:text-[var(--text-subtle)]"
                          disabled={!s.cwd}
                          title={t('workspace.copyPath')}
                          aria-label={t('workspace.copyPath')}
                          onClick={() => {
                            setMenuPos(null);
                            window.clipboardAPI.writeText(s.cwd)
                              .then(() => showCopyToast(t('workspace.copied')))
                              .catch(() => { /* clipboard denied — silent, non-critical */ });
                          }}
                        >
                          <IconCopy size={11} />
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
          className="fixed z-[var(--z-popover-top)] w-[220px] py-2 rounded-[7px] shadow-xl sidebar-popover-enter"
          style={{ left: Math.min(closeConfirmPos.x, window.innerWidth - 232), top: closeConfirmPos.y, background: 'var(--bg-surface)', border: '1px solid color-mix(in srgb, var(--bg-overlay) 70%, transparent)' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-3 pb-1 text-xs text-[var(--text-main)]">
            {t('workspace.closeConfirm', { name: workspace.name })}
          </div>
          {(() => {
            const count = collectTerminalSurfaces(workspace.rootPane).length;
            if (count === 0) return null;
            return (
              <div className="px-3 pb-2 text-caption text-[var(--text-muted)]">
                {t('workspace.closeConfirmDetail', { count })}
              </div>
            );
          })()}
          <div className="flex justify-end gap-2 px-3 pt-1">
            <button
              className="px-2 py-0.5 text-caption rounded transition-colors text-[var(--text-subtle)] hover:bg-[var(--bg-overlay)]"
              onClick={() => setCloseConfirmPos(null)}
            >
              {t('workspace.closeCancel')}
            </button>
            <button
              className="px-2 py-0.5 text-caption rounded transition-colors text-[var(--accent-red)] hover:bg-[var(--bg-overlay)]"
              onClick={() => { setCloseConfirmPos(null); onClose(workspaceId); }}
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

// A2: 리스트 자식 memo 방벽. 부모(Sidebar)가 리렌더돼도 이 항목의 props(id·
// isActive·isMultiview·index·안정 콜백)가 그대로면 리렌더를 건너뛴다. 자기 ws
// 내용 변경은 내부 self-subscribe가 직접 리렌더를 유발하므로 memo와 무관하게
// 반영된다. 기본 얕은 비교로 충분(모든 콜백이 Sidebar에서 안정적으로 생성됨).
export default memo(WorkspaceItem);
