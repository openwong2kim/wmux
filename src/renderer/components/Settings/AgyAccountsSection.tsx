import { useCallback, useEffect, useState } from 'react';
import type { AgyAccountRow, AgyAccountsSnapshot } from '../../../shared/agyAccounts';
import type { AgyLoginState } from '../../../main/account/AgyAccountService';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { IconX } from '../icons';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Input from '../ui/Input';
import { SettingsSection } from './SettingsLayout';
import { openTerminalTab } from '../../utils/accountLogin';

type Snapshot = AgyAccountsSnapshot & { login: AgyLoginState };

/** Snapshots carry the quota fractions the sensor last saw for each account;
 *  re-list on this cadence so a cooldown that ends shows up without a push. */
const POLL_MS = 15_000;

function pct(fraction: number | undefined): string | null {
  return typeof fraction === 'number' && Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : null;
}

function QuotaBits({ row }: { row: AgyAccountRow }): React.ReactElement | null {
  const t = useT();
  const q = row.quota?.quota;
  const fiveH = pct(q?.['gemini-5h']?.remaining_fraction);
  const weekly = pct(q?.['gemini-weekly']?.remaining_fraction);
  if (!fiveH && !weekly) {
    return <span className="text-[11px] text-[var(--text-muted)] shrink-0">{t('agyAccounts.quotaUnknown')}</span>;
  }
  return (
    <span className="text-[11px] text-[var(--text-sub)] shrink-0 tabular-nums" title={t('agyAccounts.quotaTitle')}>
      {fiveH && t('agyAccounts.quota5h', { pct: fiveH })}
      {fiveH && weekly && ' · '}
      {weekly && t('agyAccounts.quotaWeekly', { pct: weekly })}
    </span>
  );
}

function StateBadge({ row }: { row: AgyAccountRow }): React.ReactElement {
  const t = useT();
  if (row.state === 'needs-reauth') return <Badge tone="danger" className="shrink-0">{t('agyAccounts.needsSignIn')}</Badge>;
  if (row.state === 'exhausted') {
    const until = row.availableAtMs ? new Date(row.availableAtMs).toLocaleString() : null;
    return (
      <Badge tone="warning" className="shrink-0" title={until ? t('agyAccounts.exhaustedUntil', { time: until }) : undefined}>
        {t('agyAccounts.exhausted')}
      </Badge>
    );
  }
  if (row.active) return <Badge tone="success" className="shrink-0">{t('agyAccounts.active')}</Badge>;
  return <Badge className="shrink-0">{t('agyAccounts.ready')}</Badge>;
}

/**
 * Settings → Accounts → Antigravity (agy). agy keeps ONE sign-in for the whole
 * machine, so these accounts are not bound per workspace like Claude/Codex:
 * wmux keeps a vault copy of each and swaps the active one — on demand here,
 * and automatically before each agy launch when the active account is out of
 * quota.
 */
export function AgyAccountsSection(): React.ReactElement | null {
  const t = useT();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const api = window.electronAPI?.agyAccounts;

  const reload = useCallback(() => {
    if (!api) return;
    void api.list().then(setSnap).catch(() => { /* useIpc surfaces the error */ });
  }, [api]);

  useEffect(() => {
    reload();
    const off = api?.onChanged(reload);
    const timer = setInterval(reload, POLL_MS);
    return () => { off?.(); clearInterval(timer); };
  }, [api, reload]);

  if (!api || !snap) return null;
  if (!snap.supported) {
    return (
      <SettingsSection id="agyacct" title={t('agyAccounts.title')}>
        <p className="settings-note">{t('agyAccounts.unsupported')}</p>
      </SettingsSection>
    );
  }

  const run = (p: Promise<unknown>) => { void p.then(reload).catch((err: unknown) => {
    useStore.getState().pushToast({ level: 'error', message: err instanceof Error ? err.message : String(err) });
    reload();
  }); };

  const activeRegistered = snap.activeEmail !== null && snap.accounts.some((a) => a.active);

  const signInAnother = () => {
    run(api.beginLogin().then(async () => {
      const tab = await openTerminalTab({ initialCommand: 'agy', title: t('agyAccounts.loginTabTitle') });
      if (!tab) {
        await api.cancelLogin();
        useStore.getState().pushToast({ level: 'error', message: t('agyAccounts.loginTabFailed') });
      }
    }));
  };

  const rename = (id: string) => {
    run(api.rename(id, editLabel));
    setEditingId(null);
  };

  return (
    <SettingsSection id="agyacct" title={t('agyAccounts.title')} description={t('agyAccounts.intro')}>
      <p className="settings-note">{t('agyAccounts.machineWideNote')}</p>
      <div className="ui-row">
        <Checkbox
          checked={snap.autoRotate}
          onCheckedChange={(on) => run(api.setAutoRotate(on))}
          aria-label={t('agyAccounts.autoRotate')}
        />
        <span className="flex-1 text-[13px] text-[var(--text-main)]">{t('agyAccounts.autoRotate')}</span>
      </div>
      <p className="settings-note">{t('agyAccounts.autoRotateDesc')}</p>
      <p className="settings-note">{t('agyAccounts.rotateTerms')}</p>
      {snap.accounts.length === 0 && <p className="settings-note">{t('agyAccounts.empty')}</p>}
      {snap.accounts.map((r) => (
        <div key={r.id} className="ui-row" data-agy-account-row={r.id}>
          {editingId === r.id ? (
            <Input
              className="settings-input flex-1"
              aria-label={t('agyAccounts.labelPlaceholder')}
              placeholder={t('agyAccounts.labelPlaceholder')}
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') rename(r.id); if (e.key === 'Escape') setEditingId(null); }}
              onBlur={() => rename(r.id)}
              autoFocus
            />
          ) : (
            <button
              type="button"
              className="flex-1 min-w-0 text-left text-[13px] text-[var(--text-main)] truncate hover:underline rounded"
              onClick={() => { setEditingId(r.id); setEditLabel(r.label); }}
              title={r.email}
            >
              {r.label ? <><span className="font-medium">{r.label}</span> <span className="text-[var(--text-sub)]">{r.email}</span></> : r.email}
            </button>
          )}
          <StateBadge row={r} />
          <QuotaBits row={r} />
          {!r.active && r.state !== 'needs-reauth' && (
            <Button variant="secondary" size="md" className="shrink-0" disabled={snap.login.pending} onClick={() => run(api.activate(r.id))}>
              {t('agyAccounts.useNow')}
            </Button>
          )}
          {confirmRemove === r.id ? (
            <span className="flex items-center gap-2 shrink-0">
              <Button variant="ghost" size="md" onClick={() => setConfirmRemove(null)}>{t('common.cancel')}</Button>
              <Button variant="danger" size="md" onClick={() => { setConfirmRemove(null); run(api.remove(r.id)); }}>{t('common.remove')}</Button>
            </span>
          ) : (
            <Button
              variant="icon"
              className="shrink-0"
              onClick={() => setConfirmRemove(r.id)}
              title={t('agyAccounts.removeTitle')}
              aria-label={t('agyAccounts.removeTitle')}
            >
              <IconX size={12} />
            </Button>
          )}
        </div>
      ))}
      {snap.login.restoreFailed && !snap.login.pending && (
        <div className="ui-row" role="alert">
          <span className="flex-1 text-[13px] text-[var(--text-sub)]">
            {t('agyAccounts.restoreFailed', { email: snap.login.restoreFailed })}
          </span>
        </div>
      )}
      {snap.login.pending ? (
        <div className="ui-row">
          <span className="flex-1 text-[13px] text-[var(--text-sub)]">{t('agyAccounts.waitingForSignIn')}</span>
          <Button variant="ghost" size="md" onClick={() => run(api.cancelLogin())}>{t('common.cancel')}</Button>
        </div>
      ) : (
        <div className="settings-row flex gap-2" style={{ minHeight: 0 }}>
          {snap.activeEmail && !activeRegistered && (
            <Button variant="primary" size="md" onClick={() => run(api.addCurrent())}>
              {t('agyAccounts.addCurrent', { email: snap.activeEmail })}
            </Button>
          )}
          <Button variant={snap.accounts.length === 0 && !snap.activeEmail ? 'primary' : 'secondary'} size="md" onClick={signInAnother}>
            {t('agyAccounts.signInAnother')}
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}
