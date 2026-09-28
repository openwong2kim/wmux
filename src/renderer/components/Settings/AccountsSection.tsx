import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import type { Account } from '../../../main/account/accountStore';
import type { CredentialStatus } from '../../../main/ipc/handlers/account.handler';
import type { AccountUsageEntry } from '../../../main/account/AccountUsageService';
import { t } from '../../i18n';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconRefresh, IconX } from '../icons';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Input from '../ui/Input';
import SegmentedControl from '../ui/SegmentedControl';
import { SettingsSection } from './SettingsLayout';
import {
  startAccountLogin,
  checkAccountLoginAgain,
  reopenAccountLoginTab,
  cancelAccountLogin,
  subscribeAccountLogins,
  getPendingAccountLogins,
  type PendingLogin,
} from '../../utils/accountLogin';

type Vendor = 'claude' | 'codex';
type AccountRow = Account & { status: CredentialStatus; loginCommand: string };

// ─── M2 — per-account usage (hook-gated) ─────────────────────────────────────
// The 5h/7d numbers are populated in the background when a claude turn ends in a
// pane bound to this account (and the usage toggle is on). The ↻ button forces a
// manual probe regardless of the toggle — an explicit user action that reads
// that account's usage endpoint (no model request, no quota spent).

function fmtAge(fetchedAtMs: number | null): string {
  if (fetchedAtMs == null) return '';
  const secs = Math.max(0, Math.round((Date.now() - fetchedAtMs) / 1000));
  if (secs < 60) return t('accounts.ageSeconds', { n: secs });
  const mins = Math.round(secs / 60);
  if (mins < 60) return t('accounts.ageMinutes', { n: mins });
  return t('accounts.ageHours', { n: Math.round(mins / 60) });
}

/** The warning hue once a window crosses 80% — the "getting close" cue (amber
 *  in the amber theme, by DESIGN.md's warning rule). Below that it stays muted
 *  so the panel isn't a wall of color. */
function pctColor(pct: number): string {
  return pct >= 80 ? 'var(--accent-yellow)' : 'var(--text-sub)';
}

function UsageBit({ entry, onRefresh }: {
  entry: AccountUsageEntry | undefined;
  onRefresh: () => void;
}): React.ReactElement {
  const t = useT();
  const refreshBtn = (
    <Button
      variant="icon"
      onClick={onRefresh}
      title={t('accounts.refreshUsageTitle')}
      aria-label={t('accounts.refreshUsageTitle')}
    >
      <IconRefresh size={12} />
    </Button>
  );
  if (!entry) return refreshBtn;
  if (entry.status === 'ok' && entry.snapshot) {
    const s = entry.snapshot;
    return (
      <span className="flex items-center gap-1 text-[11px] text-[var(--text-sub)] tabular-nums">
        <span style={{ color: pctColor(s.sessionPct) }}>5h {s.sessionPct}%</span>
        <span className="text-[var(--text-subtle)]">·</span>
        <span style={{ color: pctColor(s.weeklyPct) }}>7d {s.weeklyPct}%</span>
        <span className="text-[var(--text-subtle)]" title={t('accounts.updatedTitle', { age: fmtAge(entry.fetchedAtMs) })}>· {fmtAge(entry.fetchedAtMs)}</span>
        {refreshBtn}
      </span>
    );
  }
  // Non-ok: keep the last-known snapshot visible (stale) if we have one, plus a
  // small reason. Otherwise just the refresh affordance.
  const reason = entry.status === 'unauthorized' ? t('accounts.statusAuthExpired')
    : entry.status === 'token-missing' ? '' // logged-out badge already conveys this
    : t('accounts.statusUnavailable');
  return (
    <span className="flex items-center gap-1 text-[11px] text-[var(--text-sub)] tabular-nums">
      {entry.snapshot && (
        <span title={t('accounts.lastKnownTitle')}>5h {entry.snapshot.sessionPct}% · 7d {entry.snapshot.weeklyPct}% ({t('accounts.stale')})</span>
      )}
      {reason && <span>{reason}</span>}
      {refreshBtn}
    </span>
  );
}

// ─── Settings → Accounts (M1) ────────────────────────────────────────────────
//
// Registry management + guided onboarding for multi-account. Onboarding
// provisions an isolated (hybrid-shared) config dir, then opens a terminal tab
// logged into that dir (utils/accountLogin), which watches credentialStatus and
// commits the account once login lands. wmux never touches the OAuth flow
// itself. Hidden entirely when the preload doesn't expose accounts.

function statusBadge(status: CredentialStatus): React.ReactElement {
  if (status.loggedIn) {
    return (
      <Badge tone="success" className="shrink-0">
        {status.subscriptionType ? status.subscriptionType : t('accounts.loggedIn')}
      </Badge>
    );
  }
  return (
    <Badge tone="danger" className="shrink-0">
      {t('accounts.loggedOut')}
    </Badge>
  );
}

function CopyCommandButton({ command }: { command: string }): React.ReactElement {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="md"
      title={command}
      onClick={() => {
        void window.clipboardAPI?.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? t('common.copied') : t('accounts.copyLoginCommand')}
    </Button>
  );
}

/** A login that is open in a terminal tab and not yet detected. */
function PendingLoginRow({ entry }: { entry: PendingLogin }): React.ReactElement {
  const t = useT();
  const waiting = entry.phase === 'waiting' || entry.phase === 'starting';
  const failed = entry.phase === 'error';
  return (
    <div className="settings-row" data-account-login={entry.configDir}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[13px] text-[var(--text-main)]">
          {/* Amber = alive: the one live wait on this surface. */}
          {waiting && <span className="inline-block w-2 h-2 rounded-full animate-pulse shrink-0" style={{ background: 'var(--accent-amber)' }} />}
          {waiting
            ? t('accounts.waitingForLoginNamed', { name: entry.name })
            : failed
              ? t('accounts.loginStatusFailed', { name: entry.name })
              : t('accounts.loginTimedOut', { name: entry.name })}
        </div>
        {!entry.tabOpen && !failed && entry.phase !== 'starting' && (
          <div className="text-[11px] text-[var(--text-sub)]">{t('accounts.loginTabFailed')}</div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <CopyCommandButton command={entry.loginCommand} />
          <Button variant="ghost" size="md" onClick={() => cancelAccountLogin(entry.configDir)}>{t('common.cancel')}</Button>
          {!failed && entry.phase !== 'starting' && (
            <Button variant="secondary" size="md" onClick={() => { void reopenAccountLoginTab(entry.configDir); }}>
              {t('accounts.openLoginTab')}
            </Button>
          )}
          {!waiting && (
            <Button variant="primary" size="md" onClick={() => checkAccountLoginAgain(entry.configDir)}>
              {t('accounts.checkAgain')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function AddAccountWizard({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }): React.ReactElement {
  const t = useT();
  const [vendor, setVendor] = useState<Vendor>('claude');
  const [name, setName] = useState('');
  const [share, setShare] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const prepare = useCallback(async () => {
    setError(null);
    const api = window.electronAPI?.accounts;
    if (!api) return;
    if (!name.trim()) { setError(t('accounts.enterName')); return; }
    setBusy(true);
    try {
      const res = await api.onboardPrepare({ vendor, share });
      // Opens the login tab, closes Settings and watches for the login; the
      // account is registered once the credential shows up.
      await startAccountLogin({ vendor, name: name.trim(), configDir: res.configDir, loginCommand: res.loginCommand });
      onDone();
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
      setBusy(false);
    }
  }, [vendor, name, share, onDone, t]);

  return (
    <div className="settings-row" data-account-wizard>
      <div className="flex flex-col gap-3">
        <SegmentedControl
          value={vendor}
          onValueChange={setVendor}
          ariaLabel={t('accounts.addAccount')}
          options={[
            { value: 'claude', label: 'Claude' },
            { value: 'codex', label: 'Codex' },
          ]}
        />
        <Input
          className="settings-input"
          placeholder={t('accounts.namePlaceholder')}
          aria-label={t('accounts.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <label className="flex items-center gap-2 text-[13px] text-[var(--text-main)] cursor-pointer">
          <Checkbox checked={share} onCheckedChange={setShare} aria-label={t('accounts.copyDefaultSettings')} />
          {t('accounts.copyDefaultSettings')}
        </label>
        {share && <div className="text-[11px] text-[var(--text-sub)]">{t('accounts.independentProfile')}</div>}
        <div className="text-[11px] text-[var(--text-sub)]">{t('accounts.loginHowItWorks')}</div>
        {error && <div className="text-[11px] text-[var(--accent-red)]">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" size="md" onClick={prepare} disabled={busy}>{t('accounts.createAndLogin')}</Button>
        </div>
      </div>
    </div>
  );
}

export function AccountsSection(): React.ReactElement | null {
  const t = useT();
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removeNotice, setRemoveNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<Map<string, AccountUsageEntry>>(new Map());
  const pending = useSyncExternalStore(subscribeAccountLogins, getPendingAccountLogins);

  const reload = useCallback(() => {
    const api = window.electronAPI?.accounts;
    if (!api) { setLoaded(true); return; }
    void api.list().then((res) => { setRows(res.accounts); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  // A login finishing (or being cancelled) changes the registry / status badges.
  useEffect(() => subscribeAccountLogins(reload), [reload]);

  // M2: seed the usage cache on mount, then live-update on per-account pushes.
  useEffect(() => {
    const api = window.electronAPI?.accounts;
    if (!api?.usageList) return;
    void api.usageList().then((entries) => {
      // Merge, don't overwrite: onUsageUpdate is subscribed synchronously but
      // usageList resolves after an IPC round-trip, so a live push can land
      // FIRST. A blind `new Map(entries)` would clobber that fresher push with
      // the older initial snapshot (CodeRabbit). Keep whichever entry was
      // fetched more recently per account. (fetchedAtMs is monotone per push.)
      setUsage((prev) => {
        const next = new Map(prev);
        for (const e of entries) {
          const cur = next.get(e.accountId);
          if (!cur || (e.fetchedAtMs ?? 0) >= (cur.fetchedAtMs ?? 0)) next.set(e.accountId, e);
        }
        return next;
      });
    }).catch(() => { /* usage is best-effort — the registry still renders */ });
    const off = api.onUsageUpdate?.((entry) => {
      setUsage((prev) => new Map(prev).set(entry.accountId, entry));
    });
    return off;
  }, []);

  // M2 (Claude+Codex review): the "Nm ago" age is computed at render time, so
  // without a rerender it would freeze between usage pushes. Tick every 30s
  // while any usage entry is shown so the freshness label advances. `ageTick`
  // is intentionally unused as a value — bumping it just forces the rerender.
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    if (usage.size === 0) return;
    const t = setInterval(() => setAgeTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [usage.size]);

  // Hidden when the preload predates multi-account.
  if (!window.electronAPI?.accounts) return null;

  const remove = (id: string) => {
    const api = window.electronAPI?.accounts;
    if (api) {
      void api.remove(id).then((res) => {
        const n = res.affectedWorkspaceIds.length;
        // Tell the user which workspaces now fall back to the default account
        // instead of silently reverting them (Codex review P2).
        setRemoveNotice(n > 0
          ? (n === 1 ? t('accounts.removedReverted', { n }) : t('accounts.removedRevertedPlural', { n }))
          : t('accounts.removed'));
        setTimeout(() => setRemoveNotice(null), 6000);
        reload();
      }).catch(() => { /* useIpc surfaces the error */ });
    }
    setConfirmRemove(null);
  };
  const rename = (id: string) => {
    const api = window.electronAPI?.accounts;
    if (api && editName.trim()) {
      void api.rename({ id, name: editName.trim() }).then(reload).catch(() => { /* useIpc surfaces the error */ });
    }
    setEditingId(null);
  };

  return (
    // No heading: the Accounts page title already names this, its only group.
    <SettingsSection id="claudeacct">
      <p className="settings-note">{t('accounts.intro')}</p>
      {removeNotice && <p className="settings-note">{removeNotice}</p>}
      {loaded && rows.length === 0 && !adding && (
        <p className="settings-note">{t('accounts.empty')}</p>
      )}
      {rows.map((r) => (
        <div key={r.id} className="ui-row" data-account-row={r.id}>
          <Badge className="shrink-0">{r.vendor}</Badge>
          {editingId === r.id ? (
            <Input
              className="settings-input flex-1"
              aria-label={t('accounts.namePlaceholder')}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') rename(r.id); if (e.key === 'Escape') setEditingId(null); }}
              onBlur={() => rename(r.id)}
              autoFocus
            />
          ) : (
            <button
              type="button"
              className={`flex-1 min-w-0 text-left text-[13px] font-medium text-[var(--text-main)] truncate hover:underline rounded ${FOCUS_RING}`}
              onClick={() => { setEditingId(r.id); setEditName(r.name); }}
            >
              {r.name}
            </button>
          )}
          {statusBadge(r.status)}
          {(!r.status.loggedIn || usage.get(r.id)?.status === 'unauthorized')
            && !pending.some((p) => p.configDir === r.configDir) && (
            <Button
              variant="secondary"
              size="md"
              className="shrink-0"
              onClick={() => {
                void startAccountLogin({
                  vendor: r.vendor, name: r.name, configDir: r.configDir, loginCommand: r.loginCommand, accountId: r.id,
                });
              }}
            >
              {t('accounts.loginAgain')}
            </Button>
          )}
          {r.vendor === 'claude' && (
            <UsageBit
              entry={usage.get(r.id)}
              onRefresh={() => window.electronAPI?.accounts?.usageRefresh?.(r.id)}
            />
          )}
          {confirmRemove === r.id ? (
            <span className="flex items-center gap-2 shrink-0">
              <Button variant="ghost" size="md" onClick={() => setConfirmRemove(null)}>{t('common.cancel')}</Button>
              <Button variant="danger" size="md" onClick={() => remove(r.id)}>{t('common.remove')}</Button>
            </span>
          ) : (
            <Button
              variant="icon"
              className="shrink-0"
              onClick={() => setConfirmRemove(r.id)}
              title={t('accounts.unregisterTitle')}
              aria-label={t('accounts.unregisterTitle')}
            >
              <IconX size={12} />
            </Button>
          )}
        </div>
      ))}
      {pending.map((p) => <PendingLoginRow key={p.configDir} entry={p} />)}
      {adding ? (
        <AddAccountWizard onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />
      ) : (
        <div className="settings-row" style={{ minHeight: 0 }}>
          {/* With no account yet, adding one is what the tab is for. */}
          <Button
            variant={rows.length === 0 ? 'primary' : 'secondary'}
            size="md"
            className="self-start"
            onClick={() => setAdding(true)}
          >
            {t('accounts.addAccount')}
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}
