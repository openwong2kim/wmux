import { useState, useEffect, useCallback, useRef } from 'react';
import type { Account } from '../../../main/account/accountStore';
import type { CredentialStatus } from '../../../main/ipc/handlers/account.handler';
import type { AccountUsageEntry } from '../../../main/account/AccountUsageService';

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
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/** Amber once a window crosses 80% — the "getting close" cue (DESIGN.md: amber =
 *  alive + focus). Below that it stays muted so the panel isn't a wall of color. */
function pctColor(pct: number): string {
  return pct >= 80 ? 'var(--accent-amber)' : 'var(--text-subtle)';
}

function UsageBit({ entry, onRefresh }: {
  entry: AccountUsageEntry | undefined;
  onRefresh: () => void;
}): React.ReactElement {
  const refreshBtn = (
    <button
      className="text-[10px] px-1 rounded text-[var(--text-subtle)] hover:text-[var(--accent-amber)] hover:bg-[var(--bg-overlay)]"
      onClick={onRefresh}
      title="Refresh usage now (spends one request against this account's quota)"
    >
      ↻
    </button>
  );
  if (!entry) return refreshBtn;
  if (entry.status === 'ok' && entry.snapshot) {
    const s = entry.snapshot;
    return (
      <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
        <span style={{ color: pctColor(s.sessionPct) }}>5h {s.sessionPct}%</span>
        <span className="text-[var(--text-subtle)]">·</span>
        <span style={{ color: pctColor(s.weeklyPct) }}>7d {s.weeklyPct}%</span>
        <span className="text-[var(--text-subtle)]" title={`Updated ${fmtAge(entry.fetchedAtMs)}`}>· {fmtAge(entry.fetchedAtMs)}</span>
        {refreshBtn}
      </span>
    );
  }
  // Non-ok: keep the last-known snapshot visible (stale) if we have one, plus a
  // small reason. Otherwise just the refresh affordance.
  const reason = entry.status === 'unauthorized' ? 'auth expired'
    : entry.status === 'token-missing' ? '' // logged-out badge already conveys this
    : 'unavailable';
  return (
    <span className="flex items-center gap-1 text-[10px] text-[var(--text-subtle)]">
      {entry.snapshot && (
        <span title="Last known, refresh failed">5h {entry.snapshot.sessionPct}% · 7d {entry.snapshot.weeklyPct}% (stale)</span>
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
      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'var(--accent-green)', background: 'color-mix(in srgb, var(--accent-green) 12%, transparent)' }}>
        {status.subscriptionType ? status.subscriptionType : 'logged in'}
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'var(--accent-red)', background: 'color-mix(in srgb, var(--accent-red) 12%, transparent)' }}>
      logged out
    </span>
  );
}

// Login completion is polled for at most this long, then the wizard offers a
// manual "I've logged in" confirm. Bounds the credential I/O (review) and covers
// macOS claude (where the credential can't be read per-account at all).
const POLL_TIMEOUT_MS = 3 * 60 * 1000;

function AddAccountWizard({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }): React.ReactElement {
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
    if (!name.trim()) { setError('Enter a name'); return; }
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
    <div className="mt-2 p-3 rounded-[7px]" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-overlay)' }}>
      {phase === 'form' && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            {(['claude', 'codex'] as const).map((v) => (
              <button
                key={v}
                className="px-2 py-1 text-xs rounded transition-colors"
                style={vendor === v
                  ? { color: 'var(--accent-amber)', background: 'color-mix(in srgb, var(--accent-amber) 14%, transparent)' }
                  : { color: 'var(--text-muted)', background: 'var(--bg-overlay)' }}
                onClick={() => setVendor(v)}
              >
                {v === 'claude' ? 'Claude' : 'Codex'}
              </button>
            ))}
          </div>
          <input
            className="px-2 py-1 text-xs rounded bg-[var(--bg-overlay)] text-[var(--text-main)] outline-none"
            placeholder="Account name (e.g. Work Max)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
            Copy default settings (MCP · skills · plugins shared, login separate)
          </label>
          {error && <div className="text-[10px] text-[var(--accent-red)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <button className="px-2 py-1 text-xs rounded text-[var(--text-subtle)] hover:bg-[var(--bg-overlay)]" onClick={onCancel}>Cancel</button>
            <button className="px-2 py-1 text-xs rounded" style={{ color: 'var(--accent-amber)', background: 'color-mix(in srgb, var(--accent-amber) 14%, transparent)' }} onClick={prepare}>Create & log in</button>
          </div>
        </div>
      )}
      {phase === 'login' && prep && (
        <div className="flex flex-col gap-2">
          <div className="text-xs text-[var(--text-main)]">
            Run this in any terminal, then complete login{vendor === 'claude' ? ' with /login' : ''}:
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-2 py-1 text-[11px] rounded bg-[var(--bg-overlay)] text-[var(--accent-blue)] font-mono truncate" title={prep.loginCommand}>
              {prep.loginCommand}
            </code>
            <button
              className="px-2 py-1 text-[10px] rounded text-[var(--text-subtle)] hover:bg-[var(--bg-overlay)]"
              onClick={() => {
                void window.clipboardAPI?.writeText(prep.loginCommand);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {share && (
            <div className="text-[10px] text-[var(--text-muted)]">
              This is an independent profile — settings/MCP/skills copied from your default; login stays separate.
            </div>
          )}
          {!prep.credentialReadSupported && (
            <div className="text-[10px] text-[var(--text-muted)]">
              On macOS wmux can't auto-detect this login (the credential is in the shared keychain). Click below once you've logged in.
            </div>
          )}
          {prep.credentialReadSupported && !pollTimedOut ? (
            <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
              <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent-amber)' }} />
              Waiting for login…
            </div>
          ) : null}
          {error && <div className="text-[10px] text-[var(--accent-red)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <button className="px-2 py-1 text-xs rounded text-[var(--text-subtle)] hover:bg-[var(--bg-overlay)]" onClick={() => { stopPoll(); onCancel(); }}>Cancel</button>
            {(pollTimedOut || !prep.credentialReadSupported) && (
              <button className="px-2 py-1 text-xs rounded" style={{ color: 'var(--accent-amber)', background: 'color-mix(in srgb, var(--accent-amber) 14%, transparent)' }} onClick={() => { stopPoll(); commit(prep.configDir); }}>
                I've logged in
              </button>
            )}
          </div>
        </div>
      )}
      {phase === 'done' && (
        <div className="flex flex-col gap-2">
          <div className="text-xs" style={{ color: 'var(--accent-green)' }}>✓ Account added.</div>
          <div className="flex justify-end">
            <button className="px-2 py-1 text-xs rounded" style={{ color: 'var(--accent-amber)', background: 'color-mix(in srgb, var(--accent-amber) 14%, transparent)' }} onClick={onDone}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AccountsSection(): React.ReactElement | null {
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
        setRemoveNotice(n > 0 ? `Removed — ${n} workspace${n === 1 ? '' : 's'} reverted to the default account.` : 'Removed.');
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
    <div className="flex flex-col gap-1">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Accounts</div>
      {removeNotice && <div className="text-[10px] text-[var(--accent-amber)] mb-1">{removeNotice}</div>}
      {loaded && rows.length === 0 && !adding && (
        <div className="text-xs text-[var(--text-muted)]">No accounts yet. Add one to bind different subscriptions per workspace.</div>
      )}
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-2 py-1">
          <span className="text-[10px] px-1 rounded bg-[var(--bg-overlay)] text-[var(--text-subtle)]">{r.vendor}</span>
          {editingId === r.id ? (
            <input
              className="flex-1 px-2 py-0.5 text-xs rounded bg-[var(--bg-overlay)] text-[var(--text-main)] outline-none"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') rename(r.id); if (e.key === 'Escape') setEditingId(null); }}
              onBlur={() => rename(r.id)}
              autoFocus
            />
          ) : (
            <button className="flex-1 text-left text-xs text-[var(--text-main)] truncate hover:underline" onClick={() => { setEditingId(r.id); setEditName(r.name); }}>
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
            <>
              <button className="text-[10px] text-[var(--accent-red)]" onClick={() => remove(r.id)}>Remove</button>
              <button className="text-[10px] text-[var(--text-subtle)]" onClick={() => setConfirmRemove(null)}>Cancel</button>
            </>
          ) : (
            <button className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--accent-red)]" onClick={() => setConfirmRemove(r.id)} title="Unregister (does not delete the directory)">×</button>
          )}
        </div>
      ))}
      {adding ? (
        <AddAccountWizard onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />
      ) : (
        <button className="self-start mt-1 px-2 py-1 text-xs rounded text-[var(--accent-amber)] hover:bg-[var(--bg-overlay)]" onClick={() => setAdding(true)}>
          + Add account
        </button>
      )}
    </div>
  );
}
