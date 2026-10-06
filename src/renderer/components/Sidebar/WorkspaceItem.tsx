// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/app/shell/Sidebar.tsx), MIT License, Copyright (c) 2026 Nick
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo } from 'react';
import type { GitSyncStatus, PrStatus, WorkspaceMetadata } from '../../../shared/types';
import { useStore } from '../../stores';
import { selectWorkspaceById } from '../../stores/selectors/workspaceProjections';
import { formatStaleMinutes, selectWorkspaceAgentStatus, selectWorkspaceUnverifiableMinutes } from '../../stores/selectors/fleet';
import { createWorkspaceRosterChipSelector } from '../../stores/selectors/workspaceAgentRoster';
import { useT } from '../../hooks/useT';
import type { TranslationKey } from '../../i18n/locales/en';
import { AGENT_STATUS_ICON } from './agentStatusIcon';
import { StatusMarkView } from './AgentMarks';
import { selectSidebarUnseenWorkspaces, visibleWorkspaceIds } from '../../stores/selectors/sidebarSeen';
import { attentionPulseClass } from './attentionBlink';
import { usePrefersReducedMotion } from '../ui/MediaPreview';
import { workspaceHasUsageLimitWaiting } from '../../stores/slices/usageLimitSlice';
import { selectWorkspaceAttentionClasses } from '../../stores/selectors/fleet';
import { IconCopy, IconX, IconGear, IconChevron, IconBell, IconFolder, IconTerminal, IconExternalLink, IconCheck, IconGitBranch, IconWorktree, IconWarning, IconFanOut, IconPin } from '../icons';
import { tokenAttrs } from '../../themes';
import { HIT_TARGET_24_CLUSTER, HIT_TARGET_24_IN_CLUSTER } from '../hitArea';
import { buildWorkspaceMarkdown } from '../../utils/sessionInfoMarkdown';
import { collectTerminalSurfaces, collectWorkspaceTerminalSurfaces } from '../../utils/paneTraversal';
import { openUrlInBrowserPane } from '../../utils/browserPaneActions';
import WorkspaceProfileModal from './WorkspaceProfileModal';
import Popover from '../ui/Popover';
import Button from '../ui/Button';
import { placePopover } from '../AgentToolbar/placePopover';
import WorkspaceAccountMenu from './WorkspaceAccountMenu';
import WorkspaceChromeProfileMenu from './WorkspaceChromeProfileMenu';
import WorkspaceAgentRoster, { WorkspaceRosterSummaryMemo, STASH_PULSE_MS } from './WorkspaceAgentRoster';
import { displayPath } from '../../utils/displayPath';
import { formatIdle, IDLE_SHOW_AFTER_MS, IDLE_TICK_MS } from '../../utils/idleTime';
import { timeAgo } from '../../utils/timeAgo';
import { displayWorkspaceName, provenanceTooltip, requesterName, resolveTaskRequester } from '../../utils/fanoutProvenance';
import { useShallow } from 'zustand/react/shallow';
import { usePaneTaskSplit } from './SidebarTaskGroup';
import { taskNeedsYou } from './sidebarTree';
import { WORKSPACE_COLOR_IDS, WORKSPACE_COLOR_HEX, workspaceColorHex, workspaceColorLabelKey } from '../../../shared/workspaceColors';
import { WORKSPACE_SNOOZE_PRESETS, workspaceSnoozeUntil } from '../../../shared/workspaceSettle';
import { sendWorkspaceSettleCommand } from '../../hooks/useWorkspaceSettleBridge';
import { isOurHandoffDrag, takeHandoffDrop } from '../Git/handoffDrag';
import { sanitizeDisplayText } from '../../../shared/phoneText';

interface WorkspaceItemProps {
  /** A1: 부모(Sidebar)는 id만 내리고, 이 컴포넌트가 자기 ws를 self-subscribe해
   *  자기 ws 변경에만 리렌더된다. 콜백은 모두 id 인자를 받아 부모에서 안정적으로
   *  한 번만 생성될 수 있게 한다(React.memo가 실효하도록). */
  workspaceId: string;
  isActive: boolean;
  isMultiview: boolean;
  index: number;
  /** Position in the list the operator sees (Moa's HQ left out), which is
   *  what Ctrl+N counts. Defaults to `index`. */
  shortcutIndex?: number;
  onSelect: (id: string) => void;
  onCtrlSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onClose: (id: string) => void;
  /** #1011 — snapshot-and-close: same teardown as Close, configuration survives. */
  onArchive: (id: string) => void;
  onCopyInfo: (id: string) => void;
  onDuplicate: (id: string) => void;
  /** `pin` is this (target) row's pin state: a drop beside it takes it on. */
  onReorder: (fromIndex: number, toIndex: number, pin?: boolean) => void;
  /**
   * #1481 — this row is a fan-out task rendered under its owner (or in the
   * closed-owner group): shown without the `wtask: ` prefix, marked with the
   * fan-out glyph + provenance tooltip, and not a reorder source or target —
   * the drop math assumes flat siblings, and a task's place is its owner's.
   */
  taskRow?: boolean;
  /**
   * The row sits in the sidebar's Snoozed or Settled group, out of stored
   * order, so a Ctrl+N hint would be out of sequence: none is drawn. The
   * shortcut itself still follows the stored order.
   */
  shortcutHintHidden?: boolean;
  /**
   * 2026-09-27 — this workspace's fan-out tasks (owner rows only). Each one
   * nests under the roster row of the pane that requested it; the rest are
   * Sidebar's "From closed pane" group. Undefined for a row with no tasks,
   * so memo still holds for the common row.
   */
  nestedTaskIds?: readonly string[];
  /** Renders one nested task row. */
  renderTask?: (id: string) => React.ReactNode;
  /** Sidebar's workspace close, for a pane group's "Close finished tasks". */
  onCloseTask?: (id: string) => void;
  /** Moa's app-owned HQ workspace: Close and Archive are shown but disabled
   *  (with the reason), and it is not a reorder or pin target. */
  moaHq?: boolean;
  /** This row is the list's one Tab stop (roving tabindex, Sidebar owns it);
   *  every other row is reached with the arrow keys. */
  tabStop?: boolean;
}

/** Longest question the row keeps (it truncates on screen; the full text is
 *  in the tooltip and Fleet's detail). */
const ROW_QUESTION_MAX = 240;

/**
 * X1 — PR badge for the current branch. Color encodes state; the trailing
 * dot encodes CI checks. Clicking opens the PR in the default browser.
 */
export function PrBadge({ pr }: { pr: PrStatus }): React.ReactElement {
  const t = useT();
  const stateColor =
    pr.state === 'open' ? 'var(--accent-green)'
    : pr.state === 'merged' ? 'var(--accent-blue)'
    : pr.state === 'closed' ? 'var(--accent-red)'
    : 'var(--text-muted)'; // draft
  // #1481 — monochrome SVG marks, not text glyphs that can render as emoji.
  const checksGlyph =
    pr.checks === 'passing' ? <IconCheck size={9} />
    : pr.checks === 'failing' ? <IconX size={9} />
    : pr.checks === 'pending' ? <svg width="5" height="5" viewBox="0 0 5 5" aria-hidden="true"><circle cx="2.5" cy="2.5" r="2.5" fill="currentColor" /></svg>
    : null;
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
      {checksGlyph && <span className="inline-flex" style={{ color: checksColor }}>{checksGlyph}</span>}
    </span>
  );
}

/**
 * Git 신호등(owner 2026-07-20) — 워크스페이스 이름 아래 전용 행에서 색으로
 * 상태를 즉독: clean=green ●, dirty=muted ·N, ahead=blue ↑N, behind=red ↓N.
 * 브랜치가 잡힌 워크스페이스는 항상 최소 1개의 불이 켜진다(clean이면 green).
 * 숫자는 항상 동반(맨 화살표는 모호 — GitHub Desktop #9282).
 */
export function GitSyncBadge({ sync, compact = false }: { sync: GitSyncStatus; compact?: boolean }): React.ReactElement | null {
  const t = useT();
  const ahead = sync.hasUpstream ? sync.ahead : 0;
  const behind = sync.hasUpstream ? sync.behind : 0;
  const clean = ahead === 0 && behind === 0 && sync.dirty === 0;
  return (
    <span
      className="flex items-center gap-1.5 flex-shrink-0 font-mono"
      title={`${t('workspace.gitSyncTooltip', { ahead, behind, dirty: sync.dirty })}${compact && ((sync.added ?? 0) + (sync.removed ?? 0)) > 0 ? ` · +${sync.added ?? 0} −${sync.removed ?? 0}` : ''}`}
      data-git-signal
    >
      {clean && <span className="inline-flex" data-git-clean style={{ color: 'var(--accent-green)' }}><svg width="6" height="6" viewBox="0 0 6 6" aria-hidden="true"><circle cx="3" cy="3" r="3" fill="currentColor" /></svg></span>}
      {/* Uncommitted files are information, not attention: amber is reserved for "needs you". */}
      {/* Line counts vs HEAD, coloured like a diff. Adapted from MonoCode
          (hardbeat920/monocode@6bd432ca, src/app/shell/Sidebar.tsx), MIT
          License, Copyright (c) 2026 Nick. The changed-path count stays the
          fallback when the line counts could not be read, or read none (only
          untracked files changed). */}
      {!compact && (sync.added ?? 0) > 0 && <span data-git-diff="added" style={{ color: 'var(--accent-green)' }}>+{sync.added}</span>}
      {!compact && (sync.removed ?? 0) > 0 && <span data-git-diff="removed" style={{ color: 'var(--accent-red)' }}>−{sync.removed}</span>}
      {sync.dirty > 0 && (compact || (sync.added ?? 0) + (sync.removed ?? 0) === 0) && <span style={{ color: 'var(--text-subtle)' }}>·{sync.dirty}</span>}
      {ahead > 0 && <span style={{ color: 'var(--accent-blue)' }}>↑{ahead}</span>}
      {behind > 0 && <span style={{ color: 'var(--accent-red)' }}>↓{behind}</span>}
    </span>
  );
}

/** The branch keeps at least this much of the git line (icon + ~5 chars). */
export const GIT_LINE_BRANCH_MIN_PX = 56;

/**
 * How much of the git line gives way so the branch name stays readable at
 * narrow widths: 0 shows everything, 1 drops the +/− line counts (they stay
 * in the tooltip), 2 drops the sync badge too. The PR badge always stays.
 * Steps one tier per measure while the branch is squeezed below its floor.
 */
export function nextGitLineTier(tier: number, branch: { clientWidth: number; scrollWidth: number }): number {
  const squeezed = branch.clientWidth < Math.min(branch.scrollWidth, GIT_LINE_BRANCH_MIN_PX);
  return squeezed ? Math.min(tier + 1, 2) : tier;
}

/** The tier for the git line's current width, re-measured on every resize. */
function useGitLineTier(deps: readonly unknown[]) {
  const lineRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLSpanElement>(null);
  const [tier, setTier] = useState(0);
  const steppedAt = useRef(0);
  const measure = useCallback(() => {
    const line = lineRef.current;
    const branch = branchRef.current;
    if (!line || !branch) return;
    // Wider than where the last step happened: start over and measure again.
    if (line.clientWidth > steppedAt.current + 1 && steppedAt.current > 0) {
      steppedAt.current = 0;
      setTier(0);
      return;
    }
    setTier((current) => {
      const next = nextGitLineTier(current, branch);
      if (next !== current) steppedAt.current = line.clientWidth;
      return next;
    });
  }, []);
  useLayoutEffect(measure, [measure, tier, ...deps]);
  useEffect(() => {
    const line = lineRef.current;
    if (!line || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(line);
    return () => ro.disconnect();
  }, [measure]);
  return { lineRef, branchRef, tier };
}

/**
 * X1 — one-line live context under the workspace name: git branch
 * (worktree-aware), PR badge, PID-tree-scoped listening ports, and the
 * latest terminal notification. Renders nothing until metadata arrives —
 * zero-config, no reserved blank space.
 */
function WorkspaceContextLine({ metadata, onPortClick, actions, metaHiddenOnHover, question, innerTab }: {
  metadata: WorkspaceMetadata;
  /** A needs-you row's question: it takes the git line's place, with the
   *  row's actions at its end. */
  question?: string;
  /** Tab order of the line's own buttons: reachable only once the row has
   *  keyboard focus (roving tabindex). */
  innerTab?: number;
  /** X3 — open http://localhost:<port> in this workspace's browser pane. */
  onPortClick: (port: number) => void;
  /** The row's hover actions, at the end of the git line. */
  actions?: React.ReactNode;
  /** Hides the diff counts and the PR badge while the row is hovered or
   *  focused, so the actions take their place instead of the branch's width. */
  metaHiddenOnHover?: string;
}): React.ReactElement | null {
  const t = useT();
  const { lineRef, branchRef, tier } = useGitLineTier([metadata.gitBranch, metadata.gitSync, metadata.pr, question]);
  const ports = metadata.listeningPorts ?? [];
  const hasContext = ports.length > 0;
  const note = metadata.lastNotificationText;
  if (!question && !metadata.gitBranch && !hasContext && !note) return null;
  return (
    <>
      {question && (
        <div className="flex items-center gap-2 mt-1 min-w-0" data-row-question data-git-signal-line>
          <span className="min-w-0 flex-1 truncate font-sans" title={question}>{question}</span>
          {actions}
        </div>
      )}
      {/* Git 신호등 행 — 이름 바로 아래 전용 줄(owner 2026-07-20: 행이 위아래로
          두꺼워져도 OK). 브랜치·신호등·PR을 한 줄에, 포트·알림은 다음 줄로. */}
      {!question && metadata.gitBranch && (
        <div ref={lineRef} className="flex items-center gap-2 mt-1 text-[11px] leading-4 tabular-nums text-[color-mix(in_srgb,var(--text-main)_45%,transparent)] min-w-0" data-git-signal-line data-git-line-tier={tier || undefined}>
          <span
            ref={branchRef}
            className="min-w-0 truncate"
            title={`${t('workspace.gitBranch')}: ${metadata.gitBranch}${metadata.gitIsWorktree ? ` (${t('workspace.gitWorktree')})` : ''}`}
          >
            {/* #1481 — branch and worktree marks are SVG icons, not ⎇ / ⊕. */}
            <span className="mr-1 inline-flex align-[-2px]" aria-hidden="true"><IconGitBranch size={12} /></span>
            {metadata.gitBranch}
            {metadata.gitIsWorktree ? <span className="ml-1 inline-flex align-[-1px]" aria-hidden="true"><IconWorktree size={10} /></span> : null}
          </span>
          {metadata.gitSync && tier < 2 && (
            actions
              ? <span className={`flex flex-shrink-0 ${metaHiddenOnHover ?? ''}`}><GitSyncBadge sync={metadata.gitSync} compact={tier >= 1} /></span>
              : <GitSyncBadge sync={metadata.gitSync} compact={tier >= 1} />
          )}
          {metadata.pr && (
            actions
              ? <span className={`flex flex-shrink-0 ${metaHiddenOnHover ?? ''}`}><PrBadge pr={metadata.pr} /></span>
              : <PrBadge pr={metadata.pr} />
          )}
          {actions}
        </div>
      )}
      {hasContext && (
        <div className="flex items-center gap-1.5 mt-0.5 text-[11px] font-mono text-[color-mix(in_srgb,var(--text-main)_45%,transparent)] min-w-0">
          {ports.length > 0 && (
            <span className="flex items-center gap-1 flex-shrink-0">
              {ports.slice(0, 3).map((p) => (
                <button
                  key={p}
                  type="button"
                  tabIndex={innerTab}
                  className="cursor-pointer hover:text-[var(--text-main)] hover:underline"
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
          className="mt-0.5 flex items-center gap-1 text-[11px] text-[color-mix(in_srgb,var(--text-main)_45%,transparent)] truncate"
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

/**
 * 2026-09-27 — a task row renders INSIDE its owner's row (under the pane that
 * requested it). Tailwind's `group-hover` matches any `.group` ancestor, so
 * with the plain names hovering the owner row would reveal every nested
 * task's chrome. Task rows use their own group name. Literal strings, so
 * Tailwind's scanner sees every class.
 */
const TASK_REST_HIDDEN =
  'opacity-0 pointer-events-none max-w-0 overflow-hidden transition-opacity duration-150'
  + ' group-hover/task:opacity-100 group-hover/task:pointer-events-auto group-hover/task:max-w-none group-hover/task:overflow-visible'
  + ' group-focus-within/task:opacity-100 group-focus-within/task:pointer-events-auto group-focus-within/task:max-w-none group-focus-within/task:overflow-visible';
const TASK_REST_HIDDEN_GAP_ROW = '-ml-2 group-hover/task:ml-0 group-focus-within/task:ml-0';
const TASK_REST_HIDDEN_GAP_NAME_LINE = '-ml-1 group-hover/task:ml-0 group-focus-within/task:ml-0';

/** The hover-revealed recipes for an owner row or a nested task row. */
function hoverRecipes(taskRow: boolean) {
  return taskRow
    ? {
      group: 'group/task',
      restHidden: TASK_REST_HIDDEN,
      gapRow: TASK_REST_HIDDEN_GAP_ROW,
      gapNameLine: TASK_REST_HIDDEN_GAP_NAME_LINE,
      hideOnHover: 'group-hover/task:hidden group-focus-within/task:hidden',
      cluster: 'group-hover/task:opacity-100 group-hover/task:pointer-events-auto group-focus-within/task:opacity-100 group-focus-within/task:pointer-events-auto',
      clusterSlot: 'group-hover/task:max-w-none group-hover/task:overflow-visible group-hover/task:ml-auto group-hover/task:pl-0.5 group-focus-within/task:max-w-none group-focus-within/task:overflow-visible group-focus-within/task:ml-auto group-focus-within/task:pl-0.5',
    }
    : {
      group: 'group',
      restHidden: REST_HIDDEN,
      gapRow: REST_HIDDEN_GAP_ROW,
      gapNameLine: REST_HIDDEN_GAP_NAME_LINE,
      hideOnHover: 'group-hover:hidden group-focus-within:hidden',
      cluster: 'group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
      clusterSlot: 'group-hover:max-w-none group-hover:overflow-visible group-hover:ml-auto group-hover:pl-0.5 group-focus-within:max-w-none group-focus-within:overflow-visible group-focus-within:ml-auto group-focus-within:pl-0.5',
    };
}

function shortenPath(path: string, maxLen = 25): string {
  if (!path || path.length <= maxLen) return path;
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join('/')}`;
}

function WorkspaceItem({ workspaceId, isActive, isMultiview, index, shortcutIndex = index, onSelect, onCtrlSelect, onRename, onClose, onArchive, onCopyInfo, onDuplicate, onReorder, taskRow = false, shortcutHintHidden = false, nestedTaskIds, renderTask, onCloseTask, moaHq = false, tabStop = false }: WorkspaceItemProps) {
  const t = useT();
  // A1: 자기 ws만 구독 — 배경 ws churn/다른 항목 변경에는 리렌더되지 않는다.
  const workspace = useStore(selectWorkspaceById(workspaceId));
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(workspace?.name ?? '');
  const [dropIndicator, setDropIndicator] = useState<'above' | 'below' | null>(null);
  // An issue / PR from the Git page is held over this row.
  const [handoffOver, setHandoffOver] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [wdOpen, setWdOpen] = useState(false);
  const [owOpen, setOwOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  // Keyboard path into the Snooze submenu: focus its first preset once it
  // mounts, and do not reopen it when Escape hands focus back to the trigger.
  const snoozeTriggerRef = useRef<HTMLButtonElement>(null);
  const snoozeFocusFirst = useRef(false);
  const snoozeSkipFocusOpen = useRef(false);
  const [folderApps, setFolderApps] = useState<{ id: string; name: string }[]>([]);
  const [closeConfirmPos, setCloseConfirmPos] = useState<CloseConfirmAnchor | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragStartTimeRef = useRef<number>(0);

  const unreadCount = useStore((s) =>
    s.notifications.filter((n) => !n.read && n.workspaceId === workspaceId).length,
  );
  // Sidebar reorder source index lives in the store, not in dataTransfer.
  // See uiSlice.draggedWorkspaceIndex for why this is out-of-band.
  const setWorkspaceColor = useStore((s) => s.setWorkspaceColor);
  // Browser mirror (wmux web /app): no rename, reorder, context menu or row actions.
  const readOnly = useStore((s) => s.readOnly);
  const setDraggedWorkspaceIndex = useStore((s) => s.setDraggedWorkspaceIndex);
  // Needs-you-first ordering is display-only, so a drop judged against the
  // DISPLAY order would move the row to a different ARRAY index than the
  // indicator promised. Reorder is paused while it is on; Ctrl+N and the
  // stored order are untouched.
  // #1481 — any non-manual order ('attention' or 'recent') is display-only in
  // the same way, so reorder pauses for both; task rows never reorder.
  // Pinned to top (2026-09-26): the pinned group shows in stored order in
  // every mode, so inside it display and array positions agree and a pinned
  // row can reorder among the other pinned rows even while the rest is sorted.
  const sortMode = useStore((s) => s.sidebarSortMode);
  const sortPaused = sortMode !== 'manual';
  const pinned = useStore((s) => s.sidebarPinnedIds.includes(workspaceId));
  const reorderOff = taskRow || moaHq || (sortPaused && !pinned);
  const setTerminalTextDropDragActive = useStore((s) => s.setTerminalTextDropDragActive);

  const metadata = workspace?.metadata;

  // Sidebar dot source (agent-status-dot fix): the WHOLE workspace's most-urgent
  // agent status, rolled up over every pane's every surface — the same
  // derivation the deck Fleet roster + titlebar vitals use. Reading
  // `metadata.agentStatus` directly only ever saw the active pane and never
  // self-healed. Scalar return → Object.is subscription re-renders only on change.
  const agentStatus = useStore((s) => selectWorkspaceAgentStatus(s, workspaceId));
  // Minutes of silence when this workspace is 'running' but nothing has
  // reported in for the hook-authority window — 0 otherwise. Whole minutes so
  // the scalar subscription settles between ticks instead of re-rendering the
  // row every 2 s for a label that only moves once a minute.
  const unverifiableMinutes = useStore((s) => selectWorkspaceUnverifiableMinutes(s, workspaceId));
  // An agent that is blocked on the user is the one row state the design
  // system lets us paint (DESIGN.md: the only permitted wash is the danger
  // needs-input row). Two renditions and no more — the wash and the label.
  // One rule with Fleet and the Attention order (fleetAttentionClass): a
  // plain `waiting` with no pending question is idle there, so it must not
  // paint a "Needs you" row that sorts to the bottom.
  const attentionClass = useStore((s) => selectWorkspaceAttentionClasses(s)[workspaceId] ?? 'idle');
  const needsYou = attentionClass === 'needsYou' && (agentStatus === 'waiting' || agentStatus === 'awaiting_input');
  const markStatus = agentStatus === 'waiting' && attentionClass !== 'needsYou' ? 'idle' : agentStatus;
  // A failed turn is its own tier (fleetAttentionClass): it says "Error" where
  // a needs-you row says "Needs you", and sorts above finished and idle rows
  // however old it is. Fleet still lists it under Needs you.
  const errored = attentionClass === 'error';
  // A needs-you row's second line is what the agent asked — the reason the row
  // is waiting — instead of the branch. Plain text, one line.
  const rawQuestion = useStore((s) => {
    if (!needsYou) return '';
    const ws = s.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return '';
    for (const surf of collectWorkspaceTerminalSurfaces(ws)) {
      const q = surf.ptyId ? s.surfacePendingQuestion?.[surf.ptyId]?.trim() : undefined;
      if (q) return q;
    }
    return '';
  });
  const question = needsYou ? sanitizeDisplayText(rawQuestion, ROW_QUESTION_MAX) : undefined;
  // Roving tabindex: the row's own buttons join the Tab order only while the
  // keyboard is on this row, so Tab walks rows' actions one row at a time
  // instead of every hidden button in the list.
  const [rowFocusWithin, setRowFocusWithin] = useState(false);
  const innerTab = rowFocusWithin || moaHq ? 0 : -1;
  // A pane here is waiting out a usage limit: when nothing louder is going on
  // the workspace row draws the waiting clock instead of nothing (or a red ✕).
  const usageWaiting = useStore((s) => workspaceHasUsageLimitWaiting(s, workspaceId));
  // Glance board (2026-09-25): something here changed since it was last in
  // view, and it wants a look. Fleet's changed-dot rule: --text-main, never amber.
  const unseen = useStore((s) => !!selectSidebarUnseenWorkspaces(s)[workspaceId]);
  // 2026-10-07 — a turn that finished with no question draws no needs-you
  // border; the unseen dot is its "done" dot, cleared when the workspace is
  // viewed. A turn that ended on a question is needs you, not done.
  const done = unseen && attentionClass === 'finished';
  // Attention blink: a CSS class picked from state (attentionBlink.ts). Never
  // on a row whose workspace is on screen, never under reduced motion.
  const blinkMode = useStore((s) => s.attentionBlink);
  const blinkRemindMs = useStore((s) => s.attentionBlinkRemindMs);
  const blinkFinished = useStore((s) => s.attentionBlinkFinished);
  const onScreen = useStore((s) => visibleWorkspaceIds(s).has(workspaceId));
  const reducedMotion = usePrefersReducedMotion();
  const visible = isActive || onScreen;
  // Whether this wait has already been on screen: "once" is then spent and
  // "remind" waits a full interval. Reset when the wait ends (render-time
  // derived state, no effect).
  const [seenThisWait, setSeenThisWait] = useState(false);
  if (needsYou && visible && !seenThisWait) setSeenThisWait(true);
  if (!needsYou && seenThisWait) setSeenThisWait(false);
  // A nested task row draws no box of its own, so it does not pulse either.
  const pulseClass = taskRow ? '' : attentionPulseClass({
    needsYou, done, visible, reducedMotion, seenThisWait,
    mode: blinkMode, remindMs: blinkRemindMs, finished: blinkFinished,
  });
  const toggleSidebarPin = useStore((s) => s.toggleSidebarPin);
  // Settle / snooze (main owns both; the menu only sends the verbs). Scalars,
  // so a push about another workspace does not re-render this row.
  const workspaceSettled = useStore((s) => !!s.workspaceSettle.states[workspaceId]?.settled);
  const snoozedUntil = useStore((s) => s.workspaceSettle.states[workspaceId]?.snoozedUntil ?? 0);
  // Main refuses to settle these (rules (b)/(c)); the item says so up front.
  const settleBlocked = pinned || needsYou || agentStatus === 'running' || agentStatus === 'awaiting_input';
  // The HQ workspace never settles or snoozes (rule (d)).
  const isHq = useStore((s) => s.workspaceSettle.hqWorkspaceId === workspaceId);
  // Name first. At rest the row shows the workspace name and the signals that
  // change on their own (status dot, unread, idle, "needs you"); the project
  // badge, the agent count and the shortcut hint are chrome you only look for
  // once you are already pointing at the row, and at 240px they were spending
  // the name's width to sit there. The ACTIVE row keeps them — it is the one
  // row you are working in. See REST_HIDDEN for why hiding is not enough on its
  // own: at rest the chrome must also give its WIDTH back to the name.
  const hover = hoverRecipes(taskRow);
  const restHidden = isActive ? '' : `${hover.restHidden} ${hover.gapRow}`;
  /** The same, for chrome that sits inside the `gap-1` name line. */
  const restHiddenNameLine = isActive ? '' : `${hover.restHidden} ${hover.gapNameLine}`;
  // #997 — the roster's expanded state. It lives here, not in the roster,
  // because the control that toggles it now sits on THIS row while the list it
  // reveals is rendered below; the two would otherwise need to agree across a
  // sibling boundary. The list keeps its own store subscription, so roster
  // churn still does not rerender this component.
  const [rosterOpen, setRosterOpen] = useState(isActive);
  const toggleRoster = useCallback(() => setRosterOpen((value) => !value), []);
  // 2026-09-27 — fan-out tasks nest under the roster row of the pane that
  // requested them, so folding the roster folds them too. Two things must not
  // hide there: the task you are working in (entering it makes this row
  // inactive, which would fold the roster under you), and a task that needs
  // you (it re-opens the roster, the way a stash pulse does — again for each
  // further task that starts needing you). If the user folds it anyway, the
  // folded chip counts them in amber.
  const paneTaskSplit = usePaneTaskSplit(workspaceId, renderTask ? nestedTaskIds : undefined);
  const paneTaskIds = useMemo(() => [...paneTaskSplit.byPane.values()].flat(), [paneTaskSplit]);
  const paneTaskActive = useStore((s) => !!s.activeWorkspaceId && paneTaskIds.includes(s.activeWorkspaceId));
  const paneTaskNeedYou = useStore((s) => paneTaskIds.reduce((n, id) => n + (taskNeedsYou(selectWorkspaceAgentStatus(s, id)) ? 1 : 0), 0));
  const prevNeedYouRef = useRef(paneTaskNeedYou);
  useEffect(() => {
    if (paneTaskNeedYou > prevNeedYouRef.current) setRosterOpen(true);
    prevNeedYouRef.current = paneTaskNeedYou;
  }, [paneTaskNeedYou]);
  // Renaming keeps the nested tasks in view: the rename must not hide them.
  const rosterShown = rosterOpen || paneTaskActive || (editing && paneTaskIds.length > 0);
  // Counts only — a reference-stable projection of two integers, so this does
  // not rerender the row on terminal output the way the full roster would.
  // #1481 — the chip projection: counts plus up to three agents for the
  // collapsed summary. Reference-stable; it changes only when a drawn glyph,
  // its status or a count does, never on output.
  const rosterChipSelector = useMemo(
    () => createWorkspaceRosterChipSelector(workspaceId),
    [workspaceId],
  );
  const rosterCounts = useStore(rosterChipSelector);
  const hasRoster = rosterCounts.agentCount > 0 || rosterCounts.stashedCount > 0;
  /** Rows whose roster summary must not wait for the pointer — see its JSX.
   *  #1481 — the summary now names who is here and what they are doing, which
   *  is the reason to scan the list, so it no longer hides at rest. */
  // One idle agent and nothing else: a "› 1" on every quiet row says nothing
  // the status column does not, so its chip waits for hover or focus like the
  // other chrome (and draws no count).
  const quietSingle = rosterCounts.agentCount === 1 && rosterCounts.stashedCount === 0
    && paneTaskIds.length === 0 && (rosterCounts.agents[0]?.status ?? 'idle') === 'idle';
  const rosterAlwaysShown = rosterShown || (hasRoster && !quietSingle) || paneTaskIds.length > 0;
  /** → opens the roster (and the tasks under it), ← folds it. */
  const expandable = hasRoster || paneTaskIds.length > 0;
  // Newly selected workspaces reveal their agents automatically; workspaces
  // that move to the background collapse back to the count. The user can still
  // explicitly toggle either state until selection changes again.
  // A row whose nested task needs you stays open when it moves to the
  // background: folding it there would hide the one row asking for you.
  const paneTaskNeedYouRef = useRef(paneTaskNeedYou);
  paneTaskNeedYouRef.current = paneTaskNeedYou;
  useEffect(() => {
    setRosterOpen(isActive || paneTaskNeedYouRef.current > 0);
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
  // #1481 — provenance for a task row: the audit record (who asked, when) and
  // the owner's current name. Undefined for every other row.
  const provenance = useStore((s) => (taskRow ? s.fanoutProvenance[workspaceId] : undefined));
  const spawnOwner = useStore((s) => (taskRow ? s.fanoutSpawnOwner[workspaceId] : undefined));
  const lineageOwner = useStore((s) => (taskRow ? s.fanoutLineage[workspaceId] : undefined));
  const taskOwnerId = taskRow ? childMission?.owner?.verifiedWorkspaceId ?? lineageOwner ?? spawnOwner : undefined;
  const taskOwnerName = useStore((s) => (taskOwnerId ? s.workspaces.find((w) => w.id === taskOwnerId)?.name : undefined));
  // Who asked for this task — for the fan-out glyph's tooltip. The sidebar
  // shows it by nesting the task under the requesting pane (2026-09-27).
  const requester = useStore(useShallow((s) => (taskRow ? resolveTaskRequester(s, workspaceId) : undefined)));

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
    // A row always drags its markdown out (dropping it on an agent's pane
    // hands that agent this workspace to message). Only the reorder half
    // depends on reorderOff: a sorted order used to cancel the whole drag,
    // which silently killed the hand-off for every unpinned row. While
    // renaming, a text drag in the input bubbles up here: let it stay a text
    // drag instead of overwriting it with the workspace markdown.
    if (!workspace || editing) return;
    // Roster controls live inside this draggable card. Chromium chooses the
    // nearest draggable ancestor as the native source, so `draggable={false}`
    // on a nested button is not enough. Reject a drag whose pointer originated
    // over the roster; clicks still handle disclosure and exact agent focus.
    // Only THIS row's own roster counts: a task row nested in its owner's
    // roster sits inside that roster, and must still drag itself.
    const pointerTarget = document.elementFromPoint(e.clientX, e.clientY);
    const control = pointerTarget?.closest('[data-workspace-agent-roster], [data-workspace-fanout]');
    if (control && e.currentTarget.contains(control)) {
      e.preventDefault();
      return;
    }
    dragStartTimeRef.current = Date.now();
    // dataTransfer carries ONLY the markdown so external chat composers
    // see a clean text drop. The source index for sidebar reorder is
    // stashed in zustand (cleared in dragend) — see uiSlice
    // setDraggedWorkspaceIndex. Mirrors what SurfaceTabs does for pane
    // export, where there is no internal-drop sibling at all.
    const state = useStore.getState();
    const md = buildWorkspaceMarkdown(workspace, state.surfaceAgent, state);
    e.dataTransfer.setData('text/plain', md);
    // copyMove (not copy): the sibling onDragOver below sets
    // dropEffect='move' for reorder, which is only valid against an
    // effectAllowed that includes 'move'. External chat composers
    // accept the 'copy' half of 'copyMove' just as well.
    // A row that cannot reorder offers copy only and leaves no reorder
    // source, so no sidebar row lights up as a drop target for it.
    e.dataTransfer.effectAllowed = reorderOff ? 'copy' : 'copyMove';
    if (!reorderOff) setDraggedWorkspaceIndex(index);
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

  // The drag source and this row, resolved by id at the moment of use: a
  // workspace closed mid-drag shifts every stored index after it. -1 when the
  // drag is not an internal reorder or the source is gone.
  const dragSourceIndex = () => {
    const st = useStore.getState();
    const id = st.draggedWorkspaceId;
    return id === null ? -1 : st.workspaces.findIndex((w) => w.id === id);
  };
  const ownIndex = () => useStore.getState().workspaces.findIndex((w) => w.id === workspaceId);

  const draggedRowPinned = (fromIndex: number) => {
    const st = useStore.getState();
    const id = st.workspaces[fromIndex]?.id;
    return id !== undefined && st.sidebarPinnedIds.includes(id);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    // An issue / PR dragged from the Git page: this workspace's agent takes it.
    if (isOurHandoffDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!handoffOver) setHandoffOver(true);
      return;
    }
    if (reorderOff) return;
    // A drag with no reorder source (a copy-only hand-off, or text from
    // outside) is not for this row: leave the drop unclaimed.
    const reorderFrom = dragSourceIndex();
    if (reorderFrom === -1) return;
    e.preventDefault();
    // Codex P1: do NOT force dropEffect='move' on the source row itself.
    // While the pointer is still over the row that started the drag,
    // the operation must stay 'copy' (the effectAllowed='copyMove'
    // default) so an external chat composer the user is about to drop
    // onto sees a clean copy text drag. Forcing 'move' here poisoned
    // every subsequent drop target into believing this was a reorder
    // and external text composers rejected it with 🚫.
    if (reorderFrom === ownIndex()) return;
    if (sortPaused && !draggedRowPinned(reorderFrom)) return;
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropIndicator(e.clientY < midY ? 'above' : 'below');
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // currentTarget 밖으로 나갈 때만 인디케이터 제거
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropIndicator(null);
      setHandoffOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (isOurHandoffDrag(e.dataTransfer)) {
      setHandoffOver(false);
      e.preventDefault();
      const taken = takeHandoffDrop(e.dataTransfer);
      if (taken) {
        useStore.getState().setGitHandoff({ item: taken.item, workspaceId, repo: taken.repo, anchor: { x: e.clientX, y: e.clientY } });
      }
      return;
    }
    if (reorderOff) return;
    setDropIndicator(null);
    // Reorder source comes from the store, not dataTransfer. No source
    // means the drop originated from outside the sidebar (or a copy-only
    // hand-off) — leave it unclaimed so foreign markdown never reshuffles
    // the list. Both ends are resolved by id, so a workspace closed
    // mid-drag cannot redirect the move.
    const fromIndex = dragSourceIndex();
    const index = ownIndex();
    if (fromIndex === -1 || index === -1) return;
    e.preventDefault();
    if (fromIndex === index) return;
    // A sorted order only accepts pinned-to-pinned drops.
    if (sortPaused && !draggedRowPinned(fromIndex)) return;

    // 드롭 위치를 아이템 중간 기준으로 결정
    // 위 절반 → 현재 index 앞으로, 아래 절반 → 현재 index 뒤로
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const toIndex = e.clientY < midY
      ? (fromIndex < index ? index - 1 : index)
      : (fromIndex > index ? index + 1 : index);
    onReorder(fromIndex, toIndex, pinned);
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
    if (readOnly) return;
    // 드래그 직후 더블클릭 이벤트 무시
    if (Date.now() - dragStartTimeRef.current < 300) return;
    setEditName(workspace?.name ?? '');
    setEditing(true);
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (readOnly) return;
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
      setSnoozeOpen(false);
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

  const displayName = displayWorkspaceName(workspace.name, taskRow);
  const provenanceTitle = taskRow
    ? provenanceTooltip({
      ownerName: taskOwnerName ? displayWorkspaceName(taskOwnerName, false) : undefined,
      caller: requester && requesterName(requester, t),
      when: provenance?.at ?? childMission?.createdAt ? timeAgo(provenance?.at ?? childMission?.createdAt ?? 0) : undefined,
    }, t)
    : undefined;

  // The treeitem's name: the workspace, what it is waiting on, and (for a
  // question) the question itself, like Fleet's row.
  const statusWord = needsYou ? t('workspace.needsYou')
    : unverifiableMinutes > 0 ? t('workspace.agentUnverifiable', { time: formatStaleMinutes(unverifiableMinutes) })
      : markStatus !== 'idle' ? t(AGENT_STATUS_ICON[markStatus].labelKey)
        : usageWaiting ? t('usageLimit.waiting') : undefined;
  const rowLabel = [displayName, statusWord, question].filter(Boolean).join(', ');

  // Keys on the row itself (the list moves between rows, Sidebar.tsx): Enter
  // or Space opens it (⌘/Ctrl adds it to the multiview), → opens its agents,
  // ← folds them or steps out to the owner row, Shift+F10 opens its menu.
  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || editing) return;
    const cmdOrCtrl = window.electronAPI?.platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (cmdOrCtrl) onCtrlSelect(workspaceId);
      else onSelect(workspaceId);
    } else if (e.key === 'ArrowRight' && expandable && !rosterShown) {
      e.preventDefault();
      setRosterOpen(true);
    } else if (e.key === 'ArrowLeft' && expandable && rosterShown && rosterOpen) {
      e.preventDefault();
      setRosterOpen(false);
    } else if (e.key === 'ArrowLeft' && taskRow && taskOwnerId) {
      // By the owner's id, not by DOM ancestry: a task in the owner's
      // trailing group (started from the app, by the orchestrator, from a
      // closed pane) is the owner card's sibling, not its descendant.
      const scope = e.currentTarget.closest('[data-sidebar-tree]') ?? document;
      const ownerRow = [...scope.querySelectorAll<HTMLElement>('[data-sidebar-row]')]
        .find((el) => el.getAttribute('data-sidebar-row') === taskOwnerId);
      if (ownerRow) {
        e.preventDefault();
        ownerRow.focus();
      }
    } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      if (readOnly) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      setWdOpen(false);
      setMenuPos({ x: r.left + 24, y: r.bottom - 4 });
    }
  };

  const hasProfile = workspace.profile !== undefined;
  // Color tag (optional). Undefined → every style below falls back to exactly
  // the pre-feature rendering, so an untagged workspace is pixel-identical.
  const tagColor = workspaceColorHex(workspace.color);

  // Hover actions. Each is a real 24x24 target; they sit in a cluster because
  // three 24px boxes do not fit side by side in this column: the cluster's
  // gap-3 is exactly what the members' side refunds give back, so consecutive
  // boxes TILE instead of overlapping (see hitArea.ts).
  //
  // In flow, never floated over the row. A row with a git line puts them at
  // the end of that line, where they take the place of the diff counts and
  // the PR badge while revealed — the right-side metadata steps aside, the
  // name and the branch do not. A top-level row without one puts them at the
  // end of the name line, which truncates by exactly their width. Either way
  // the roster chip beside both lines stays visible and clickable.
  //
  // The outer span owns the footprint: at rest it is weightless (`max-w-0`,
  // and `restGap` cancels the line's own gap); shown, `ml-auto` pins it to
  // the line's end and `pl-0.5` plus the gap gives back the 6px the first
  // member's left refund reaches over, so its box never covers the text. The
  // margins live on the span, not the cluster: hitArea.ts keeps a cluster
  // free of margins of its own. `pointer-events` follow visibility. Focus
  // anywhere on the row line reveals the cluster exactly as hover does, and
  // hides the same metadata, so a Tab into the row never overflows the line.
  const actionsOnGitLine = !!metadata?.gitBranch || !!question;
  // A nested task row has no width to spare on its name line (78px of text
  // at the 220px minimum): without a branch, its actions get a line of their
  // own, the height its sibling rows' git line takes, so the row never
  // changes height on hover.
  const actionsOnOwnLine = !actionsOnGitLine && taskRow;
  const actionCluster = (restGap: '-ml-1' | '-ml-2' | '') => readOnly ? null : (
    <span className={`flex flex-shrink-0 items-center self-center max-w-0 overflow-hidden ${restGap} ${hover.clusterSlot}`}>
      <div
        data-workspace-actions
        className={`${HIT_TARGET_24_CLUSTER} opacity-0 pointer-events-none transition-opacity duration-150 ${hover.cluster}`}
      >
        {/* Folder icon — reveals this workspace's cwd in the OS file manager. */}
        <button
          data-workspace-action="explorer"
          tabIndex={innerTab}
          className={`${HIT_TARGET_24_IN_CLUSTER} rounded-md text-[color-mix(in_srgb,var(--text-main)_50%,transparent)] hover:bg-[var(--selection)] hover:text-[var(--text-main)] text-[10px] font-mono`}
          onClick={(e) => { e.stopPropagation(); handleOpenExplorer(); }}
          title={t('workspace.openInExplorer', { app: fileManagerName(t) })}
          aria-label={t('workspace.openInExplorer', { app: fileManagerName(t) })}
        >
          <IconFolder size={11} />
        </button>

        {/* Copy session info button */}
        <button
          data-workspace-action="copy-info"
          tabIndex={innerTab}
          className={`${HIT_TARGET_24_IN_CLUSTER} rounded-md text-[color-mix(in_srgb,var(--text-main)_50%,transparent)] hover:bg-[var(--selection)] hover:text-[var(--text-main)] text-[10px] font-mono`}
          onClick={(e) => { e.stopPropagation(); onCopyInfo(workspaceId); }}
          title={t('workspace.copyInfo')}
          aria-label={t('workspace.copyInfo')}
        >
          <IconCopy size={11} />
        </button>

        {/* Close button — asks for confirmation first (anti-misclick). Last in
            the cluster: a pointer overshooting it to the right leaves the
            cluster instead of landing on the one control here that kills a
            workspace. */}
        {/* Moa's HQ: present but disabled, focusable so the reason can be
            read (aria-disabled, not `disabled`). */}
        <button
          data-workspace-action="close"
          tabIndex={innerTab}
          className={`${HIT_TARGET_24_IN_CLUSTER} rounded-md text-[color-mix(in_srgb,var(--text-main)_50%,transparent)] text-[10px] font-mono ${moaHq ? 'opacity-50 cursor-default' : 'hover:bg-[var(--selection)] hover:text-[var(--accent-red)]'}`}
          onClick={(e) => { e.stopPropagation(); if (moaHq) return; setMenuPos(null); setCloseConfirmPos(anchorOf(e.currentTarget)); }}
          title={moaHq ? t('moa.guard.reason') : t('workspace.close')}
          aria-label={t('workspace.close')}
          aria-disabled={moaHq || undefined}
          aria-description={moaHq ? t('moa.guard.reason') : undefined}
        >
          <IconX size={11} />
        </button>
      </div>
    </span>
  );

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
        // Not while renaming: a text drag inside the input must stay a text drag.
        draggable={!!workspace && !editing && !readOnly}
        {...tokenAttrs('bgSurface', 'bg')}
        // Card states (idle / hover / active / needs you) are painted by the
        // .wmux-sidebar .sidebar-row rules in ui.css.
        className={`sidebar-row px-2.5 ${taskRow ? 'sidebar-row-task py-1.5' : 'py-2'} cursor-pointer rounded-md select-none ${needsYou ? 'sidebar-row-needs' : ''} ${pulseClass} ${
          isActive ? 'sidebar-row-active' : ''
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
        data-handoff-over={handoffOver ? 'true' : undefined}
      >
        {/* The hover group is this line, not the card: the card also holds the
            expanded roster and its nested task rows, and `:hover` reaches every
            ancestor, so a pointer on a nested task would reveal this row's
            chrome too and cut its name for buttons nobody is pointing at.
            The negative margin and matching padding stretch the line over the
            card's own padding (ui.css: 8px 10px), so the actions reveal
            wherever the card paints its hover fill, without moving a pixel of
            content. */}
        {/* It is also the row's keyboard stop (a treeitem with roving
            tabindex): focus here reveals the same actions hover does, and the
            ring sits on the line, never on the roster below it. */}
        <div
          className={`${hover.group} -mx-2.5 -my-2 flex min-w-0 items-start gap-2 px-2.5 py-2`}
          // Moa's HQ row sits above the list, outside the tree: a labelled
          // group whose own buttons take Tab directly, no row stop.
          role={moaHq ? 'group' : 'treeitem'}
          aria-level={moaHq ? undefined : taskRow ? 2 : 1}
          aria-selected={moaHq ? undefined : isActive}
          aria-expanded={!moaHq && expandable && !editing ? rosterShown : undefined}
          aria-current={moaHq && isActive ? 'true' : undefined}
          aria-label={rowLabel}
          tabIndex={moaHq ? undefined : tabStop ? 0 : -1}
          data-sidebar-row={moaHq ? undefined : workspaceId}
          onKeyDown={moaHq ? undefined : handleRowKeyDown}
          onFocus={() => setRowFocusWithin(true)}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRowFocusWithin(false); }}
        >
        {/* Status indicator — #1481: one shared mark (AgentMarks.tsx), status
            told by shape. Idle draws nothing: an active-but-idle workspace
            is no longer painted green, because green means "finished" and
            selection already has its own treatment. `mt-1` centres the 10px
            box on the name line. */}
        <span className="mt-1 flex-none">
          <StatusMarkView
            status={markStatus}
            // The row's pulse setting owns its motion, so the mark does not
            // breathe on its own (Off means still).
            quiet={needsYou}
            unverifiable={unverifiableMinutes > 0}
            usageWaiting={usageWaiting}
            label={unverifiableMinutes > 0
              ? t('workspace.agentUnverifiable', { time: formatStaleMinutes(unverifiableMinutes) })
              : markStatus !== 'idle' ? t(AGENT_STATUS_ICON[markStatus].labelKey)
                : usageWaiting ? t('usageLimit.waiting') : undefined}
          />
        </span>

        {/* Name + Metadata */}
        <div className="flex-1 min-w-0" data-workspace-text>
          {editing ? (
            <input
              ref={inputRef}
              className="w-full bg-[var(--bg-base)] text-[var(--text-main)] text-caption font-mono px-1 py-0 rounded-md border border-[var(--line-strong)] outline-none"
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
                {taskRow && (
                  // #1481 — provenance: a muted fan-out glyph whose tooltip says
                  // who fanned this task out, from which caller, and when.
                  <span
                    className="flex-none text-[var(--text-muted)]"
                    role="img"
                    aria-label={provenanceTitle}
                    title={provenanceTitle}
                    data-task-provenance
                  >
                    <IconFanOut size={10} />
                  </span>
                )}
                <span
                  className="wmux-row-title font-sans text-[13px] leading-snug truncate font-semibold text-[var(--text-main)]"
                  title={idleLabel ? `${displayName} · ${t('workspace.idleTooltip', { time: idleLabel })}` : displayName}
                >
                  {displayName}
                </span>
                {unseen && (
                  <span
                    className="h-1.5 w-1.5 flex-none rounded-full bg-[var(--text-main)]"
                    role="img"
                    aria-label={t('sidebar.changedSinceSeen')}
                    title={t('sidebar.changedSinceSeen')}
                    data-sidebar-unseen
                    data-sidebar-done={done ? '' : undefined}
                  />
                )}
                {pinned && !taskRow && (
                  <span className="flex-none text-[var(--text-muted)]" role="img" aria-label={t('sidebar.pinned')} title={t('sidebar.pinned')} data-sidebar-pinned>
                    <IconPin size={10} />
                  </span>
                )}
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
                    tabIndex={innerTab}
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
                  <span className="bg-[var(--selection)] text-[var(--text-main)] text-[10px] font-semibold tabular-nums min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 flex-shrink-0">
                    {unreadCount}
                  </span>
                )}
                {departedCwd && (
                  <span
                    className="text-[10px] text-[var(--accent-yellow)] flex-shrink-0"
                    title={t('workspace.cwdDeparted', { cwd: departedCwd })}
                  >
                    <span className="mr-0.5 inline-flex align-[-1px]" aria-hidden="true"><IconWarning size={10} /></span>
                    {t('workspace.departed')}
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
                    className="text-[11px] tabular-nums text-[color-mix(in_srgb,var(--text-main)_45%,transparent)] flex-shrink-0"
                    title={t('workspace.idleTooltip', { time: idleLabel })}
                  >
                    · {idleLabel}
                  </span>
                )}
                {/* The trailing chrome rides the name line, so the line under
                    it (branch or question) gets the row's full width. */}
                <span className="ml-auto flex flex-shrink-0 items-center gap-1" data-row-trailing>
                  {!actionsOnGitLine && !actionsOnOwnLine && actionCluster('-ml-1')}
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
                  <span className={`inline-flex flex-shrink-0 ${rosterAlwaysShown ? '' : restHiddenNameLine}`}>
                    <WorkspaceRosterSummaryMemo
                      tabIndex={innerTab}
                      workspaceId={workspaceId}
                      agentCount={rosterCounts.agentCount}
                      stashedCount={rosterCounts.stashedCount}
                      agents={rosterShown ? undefined : rosterCounts.agents}
                      extra={rosterCounts.extra}
                      paneTaskCount={paneTaskIds.length}
                      paneTaskNeedYou={paneTaskNeedYou}
                      open={rosterShown}
                      onToggle={toggleRoster}
                    />
                  </span>
                )}

                {/* The blocked-agent label, right-aligned. It replaces the play/pause
                    mark this row used to carry: "running" is already the accent dot,
                    and a paused glyph never said what it was paused ON. Words do.
                    On hover the row's chrome comes back and the label steps aside for
                    it (the dashed fill and the amber ring keep saying "needs you"); the active
                    row, which shows its chrome permanently, keeps the label too. */}
                {/* #1481 — not on a nested task row: its fill and amber ring stay, and the
                    owner's rollup line already says "N need you" for the group. */}
                {/* The label stays on hover and focus: the actions sit on the second
                    line, so they never need its width. */}
                {needsYou && !taskRow && (
                  <span className="font-sans text-[11px] font-medium text-[var(--attention-text)] flex-shrink-0" data-row-needs-you>
                    {t('workspace.needsYou')}
                  </span>
                )}
                {errored && !taskRow && (
                  <span className="font-sans text-[11px] font-medium text-[var(--accent-red)] flex-shrink-0" data-row-error>
                    {t('workspace.agentError')}
                  </span>
                )}

                {/* Shortcut hint */}
                {/* #1481 — a nested task row is indented, so even the active one gives
                    the hint back to its name at rest. */}
                {/* #1481 review — Ctrl+N follows the stored order, which nesting no
                    longer mirrors on screen; a nested task row would show a hint out
                    of sequence with the rows around it, so it shows none. */}
                {/* Ctrl+N follows the stored (manual) order, which only Manual shows
                    on screen; in the other orders a hint would name a shortcut out of
                    sequence with the rows around it, so none is drawn — except on a
                    pinned row: the pinned group leads the stored order and is shown
                    as stored, so its numbers match the screen. */}
                {!taskRow && !moaHq && !shortcutHintHidden && (!sortPaused || pinned) && (
                  <span className={`text-[11px] tabular-nums text-[color-mix(in_srgb,var(--text-main)_35%,transparent)] flex-shrink-0 ${restHiddenNameLine}`}>
                    {shortcutIndex >= 0 && shortcutIndex < 9 ? `^${shortcutIndex + 1}` : ''}
                  </span>
                )}
                </span>
              </div>
              {(metadata || question) && (
                <WorkspaceContextLine
                  metadata={metadata ?? {}}
                  onPortClick={handlePortClick}
                  actions={actionsOnGitLine ? actionCluster('-ml-2') : null}
                  metaHiddenOnHover={hover.hideOnHover}
                  question={question}
                  innerTab={innerTab}
                />
              )}
              {actionsOnOwnLine && (
                <div className="mt-0.5 flex min-h-[18px] items-center justify-end" data-row-actions-line>
                  {actionCluster('')}
                </div>
              )}
            </>
          )}
        </div>

        </div>
        {/* Mounted only when expanded: a collapsed list would subscribe to the
            whole roster projection to render nothing. */}
        {(!editing || paneTaskIds.length > 0) && rosterShown && (
          <WorkspaceAgentRoster
            workspaceId={workspaceId}
            pulsingPaneId={pulsingPaneId}
            taskIds={nestedTaskIds}
            renderTask={renderTask}
            onCloseTask={onCloseTask}
            ownerActive={isActive}
          />
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
          className="fixed z-[var(--z-popover-top)] w-max flex flex-col py-1 rounded-xl shadow-xl sidebar-popover-enter"
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
          {/* #1011 — the non-destructive exit: same session teardown as Close,
              but the workspace comes back from the Archived section intact. */}
          <button
            className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${moaHq ? 'opacity-50 cursor-default' : 'hover:bg-[var(--bg-overlay)]'}`}
            style={{ color: 'var(--text-main)' }}
            onClick={() => { if (moaHq) return; setMenuPos(null); onArchive(workspaceId); }}
            data-workspace-action="archive"
            title={moaHq ? t('moa.guard.reason') : undefined}
            aria-disabled={moaHq || undefined}
            aria-description={moaHq ? t('moa.guard.reason') : undefined}
          >
            {t('workspace.archive')}
          </button>
          {/* Pinned to top (2026-09-26): offered in every order. A task row
              renders under its owner, so it has no top to pin to; Moa's HQ
              is not in the list at all. */}
          {!taskRow && !moaHq && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
              style={{ color: 'var(--text-main)' }}
              onClick={() => { setMenuPos(null); toggleSidebarPin(workspaceId); }}
              data-workspace-action="pin"
            >
              {pinned ? t('sidebar.unpin') : t('sidebar.pin')}
            </button>
          )}
          {/* Settle / snooze: visibility only — the workspace moves to the
              sidebar's Settled or Snoozed group, nothing is closed. A task row
              rides with its owner, so it has no verbs of its own. */}
          {!taskRow && (workspaceSettled ? (
            <button
              className="w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
              style={{ color: 'var(--text-main)' }}
              onClick={() => { setMenuPos(null); void sendWorkspaceSettleCommand({ op: 'unsettle', workspaceId }); }}
              data-workspace-action="unsettle"
            >
              {t('workspaceSettle.unsettle')}
            </button>
          ) : (
            <button
              className="w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)] disabled:opacity-40 disabled:hover:bg-transparent"
              style={{ color: 'var(--text-main)' }}
              disabled={isHq || settleBlocked}
              title={isHq ? t('workspaceSettle.settleHq') : settleBlocked ? t('workspaceSettle.settleBlocked') : undefined}
              onClick={() => { setMenuPos(null); void sendWorkspaceSettleCommand({ op: 'settle', workspaceId }); }}
              data-workspace-action="settle"
            >
              {t('workspaceSettle.settle')}
            </button>
          ))}
          {!taskRow && (snoozedUntil > Date.now() ? (
            <button
              className="w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
              style={{ color: 'var(--text-main)' }}
              onClick={() => { setMenuPos(null); void sendWorkspaceSettleCommand({ op: 'unsnooze', workspaceId }); }}
              data-workspace-action="unsnooze"
            >
              {t('workspaceSettle.unsnooze')}
            </button>
          ) : !pinned && !isHq && (
            <div
              className="relative"
              onMouseEnter={() => setSnoozeOpen(true)}
              onMouseLeave={() => setSnoozeOpen(false)}
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSnoozeOpen(false); }}
            >
              <button
                ref={snoozeTriggerRef}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
                style={{ color: 'var(--text-main)' }}
                aria-haspopup="menu"
                aria-expanded={snoozeOpen}
                onClick={() => setSnoozeOpen(true)}
                onFocus={() => {
                  if (snoozeSkipFocusOpen.current) snoozeSkipFocusOpen.current = false;
                  else setSnoozeOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && snoozeOpen) {
                    // First Escape folds the submenu; the next one closes the menu.
                    e.stopPropagation();
                    setSnoozeOpen(false);
                    return;
                  }
                  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowRight') return;
                  e.preventDefault();
                  snoozeFocusFirst.current = true;
                  setSnoozeOpen(true);
                }}
                data-workspace-action="snooze"
              >
                <span>{t('workspaceSettle.snooze')}</span>
                <span className="text-[var(--text-muted)] ml-auto"><IconChevron /></span>
              </button>
              {snoozeOpen && (
                <div
                  ref={(el) => {
                    if (!el || !snoozeFocusFirst.current) return;
                    snoozeFocusFirst.current = false;
                    el.querySelector<HTMLButtonElement>('[data-snooze-preset]')?.focus();
                  }}
                  role="menu"
                  className={`absolute top-0 ${menuPos.x > window.innerWidth * 0.6 ? 'right-full mr-0.5' : 'left-full ml-0.5'} min-w-[140px] py-1 rounded-xl shadow-xl sidebar-popover-enter`}
                  style={{ background: 'var(--bg-surface)', border: '1px solid color-mix(in srgb, var(--bg-overlay) 70%, transparent)' }}
                  onKeyDown={(e) => {
                    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-snooze-preset]')];
                    const at = items.indexOf(document.activeElement as HTMLButtonElement);
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const step = e.key === 'ArrowDown' ? 1 : -1;
                      items[(at + step + items.length) % items.length]?.focus();
                    } else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
                      // Close only the submenu: stop the event before the
                      // document listener that dismisses the whole menu.
                      e.preventDefault();
                      e.stopPropagation();
                      setSnoozeOpen(false);
                      snoozeSkipFocusOpen.current = true;
                      snoozeTriggerRef.current?.focus();
                    }
                  }}
                >
                  {WORKSPACE_SNOOZE_PRESETS.map((preset) => {
                    // A preset that makes no sense now ("tonight" late in the
                    // evening) is not offered. The end is taken again on
                    // click, so a menu left open does not send a stale time.
                    if (workspaceSnoozeUntil(preset, new Date()) === null) return null;
                    return (
                      <button
                        key={preset}
                        role="menuitem"
                        className="w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
                        style={{ color: 'var(--text-main)' }}
                        onClick={() => {
                          setMenuPos(null);
                          const until = workspaceSnoozeUntil(preset, new Date());
                          if (until !== null) void sendWorkspaceSettleCommand({ op: 'snooze', workspaceId, until });
                        }}
                        data-snooze-preset={preset}
                      >
                        {t(`workspaceSettle.preset.${preset}`)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
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
                className={`absolute top-0 ${menuPos.x > window.innerWidth * 0.6 ? 'right-full mr-0.5' : 'left-full ml-0.5'} py-1.5 px-2 rounded-xl shadow-xl sidebar-popover-enter`}
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
                className={`absolute top-0 ${menuPos.x > window.innerWidth * 0.6 ? 'right-full mr-0.5' : 'left-full ml-0.5'} min-w-[180px] py-1 rounded-xl shadow-xl sidebar-popover-enter`}
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
                className={`absolute top-0 ${menuPos.x > window.innerWidth * 0.6 ? 'right-full mr-0.5' : 'left-full ml-0.5'} min-w-[240px] max-w-[420px] py-1 rounded-xl shadow-xl sidebar-popover-enter`}
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
        <CloseWorkspaceConfirm
          anchor={closeConfirmPos}
          title={t('workspace.closeConfirm', { name: displayName })}
          // Workspace-wide (#977): closing the workspace disposes stashed
          // PTYs too, so a visible-only count promises to close fewer panes
          // than it actually kills.
          terminalCount={collectWorkspaceTerminalSurfaces(workspace).length}
          detail={(count) => t('workspace.closeConfirmDetail', { count })}
          cancelLabel={t('workspace.closeCancel')}
          confirmLabel={t('workspace.closeConfirmYes')}
          onCancel={() => setCloseConfirmPos(null)}
          onConfirm={() => { setCloseConfirmPos(null); onClose(workspaceId); }}
        />
      )}

      {/* Profile editor modal */}
      {profileModalOpen && (
        <WorkspaceProfileModal workspace={workspace} onClose={() => setProfileModalOpen(false)} />
      )}
    </div>
  );
}

/** Viewport rect of the control that opened the close confirmation. */
export interface CloseConfirmAnchor {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

function anchorOf(el: Element): CloseConfirmAnchor {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
}

export const CLOSE_CONFIRM_WIDTH = 240;
/** Opening estimate only; the real height is measured before paint. */
const CLOSE_CONFIRM_HEIGHT_ESTIMATE = 112;

export interface CloseWorkspaceConfirmProps {
  anchor: CloseConfirmAnchor;
  title: string;
  terminalCount: number;
  detail: (count: number) => string;
  cancelLabel: string;
  confirmLabel: string;
  /** #1481 — names of exactly what will be closed, listed under the detail. */
  items?: readonly string[];
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The close-workspace confirmation, anchored to the row's close button.
 *
 * Placed with placePopover (the pane actions menu's helper, #957): it hangs
 * below the button, right-aligned inside the sidebar, and flips above it when
 * the row sits near the bottom of the window (#1482) — opening at the pointer
 * put the Close button past the window edge for the last rows.
 */
export function CloseWorkspaceConfirm({
  anchor,
  title,
  terminalCount,
  detail,
  cancelLabel,
  confirmLabel,
  items,
  onCancel,
  onConfirm,
}: CloseWorkspaceConfirmProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(CLOSE_CONFIRM_HEIGHT_ESTIMATE);
  // Measure before paint and re-place with the real height: the detail line
  // is conditional and the title wraps with long names, so the estimate alone
  // would flip too late (or too early). offsetHeight, not the bounding rect:
  // the enter animation scales the card, and a rect read mid-animation is
  // short by that scale.
  useLayoutEffect(() => {
    const measured = ref.current?.offsetHeight ?? 0;
    if (measured > 0 && Math.abs(measured - height) > 0.5) setHeight(measured);
  });
  // The anchor is the button's rect at click time. A window resize or a
  // scroll of the sidebar (anything that contains this popover — it is a DOM
  // descendant of its row) moves the button, and a stale anchor would put the
  // confirm off-screen again (#1482), so either dismisses it, like an outside
  // click. Scrolls elsewhere (a terminal printing output) do not.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    const dismiss = () => onCancelRef.current();
    const onScroll = (e: Event) => {
      const el = ref.current;
      if (el && e.target instanceof Node && e.target !== el && e.target.contains(el)) dismiss();
    };
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);
  const pos = placePopover(anchor, { width: CLOSE_CONFIRM_WIDTH, height });
  return (
    <Popover
      ref={ref}
      padded
      aria-label={title}
      data-workspace-close-confirm=""
      className="fixed z-[var(--z-popover-top)] sidebar-popover-enter"
      style={{ top: pos.top, left: pos.left, width: CLOSE_CONFIRM_WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <p className="m-0 text-[13px] font-medium leading-5 text-[var(--text-main)] [overflow-wrap:anywhere]">{title}</p>
      {terminalCount > 0 ? <p className="ui-note mt-1">{detail(terminalCount)}</p> : null}
      {items && items.length > 0 ? (
        <ul className="m-0 mt-2 max-h-[132px] list-none overflow-y-auto p-0 text-[13px] leading-5 text-[var(--text-main)]" data-close-items>
          {items.map((item, i) => <li key={i} className="truncate" title={item}>{item}</li>)}
        </ul>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="danger" size="sm" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Popover>
  );
}

// A2: 리스트 자식 memo 방벽. 부모(Sidebar)가 리렌더돼도 이 항목의 props(id·
// isActive·isMultiview·index·안정 콜백)가 그대로면 리렌더를 건너뛴다. 자기 ws
// 내용 변경은 내부 self-subscribe가 직접 리렌더를 유발하므로 memo와 무관하게
// 반영된다. 기본 얕은 비교로 충분(모든 콜백이 Sidebar에서 안정적으로 생성됨).
export default memo(WorkspaceItem);
