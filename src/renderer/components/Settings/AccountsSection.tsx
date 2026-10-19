import { useState, useEffect, useCallback, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import type { Account } from '../../../main/account/accountStore';
import type { CredentialStatus } from '../../../main/ipc/handlers/account.handler';
import type { AccountUsageEntry } from '../../../main/account/AccountUsageService';
import { accountGroupOf, groupAccounts, MAX_ACCOUNT_GROUP_CHARS } from '../../../shared/accountGroup';
import { t } from '../../i18n';
import { useT } from '../../hooks/useT';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Field from '../ui/Field';
import Input from '../ui/Input';
import SegmentedControl from '../ui/SegmentedControl';
import Select from '../ui/Select';
import { SettingsSection, useOwnedDialog } from './SettingsLayout';
import { AccountRotationControls, RotationQuotaBit, useAccountRotation } from './AccountRotationControls';
import RemoteRowMenu, { type RemoteRowMenuItem } from '../Remote/RemoteRowMenu';
import { useStore } from '../../stores';
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

/** The account's last usage reading; Refresh lives in the row's ⋯ menu. */
function UsageBit({ entry }: { entry: AccountUsageEntry | undefined }): React.ReactElement | null {
  const t = useT();
  if (!entry) return null;
  if (entry.status === 'ok' && entry.snapshot) {
    const s = entry.snapshot;
    return (
      <span className="flex items-center gap-1 text-[11px] text-[var(--text-sub)] tabular-nums">
        <span style={{ color: pctColor(s.sessionPct) }}>5h {s.sessionPct}%</span>
        <span className="text-[var(--text-subtle)]">·</span>
        <span style={{ color: pctColor(s.weeklyPct) }}>7d {s.weeklyPct}%</span>
        <span className="text-[var(--text-subtle)]" title={t('accounts.updatedTitle', { age: fmtAge(entry.fetchedAtMs) })}>· {fmtAge(entry.fetchedAtMs)}</span>
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

/** One element says the login state: the tier while logged in, "Log in
 *  again" while logged out or expired, the logged-out badge while a login
 *  for it is already open. */
function LoginState({ row, expired, pending }: { row: AccountRow; expired: boolean; pending: boolean }): React.ReactElement {
  if (row.status.loggedIn && !expired) {
    return (
      <Badge tone="success" className="shrink-0">
        {row.status.subscriptionType ? row.status.subscriptionType : t('accounts.loggedIn')}
      </Badge>
    );
  }
  if (pending) return <Badge tone="danger" className="shrink-0">{t('accounts.loggedOut')}</Badge>;
  return (
    <Button
      variant="secondary"
      size="sm"
      className="shrink-0"
      onClick={() => {
        void startAccountLogin({
          vendor: row.vendor, name: row.name, configDir: row.configDir, loginCommand: row.loginCommand, accountId: row.id,
        });
      }}
    >
      {t('accounts.loginAgain')}
    </Button>
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
          {/* The accent = alive: the one live wait on this surface. */}
          {waiting && <span className="inline-block w-2 h-2 rounded-full animate-pulse shrink-0" style={{ background: 'var(--accent)' }} />}
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

/** The picker option that swaps it for a name field; a group name cannot hold a control character. */
const NEW_GROUP = '\u0000new';

/** A group: an existing one, none, or a new name typed in place. */
function GroupPicker({ value, groups, onSet }: {
  value: string;
  groups: string[];
  onSet: (group: string) => void;
}): React.ReactElement {
  const t = useT();
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const label = t('accounts.groupLabel');
  if (typing) {
    const commit = () => {
      setTyping(false);
      if (draft.trim()) onSet(draft.trim());
    };
    return (
      <Input
        className="settings-input shrink-0 w-[140px]"
        aria-label={label}
        placeholder={t('accounts.groupPlaceholder')}
        maxLength={MAX_ACCOUNT_GROUP_CHARS}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Enter that ends an IME composition is not a commit (some IMEs send it as keyCode 229).
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setTyping(false);
        }}
        onBlur={commit}
        autoFocus
      />
    );
  }
  return (
    <Select
      className="settings-select shrink-0"
      aria-label={label}
      data-account-group-picker
      value={value}
      onChange={(e) => {
        if (e.target.value === NEW_GROUP) { setDraft(''); setTyping(true); } else onSet(e.target.value);
      }}
    >
      <option value="">{t('accounts.noGroup')}</option>
      {[...new Set([...groups, value].filter(Boolean))].map((g) => <option key={g} value={g}>{g}</option>)}
      <option value={NEW_GROUP}>{t('accounts.newGroup')}</option>
    </Select>
  );
}

function AddAccountWizard({ groups, onDone, onCancel }: { groups: string[]; onDone: () => void; onCancel: () => void }): React.ReactElement {
  const t = useT();
  const [vendor, setVendor] = useState<Vendor>('claude');
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
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
      await startAccountLogin({ vendor, name: name.trim(), configDir: res.configDir, loginCommand: res.loginCommand, group: group || undefined });
      onDone();
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
      setBusy(false);
    }
  }, [vendor, name, group, share, onDone, t]);

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
        <Field label={t('accounts.groupLabel')} description={t('accounts.groupHint')}>
          <GroupPicker value={group} groups={groups} onSet={setGroup} />
        </Field>
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
  const [confirmRemove, setConfirmRemove] = useState<AccountRow | null>(null);
  const [bindings, setBindings] = useState<Record<string, Partial<Record<Vendor, string>>>>({});
  const [move, setMove] = useState<PendingMove | null>(null);
  const workspaces = useStore((s) => s.workspaces);
  // Settings closes on Escape unless something it opened owns the key.
  useOwnedDialog(move !== null || confirmRemove !== null);
  const [removeNotice, setRemoveNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<Map<string, AccountUsageEntry>>(new Map());
  const pending = useSyncExternalStore(subscribeAccountLogins, getPendingAccountLogins);
  const rotation = useAccountRotation();

  const reload = useCallback(() => {
    const api = window.electronAPI?.accounts;
    if (!api) { setLoaded(true); return; }
    void api.list().then((res) => { setRows(res.accounts); setBindings(res.bindings); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  // After a move the list re-renders in a new order (a group's heading and ⋯
  // may be gone): focus the moved account's ⋯ once the new rows are in.
  const focusAfterReload = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfterReload.current;
    if (!id) return;
    focusAfterReload.current = null;
    document.querySelector<HTMLElement>(`[data-account-row="${CSS.escape(id)}"] [data-remote-menu]`)?.focus();
  }, [rows]);
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

  const closeRemove = (id: string) => {
    setConfirmRemove(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-account-row="${id}"] [data-remote-menu]`)?.focus());
  };
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
  /** A group-wide move takes the group's members as they are now, not when it was asked for. */
  const membersOf = (m: PendingMove): string[] => (m.kind === 'move'
    ? m.ids
    : rows.filter((r) => accountGroupOf(r) === m.from).map((r) => r.id));
  /** Workspaces whose rotation pool a move changes, and the pool they move to. */
  const moveImpact = (m: PendingMove, to: string): string[] => {
    const ids = membersOf(m);
    const moved = rows.filter((r) => ids.includes(r.id));
    const names = new Set<string>();
    for (const vendor of ['claude', 'codex'] as const) {
      const movedHere = moved.filter((r) => r.vendor === vendor);
      const key = (list: AccountRow[]) => list.map((r) => r.id).sort().join('|');
      const before = rows.filter((r) => r.vendor === vendor && accountGroupOf(r) === m.from);
      const after = [...rows.filter((r) => r.vendor === vendor && accountGroupOf(r) === to && !ids.includes(r.id)), ...movedHere];
      if (movedHere.length === 0 || key(before) === key(after)) continue;
      for (const [wsId, perVendor] of Object.entries(bindings)) {
        if (movedHere.some((r) => r.id === perVendor[vendor])) names.add(workspaces.find((w) => w.id === wsId)?.name ?? wsId);
      }
    }
    return [...names];
  };
  const applyMove = (m: PendingMove, to: string) => {
    const api = window.electronAPI?.accounts;
    closeMove(m);
    if (!api?.setGroup) return;
    const ids = membersOf(m);
    focusAfterReload.current = ids[0] ?? null;
    void ids.reduce<Promise<unknown>>((chain, id) => chain.then(() => api.setGroup({ id, group: to })), Promise.resolve())
      .then(reload)
      .catch(() => {
        reload();
        useStore.getState().pushToast({ level: 'error', message: t('accounts.moveFailed') });
      });
  };
  /** Focus goes back to the ⋯ the move came from (its menu item is gone). */
  const closeMove = (m: PendingMove) => {
    setMove(null);
    const selector = m.kind === 'move' ? `[data-account-row="${m.ids[0]}"] [data-remote-menu]` : `[data-account-group="${CSS.escape(m.from)}"] [data-remote-menu]`;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
  };
  /** A move that changes no workspace's pool applies at once; else it asks first. */
  const requestMove = (m: PendingMove) => {
    if (m.to !== null && moveImpact(m, m.to).length === 0) applyMove(m, m.to);
    else setMove(m);
  };
  const rename = (id: string) => {
    const api = window.electronAPI?.accounts;
    if (api && editName.trim()) {
      void api.rename({ id, name: editName.trim() }).then(reload).catch(() => { /* useIpc surfaces the error */ });
    }
    setEditingId(null);
  };
  // Rows in group order; each group gets a heading once any account has one,
  // so a registry with no groups looks as it always did.
  const buckets = groupAccounts(rows);
  const groupNames = buckets.map((b) => b.group).filter(Boolean);
  const orderedRows = buckets.flatMap((b) => b.accounts);
  // A heading above its group's own container: small, muted, no fill. A
  // named group's ⋯ (rename, ungroup) shows on hover, focus or while open.
  const groupHeading = (group: string, accounts: AccountRow[]) => {
    const ids = accounts.map((r) => r.id);
    return (
      <div className="group/heading flex items-center gap-2 min-h-[26px] px-[14px] text-[12px] leading-4 text-[var(--text-sub)]" data-account-group={group}>
        <span className="flex-1 min-w-0 truncate">{group || t('accounts.noGroup')}</span>
        {group && (
          <span className="flex opacity-0 group-hover/heading:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">
            <AccountMenu
              label={t('accounts.groupMenu', { group })}
              items={[
                { id: 'rename', label: t('accounts.renameGroup'), onSelect: () => setMove({ ids, from: group, to: null, kind: 'rename' }) },
                { id: 'ungroup', label: t('accounts.ungroup'), onSelect: () => requestMove({ ids, from: group, to: '', kind: 'ungroup' }) },
              ]}
            />
          </span>
        )}
      </div>
    );
  };
  const rowMenu = (r: AccountRow): RemoteRowMenuItem[] => {
    const from = accountGroupOf(r);
    return [
      ...groupNames.filter((g) => g !== from).map((g) => ({
        id: `to-group:${g}`, label: t('accounts.moveTo', { group: g }), onSelect: () => requestMove({ ids: [r.id], from, to: g, kind: 'move' }),
      })),
      ...(from ? [{ id: 'move:none', label: t('accounts.moveToNoGroup'), onSelect: () => requestMove({ ids: [r.id], from, to: '', kind: 'move' }) }] : []),
      { id: 'move:new', label: t('accounts.moveToNewGroup'), onSelect: () => setMove({ ids: [r.id], from, to: null, kind: 'move' }) },
      ...(r.vendor === 'claude' ? [{ id: 'refresh', label: t('accounts.refreshUsage'), onSelect: () => window.electronAPI?.accounts?.usageRefresh?.(r.id) }] : []),
      { id: 'rename', label: t('accounts.rename'), onSelect: () => { setEditingId(r.id); setEditName(r.name); } },
      { id: 'remove', label: t('common.remove'), danger: true, onSelect: () => setConfirmRemove(r) },
    ];
  };

  const renderRow = (r: AccountRow) => (
    <div key={r.id} className="ui-row" style={ROW_TRACKS} data-account-row={r.id}>
      <Badge className="justify-self-start">{r.vendor}</Badge>
      {editingId === r.id ? (
        <Input
          className="settings-input min-w-0"
          aria-label={t('accounts.namePlaceholder')}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') rename(r.id); if (e.key === 'Escape') setEditingId(null); }}
          onBlur={() => rename(r.id)}
          autoFocus
        />
      ) : (
        <span className="min-w-0 text-[13px] font-medium text-[var(--text-main)] truncate">{r.name}</span>
      )}
      <span className="justify-self-end min-w-0 max-w-full overflow-hidden">
        <LoginState
          row={r}
          expired={usage.get(r.id)?.status === 'unauthorized'}
          pending={pending.some((p) => p.configDir === r.configDir)}
        />
      </span>
      <span className="justify-self-end min-w-0 max-w-full overflow-hidden">
        {r.vendor === 'codex'
          ? <RotationQuotaBit row={rotation.state?.rows.find((x) => x.accountId === r.id)} />
          : <UsageBit entry={usage.get(r.id)} />}
      </span>
      <AccountMenu label={t('accounts.rowMenu', { name: r.name })} items={rowMenu(r)} />
    </div>
  );
  const tail = (
    <>
      {pending.map((p) => <PendingLoginRow key={p.configDir} entry={p} />)}
      {adding ? (
        <AddAccountWizard groups={groupNames} onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />
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
    </>
  );
  // Rows sit in the section's container until any account has a group; then
  // each group gets its own container under a heading.
  const grouped = groupNames.length > 0;

  return (
    <>
      {/* No heading: the Accounts page title already names this, its only group. */}
      <SettingsSection
        id="claudeacct"
        // The scope line alone is the visible line; the rest waits behind Learn more.
      description={`${t('accounts.scopeLine')}\n${[t('accounts.intro'), t('accounts.rotateDesc'), t('accounts.groupsDesc')].join(' ')}`}
      >
        <AccountRotationControls state={rotation.state} reload={rotation.reload} />
        {removeNotice && <p className="settings-note">{removeNotice}</p>}
        {loaded && rows.length === 0 && !adding && (
          <p className="settings-note">{t('accounts.empty')}</p>
        )}
        {!grouped && orderedRows.map(renderRow)}
        {!grouped && tail}
      </SettingsSection>
      {grouped && (
        <div className="flex flex-col gap-4" data-account-groups>
          {buckets.map(({ group, accounts }) => (
            <div key={group || 'ungrouped'} className="flex flex-col gap-1">
              {groupHeading(group, accounts)}
              <div className="ui-group">{accounts.map(renderRow)}</div>
            </div>
          ))}
          <div className="ui-group">{tail}</div>
        </div>
      )}
      {move && <MoveDialog move={move} impact={(to) => moveImpact(move, to)} onApply={(to) => applyMove(move, to)} onCancel={() => closeMove(move)} />}
      {confirmRemove && (
        <Dialog onClose={() => closeRemove(confirmRemove.id)} width={420}>
          <DialogHeader title={t('accounts.removeTitle', { name: confirmRemove.name })} description={t('accounts.removeDesc')} closeLabel={t('common.cancel')} />
          <DialogFooter>
            <Button variant="ghost" size="md" onClick={() => closeRemove(confirmRemove.id)}>{t('common.cancel')}</Button>
            <Button variant="danger" size="md" onClick={() => remove(confirmRemove.id)}>{t('common.remove')}</Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}

/** Shared column tracks (vendor · name · login · quota · ⋯) so a row that
 *  shows less than another does not shift its neighbours. */
const ROW_TRACKS: CSSProperties = { display: 'grid', gridTemplateColumns: '64px minmax(64px, 1fr) minmax(0, 112px) minmax(0, 176px) 28px' };

/** A ⋯ menu that holds Escape while open, so Settings does not close under it. */
function AccountMenu(props: { label: string; items: RemoteRowMenuItem[] }): React.ReactElement {
  const [open, setOpen] = useState(false);
  useOwnedDialog(open);
  return <RemoteRowMenu {...props} onOpenChange={setOpen} />;
}

interface PendingMove {
  ids: string[];
  /** The group the accounts are in now ('' = ungrouped). */
  from: string;
  /** Destination; null = ask for a name (a new group, or renaming `from`). */
  to: string | null;
  kind: 'move' | 'rename' | 'ungroup';
}

/** Names a new group when needed and, when the move changes the rotation
 *  pool of bound workspaces, says which ones and the pool they move to. */
function MoveDialog({ move, impact, onApply, onCancel }: {
  move: PendingMove;
  impact: (to: string) => string[];
  onApply: (to: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const t = useT();
  const [draft, setDraft] = useState(move.kind === 'rename' ? move.from : '');
  const to = move.to ?? draft.trim();
  const affected = to || move.to !== null ? impact(to) : [];
  const title = move.kind === 'rename' ? t('accounts.renameGroupTitle', { group: move.from })
    : move.kind === 'ungroup' ? t('accounts.ungroupTitle', { group: move.from })
      : move.to === null ? t('accounts.moveTitle') : t('accounts.moveTo', { group: move.to || t('accounts.noGroup') });
  const canApply = move.to !== null || (to !== '' && to !== move.from);
  return (
    <Dialog onClose={onCancel} width={420}>
      <DialogHeader title={title} closeLabel={t('common.cancel')} />
      <DialogBody>
        <div className="flex flex-col gap-3">
          {move.to === null && (
            <Field label={t('accounts.groupLabel')} layout="stacked">
              <Input
                className="w-full text-[13px]"
                placeholder={t('accounts.groupPlaceholder')}
                maxLength={MAX_ACCOUNT_GROUP_CHARS}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === 'Enter' && canApply) onApply(to);
                }}
                autoFocus
              />
            </Field>
          )}
          {affected.length > 0 && (
            <p className="m-0 text-[13px] text-[var(--text-sub)]" data-account-move-impact>
              {t('accounts.poolChangeNotice', { workspaces: affected.join(', '), pool: to || t('accounts.noGroup') })}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="md" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="primary" size="md" disabled={!canApply} onClick={() => onApply(to)}>{t('accounts.apply')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
