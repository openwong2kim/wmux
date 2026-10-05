// Receipts for hand-offs Moa delivered without a click (both the target
// workspace and Moa's HQ in danger mode). Non-blocking and neutral: nothing
// here waits on the operator, it only says what happened and offers Stop.
import { useState } from 'react';
import { useMoaHandoffReceipts, type MoaHandoffReceiptsApi } from './useMoaPanelData';
import Button from '../../ui/Button';
import { FOCUS_RING } from '../../focusRing';

type T = (key: string, vars?: Record<string, string | number>) => string;

export function MoaHandoffReceipts({
  api,
  workspaceName,
  onOpenPane,
  t,
}: {
  api: MoaHandoffReceiptsApi | undefined;
  workspaceName: (id: string) => string | undefined;
  onOpenPane?: (workspaceId: string, paneId?: string) => void;
  t: T;
}): React.ReactElement | null {
  const { receipts, refresh } = useMoaHandoffReceipts(api);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [stopped, setStopped] = useState<ReadonlySet<string>>(() => new Set());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const visible = receipts.filter((r) => !dismissed.has(r.id));
  if (visible.length === 0) return null;

  const add = (set: ReadonlySet<string>, id: string) => new Set(set).add(id);
  const drop = (set: ReadonlySet<string>, id: string) => { const n = new Set(set); n.delete(id); return n; };

  const stop = async (id: string) => {
    if (!api || stopping.has(id)) return;
    setStopping((s) => add(s, id));
    setFailed((s) => drop(s, id));
    let ok = false;
    try { ok = (await api.handoffStop({ id })).ok; } catch { ok = false; }
    setStopping((s) => drop(s, id));
    if (ok) { setStopped((s) => add(s, id)); refresh(); } else setFailed((s) => add(s, id));
  };

  return (
    <section data-moa-handoff-receipts aria-label={t('moa.receipts.title')} className="px-3 pt-2 pb-1">
      <ul className="m-0 p-0 list-none flex flex-col gap-1">
        {visible.map((r) => {
          const name = r.targetWorkspaceName || workspaceName(r.targetWorkspaceId) || t('moa.panel.unknownWorkspace');
          const isStopped = r.stopped || stopped.has(r.id);
          return (
            <li key={r.id} data-moa-handoff-receipt={r.id} className="flex flex-col gap-1 rounded-md border border-[var(--line)] px-2 py-1.5 text-[12px] text-[var(--text-sub)]">
              <div className="flex items-start gap-1.5">
                <span className="min-w-0 flex-1 break-words">{t('moa.receipts.line', { title: r.title, workspace: name })}</span>
                <Button
                  variant="icon"
                  aria-label={t('moa.receipts.dismiss')}
                  onClick={() => setDismissed((s) => add(s, r.id))}
                  className="shrink-0 w-5 h-5 text-[12px]"
                  data-moa-handoff-receipt-dismiss
                >
                  ×
                </Button>
              </div>
              <div className="flex items-center gap-2">
                {isStopped ? (
                  <span data-moa-handoff-receipt-stopped>{t('moa.receipts.stopped')}</span>
                ) : (
                  <Button variant="secondary" size="sm" disabled={stopping.has(r.id)} onClick={() => void stop(r.id)} data-moa-handoff-receipt-stop>
                    {t('moa.receipts.stop')}
                  </Button>
                )}
                {onOpenPane && (
                  <button
                    type="button"
                    onClick={() => onOpenPane(r.targetWorkspaceId, r.targetPaneId)}
                    className={`text-[var(--accent)] hover:underline underline-offset-2 ${FOCUS_RING}`}
                    data-moa-handoff-receipt-open
                  >
                    {t('moa.panel.openPane')}
                  </button>
                )}
              </div>
              {failed.has(r.id) && (
                <p role="alert" className="m-0 text-[11px] text-[var(--accent-red)]">{t('moa.receipts.stopFailed')}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
