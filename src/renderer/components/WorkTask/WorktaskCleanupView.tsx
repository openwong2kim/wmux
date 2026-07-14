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
