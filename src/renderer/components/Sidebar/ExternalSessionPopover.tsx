// The detail card of a session started outside wmux (placement B,
// 2026-11-01). wmux can neither show that terminal nor type into it, so the
// card never pretends to jump to a pane: it says where the session lives, how
// to attach to it from another terminal when tmux or screen is known, and
// offers a wmux pane in the same folder instead.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { useCopyText } from '../../hooks/useCopyText';
import { placePopover } from '../AgentToolbar/placePopover';
import Popover, { PopoverSection } from '../ui/Popover';
import Button from '../ui/Button';
import { FOCUS_RING } from '../focusRing';
import { IconCopy, IconTerminal, IconX } from '../icons';
import { StatusMarkView } from './AgentMarks';
import { AGENT_STATUS_ICON } from './agentStatusIcon';
import { externalAgentStatus, externalAttachCommand, externalSessionWslDistro, terminalAppName } from './externalSessionPlacement';
import { folderWorkspaceName } from '../FirstRunWizard';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { displayPath } from '../../utils/displayPath';
import { formatIdle } from '../../utils/idleTime';
import { timeAgo } from '../../utils/timeAgo';
import { agentSlugToDisplay } from '../../../shared/agentIdentity';
import type { ExternalSession, ExternalSessionWhere } from '../../../shared/externalSessions';
import type { TranslationKey } from '../../i18n/locales/en';
import type { t as translate } from '../../i18n';

export const EXTERNAL_SESSION_CARD_WIDTH = 352;

type Anchor = { top: number; left: number; right: number; bottom: number };
type Translate = typeof translate;

/** The card's "Where" line: `tmux · session api · window 2`, `ssh from …`, the terminal app. */
export function externalWhereLong(where: ExternalSessionWhere, t: Translate): string {
  const parts: string[] = [];
  const session = where.session?.trim();
  const label = where.label?.trim();
  switch (where.kind) {
    case 'tmux':
    case 'screen':
    case 'zellij':
      parts.push(where.kind);
      if (session) parts.push(t('externalSessions.whereSession', { name: session }));
      if (where.kind === 'tmux' && where.window) parts.push(t('externalSessions.whereWindow', { name: where.window }));
      break;
    case 'ssh':
      parts.push(label ? t('externalSessions.whereSsh', { client: label }) : 'ssh');
      break;
    case 'terminal':
      if (label) parts.push(terminalAppName(label));
      break;
    default:
      break;
  }
  if (where.wslDistro) parts.push(`WSL ${where.wslDistro}`);
  return parts.length > 0 ? parts.join(' · ') : t('externalSessions.whereUnknown');
}

/**
 * A wmux pane in the session's folder: beside the workspace's active pane when
 * the session sits in a workspace, else a new workspace on that folder. A
 * split takes the folder only while splits inherit a folder (Settings), so
 * with that off it is a new workspace too.
 *
 * A session in WSL gets a WSL shell in its distro at its Linux folder (the
 * pane seed the funnel creates it from), never a Windows shell handed a
 * /home path. Its new workspace keeps no startup folder: a Linux path means
 * nothing to the other shells a later pane may run.
 */
export function openPaneInSessionFolder(session: ExternalSession, workspaceId: string | undefined): void {
  const st = useStore.getState();
  const wslDistro = externalSessionWslDistro(session);
  const ws = workspaceId && st.splitInheritsCwd ? st.workspaces.find((w) => w.id === workspaceId) : undefined;
  if (ws) {
    st.setActiveWorkspace(ws.id);
    const paneId = useStore.getState().splitPane(ws.activePaneId, 'horizontal', ws.id);
    // The split seeds the new pane with its neighbour's folder; this pane is
    // asked for the session's folder.
    if (paneId) {
      useStore.setState((s) => {
        if (wslDistro) {
          s.projectPaneSeed[paneId] = { cwd: session.cwd, wslDistro };
          delete s.splitCwdSeed[paneId];
        } else {
          s.splitCwdSeed[paneId] = session.cwd;
        }
      });
    }
  } else if (wslDistro) {
    st.addWorkspace(folderWorkspaceName(session.cwd));
    const now = useStore.getState();
    const leafId = now.workspaces.find((w) => w.id === now.activeWorkspaceId)?.activePaneId;
    if (leafId) useStore.setState((s) => { s.projectPaneSeed[leafId] = { cwd: session.cwd, wslDistro }; });
  } else {
    st.addWorkspace(folderWorkspaceName(session.cwd), { startupCwd: session.cwd });
  }
  showWorkspaces(useStore.getState());
}

export function ExternalSessionCard({ session, inWorkspace, anchor, triggerRef, now, onClose, onOpenPane, onHide }: {
  session: ExternalSession;
  /** Whether a workspace's folder holds the session (else the card says none does). */
  inWorkspace: boolean;
  anchor: Anchor;
  triggerRef?: RefObject<HTMLElement | null>;
  now: number;
  /** `restoreFocus` when the keyboard closed it (Escape, ×): focus goes back to the row. */
  onClose: (restoreFocus: boolean) => void;
  onOpenPane: () => void;
  onHide: () => void;
}) {
  const t = useT();
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [height, setHeight] = useState(260);
  const { state: copyState, copy } = useCopyText();
  // Measured after each render, so placePopover can flip it above the row.
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight;
    if (h && h !== height) setHeight(h);
  });
  // Focus starts on the one primary action, not the close ×.
  useEffect(() => { primaryRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || triggerRef?.current?.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      onClose(true);
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || triggerRef?.current?.contains(target)) return;
      onClose(false);
    };
    const onResize = () => onClose(false);
    // Capture on keydown: the terminal swallows keys.
    document.addEventListener('keydown', onKey, true);
    // Capture on mousedown too: the roster stops presses on its rows before
    // they bubble, and a press on another row must still close this card.
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose, triggerRef]);

  const pos = placePopover(anchor, { width: EXTERNAL_SESSION_CARD_WIDTH, height });
  const status = externalAgentStatus(session.state);
  const agentName = agentSlugToDisplay(session.agent);
  const title = session.title?.trim() || agentName;
  const attach = externalAttachCommand(session.where);
  const ended = session.state === 'ended';
  const idleMs = now - session.lastSignalAt;
  const stateLine = session.state === 'needs-you'
    ? [t('workspace.needsYou'), session.pendingKind ? t(session.pendingKind === 'approval' ? 'externalSessions.approval' : 'externalSessions.question') : undefined].filter(Boolean).join(' · ')
    : session.state === 'running'
      ? t(AGENT_STATUS_ICON.running.labelKey as TranslationKey)
      : ended
        ? t('externalSessions.endedAgo', { time: timeAgo(session.endedAt ?? session.lastSignalAt, now) })
        : `${t(AGENT_STATUS_ICON.idle.labelKey as TranslationKey)} · ${formatIdle(Math.max(0, idleMs))}`;
  const hint = session.state === 'needs-you'
    ? t('externalSessions.answerHint')
    : ended
      ? t('externalSessions.endedHint')
      : attach ? undefined : t('externalSessions.noAttachHint');
  const question = session.state === 'needs-you' ? session.pendingQuestion?.trim() : undefined;
  const activity = session.state === 'running' ? (session.lastActivity?.trim() || undefined) : undefined;

  return createPortal(
    <Popover
      ref={cardRef}
      padded
      aria-label={title}
      data-external-session-card={session.id}
      className="fixed"
      style={{ top: pos.top, left: pos.left, width: EXTERNAL_SESSION_CARD_WIDTH, zIndex: 'var(--z-popover-top)' }}
      // A portal still bubbles through the React tree: keep the card's
      // presses, double-clicks (rename) and right-clicks (row menu) away from
      // the roster and the workspace row it sits under.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onDragStart={(e) => e.stopPropagation()}
    >
      <PopoverSection>
        <div className="flex items-start gap-2">
          <span className="mt-[5px] flex-none">
            <StatusMarkView status={status} label={t(AGENT_STATUS_ICON[status].labelKey as TranslationKey)} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[var(--text-main)]">{title}</div>
            <div className="mt-px truncate text-[11px] text-[var(--text-muted)]">
              {`${agentName} · ${ended ? t('externalSessions.ended') : t('externalSessions.outsideWmux')}`}
            </div>
          </div>
          <button
            type="button"
            className={`-mr-1 -mt-1 inline-flex h-[26px] w-[26px] flex-none items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
            aria-label={t('externalSessions.close')}
            title={t('externalSessions.close')}
            onClick={() => onClose(true)}
          >
            <IconX size={12} />
          </button>
        </div>
      </PopoverSection>
      <PopoverSection>
        <div>
          <div className={`text-[11px] font-medium ${session.state === 'needs-you' ? 'text-[var(--attention-text)]' : 'text-[var(--text-sub)]'}`} data-external-session-state>
            {stateLine}
          </div>
          {question && <div className="mt-1 text-[13px] text-[var(--text-main)] [overflow-wrap:anywhere]">{question}</div>}
          {!question && activity && <div className="mt-1"><span className="ui-code">{activity}</span></div>}
          {hint && <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">{hint}</p>}
        </div>
      </PopoverSection>
      <PopoverSection>
        <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-[12px]">
          <dt className="text-[var(--text-muted)]">{t('externalSessions.folder')}</dt>
          <dd className="m-0 min-w-0 text-[var(--text-sub)] [overflow-wrap:anywhere]"><span className="ui-code">{displayPath(session.cwd)}</span></dd>
          <dt className="text-[var(--text-muted)]">{t('externalSessions.where')}</dt>
          <dd className="m-0 flex min-w-0 items-center gap-1 text-[var(--text-sub)] [overflow-wrap:anywhere]">
            <span className="flex-none text-[var(--text-muted)]" aria-hidden="true"><IconTerminal size={12} /></span>
            <span className="min-w-0">{externalWhereLong(session.where, t)}</span>
          </dd>
          <dt className="text-[var(--text-muted)]">{t('externalSessions.lastActivity')}</dt>
          <dd className="m-0 min-w-0 text-[var(--text-sub)] [overflow-wrap:anywhere]">
            {session.lastActivity?.trim() && <><span className="ui-code">{session.lastActivity.trim()}</span>{' · '}</>}
            {timeAgo(session.lastSignalAt, now)}
          </dd>
          {!inWorkspace && (
            <>
              <dt className="text-[var(--text-muted)]">{t('externalSessions.workspace')}</dt>
              <dd className="m-0 min-w-0 text-[var(--text-sub)]">{t('externalSessions.noWorkspace')}</dd>
            </>
          )}
        </dl>
      </PopoverSection>
      {attach && (
        <PopoverSection>
          <div>
            <div className="text-[11px] text-[var(--text-muted)]">{t('externalSessions.attachLabel')}</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-[var(--selection)] px-2 py-[5px] font-mono text-[11px] text-[var(--text-sub)] select-text" data-external-attach-command>{attach}</code>
              <Button
                ref={primaryRef}
                size="sm"
                variant="primary"
                onClick={() => { void copy(attach); }}
                data-external-session-action="copy"
              >
                <IconCopy size={12} />
                <span>{copyState === 'copied' ? t('common.copied') : t('externalSessions.copyAttach')}</span>
              </Button>
            </div>
          </div>
        </PopoverSection>
      )}
      <PopoverSection>
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={onHide} data-external-session-action="hide">
            {t('externalSessions.hide')}
          </Button>
          <Button
            ref={attach ? undefined : primaryRef}
            size="sm"
            variant={attach ? 'secondary' : 'primary'}
            onClick={onOpenPane}
            data-external-session-action="open-pane"
          >
            {t('externalSessions.openPaneHere')}
          </Button>
        </div>
      </PopoverSection>
    </Popover>,
    document.body,
  );
}
