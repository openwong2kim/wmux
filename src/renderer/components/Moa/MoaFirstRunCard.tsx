// ─── Moa first-run card ──────────────────────────────────────────────────────
//
// The one screen between "Moa is off" and "Moa is on": what Moa does and does
// not do, in plain words, and one button. The operator picks nothing — setup
// creates the app-owned "Moa" workspace and starts it at level 1 (observe and
// report). Opened from Settings › Moa; exported so other entry points can open
// it too.

import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';

export interface MoaSetupResult {
  ok: boolean;
  code?: string;
  archived?: number;
}

export interface MoaFirstRunCardViewProps {
  /** Runs setup. Resolves with main's answer; a throw counts as a failure. */
  onConfirm: () => Promise<MoaSetupResult>;
  /** Called once after setup succeeded, before the card closes. */
  onTurnedOn?: (result: MoaSetupResult) => void;
  onClose: () => void;
}

/** The store-free card: everything but where setup and the toast come from. */
export function MoaFirstRunCardView({ onConfirm, onTurnedOn, onClose }: MoaFirstRunCardViewProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    let result: MoaSetupResult;
    try {
      result = await onConfirm();
    } catch {
      result = { ok: false, code: 'failed' };
    }
    if (result.ok) {
      onTurnedOn?.(result);
      onClose();
      return;
    }
    setBusy(false);
    setError(t(result.code === 'store_corrupt' ? 'moa.firstRun.failedCorrupt' : 'moa.firstRun.failed'));
  };

  return (
    <Dialog
      onClose={() => { if (!busy) onClose(); }}
      closeOnEscape={!busy}
      width={460}
      data-testid="moa-first-run"
    >
      <DialogHeader
        title={t('moa.firstRun.title')}
        description={t('moa.firstRun.description')}
        closeLabel={t('moa.archive.close')}
        closeDisabled={busy}
      />
      <DialogBody>
        <section>
          <h3 className="ui-group-label">{t('moa.firstRun.does')}</h3>
          <ul className="m-0 pl-5 text-[13px] leading-5">
            <li>{t('moa.firstRun.doesDelegate')}</li>
            <li>{t('moa.firstRun.doesDecisions')}</li>
          </ul>
        </section>
        <section>
          <h3 className="ui-group-label">{t('moa.firstRun.doesnt')}</h3>
          <ul className="m-0 pl-5 text-[13px] leading-5">
            <li>{t('moa.firstRun.doesntCode')}</li>
            <li>{t('moa.firstRun.doesntOff')}</li>
          </ul>
        </section>
        <p className="ui-note">{t('moa.firstRun.level')} {t('moa.firstRun.workspace')}</p>
        {error && (
          <p className="ui-row-error" role="alert" data-testid="moa-first-run-error">{error}</p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
          {t('moa.firstRun.notNow')}
        </Button>
        <Button variant="primary" size="md" onClick={() => { void confirm(); }} disabled={busy} data-testid="moa-first-run-confirm">
          {busy ? t('moa.firstRun.working') : t('moa.firstRun.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Push the one archive notice a successful setup may owe the operator. */
export function archiveToastMessage(t: (key: string, vars?: Record<string, number>) => string, archived: number): string | null {
  if (archived <= 0) return null;
  return archived === 1 ? t('moa.archive.toastOne') : t('moa.archive.toast', { count: archived });
}

/** The card wired to the store: setup through createMoaHq, the archive notice
 *  as one toast. */
export default function MoaFirstRunCard({ onClose }: { onClose: () => void }) {
  const t = useT();
  const createMoaHq = useStore((s) => s.createMoaHq);
  const pushToast = useStore((s) => s.pushToast);
  return (
    <MoaFirstRunCardView
      onConfirm={createMoaHq}
      onTurnedOn={(result) => {
        const message = archiveToastMessage(t, result.archived ?? 0);
        if (message) pushToast({ message, level: 'info' });
      }}
      onClose={onClose}
    />
  );
}
