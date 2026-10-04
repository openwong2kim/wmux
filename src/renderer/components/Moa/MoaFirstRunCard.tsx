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
import type { MoaSetupResult } from '../../../shared/moa';

export type { MoaSetupResult };

export interface MoaFirstRunCardViewProps {
  /** Runs setup. Resolves with main's answer; a throw counts as a failure. */
  onConfirm: () => Promise<MoaSetupResult>;
  /** Called once after setup succeeded, before the card closes. */
  onTurnedOn?: (result: MoaSetupResult) => void;
  onClose: () => void;
  /** Main already made a workspace the HQ but a later setup step failed:
   *  confirming finishes setup on that workspace. */
  pending?: boolean;
  /** Offered only to an existing orchestrator user with no HQ: turn the switch
   *  on and keep working the way they did before Moa. Resolves true when the
   *  switch went on. */
  onTurnOnOnly?: () => Promise<boolean>;
}

/** The store-free card: everything but where setup and the toast come from. */
export function MoaFirstRunCardView({ onConfirm, onTurnedOn, onClose, pending = false, onTurnOnOnly }: MoaFirstRunCardViewProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);
  const finishing = pending || committed;

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
    if (result.committed === true) setCommitted(true);
    setError(t(
      result.code === 'store_corrupt' ? 'moa.firstRun.failedCorrupt'
        : result.committed === true || finishing ? 'moa.firstRun.failedCommitted'
          : 'moa.firstRun.failed',
    ));
  };

  const turnOnOnly = async () => {
    if (!onTurnOnOnly) return;
    setBusy(true);
    setError(null);
    let ok = false;
    try {
      ok = await onTurnOnOnly();
    } catch {
      ok = false;
    }
    if (ok) {
      onClose();
      return;
    }
    setBusy(false);
    setError(t('moa.firstRun.failed'));
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
        {onTurnOnOnly && !finishing && (
          <section className="flex flex-col items-start gap-2" data-testid="moa-first-run-current">
            <p className="ui-note m-0">{t('moa.firstRun.turnOnOnlyNote')}</p>
            <Button variant="secondary" size="md" onClick={() => { void turnOnOnly(); }} disabled={busy} data-testid="moa-first-run-turn-on-only">
              {t('moa.firstRun.turnOnOnly')}
            </Button>
          </section>
        )}
        {error && (
          <p className="ui-row-error" role="alert" data-testid="moa-first-run-error">{error}</p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
          {t('moa.firstRun.notNow')}
        </Button>
        <Button variant="primary" size="md" onClick={() => { void confirm(); }} disabled={busy} data-testid="moa-first-run-confirm">
          {busy ? t('moa.firstRun.working') : t(finishing ? 'moa.firstRun.finish' : 'moa.firstRun.confirm')}
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
  const refreshMoa = useStore((s) => s.refreshMoa);
  const pushToast = useStore((s) => s.pushToast);
  const pending = useStore((s) => s.moaHqPendingId !== null);
  // An existing orchestrator user without an HQ may keep the old behaviour:
  // the switch on, no Moa workspace.
  const existingNoHq = useStore((s) => s.moa?.config.defaultReason === 'existing-brain' && s.moa.hq.state === 'unset');
  const turnOnOnly = async (): Promise<boolean> => {
    const r = await window.electronAPI.deck?.moa?.set(true);
    await refreshMoa();
    return !!r?.ok;
  };
  return (
    <MoaFirstRunCardView
      onConfirm={createMoaHq}
      pending={pending}
      onTurnOnOnly={existingNoHq && !pending ? turnOnOnly : undefined}
      onTurnedOn={(result) => {
        const message = archiveToastMessage(t, result.archived ?? 0);
        if (message) pushToast({ message, level: 'info' });
      }}
      onClose={onClose}
    />
  );
}
