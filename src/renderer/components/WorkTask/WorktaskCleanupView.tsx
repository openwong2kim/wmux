// J3 §1 — task cleanup list (palette entry). Shows four categories from dedicated root
// disk canonical scan (unmaterialized open, disk missing, preserved remnant, unlinked directory).
//
// Canonical = disk. Reconcile open set is union of daemon authoritative list + all open the
// renderer knows (missionByPaneGroup), so active worktrees owned by other parent workspaces are
// not misclassified as orphans. Open task anomalies (unmaterialized, disk missing, preserved)
// are reconciled via "close" (TaskCloseService); unlinked directories show path and guidance
// only (auto-delete is out of J3 scope — manual cleanup after human review).

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { WorktaskScanEntryWire, WorktaskScanCategoryWire } from '../../../shared/workTask';

const CATEGORY_LABEL_KEY: Record<WorktaskScanCategoryWire, string> = {
  'unmaterialized-open': 'worktask.cleanup.cat.unmaterialized',
  'disk-missing': 'worktask.cleanup.cat.diskMissing',
  preserved: 'worktask.cleanup.cat.preserved',
  'orphan-dir': 'worktask.cleanup.cat.orphan',
};

const CATEGORY_COLOR: Record<WorktaskScanCategoryWire, string> = {
  'unmaterialized-open': 'var(--accent-yellow, #f9e2af)',
  'disk-missing': 'var(--accent-red, #f87171)',
  preserved: 'var(--accent-blue, #89b4fa)',
  'orphan-dir': 'var(--text-muted)',
};

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

  const runScan = useCallback(async () => {
    const api = window.electronAPI.workTask;
    if (!api || !activeWorkspaceId) return;
    setLoading(true);
    setError(null);
    // Pass all open missions the renderer knows (all parents) as reconcile hints. F1: include
    // each mission's owner ws id so reconciling close for tasks owned by another parent is
    // invoked with that owner identity (close authz is owner-scoped).
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
      // F1 — close uses task owner-scoped authz, so call with entry owner ws id (not active ws).
      // Fall back to active ws when owner unknown (consistent when opened from same parent).
      const closeAs = ownerWorkspaceId || activeWorkspaceId;
      if (!api || !closeAs) return;
      setBusyTaskId(taskId);
      try {
        const res = await api.close(taskId, closeAs);
        if (res.ok) {
          pushToast({ level: 'info', message: t('worktask.cleanup.closed') });
        } else if (res.reason === 'dirty') {
          pushToast({ level: 'warn', message: t('worktask.cleanup.preserved') });
        } else if (res.reason === 'unpushed') {
          pushToast({ level: 'warn', message: t('worktask.cleanup.unpushed', { count: res.aheadCount ?? '' }) });
        } else {
          pushToast({ level: 'error', message: t('worktask.cleanup.closeFailed', { error: res.error ?? '' }) });
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

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setVisible(false);
      }}
    >
      <div
        className="w-[560px] max-h-[70vh] flex flex-col rounded-xl overflow-hidden shadow-2xl"
        style={{ backgroundColor: 'var(--bg-base)', border: '1px solid var(--bg-surface)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--bg-surface)]">
          <span className="text-sm font-semibold text-[var(--text-main)]">{t('worktask.cleanup.title')}</span>
          <div className="flex-1" />
          <button
            className="px-2 py-0.5 rounded text-[11px] text-[var(--text-sub)] hover:text-[var(--text-main)] border border-[var(--bg-mantle)]"
            onClick={() => void runScan()}
            disabled={loading}
          >
            {loading ? t('worktask.cleanup.scanning') : t('worktask.cleanup.rescan')}
          </button>
          <button
            className="px-2 py-0.5 rounded text-[11px] text-[var(--text-sub)] hover:text-[var(--text-main)]"
            onClick={() => setVisible(false)}
          >
            {t('worktask.cleanup.dismiss')}
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-2">
          {scannedRoot && (
            <div className="px-2 py-1 text-[10px] text-[var(--text-muted)] font-mono truncate" title={scannedRoot}>
              {t('worktask.cleanup.root')}: {scannedRoot}
            </div>
          )}
          {error && <div className="px-2 py-2 text-[11px] text-[var(--accent-red,#f87171)]">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="px-2 py-8 text-center text-[12px] text-[var(--text-muted)]">
              {t('worktask.cleanup.empty')}
            </div>
          )}
          {entries.map((e, i) => {
            const canClose = e.taskId && e.category !== 'orphan-dir';
            return (
              <div
                key={`${e.category}-${e.taskId ?? e.worktreePath ?? i}`}
                className="flex items-start gap-2 px-2 py-2 border-b border-[var(--bg-mantle)]"
              >
                <span
                  className="text-[9px] font-semibold px-1.5 py-0.5 rounded mt-0.5 shrink-0"
                  style={{ color: CATEGORY_COLOR[e.category], border: `1px solid ${CATEGORY_COLOR[e.category]}` }}
                >
                  {t(CATEGORY_LABEL_KEY[e.category])}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-[var(--text-main)] truncate">{e.title ?? e.taskId ?? t('worktask.cleanup.unnamed')}</div>
                  {e.worktreePath && (
                    <div className="text-[10px] text-[var(--text-muted)] font-mono truncate" title={e.worktreePath}>
                      {e.worktreePath}
                    </div>
                  )}
                  {e.detail && <div className="text-[10px] text-[var(--text-sub)]">{e.detail}</div>}
                  {e.closedAt && (
                    <div className="text-[10px] text-[var(--text-muted)]">
                      {t('worktask.cleanup.closedAt')}: {new Date(e.closedAt).toLocaleString()}
                    </div>
                  )}
                </div>
                {canClose && (
                  <button
                    className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-mantle)] text-[var(--text-sub)] hover:text-[var(--accent-red,#f87171)] border border-[var(--bg-mantle)] disabled:opacity-40 shrink-0"
                    onClick={() => void handleClose(e.taskId!, e.ownerWorkspaceId)}
                    disabled={busyTaskId !== null}
                  >
                    {busyTaskId === e.taskId ? t('worktask.cleanup.closing') : t('worktask.cleanup.close')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
