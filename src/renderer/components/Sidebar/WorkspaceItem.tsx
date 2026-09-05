import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import type { GitSyncStatus, PrStatus, WorkspaceMetadata } from '../../../shared/types';
import { useStore } from '../../stores';
import { selectWorkspaceById } from '../../stores/selectors/workspaceProjections';
import { selectWorkspaceAgentStatus } from '../../stores/selectors/fleet';
import { createWorkspaceRosterCountsSelector } from '../../stores/selectors/workspaceAgentRoster';
import { useT } from '../../hooks/useT';
import type { TranslationKey } from '../../i18n/locales/en';
import { AGENT_STATUS_ICON } from './agentStatusIcon';
import { IconCopy, IconX, IconGear, IconChevron, IconBell, IconFolder, IconTerminal, IconExternalLink } from '../icons';
import { tokenAttrs } from '../../themes';
import { HIT_TARGET_24_CLUSTER, HIT_TARGET_24_IN_CLUSTER } from '../hitArea';
import { buildWorkspaceMarkdown } from '../../utils/sessionInfoMarkdown';
import { collectTerminalSurfaces, collectWorkspaceTerminalSurfaces } from '../../utils/paneTraversal';
import { openUrlInBrowserPane } from '../../utils/browserPaneActions';
import WorkspaceProfileModal from './WorkspaceProfileModal';
import WorkspaceAccountMenu from './WorkspaceAccountMenu';
import WorkspaceChromeProfileMenu from './WorkspaceChromeProfileMenu';
import WorkspaceAgentRoster, { WorkspaceRosterSummaryMemo, STASH_PULSE_MS } from './WorkspaceAgentRoster';
import { displayPath } from '../../utils/displayPath';
import { WORKSPACE_COLOR_IDS, WORKSPACE_COLOR_HEX, workspaceColorHex, workspaceColorLabelKey } from '../../../shared/workspaceColors';

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
 * Git 신호등(owner 2026-07-20) — 워크스페이스 이름 아래 전용 행에서 색으로
 * 상태를 즉독: clean=green ●, dirty=muted ·N, ahead=blue ↑N, behind=red ↓N.
 * 브랜치가 잡힌 워크스페이스는 항상 최소 1개의 불이 켜진다(clean이면 green).
 * 숫자는 항상 동반(맨 화살표는 모호 — GitHub Desktop #9282).
 */
export function GitSyncBadge({ sync }: { sync: GitSyncStatus }): React.ReactElement | null {
  const t = useT();
  const ahead = sync.hasUpstream ? sync.ahead : 0;
  const behind = sync.hasUpstream ? sync.behind : 0;
  const clean = ahead === 0 && behind === 0 && sync.dirty === 0;
  return (
    <span
      className="flex items-center gap-1.5 flex-shrink-0"
      title={t('workspace.gitSyncTooltip', { ahead, behind, dirty: sync.dirty })}
      data-git-signal
    >
      {clean && <span style={{ color: 'var(--accent-green)' }}>●</span>}
      {/* Uncommitted files are information, not attention: amber is reserved for "running". */}
      {sync.dirty > 0 && <span style={{ color: 'var(--text-muted)' }}>·{sync.dirty}</span>}
      {ahead > 0 && <span style={{ color: 'var(--accent-blue)' }}>↑{ahead}</span>}
      {behind > 0 && <span style={{ color: 'var(--accent-red)' }}>↓{behind}</span>}
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
  const hasContext = ports.length > 0;
  const note = metadata.lastNotificationText;
  if (!metadata.gitBranch && !hasContext && !note) return null;
  return (
    <>
      {/* Git 신호등 행 — 이름 바로 아래 전용 줄(owner 2026-07-20: 행이 위아래로
          두꺼워져도 OK). 브랜치·신호등·PR을 한 줄에, 포트·알림은 다음 줄로. */}
      {metadata.gitBranch && (
        <div className="flex items-center gap-2 mt-1 text-[10px] font-mono text-[var(--text-muted)] min-w-0" data-git-signal-line>
          <span
            className="min-w-0 truncate"
            title={`${t('workspace.gitBranch')}: ${metadata.gitBranch}${metadata.gitIsWorktree ? ` (${t('workspace.gitWorktree')})` : ''}`}
          >
            ⎇ {metadata.gitBranch}
            {metadata.gitIsWorktree ? <span className="text-[var(--accent-blue)]">⊕</span> : null}
          </span>
          {metadata.gitSync && <GitSyncBadge sync={metadata.gitSync} />}
          {metadata.pr && <PrBadge pr={metadata.pr} />}
        </div>
      )}
      {hasContext && (
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] font-mono text-[var(--text-muted)] min-w-0">
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
          className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--text-muted)] truncate"
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

/**
 * Detected apps whose entry should read as a terminal rather than a generic
 * external app — Windows Terminal, and macOS Terminal.app / iTerm.
 */
const TERMINAL_APP_IDS = new Set(['wt', 'terminal', 'iterm']);

/**
 * The OS's own word for its file manager. Localized because "Finder" and "File
 * Explorer" are user-facing OS vocabulary — a Korean user expects 파일 탐색기 —
 * and which one applies comes from the platform, not from any string main sent.
 */
function fileManagerName(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const platform = window.electronAPI?.platform;
  if (platform === 'darwin') return t('workspace.finder');
  if (platform === 'win32') return t('workspace.fileExplorer');
  return t('workspace.fileManager');
}

/**
 * Label for one "Open with…" entry. Editor names are product names and stay as
 * main reported them; only the built-in file manager is localized.
 */
function folderAppLabel(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  app: { id: string; name: string },
): string {
  return app.id === 'explorer' ? fileManagerName(t) : app.name;
}

/**
 * "Open in explorer / open with" 실패 피드백. OS가 폴더를 열지 못한 경우
 * (경로 삭제, 권한 거부, 연결 프로그램 실행 실패) 클릭이 무반응으로 보이지
 * 않도록 원인을 붙여 경고 토스트로 알린다.
 *
 * main이 배치 셰임 실행을 거부할 때 쓰는 두 구조화 코드는 사용자가 읽을 수 있는
 * 문장으로 바꾼다. 그 외의 detail(OS 오류 문자열)은 그대로 덧붙인다.
 */
function notifyOpenFailed(t: (key: TranslationKey, params?: Record<string, string | number>) => string, detail?: string): void {
  const label = t('workspace.openFailed');
  let message = detail ? `${label}: ${detail}` : label;
  if (detail === 'PATH_NOT_QUOTABLE') {
    message = `${label}: ${t('workspace.openFailedQuoting')}`;
  } else if (detail?.startsWith('PATH_HAS_ENV_SYNTAX:')) {
    message = `${label}: ${t('workspace.openFailedEnvSyntax', { name: detail.slice('PATH_HAS_ENV_SYNTAX:'.length) })}`;
  }
  useStore.getState().pushToast({ level: 'warn', message });
}

/** Idle-duration label: minutes under an hour, then hours, then days. */
function formatIdle(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Idle badge threshold — under a minute is "just now", not neglect. */
const IDLE_SHOW_AFTER_MS = 60_000;
/** Re-render cadence for the idle label; minute granularity needs no more. */
const IDLE_TICK_MS = 30_000;

/**
 * Rest-state chrome: invisible AND weightless.
 *
 * `opacity-0` alone still spends the item's width, and in a 240px sidebar that
 * width comes straight out of the workspace name — a "Needs you" row truncated
 * a readable name to "sa…" while the chrome nobody could see sat beside it.
 * `max-w-0` + `overflow-hidden` collapse the box at rest; hover and
 * focus-within hand back the width AND the overflow the 24px hit recipes need
 * for their margin refunds. `pointer-events` follow visibility so an invisible
 * control never takes a click meant for the row underneath.
 */
const REST_HIDDEN =
  'opacity-0 pointer-events-none max-w-0 overflow-hidden transition-opacity duration-150'
  + ' group-hover:opacity-100 group-hover:pointer-events-auto group-hover:max-w-none group-hover:overflow-visible'
  + ' group-focus-within:opacity-100 group-focus-within:pointer-events-auto group-focus-within:max-w-none group-focus-within:overflow-visible';

/**
 * A collapsed flex item still contributes its parent's `gap`, so the width the
 * box gave back would be spent again on nothing. These cancel the gap that
 * precedes the item — `-ml-2` for the row (`gap-2`), `-ml-1` for the name line
 * (`gap-1`) — and return it the moment the item is shown.
 */
const REST_HIDDEN_GAP_ROW = '-ml-2 group-hover:ml-0 group-focus-within:ml-0';
const REST_HIDDEN_GAP_NAME_LINE = '-ml-1 group-hover:ml-0 group-focus-within:ml-0';

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
  const [owOpen, setOwOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [folderApps, setFolderApps] = useState<{ id: string; name: string }[]>([]);
  const [closeConfirmPos, setCloseConfirmPos] = useState<{ x: number; y: number } | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragStartTimeRef = useRef<number>(0);

  const unreadCount = useStore((s) =>
    s.notifications.filter((n) => !n.read && n.workspaceId === workspaceId).length,
  );
  // Sidebar reorder source index lives in the store, not in dataTransfer.
  // See uiSlice.draggedWorkspaceIndex for why this is out-of-band.
  const setWorkspaceColor = useStore((s) => s.setWorkspaceColor);
  const setDraggedWorkspaceIndex = useStore((s) => s.setDraggedWorkspaceIndex);
  // Needs-you-first ordering is display-only, so a drop judged against the
  // DISPLAY order would move the row to a different ARRAY index than the
  // indicator promised. Reorder is paused while it is on; Ctrl+N and the
  // stored order are untouched.
  const sidebarAttentionFirst = useStore((s) => s.sidebarAttentionFirst);
  const setTerminalTextDropDragActive = useStore((s) => s.setTerminalTextDropDragActive);

  const metadata = workspace?.metadata;

  // Sidebar dot source (agent-status-dot fix): the WHOLE workspace's most-urgent
  // agent status, rolled up over every pane's every surface — the same
  // derivation the deck Fleet roster + titlebar vitals use. Reading
  // `metadata.agentStatus` directly only ever saw the active pane and never
  // self-healed. Scalar return → Object.is subscription re-renders only on change.
  const agentStatus = useStore((s) => selectWorkspaceAgentStatus(s, workspaceId));
  // An agent that is blocked on the user is the one row state the design
  // system lets us paint (DESIGN.md: the only permitted wash is the danger
  // needs-input row). Two renditions and no more — the wash and the label.
  const needsYou = agentStatus === 'waiting' || agentStatus === 'awaiting_input';
  // Name first. At rest the row shows the workspace name and the signals that
  // change on their own (status dot, unread, idle, "needs you"); the project
  // badge, the agent count and the shortcut hint are chrome you only look for
  // once you are already pointing at the row, and at 240px they were spending
  // the name's width to sit there. The ACTIVE row keeps them — it is the one
  // row you are working in. See REST_HIDDEN for why hiding is not enough on its
  // own: at rest the chrome must also give its WIDTH back to the name.
  const restHidden = isActive ? '' : `${REST_HIDDEN} ${REST_HIDDEN_GAP_ROW}`;
  /** The same, for chrome that sits inside the `gap-1` name line. */
  const restHiddenNameLine = isActive ? '' : `${REST_HIDDEN} ${REST_HIDDEN_GAP_NAME_LINE}`;
  // #997 — the roster's expanded state. It lives here, not in the roster,
  // because the control that toggles it now sits on THIS row while the list it
  // reveals is rendered below; the two would otherwise need to agree across a
  // sibling boundary. The list keeps its own store subscription, so roster
  // churn still does not rerender this component.
  const [rosterOpen, setRosterOpen] = useState(isActive);
  const toggleRoster = useCallback(() => setRosterOpen((value) => !value), []);
  // Counts only — a reference-stable projection of two integers, so this does
  // not rerender the row on terminal output the way the full roster would.
  const rosterCountsSelector = useMemo(
    () => createWorkspaceRosterCountsSelector(workspaceId),
    [workspaceId],
  );
  const rosterCounts = useStore(rosterCountsSelector);
  const hasRoster = rosterCounts.agentCount > 0 || rosterCounts.stashedCount > 0;
  /** Rows whose roster summary must not wait for the pointer — see its JSX. */
  const rosterAlwaysShown =
    rosterOpen || (rosterCounts.agentCount === 0 && rosterCounts.stashedCount > 0);
  // Newly selected workspaces reveal their agents automatically; workspaces
  // that move to the background collapse back to the count. The user can still
  // explicitly toggle either state until selection changes again.
  useEffect(() => {
    setRosterOpen(isActive);
  }, [isActive]);

  // #977 — a pane that was just stashed disappeared from the layout. If the
  // list it moved into is collapsed, the gesture is indistinguishable from a
  // delete, so open the list and flash the row once. The pulse lives HERE
  // because its first job is to open the list, and the list is only mounted
  // once open — a pulse owned by the list could never open it.
  const stashPulse = useStore((s) => s.stashPulse);
  const pulsedPaneId = stashPulse?.workspaceId === workspaceId ? stashPulse.paneId : null;
  const [pulsingPaneId, setPulsingPaneId] = useState<string | null>(null);

  // TWO effects on purpose. Consuming the pulse and owning its timeout in one
  // effect is self-defeating: clearStashPulse() nulls `pulsedPaneId` on the very
  // next render, the effect re-runs, its cleanup clears the pending timeout, and
  // the highlight never turns off — a permanent bar identical to the focused
  // style. Splitting them lets the consume run once and the timeout live on its
  // own key.
  useEffect(() => {
    if (!pulsedPaneId) return;
    setRosterOpen(true);
    setPulsingPaneId(pulsedPaneId);
    useStore.getState().clearStashPulse();
  }, [pulsedPaneId]);

  useEffect(() => {
    if (!pulsingPaneId) return;
    const timer = setTimeout(() => setPulsingPaneId(null), STASH_PULSE_MS);
    return () => clearTimeout(timer);
  }, [pulsingPaneId]);

  // X5 wmux.json badge state for this workspace (transient, probe-driven).
  const projectState = useStore((s) => s.projectConfigs[workspaceId]);
  // J3 §4 — 태스크 워크스페이스의 페인 cwd가 worktree 경계 밖으로 이탈했는지(경고만).
  const departedCwd = useStore((s) => s.departedPaneGroups[workspaceId]);
  // Detach: this workspace is a dependent child task iff its id is an open
  // WorkTask's paneGroupId. When so, surface a "detach from parent" action that
  // releases the mission (non-destructive close) while leaving this workspace,
  // its worktree/branch/PTY and running agent completely untouched.
  const childMission = useStore((s) => s.missionByPaneGroup[workspaceId]);
  const detachMissionForPaneGroup = useStore((s) => s.detachMissionForPaneGroup);
  const isDependentChild = childMission?.status === 'open';

  // Idle badge — how long since ANY of this workspace's surfaces last showed
  // life: agent activity (surfaceActivityAt, same stamps the fleet 'running'
  // derivation uses) OR raw terminal output (surfaceOutputAt, the throttled
  // useTerminal stamp — covers plain-shell panes that never trip the agent
  // gates). Scalar subscription: re-renders only when the max moves.
  // 0 = no stamp this session (fresh restart) → badge stays hidden rather
  // than lying with a fake "just now".
  const lastActivityAt = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return 0;
    let last = 0;
    // Workspace-wide (#977): if the only thing working in this workspace is a
    // stashed agent, a visible-tree scan reports "idle 2h" while an agent is
    // mid-turn — a badge that is not just missing information but wrong.
    for (const surf of collectWorkspaceTerminalSurfaces(ws)) {
      if (!surf.ptyId) continue;
      const at = Math.max(s.surfaceActivityAt[surf.ptyId] ?? 0, s.surfaceOutputAt[surf.ptyId] ?? 0);
      if (at > last) last = at;
    }
    return last;
  });
  // Local 30 s ticker instead of the store-wide agentClockMs: that clock
  // deliberately stops bumping once every agent decays to idle (rest-state
  // perf), which is exactly when this badge must keep counting. Per-row
  // interval re-renders only this row, and only while the badge can show.
  const [idleNow, setIdleNow] = useState(() => Date.now());
  const idleTicking = lastActivityAt > 0 && agentStatus !== 'running';
  useEffect(() => {
    if (!idleTicking) return;
    setIdleNow(Date.now());
    const id = setInterval(() => setIdleNow(Date.now()), IDLE_TICK_MS);
    return () => clearInterval(id);
  }, [idleTicking, lastActivityAt]);
  const idleMs = idleTicking ? idleNow - lastActivityAt : 0;
  const idleLabel = idleMs >= IDLE_SHOW_AFTER_MS ? formatIdle(idleMs) : null;

  // X1→X3 bridge: a listening-port badge click jumps to the workspace and
  // shows http://localhost:<port> in its browser pane (reusing one if the
  // workspace already has it).
  const handlePortClick = (port: number) => {
    useStore.getState().setActiveWorkspace(workspaceId);
    openUrlInBrowserPane(`http://localhost:${port}`, { workspaceId });
  };

  /**
   * Report a failed open. Main answers `{ ok:false, error }` for a missing or
   * permission-denied folder and for the two paths it refuses to hand to
   * cmd.exe, and the invoke itself rejects when validation fails — an unhandled
   * rejection here would leave the click looking like a silent no-op.
   */
  const reportOpen = (p: Promise<{ ok: boolean; error?: string }>) => {
    p.then((res) => { if (!res?.ok) notifyOpenFailed(t, res?.error); })
      .catch((err) => notifyOpenFailed(t, String(err?.message ?? err)));
  };

  /**
   * Detach this dependent child task from its parent. Non-destructive: the
   * mission is closed with a workspace-detached marker and its channel archived,
   * but this workspace, its worktree/branch/PTY and running agent stay exactly as
   * they are — it simply stops being tracked as a child of the parent.
   */
  const handleDetach = () => {
    setMenuPos(null);
    detachMissionForPaneGroup(workspaceId)
      .then((ok) => {
        useStore.getState().pushToast(
          ok
            ? { level: 'info', message: t('workspace.detachDone') }
            : { level: 'warn', message: t('workspace.detachFailed') },
        );
      })
      .catch(() => {
        useStore.getState().pushToast({ level: 'warn', message: t('workspace.detachFailed') });
      });
  };

  /** Open the workspace's current working directory in the OS file explorer. */
  const handleOpenExplorer = () => {
    if (!metadata?.cwd) return;
    reportOpen(window.electronAPI.shell.openPath(metadata.cwd));
  };

  /** Open cwd with a specific detected app (VS Code, Terminal, etc.). */
  const handleOpenWith = (appId: string) => {
    if (!metadata?.cwd) return;
    setMenuPos(null);
    setOwOpen(false);
    reportOpen(window.electronAPI.shell.openWith(appId, metadata.cwd));
  };

  // Detect available apps when the context menu opens, and clear when closed.
  // `cancelled` drops a probe that lands after the menu closed (or reopened on
  // another row): detectApps spawns one where.exe per candidate, so a slow AV
  // scan can easily outlive the menu and would otherwise repopulate — or
  // cross-populate — the submenu of a menu the user already dismissed.
  useEffect(() => {
    if (!menuPos || !metadata?.cwd) {
      setFolderApps([]);
      setOwOpen(false);
      return;
    }
    let cancelled = false;
    window.electronAPI.shell.detectApps()
      .then((apps) => { if (!cancelled) setFolderApps(apps); })
      .catch(() => { if (!cancelled) setFolderApps([]); });
    return () => { cancelled = true; };
  }, [menuPos, metadata?.cwd]);

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
    if (!workspace || sidebarAttentionFirst) return;
    // Roster controls live inside this draggable card. Chromium chooses the
    // nearest draggable ancestor as the native source, so `draggable={false}`
    // on a nested button is not enough. Reject a drag whose pointer originated
    // over the roster; clicks still handle disclosure and exact agent focus.
    const pointerTarget = document.elementFromPoint(e.clientX, e.clientY);
    if (pointerTarget?.closest('[data-workspace-agent-roster], [data-workspace-fanout]')) {
      e.preventDefault();
      return;
    }
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
    if (sidebarAttentionFirst) return;
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
    if (sidebarAttentionFirst) return;
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
      // The color submenu is hover-driven, so dismissing the menu by an
      // outside click or Escape unmounts the subtree before onMouseLeave can
      // fire. Without this the flag stays true and the picker is already open
      // the next time the menu is summoned. Resetting here covers every close
      // path at once rather than each menu item individually.
      setColorOpen(false);
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
  // Color tag (optional). Undefined → every style below falls back to exactly
  // the pre-feature rendering, so an untagged workspace is pixel-identical.
  const tagColor = workspaceColorHex(workspace.color);

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
      {/* Color tag rail. Sits inside the row's rounded box, so it reads as part
          of the row rather than as a separate divider. When the workspace is
          also in multiview it shifts 2px right, clearing the blue multiview
          border instead of covering it — the two signals mean different things
          and must both stay visible. pointer-events-none so it never eats a
          click or a drag hit-test. */}
      {tagColor && (
        <div
          className="absolute top-[3px] bottom-[3px] w-[3px] rounded-full z-[1] pointer-events-none"
          style={{ left: isMultiview ? 2 : 0, background: tagColor }}
          aria-hidden="true"
        />
      )}

      {/* 드롭 인디케이터 - 위. pointer-events-none so it never participates
          in drag hit-testing (codex P3). */}
      {dropIndicator === 'above' && (
        <div className="absolute top-0 left-0 right-0 h-[3px] bg-[var(--accent-blue)] rounded-full z-10 -translate-y-px pointer-events-none sidebar-row-enter" />
      )}

      <div
        draggable={!sidebarAttentionFirst}
        {...tokenAttrs('bgSurface', 'bg')}
        className={`group sidebar-row px-3 py-1 cursor-pointer rounded-md select-none ${needsYou ? 'sidebar-row-needs' : ''} ${
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
        <div className="flex min-w-0 items-start gap-2">
        {/* Status indicator */}
        {(() => {
          const st = agentStatus !== 'idle' ? AGENT_STATUS_ICON[agentStatus] : null;
          // Red is spent on both "needs you" and "error", so hue alone cannot
          // say which one this row is: an errored agent gets a ✕ in the dot's
          // own footprint instead of a round dot.
          if (st?.shape === 'cross') {
            // The box is sized to the GLYPH (10px), not to the dot it replaces
            // (6px), which the ✕ overflowed. `-mx-0.5` refunds the 4px of extra
            // width so the name column starts where it does on every other row,
            // and `mt-1` puts the taller box's centre on the dot's centre line
            // (6px + 3 − 5). No glow: the cross is told apart by FORM, so the
            // glow channel would only make it read as one more red dot.
            return (
              <span
                className="w-2.5 h-2.5 -mx-0.5 flex items-center justify-center flex-shrink-0 mt-1 text-[10px] font-bold leading-none"
                style={{ color: st.dotVar }}
                role="img"
                aria-label={t(st.labelKey)}
                title={t(st.labelKey)}
              >
                ✕
              </span>
            );
          }
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
                {/* The name truncates in a 240px sidebar and had no tooltip at
                    all, so a clipped name was simply unreadable. It carries the
                    idle minutes too, which is where they go when the roster
                    chip takes their place on the row (#997). */}
                <span
                  className={`font-sans text-[13px] truncate ${unreadCount > 0 ? 'font-semibold' : 'font-medium'} ${idleLabel && !hasRoster ? 'text-[var(--text-sub)]' : ''}`}
                  title={idleLabel ? `${workspace.name} · ${t('workspace.idleTooltip', { time: idleLabel })}` : workspace.name}
                >
                  {workspace.name}
                </span>
                {hasProfile && (
                  <span
                    className="text-[10px] leading-none flex-shrink-0 text-[var(--accent-blue)]"
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
                  // Deliberately NOT raised to 24px: this badge sits INSIDE the
                  // name line, where a 24px box costs 15px of the column #997
                  // fought to keep, and the horizontal refund that would have
                  // paid for it is exactly the overlap this pass removed. The
                  // dialog it opens has a keyboard path already (⌘K → the
                  // project config command), so the badge is not the only way
                  // in. Left for a pass that can restructure the name line.
                  //
                  // Only a TRUSTED badge waits for the pointer. The other two
                  // states are unresolved verdicts the user has to act on —
                  // "needs review" and "denied" are warnings, and a warning
                  // nobody sees until they hover the row is not one.
                  <button
                    type="button"
                    data-workspace-action="project-badge"
                    className={`text-[10px] leading-none flex-shrink-0 font-mono cursor-pointer hover:underline ${projectState.trust === 'trusted' ? restHiddenNameLine : ''}`}
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
                  <span className="bg-[var(--bg-surface)] text-[var(--text-sub)] ring-1 ring-[var(--border-soft)] text-[10px] font-bold min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 flex-shrink-0">
                    {unreadCount}
                  </span>
                )}
                {departedCwd && (
                  <span
                    className="text-[10px] text-[var(--accent-yellow)] flex-shrink-0"
                    title={t('workspace.cwdDeparted', { cwd: departedCwd })}
                  >
                    ⚠ {t('workspace.departed')}
                  </span>
                )}
                {/* #997 — the idle label and the roster chip answer the same
                    question ("is anything happening here?"), and the chip plus
                    the leading status dot answer it better. Showing both cost
                    the NAME half its width at 240px: measured 87.6px → 43.7px,
                    a 22-character workspace truncated to seven. The idle
                    minutes stay one hover away on the row's own tooltip. */}
                {idleLabel && !hasRoster && (
                  <span
                    className="text-[10px] font-mono text-[var(--text-muted)] flex-shrink-0"
                    title={t('workspace.idleTooltip', { time: idleLabel })}
                  >
                    · {idleLabel}
                  </span>
                )}
              </div>
              {metadata && <WorkspaceContextLine metadata={metadata} onPortClick={handlePortClick} />}
            </>
          )}
        </div>

        {/* #997 — roster disclosure + agent count. Lives on this row, not on
            a line of its own: see WorkspaceRosterSummary's own comment. */}
        {!editing && (
          // The wrapper carries the rest-state fade so the summary's own
          // internals stay untouched; it takes over the flex-item traits
          // (self-center, no shrink) the button had as a direct child.
          //
          // Two rows keep it at rest. A workspace whose only entries are
          // stashed panes has nothing else to show it is not empty (see the
          // stash-glyph comment in WorkspaceAgentRoster.tsx), and an expanded
          // roster must keep the control that collapses it reachable.
          <span className={`inline-flex self-center flex-shrink-0 ${rosterAlwaysShown ? '' : restHidden}`}>
            <WorkspaceRosterSummaryMemo
              workspaceId={workspaceId}
              agentCount={rosterCounts.agentCount}
              stashedCount={rosterCounts.stashedCount}
              open={rosterOpen}
              onToggle={toggleRoster}
            />
          </span>
        )}

        {/* The blocked-agent label, right-aligned. It replaces the play/pause
            mark this row used to carry: "running" is already the amber dot, and
            a paused glyph never said what it was paused ON. Words do. */}
        {needsYou && (
          <span className="font-sans text-[10px] font-semibold text-[var(--accent-red)] flex-shrink-0 mt-0.5">
            {t('workspace.needsYou')}
          </span>
        )}

        {/* Shortcut hint */}
        <span className={`text-[10px] font-mono text-[var(--text-muted)] flex-shrink-0 mt-0.5 ${restHidden}`}>
          {index < 9 ? `^${index + 1}` : ''}
        </span>

        {/* Hover actions. Each drew an 11px glyph in a 13px box; each is now a
            real 24x24 target. They sit in a cluster because three 24px boxes do
            not fit in the 57px this row used to give them: the cluster's gap-3
            is exactly what the members' side refunds give back, so consecutive
            boxes TILE instead of overlapping (see hitArea.ts). That matters
            most for the last one — with a symmetric refund and no matching gap,
            close would have owned the right 4px of Copy, and the later sibling
            wins the pointer.

            `pointer-events` follow visibility: the boxes are 24px tall in a
            ~23px row, so at rest they extend a fraction past the row's edge,
            and an invisible control must not take a click meant for the row
            under it. `focus-within` reveals the cluster for the keyboard, which
            could previously focus a button it could not see.

            `max-w-0 overflow-hidden` collapses the cluster at rest for the same
            reason the rest of the chrome collapses (REST_HIDDEN): three 24px
            boxes held ~72px of the name's column to show nothing. The overflow
            comes back on reveal — the members' `-mx-1.5` refunds live outside
            the cluster's content box, and a clipped refund is a smaller target.
            No negative left margin here: hitArea.ts forbids one on a cluster
            (chromeHitArea.test.ts asserts it), so this one item keeps its gap. */}
        <div
          data-workspace-actions
          className={`${HIT_TARGET_24_CLUSTER} flex-shrink-0 opacity-0 pointer-events-none max-w-0 overflow-hidden transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-hover:max-w-none group-hover:overflow-visible focus-within:opacity-100 focus-within:pointer-events-auto focus-within:max-w-none focus-within:overflow-visible`}
        >
          {/* Folder icon — reveals this workspace's cwd in the OS file manager. */}
          <button
            data-workspace-action="explorer"
            className={`${HIT_TARGET_24_IN_CLUSTER} text-[var(--text-subtle)] hover:text-[var(--accent-blue)] text-[10px] font-mono`}
            onClick={(e) => { e.stopPropagation(); handleOpenExplorer(); }}
            title={t('workspace.openInExplorer', { app: fileManagerName(t) })}
            aria-label={t('workspace.openInExplorer', { app: fileManagerName(t) })}
          >
            <IconFolder size={11} />
          </button>

          {/* Copy session info button */}
          <button
            data-workspace-action="copy-info"
            className={`${HIT_TARGET_24_IN_CLUSTER} text-[var(--text-subtle)] hover:text-[var(--accent-blue)] text-[10px] font-mono`}
            onClick={(e) => { e.stopPropagation(); onCopyInfo(workspaceId); }}
            title={t('workspace.copyInfo')}
            aria-label={t('workspace.copyInfo')}
          >
            <IconCopy size={11} />
          </button>

          {/* Close button — asks for confirmation first (anti-misclick). Last in
              the cluster, at the sidebar's edge: a pointer overshooting the row
              to the right leaves the cluster entirely instead of landing on the
              one control here that kills a workspace. */}
          <button
            data-workspace-action="close"
            className={`${HIT_TARGET_24_IN_CLUSTER} text-[var(--text-subtle)] hover:text-[var(--accent-red)] text-[10px] font-mono`}
            onClick={(e) => { e.stopPropagation(); setMenuPos(null); setCloseConfirmPos({ x: e.clientX, y: e.clientY }); }}
            title={t('workspace.close')}
            aria-label={t('workspace.close')}
          >
            <IconX size={11} />
          </button>
        </div>
        </div>
        {/* Mounted only when expanded: a collapsed list would subscribe to the
            whole roster projection to render nothing. */}
        {!editing && rosterOpen && (
          <WorkspaceAgentRoster workspaceId={workspaceId} pulsingPaneId={pulsingPaneId} />
        )}
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
          {/* Color tag — hover to reveal the swatch row. A single row of eight
              swatches plus "None" keeps the whole picker one click deep; a
              modal would be heavier than the decision it holds. */}
          <div
            className="relative"
            onMouseEnter={() => setColorOpen(true)}
            onMouseLeave={() => setColorOpen(false)}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
              style={{ color: 'var(--text-main)' }}
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{
                  background: tagColor ?? 'transparent',
                  border: tagColor ? 'none' : '1px solid var(--text-muted)',
                }}
              />
              <span>{t('workspace.colorTag')}</span>
              <span className="text-[var(--text-muted)] ml-auto"><IconChevron /></span>
            </button>
            {colorOpen && (
              <div
                className={`absolute top-0 ${menuPos.x > window.innerWidth * 0.6 ? 'right-full mr-0.5' : 'left-full ml-0.5'} py-1.5 px-2 rounded-[7px] shadow-xl sidebar-popover-enter`}
                style={{ background: 'var(--bg-surface)', border: '1px solid color-mix(in srgb, var(--bg-overlay) 70%, transparent)' }}
              >
                {/* Wraps at 8 per row: with 15 ids + the "none" swatch a single
                    row would run to ~320px and could overflow the sidebar's
                    edge (the ternary above already flips the popover to
                    open leftward near the right edge, but there is no
                    equivalent flip for width). Two rows of 8 stays inside the
                    same footprint the original eight used. */}
                <div className="flex flex-wrap items-center gap-1 w-[164px]">
                  {WORKSPACE_COLOR_IDS.map((id) => {
                    const selected = workspace.color === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-label={t(workspaceColorLabelKey(id))}
                        aria-pressed={selected}
                        title={t(workspaceColorLabelKey(id))}
                        className="w-4 h-4 rounded-full transition-transform hover:scale-110"
                        style={{
                          background: WORKSPACE_COLOR_HEX[id],
                          // Selection is a ring, not a checkmark: a glyph on a
                          // 16px swatch is unreadable and would tint the color
                          // the user is trying to judge.
                          boxShadow: selected ? '0 0 0 2px var(--bg-surface), 0 0 0 3px var(--text-main)' : 'none',
                        }}
                        onClick={() => { setMenuPos(null); setColorOpen(false); setWorkspaceColor(workspaceId, id); }}
                      />
                    );
                  })}
                  <button
                    type="button"
                    aria-label={t('workspace.colorNone')}
                    aria-pressed={!workspace.color}
                    title={t('workspace.colorNone')}
                    className="w-4 h-4 rounded-full text-[10px] leading-none flex items-center justify-center transition-transform hover:scale-110"
                    style={{
                      border: '1px solid var(--text-muted)',
                      color: 'var(--text-muted)',
                      boxShadow: !workspace.color ? '0 0 0 2px var(--bg-surface), 0 0 0 3px var(--text-main)' : 'none',
                    }}
                    onClick={() => { setMenuPos(null); setColorOpen(false); setWorkspaceColor(workspaceId, undefined); }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* Open with — hover to reveal detected folder-opening apps (Explorer,
              VS Code, Terminal, etc.). Closes on click so focus returns to sidebar. */}
          <div
            className="relative"
            onMouseEnter={() => setOwOpen(true)}
            onMouseLeave={() => setOwOpen(false)}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
              style={{ color: 'var(--text-main)' }}
            >
              <span>{t('workspace.openInExplorerCtx')}</span>
              <span className="text-[var(--text-muted)]"><IconChevron /></span>
            </button>
            {owOpen && folderApps.length > 0 && (
              <div
                className={`absolute top-0 ${menuPos.x > window.innerWidth * 0.6 ? 'right-full mr-0.5' : 'left-full ml-0.5'} min-w-[180px] py-1 rounded-[7px] shadow-xl sidebar-popover-enter`}
                style={{ background: 'var(--bg-surface)', border: '1px solid color-mix(in srgb, var(--bg-overlay) 70%, transparent)' }}
              >
                {folderApps.map((app) => {
                  const Icon = app.id === 'explorer' ? IconFolder
                    : TERMINAL_APP_IDS.has(app.id) ? IconTerminal
                    : IconExternalLink;
                  return (
                    <button
                      key={app.id}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
                      style={{ color: 'var(--text-main)' }}
                      onClick={() => handleOpenWith(app.id)}
                    >
                      <span className="opacity-60"><Icon size={12} /></span>
                      <span>{folderAppLabel(t, app)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Multi-account (M1): per-vendor account bind submenu. Hides itself
              when no accounts are registered. Bind-only (new terminals). */}
          <WorkspaceAccountMenu workspaceId={workspaceId} flipLeft={menuPos.x > window.innerWidth * 0.6} />
          <WorkspaceChromeProfileMenu workspaceId={workspaceId} flipLeft={menuPos.x > window.innerWidth * 0.6} />

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
                    // Display-only NFC (macOS NFD jamo) — copy/spawn keep s.cwd raw.
                    const path = displayPath(s.cwd) || '—';
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

          {/* Detach from parent — only for a dependent child task workspace.
              Releases the mission (non-destructive) without touching this
              workspace, its worktree/branch/PTY, or the running agent. */}
          {isDependentChild && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)] border-t border-[color-mix(in_srgb,var(--bg-overlay)_60%,transparent)] mt-1 pt-2"
              style={{ color: 'var(--text-main)' }}
              onClick={handleDetach}
              title={t('workspace.detachHint')}
            >
              {t('workspace.detach')}
            </button>
          )}
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
            // Workspace-wide (#977): closing the workspace disposes stashed
            // PTYs too, so a visible-only count promises to close fewer panes
            // than it actually kills.
            const count = collectWorkspaceTerminalSurfaces(workspace).length;
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
