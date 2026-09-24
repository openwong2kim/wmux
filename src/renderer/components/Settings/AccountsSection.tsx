import { useState, useEffect, useCallback, useRef } from 'react';
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

type Vendor = 'claude' | 'codex';
type AccountRow = Account & { status: CredentialStatus };

// ─── M2 — per-account usage (hook-gated) ─────────────────────────────────────
// The 5h/7d numbers are populated in the background when a claude turn ends in a
// pane bound to this account (and the usage toggle is on). The ↻ button forces a
// manual probe regardless of the toggle — an explicit user action spends one
// 1-token request against that account's quota.

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
// provisions an isolated (hybrid-shared) config dir, then hands the user the
// exact one-line command to log in there; the wizard polls credentialStatus and
// commits the account automatically once login lands. wmux never touches the
// OAuth flow itself. Hidden entirely when the preload doesn't expose accounts.

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

// Login completion is polled for at most this long, then the wizard offers a
// manual "I've logged in" confirm. Bounds the credential I/O (review) and covers
// macOS claude (where the credential can't be read per-account at all).
const POLL_TIMEOUT_MS = 3 * 60 * 1000;

function AddAccountWizard({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }): React.ReactElement {
  const t = useT();
  const [vendor, setVendor] = useState<Vendor>('claude');
  const [name, setName] = useState('');
  const [share, setShare] = useState(true);
  const [prep, setPrep] = useState<{ configDir: string; loginCommand: string; credentialReadSupported: boolean } | null>(null);
  const [phase, setPhase] = useState<'form' | 'login' | 'done'>('form');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  };
  useEffect(() => stopPoll, []);

  const commit = useCallback((configDir: string) => {
    const api = window.electronAPI?.accounts;
    if (!api) return;
    void api.add({ name: name.trim(), vendor, configDir })
      .then(() => { setPhase('done'); })
      .catch((e) => setError(String((e as { message?: string })?.message ?? e)));
  }, [name, vendor]);

  const prepare = useCallback(async () => {
    setError(null);
    const api = window.electronAPI?.accounts;
    if (!api) return;
    if (!name.trim()) { setError(t('accounts.enterName')); return; }
    try {
      const res = await api.onboardPrepare({ vendor, share });
      setPrep(res);
      setPhase('login');
      setPollTimedOut(false);
      // Auto-detect login (credential file appears) — but only when the platform
      // supports a per-account credential read. macOS claude can't, so we go
      // straight to manual confirm.
      if (res.credentialReadSupported) {
        pollRef.current = setInterval(() => {
          void api.credentialStatus({ vendor, configDir: res.configDir }).then((st) => {
            if (st.loggedIn) { stopPoll(); commit(res.configDir); }
          }).catch(() => { /* transient — keep polling */ });
        }, 2000);
        // Bounded: stop spinning after the timeout and offer manual confirm.
        timeoutRef.current = setTimeout(() => { stopPoll(); setPollTimedOut(true); }, POLL_TIMEOUT_MS);
      } else {
        setPollTimedOut(true);
      }
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    }
  }, [vendor, name, share, commit]);

  return (
    <div className="settings-row" data-account-wizard>
      {phase === 'form' && (
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
          {error && <div className="text-[11px] text-[var(--accent-red)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="md" onClick={onCancel}>{t('common.cancel')}</Button>
            <Button variant="primary" size="md" onClick={prepare}>{t('accounts.createAndLogin')}</Button>
          </div>
        </div>
      )}
      {phase === 'login' && prep && (
        <div className="flex flex-col gap-3">
          <div className="text-[13px] text-[var(--text-main)]">
            {vendor === 'claude' ? t('accounts.runLoginCommandClaude') : t('accounts.runLoginCommand')}
          </div>
          <div className="flex items-center gap-2">
            {/* The login command is machine evidence: mono. */}
            <code className="ui-code flex-1 truncate" style={{ fontSize: 11, padding: '6px 8px' }} title={prep.loginCommand}>
              {prep.loginCommand}
            </code>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                void window.clipboardAPI?.writeText(prep.loginCommand);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </Button>
          </div>
          {share && (
            <div className="text-[11px] text-[var(--text-sub)]">
              {t('accounts.independentProfile')}
            </div>
          )}
          {!prep.credentialReadSupported && (
            <div className="text-[11px] text-[var(--text-sub)]">
              {t('accounts.macosManualLogin')}
            </div>
          )}
          {prep.credentialReadSupported && !pollTimedOut ? (
            <div className="flex items-center gap-2 text-[11px] text-[var(--text-sub)]">
              {/* Amber = alive: the one live wait on this surface. */}
              <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent-amber)' }} />
              {t('accounts.waitingForLogin')}
            </div>
          ) : null}
          {error && <div className="text-[11px] text-[var(--accent-red)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="md" onClick={() => { stopPoll(); onCancel(); }}>{t('common.cancel')}</Button>
            {(pollTimedOut || !prep.credentialReadSupported) && (
              <Button variant="primary" size="md" onClick={() => { stopPoll(); commit(prep.configDir); }}>
                {t('accounts.iveLoggedIn')}
              </Button>
            )}
          </div>
        </div>
      )}
      {phase === 'done' && (
        <div className="flex items-center justify-between gap-3">
          <div className="text-[13px]" style={{ color: 'var(--accent-green)' }}>{t('accounts.accountAdded')}</div>
          <Button variant="primary" size="md" onClick={onDone}>{t('common.done')}</Button>
        </div>
      )}
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

  const reload = useCallback(() => {
    const api = window.electronAPI?.accounts;
    if (!api) { setLoaded(true); return; }
    void api.list().then((res) => { setRows(res.accounts); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => { reload(); }, [reload]);

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
