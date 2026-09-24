// J3 §1 — 태스크 정리 목록(팔레트 진입). 전용 루트 디스크 정본 스캔 결과를 4종
// (미물질화 open·디스크 결측·보존 잔존·무연결 디렉토리)으로 보여준다.
//
// 정본=디스크. reconcile 대상 open 집합은 데몬 권위 목록 + 렌더러가 아는 전체 open
// (missionByPaneGroup)의 합집합이라, 다른 부모 워크스페이스의 활성 worktree가
// orphan으로 오분류되지 않는다. open 태스크 이상(미물질화·디스크 결측·보존)은
// "닫기"(TaskCloseService)로 정합화하고, 무연결 디렉토리는 경로·안내만 표시한다
// (자동 삭제는 J3 비목표 — 사람이 확인 후 수동 정리).

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { findLeafPanes, activePaneTerminalPty } from '../../hooks/a2aAddressing';
import { formatBracketedPastePayload } from '../../utils/ptyMessageDelivery';
import type { WorktaskScanEntryWire, WorktaskScanCategoryWire } from '../../../shared/workTask';
import Dialog, { DialogBody, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import type { BadgeTone } from '../ui/Badge';
import { IconRefresh } from '../icons';

/** Why the last close attempt for a task failed — drives which next steps the
 *  row offers. 'dirty' is the only one a commit line can answer. */
type WorktaskCloseFailure = 'dirty' | 'unpushed' | 'error';

const CATEGORY_LABEL_KEY: Record<WorktaskScanCategoryWire, string> = {
  'unmaterialized-open': 'worktask.cleanup.cat.unmaterialized',
  'disk-missing': 'worktask.cleanup.cat.diskMissing',
  preserved: 'worktask.cleanup.cat.preserved',
  'orphan-dir': 'worktask.cleanup.cat.orphan',
};

// Status tones tint a neutral badge; steel is kept for focus and links.
const CATEGORY_TONE: Record<WorktaskScanCategoryWire, BadgeTone> = {
  'unmaterialized-open': 'warning',
  'disk-missing': 'danger',
  preserved: 'neutral',
  'orphan-dir': 'neutral',
};

// ─── C-4: the prepared commit line ──────────────────────────────────────
//
// A close that fails on a dirty worktree leaves the user with nothing to do
// from here. "Commit & close" writes a ready-to-run line into the task's own
// pane — it does NOT run it: what gets committed is the user's call, and an
// agent's uncommitted work is not something a cleanup dialog should decide.
//
// The line lists the changed paths EXPLICITLY. `git add -A` in a worktree an
// agent is still working in stages whatever else happens to be lying there;
// naming the paths keeps the commit to what the scan actually saw.
//
// Review fixes:
//  - every git verb is `git -C <worktree>`. The line is typed into a shell
//    whose cwd nobody controls; a bare `git add` in a shell that had cd'd
//    elsewhere would commit into the SHARED main checkout.
//  - the paths come from the status scan (`snapshot.targetDirtyFiles`), which
//    is `git status --porcelain -z` with `core.quotepath=false`: untracked
//    files included, renames as the new path, no shell-quoted escapes. The
//    numstat/`truncated`/`unsupported` lists are display artifacts — numstat
//    prints a rename as `old => new`, which is not an argv.
//  - the whole feature is POSIX-shell only. `shellQuote` is POSIX quoting and
//    PowerShell/cmd read `'…'` differently, so on win32 the row offers "Open
//    worktree" and nothing else rather than a line that quotes wrong.

/** Above this many changed paths the prepared line stops being something a
 *  human can read in a prompt — the view offers "open worktree" instead. */
export const PREPARED_COMMIT_PATH_CAP = 40;

/** POSIX single-quote escaping: everything inside '…' is literal, and a literal
 *  quote is written by closing, escaping, and reopening. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The prepared line is POSIX-shell syntax (`'…'` quoting, `&&`). cmd.exe and
 *  PowerShell both mis-read it, so the feature is simply absent on win32. */
export function preparedCommitSupported(platform: string): boolean {
  return platform !== 'win32';
}

/**
 * Build the line the pane is pre-filled with. Paths are deduped and sorted so
 * the same dirty worktree always produces the same line; the title becomes the
 * `wip:` subject. Every git invocation is pinned to `worktreePath` with `-C`.
 * Returns `null` when there is nothing to commit, when there are more paths
 * than a prepared line should carry, or when there is no worktree to pin to.
 */
export function buildPreparedCommitLine(args: {
  worktreePath: string;
  paths: readonly string[];
  title: string;
}): string | null {
  const worktreePath = args.worktreePath.trim();
  if (!worktreePath) return null;
  const unique = [...new Set(args.paths.filter((p) => p.trim().length > 0))].sort();
  if (unique.length === 0 || unique.length > PREPARED_COMMIT_PATH_CAP) return null;
  const subject = `wip: ${args.title.trim() || 'task'}`.replace(/\s+/g, ' ');
  const at = `git -C ${shellQuote(worktreePath)}`;
  return `${at} add -- ${unique.map(shellQuote).join(' ')} && ${at} commit -m ${shellQuote(subject)}`;
}

/** Why a task pane cannot take a prepared commit line. */
export type CommitTargetRefusal = 'no-pane' | 'agent-pane';

/**
 * Resolve the pty the line may be typed into.
 *
 * The pane a task runs in is normally the AGENT's TUI. Typing a git line there
 * does not reach a shell at all — it becomes a chat message, or worse, the
 * answer to whatever approval prompt the agent is sitting on. So the line is
 * only ever typed into a pty with no detected agent behind it.
 */
export function resolveCommitTargetPty(args: {
  ptyId: string | null;
  surfaceAgent: Record<string, { name: string } | undefined>;
}): { ok: true; ptyId: string } | { ok: false; reason: CommitTargetRefusal } {
  if (!args.ptyId) return { ok: false, reason: 'no-pane' };
  if (args.surfaceAgent[args.ptyId]?.name) return { ok: false, reason: 'agent-pane' };
  return { ok: true, ptyId: args.ptyId };
}

export default function WorktaskCleanupView() {
  const t = useT();
  const visible = useStore((s) => s.worktaskCleanupVisible);
  const setVisible = useStore((s) => s.setWorktaskCleanupVisible);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const missionByPaneGroup = useStore((s) => s.missionByPaneGroup);
  const pushToast = useStore((s) => s.pushToast);

  const [entries, setEntries] = useState<WorktaskScanEntryWire[]>([]);
  const [scannedRoot, setScannedRoot] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  // C-4: taskIds whose close failed, keyed by WHY. The row keeps the actions
  // that actually apply to that reason instead of a toast that scrolls away
  // with no next step — a commit line answers 'dirty', but an unpushed branch
  // needs a push, and committing again would only add to what is unpushed.
  const [closeFailed, setCloseFailed] = useState<Record<string, WorktaskCloseFailure>>({});

  const runScan = useCallback(async () => {
    const api = window.electronAPI.workTask;
    if (!api || !activeWorkspaceId) return;
    setLoading(true);
    setError(null);
    // 렌더러가 아는 전체 open 미션(모든 부모)을 reconcile 힌트로 넘긴다. F1: 각
    // 미션의 owner ws id도 실어, 다른 부모가 소유한 태스크의 정합화 close가 그
    // owner 신원으로 불리게 한다(close authz가 owner 스코프).
    const knownOpen = Object.values(missionByPaneGroup)
      .filter((m) => m.status === 'open')
      .map((m) => ({
        taskId: m.id,
        title: m.title,
        ownerWorkspaceId: m.owner?.verifiedWorkspaceId,
        ...(m.worktreePath ? { worktreePath: m.worktreePath } : {}),
      }));
    try {
      const res = await api.scan(activeWorkspaceId, knownOpen);
      if (res.ok) {
        setEntries(res.entries);
        setScannedRoot(res.scannedRoot);
      } else {
        setError(res.error);
        setEntries([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeWorkspaceId, missionByPaneGroup]);

  useEffect(() => {
    if (visible) void runScan();
  }, [visible, runScan]);

  const handleClose = useCallback(
    async (taskId: string, ownerWorkspaceId: string | undefined) => {
      const api = window.electronAPI.workTask;
      // F1 — close는 태스크 owner 스코프 authz라 엔트리의 owner ws id로 부른다
      // (활성 ws가 아님). owner를 모르면 활성 ws로 폴백(동일 부모에서 연 경우 정합).
      const closeAs = ownerWorkspaceId || activeWorkspaceId;
      if (!api || !closeAs) return;
      setBusyTaskId(taskId);
      try {
        const res = await api.close(taskId, closeAs);
        if (res.ok) {
          pushToast({ level: 'info', message: t('worktask.cleanup.closed') });
          setCloseFailed((prev) => {
            const { [taskId]: _done, ...rest } = prev;
            return rest;
          });
        } else if (res.reason === 'dirty') {
          pushToast({ level: 'warn', message: t('worktask.cleanup.preserved') });
          setCloseFailed((prev) => ({ ...prev, [taskId]: 'dirty' }));
        } else if (res.reason === 'unpushed') {
          pushToast({ level: 'warn', message: t('worktask.cleanup.unpushed', { count: res.aheadCount ?? '' }) });
          setCloseFailed((prev) => ({ ...prev, [taskId]: 'unpushed' }));
        } else {
          pushToast({ level: 'error', message: t('worktask.cleanup.closeFailed', { error: res.error ?? '' }) });
          setCloseFailed((prev) => ({ ...prev, [taskId]: 'error' }));
        }
      } catch (e) {
        pushToast({ level: 'error', message: t('worktask.cleanup.closeFailed', { error: e instanceof Error ? e.message : String(e) }) });
      } finally {
        setBusyTaskId(null);
        void runScan();
      }
    },
    [activeWorkspaceId, pushToast, runScan, t],
  );

  // C-4 "Open worktree" — reveal the directory the close refused to remove.
  // openPath resolves { ok, error }: a silent failure here leaves the user
  // staring at a button that did nothing.
  const handleOpenWorktree = useCallback(
    async (worktreePath: string) => {
      const res = await window.electronAPI.shell.openPath(worktreePath);
      if (!res.ok) {
        pushToast({
          level: 'error',
          message: t('worktask.cleanup.openWorktreeFailed', { error: res.error ?? '' }),
        });
      }
    },
    [pushToast, t],
  );

  // C-4 "Commit & close" — type a ready-to-run commit line into the task's own
  // pane and stop. Nothing is executed and nothing is submitted: the user reads
  // the paths, edits the message if they want, and presses Enter themselves.
  const handleCommitAndClose = useCallback(
    async (entry: WorktaskScanEntryWire) => {
      const worktreePath = entry.worktreePath;
      if (!worktreePath || !entry.taskId) return;
      const st = useStore.getState();
      // The task's own workspace is the one keyed by paneGroupId in the mission
      // cache; without it there is no pane to prepare the line in.
      const paneGroupId = Object.entries(st.missionByPaneGroup).find(
        ([, mission]) => mission.id === entry.taskId,
      )?.[0];
      const ws = paneGroupId ? st.workspaces.find((w) => w.id === paneGroupId) : undefined;
      const target = resolveCommitTargetPty({
        ptyId: ws ? activePaneTerminalPty(findLeafPanes(ws.rootPane), ws.activePaneId) : null,
        surfaceAgent: st.surfaceAgent,
      });
      if (!ws || !target.ok) {
        pushToast({
          level: 'warn',
          message:
            ws && !target.ok && target.reason === 'agent-pane'
              ? t('worktask.cleanup.commitNeedsShell')
              : t('worktask.cleanup.noPaneForCommit'),
        });
        return;
      }
      const ptyId = target.ptyId;
      const diff = await window.electronAPI.diff.read(worktreePath, '', 'workspace');
      if (!diff.ok) {
        pushToast({ level: 'error', message: t('worktask.cleanup.closeFailed', { error: diff.error }) });
        return;
      }
      // The status scan, not the rendered diff: it carries untracked files and
      // prints one unambiguous path per entry (rename → new path), where a
      // numstat line prints a rename as `old => new` and would become argv.
      const line = buildPreparedCommitLine({
        worktreePath,
        paths: diff.snapshot.targetDirtyFiles,
        title: entry.title ?? entry.taskId,
      });
      if (!line) {
        pushToast({ level: 'warn', message: t('worktask.cleanup.commitLineUnavailable') });
        return;
      }
      st.setActiveWorkspace(ws.id);
      // Bracketed paste, no trailing CR: the line lands at the prompt unrun.
      window.electronAPI.pty.write(ptyId, formatBracketedPastePayload(line));
      // Hand focus to the terminal holding the line before the list closes, so
      // the user's next Enter runs it instead of the dialog handing focus back
      // to its opener (which reopens this list). Loaded lazily: the terminal
      // registry pulls in xterm, which this view does not otherwise need.
      const { terminalRegistry } = await import('../../hooks/useTerminal');
      terminalRegistry.get(ptyId)?.focus();
      setVisible(false);
      pushToast({ level: 'info', message: t('worktask.cleanup.commitLinePrepared') });
    },
    [pushToast, setVisible, t],
  );

  // POSIX-shell quoting only (see preparedCommitSupported).
  const canPrepareCommit = preparedCommitSupported(window.electronAPI.platform);

  if (!visible) return null;

  // Escape, the backdrop and the header close all dismiss it (ui/Dialog) —
  // except while a task close is in flight, whose result lands in this list.
  const closeIfIdle = () => {
    if (busyTaskId === null) setVisible(false);
  };
  return (
    <Dialog
      onClose={closeIfIdle}
      closeOnBackdrop
      width={600}
      zIndexClassName="z-50"
      style={{ maxHeight: '70vh' }}
      data-testid="worktask-cleanup"
    >
      <DialogHeader
        title={t('worktask.cleanup.title')}
        closeLabel={t('worktask.cleanup.dismiss')}
        closeDisabled={busyTaskId !== null}
      />
      <DialogBody className="!gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <p className="m-0 flex-1 min-w-0 truncate text-[11px] text-[var(--text-sub)]" title={scannedRoot || undefined}>
            {scannedRoot && (
              <>
                {t('worktask.cleanup.root')}: <span className="font-mono">{scannedRoot}</span>
              </>
            )}
          </p>
          <Button size="sm" variant="secondary" className="shrink-0 gap-1" onClick={() => void runScan()} disabled={loading}>
            <IconRefresh size={12} />
            {loading ? t('worktask.cleanup.scanning') : t('worktask.cleanup.rescan')}
          </Button>
        </div>
        {error && <p className="ui-row-error !m-0 text-[13px]">{error}</p>}
        {!loading && !error && entries.length === 0 && (
          <p className="m-0 py-8 text-center text-[13px] text-[var(--text-sub)]">{t('worktask.cleanup.empty')}</p>
        )}
        {entries.length > 0 && (
          <div className="ui-group">
            {entries.map((e, i) => {
              const canClose = e.taskId && e.category !== 'orphan-dir';
              return (
                <div key={`${e.category}-${e.taskId ?? e.worktreePath ?? i}`} className="ui-row !items-start">
                  <div className="ui-row-text">
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="ui-row-title truncate">{e.title ?? e.taskId ?? t('worktask.cleanup.unnamed')}</p>
                      <Badge tone={CATEGORY_TONE[e.category]} className="shrink-0">
                        {t(CATEGORY_LABEL_KEY[e.category])}
                      </Badge>
                    </div>
                    {e.worktreePath && (
                      <p className="ui-row-detail font-mono truncate" title={e.worktreePath}>
                        {e.worktreePath}
                      </p>
                    )}
                    {e.detail && <p className="ui-row-detail">{e.detail}</p>}
                    {e.closedAt && (
                      <p className="ui-row-detail">
                        {t('worktask.cleanup.closedAt')}: {new Date(e.closedAt).toLocaleString()}
                      </p>
                    )}
                    {e.taskId && closeFailed[e.taskId] && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2" data-cleanup-close-failed>
                        {/* Only a worktree that still holds UNCOMMITTED work has a
                            commit line to prepare — an unpushed branch needs a
                            push, and a commit would only add to it. */}
                        {e.worktreePath && closeFailed[e.taskId] === 'dirty' && canPrepareCommit && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void handleCommitAndClose(e)}
                            data-cleanup-commit-close
                          >
                            {t('worktask.cleanup.commitAndClose')}
                          </Button>
                        )}
                        {e.worktreePath && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void handleOpenWorktree(e.worktreePath!)}
                            data-cleanup-open-worktree
                          >
                            {t('worktask.cleanup.openWorktree')}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  {canClose && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="shrink-0"
                      onClick={() => void handleClose(e.taskId!, e.ownerWorkspaceId)}
                      disabled={busyTaskId !== null}
                    >
                      {busyTaskId === e.taskId ? t('worktask.cleanup.closing') : t('worktask.cleanup.close')}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DialogBody>
    </Dialog>
  );
}
