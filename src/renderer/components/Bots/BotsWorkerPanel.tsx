// ─── A bot worker's terminal, beside its bot's chat ──────────────────────
//
// A worker row under its bot in the list shows that worker's panes here, on the Bots page,
// instead of jumping to Workspaces: the app's active workspace never changes
// (owner decision 2026-10-14). The worker's workspace keeps one mount (one
// xterm per PTY): while this panel shows it, the Workspaces viewport leaves
// that workspace unmounted (selectWorkerPanelHost), and it mounts there
// again, replaying from the daemon, when the panel closes or the page goes.
// Keys typed here reach the worker's PTY only; the Workspaces shortcuts stay
// off on this page (useKeyboard), and a click never activates the workspace
// (setActivePane is scoped to the active one). A worker that also holds a
// browser or an editor is not moved here (selectWorkerPanelHost: their state
// would not survive the remount); the panel says so and offers Workspaces.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import PaneContainer from '../Pane/PaneContainer';
import Button from '../ui/Button';
import Popover from '../ui/Popover';
import { FOCUS_RING } from '../focusRing';
import { IconMoreHorizontal, IconX } from '../icons';
import { InlineConfirm } from './InlineConfirm';
import { markWorkerStopUnfinished, stopTaskSummary, type BotsStopPort } from './botsStop';

type T = (key: string, vars?: Record<string, string | number>) => string;

const openInWorkspaces = (workspaceId: string) => focusNotificationTarget(() => useStore.getState(), { workspaceId }, { reveal: true });

/** Stop worker's in-place confirm under the header, as the profile's Stop
 *  asks: what will happen, Cancel and Stop. It stops that one task's worker
 *  (its task cancelled, "stopped by owner"; the bot's turn and other work go
 *  on). The result is a toast; a stop that went through closes it. */
function StopWorkerConfirm({ task, taskId, stopTask, t, onClose }: {
  task: string;
  taskId: string;
  stopTask: NonNullable<BotsStopPort['stopTask']>;
  t: T;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    // Stop worker stays offered while this runs and, when it is partial,
    // after: the task is cancelled before its worker is confirmed stopped.
    markWorkerStopUnfinished(taskId, true);
    try {
      const r = await stopTask(taskId);
      markWorkerStopUnfinished(taskId, !r.ok && r.code === 'partial');
      useStore.getState().pushToast({ message: stopTaskSummary(task, r, t), level: r.ok ? 'info' : 'error' });
      if (r.ok) onClose();
    } catch (err) {
      useStore.getState().pushToast({ message: `${t('botsPage.stop.workerFailed', { task })} ${err instanceof Error ? err.message : String(err)}`, level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-3 py-2" data-bots-worker-panel-stop-confirm>
      <InlineConfirm
        text={t('botsPage.stop.workerConfirm', { task })}
        confirmLabel={t('botsPage.stop.bot')}
        cancelLabel={t('room.hq.cancel')}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={onClose}
        testId="bots-stop-worker"
      />
    </div>
  );
}

/** The header's ⋮: Open in Workspaces, Resume for an ended task whose
 *  stopped worker can resume the same conversation, and Stop worker for a
 *  live worker whose task is still open. */
function PanelMenu({ workspaceId, t, onResume, onStop }: { workspaceId: string; t: T; onResume?: () => void; onStop?: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  // The menu's keys: arrows, Home and End move between the items; the
  // first is focused when it opens.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length
      : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  };
  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        data-bots-worker-panel-menu
        aria-label={t('botsPage.worker.menu')}
        title={t('botsPage.worker.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`wmux-bots-icon-button ${open ? 'is-open' : ''} ${FOCUS_RING}`}
      >
        <IconMoreHorizontal size={14} />
      </button>
      {open && (
        <Popover
          ref={menuRef}
          role="menu"
          aria-label={t('botsPage.worker.menu')}
          className="absolute right-0 top-full z-40 mt-1 min-w-[180px]"
          onKeyDown={onMenuKey}
        >
          {onResume && (
            <button
              type="button"
              role="menuitem"
              data-bots-worker-panel-resume
              onClick={() => { close(); onResume(); }}
              className={`ui-section-row w-full text-left text-[13px] ${FOCUS_RING}`}
            >
              {t('botsPage.worker.resume')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            data-bots-worker-panel-workspaces
            onClick={() => { close(); openInWorkspaces(workspaceId); }}
            className={`ui-section-row w-full text-left text-[13px] ${FOCUS_RING}`}
          >
            {t('botsPage.chat.openInWorkspaces')}
          </button>
          {onStop && (
            <button
              type="button"
              role="menuitem"
              data-bots-worker-panel-stop
              onClick={() => { close(); onStop(); }}
              className={`ui-section-row w-full text-left text-[13px] text-[var(--accent-red)] ${FOCUS_RING}`}
            >
              {t('botsPage.worker.stop')}
            </button>
          )}
        </Popover>
      )}
    </span>
  );
}

export default function BotsWorkerPanel({ workspaceId, hosted, name, state, attention, t, onClose, onResume, stop, style }: {
  workspaceId: string;
  /** The panel hosts the workspace's panes (selectWorkerPanelHost); false:
   *  it stays on Workspaces and the panel offers the way there. */
  hosted: boolean;
  /** The worker's name as its row shows it (its task's title). */
  name: string;
  /** Its state in words (its row's), or null. */
  state: string | null;
  /** The worker waits on the owner: the state is the needs-you text. */
  attention: boolean;
  t: T;
  onClose: () => void;
  /** Resumes an ended task's stopped worker (absent: not resumable). */
  onResume?: () => void;
  /** Stops this live worker, its task cancelled (absent: not offered). */
  stop?: { taskId: string; stopTask: NonNullable<BotsStopPort['stopTask']> };
  /** The panel's width beside the chat (the splitter's). */
  style?: React.CSSProperties;
}): React.ReactElement | null {
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  // Stop worker's confirm belongs to the task it was asked for.
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  // The worker shown now, read when a stop answers.
  const shownRef = useRef(workspaceId);
  shownRef.current = workspaceId;
  // Cancel or a stop that went through closes that task's confirm and hands
  // focus back to the menu's ⋯ — only while the panel still shows the worker
  // the stop was asked for. A stop that answers after the owner moved on to
  // another worker leaves that worker's confirm and the focus alone.
  const closeStop = (taskId: string, askedFor: string) => {
    setConfirmStop((cur) => (cur === taskId ? null : cur));
    if (shownRef.current !== askedFor) return;
    asideRef.current?.querySelector<HTMLButtonElement>('[data-bots-worker-panel-menu]')?.focus();
  };
  if (!workspace) return null;
  return (
    <aside ref={asideRef} className="wmux-bots-worker" data-bots-worker-panel={workspaceId} aria-label={t('botsPage.chat.workerPanel', { name })} style={style}>
      {/* One line: the name, its state, the menu, Close. */}
      <div className="wmux-bots-worker-head">
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]">{name}</span>
          {state && (
            <span data-bots-worker-panel-state className={`shrink-0 truncate text-[11px] ${attention ? 'text-[var(--attention-text)]' : 'text-[var(--text-muted)]'}`}>{`· ${state}`}</span>
          )}
        </span>
        <PanelMenu workspaceId={workspaceId} t={t} onResume={onResume} onStop={stop ? () => setConfirmStop(stop.taskId) : undefined} />
        <button
          type="button"
          data-bots-worker-panel-close
          onClick={onClose}
          aria-label={t('botsPage.chat.closeWorker')}
          title={t('botsPage.chat.closeWorker')}
          className={`wmux-bots-icon-button ${FOCUS_RING}`}
        >
          <IconX size={14} />
        </button>
      </div>
      {stop && confirmStop === stop.taskId && (
        <StopWorkerConfirm task={name} taskId={stop.taskId} stopTask={stop.stopTask} t={t} onClose={() => closeStop(stop.taskId, workspaceId)} />
      )}
      {/* The terminal right under the header: the pane's tab strip and its
          split, browser and zoom controls are Workspaces' (bots.css hides
          them here — this panel only views the worker). */}
      <div className="wmux-bots-worker-body">
        {hosted ? (
          <div className="wmux-bots-worker-panes">
            <PaneContainer pane={workspace.rootPane} workspace={workspace} isWorkspaceVisible />
          </div>
        ) : (
          <div data-bots-worker-panel-elsewhere className="flex flex-col items-start gap-3 px-3 py-4">
            <p className="text-[12px] text-[var(--text-muted)]">{t('botsPage.chat.workerElsewhere')}</p>
            <Button size="sm" variant="secondary" onClick={() => { openInWorkspaces(workspaceId); }}>
              {t('botsPage.chat.openInWorkspaces')}
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
