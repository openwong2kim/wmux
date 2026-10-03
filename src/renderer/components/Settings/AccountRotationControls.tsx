import { useCallback, useEffect, useState } from 'react';
import type { RotationAccountRow, RotationSettings } from '../../../main/account/AccountRotationService';
import { useT } from '../../hooks/useT';
import Badge from '../ui/Badge';
import Checkbox from '../ui/Checkbox';

type RotationState = { settings: RotationSettings; rows: RotationAccountRow[] };

/** Re-read on this cadence while Settings is open; a list call never hits the network. */
const POLL_MS = 30_000;

export function useAccountRotation(): { state: RotationState | null; reload: () => void } {
  const [state, setState] = useState<RotationState | null>(null);
  const api = window.electronAPI?.accountRotation;
  const reload = useCallback(() => {
    if (!api) return;
    void api.get().then(setState).catch(() => { /* useIpc surfaces the error */ });
  }, [api]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [reload]);
  return { state, reload };
}

/** Per-vendor "Switch accounts by quota" switches at the top of Accounts. */
export function AccountRotationControls({ state, reload }: { state: RotationState | null; reload: () => void }): React.ReactElement | null {
  const t = useT();
  const api = window.electronAPI?.accountRotation;
  if (!api || !state) return null;
  const set = (vendor: 'claude' | 'codex', on: boolean) => {
    void api.set(vendor, on).then(reload).catch(() => { /* useIpc surfaces the error */ });
  };
  return (
    <>
      {(['claude', 'codex'] as const).map((vendor) => (
        <div key={vendor} className="ui-row" data-rotation-vendor={vendor}>
          <Checkbox
            checked={state.settings[vendor]}
            onCheckedChange={(on) => set(vendor, on)}
            aria-label={t(vendor === 'claude' ? 'accounts.rotateClaude' : 'accounts.rotateCodex')}
          />
          <span className="flex-1 text-[13px] text-[var(--text-main)]">
            {t(vendor === 'claude' ? 'accounts.rotateClaude' : 'accounts.rotateCodex')}
          </span>
        </div>
      ))}
      <p className="settings-note">{t('accounts.rotateDesc')}</p>
    </>
  );
}

/** Quota left on one account (lowest window) or "out of quota" until reset. */
export function RotationQuotaBit({ row }: { row: RotationAccountRow | undefined }): React.ReactElement | null {
  const t = useT();
  if (!row) return null;
  if (!row.verdict.usable) {
    const until = row.verdict.availableAtMs ? new Date(row.verdict.availableAtMs).toLocaleString() : null;
    return (
      <Badge tone="warning" className="shrink-0" title={until ? t('accounts.quotaOutUntil', { time: until }) : undefined}>
        {t('accounts.quotaOut')}
      </Badge>
    );
  }
  if (row.verdict.remaining === null) {
    return <span className="text-[11px] text-[var(--text-muted)] shrink-0">{t('accounts.quotaUnknown')}</span>;
  }
  return (
    <span className="text-[11px] text-[var(--text-sub)] shrink-0 tabular-nums">
      {t('accounts.quotaLeft', { pct: `${Math.round(row.verdict.remaining * 100)}%` })}
    </span>
  );
}
