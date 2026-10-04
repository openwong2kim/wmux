// ─── Moa archive dialog ──────────────────────────────────────────────────────
//
// The decisions the HQ migration archived: questions that were waiting on a
// workspace brain Moa replaced. Read-only — nothing here answers them. Closing
// the dialog acknowledges them, which retires the one-time notice.

import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import type { MoaArchivedDecision } from '../../../shared/moa';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';

export default function MoaArchiveDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const refreshMoa = useStore((s) => s.refreshMoa);
  const [decisions, setDecisions] = useState<MoaArchivedDecision[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.deck?.moa?.archiveList?.()
      .then((r) => { if (!cancelled) setDecisions(r?.decisions ?? []); })
      .catch(() => { if (!cancelled) setDecisions([]); });
    return () => { cancelled = true; };
  }, []);

  const close = () => {
    onClose();
    void (async () => {
      try {
        await window.electronAPI?.deck?.moa?.archiveAck?.();
      } catch {
        // the notice simply stays until the next close
      }
      await refreshMoa();
    })();
  };

  const nameOf = (id: string) => workspaces.find((w) => w.id === id)?.name ?? id;

  return (
    <Dialog onClose={close} width={520} data-testid="moa-archive-dialog">
      <DialogHeader
        title={t('moa.archive.title')}
        description={t('moa.archive.description')}
        closeLabel={t('moa.archive.close')}
      />
      <DialogBody>
        {decisions === null ? (
          <p className="ui-note" role="status">{t('moa.archive.loading')}</p>
        ) : decisions.length === 0 ? (
          <p className="ui-note">{t('moa.archive.empty')}</p>
        ) : (
          <ul className="ui-group m-0 p-0 list-none" data-testid="moa-archive-list">
            {decisions.map((d) => (
              <li key={`${d.workspaceId}:${d.decision.id}`} className="ui-row">
                <div className="ui-row-text">
                  <p className="ui-row-title">{d.decision.question}</p>
                  <p className="ui-row-detail">
                    {nameOf(d.workspaceId)} · {t('moa.archive.archivedAt', { time: new Date(d.archivedAt).toLocaleString() })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" size="md" onClick={close}>
          {t('moa.archive.close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
