// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/app/shell/Sidebar.tsx), MIT License, Copyright (c) 2026 Nick
import { Fragment, useState, useEffect, useCallback } from 'react';
import { IconChevron } from '../icons';
import { useT } from '../../hooks/useT';
import type { Account } from '../../../main/account/accountStore';
import type { CredentialStatus } from '../../../main/ipc/handlers/account.handler';
import { accountGroupOf, groupAccountsBoundFirst } from '../../../shared/accountGroup';

type Vendor = 'claude' | 'codex';
type AccountRow = Account & { status: CredentialStatus };

/**
 * Workspace right-click → per-vendor account submenu (M1: BIND ONLY).
 *
 * Selecting an account updates the workspace binding; already-running terminals
 * keep their spawn-time account (per-PTY generation) and only NEW terminals use
 * the new account. The "Switch now" action (respawn live panes) is M3 and not
 * offered here — the footer states the bind-only semantics so the user is not
 * surprised that open panes don't change.
 */
export default function WorkspaceAccountMenu({
  workspaceId,
  flipLeft,
}: {
  workspaceId: string;
  flipLeft: boolean;
}): React.ReactElement | null {
  const t = useT();
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [bindings, setBindings] = useState<Partial<Record<Vendor, string>>>({});
  const [openVendor, setOpenVendor] = useState<Vendor | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    const api = window.electronAPI?.accounts;
    if (!api) { setLoaded(true); return; }
    void api.list().then((res) => {
      setRows(res.accounts);
      setBindings(res.bindings[workspaceId] ?? {});
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  const bind = useCallback((vendor: Vendor, accountId: string | undefined) => {
    const api = window.electronAPI?.accounts;
    if (!api) return;
    void api.setBinding({ workspaceId, vendor, accountId }).then(reload).catch(() => { /* surfaced by useIpc */ });
  }, [workspaceId, reload]);

  // Hide entirely when the preload doesn't expose accounts (older build) or no
  // accounts of any vendor are registered — nothing to bind.
  if (loaded && rows.length === 0) return null;
  if (!window.electronAPI?.accounts) return null;

  const submenuPos = flipLeft ? 'right-full mr-0.5' : 'left-full ml-0.5';

  const vendorLabelKey: Record<Vendor, string> = { claude: 'accounts.claudeAccount', codex: 'accounts.codexAccount' };

  return (
    <>
      {(['claude', 'codex'] as const).map((vendor) => {
        const vendorRows = rows.filter((r) => r.vendor === vendor);
        if (vendorRows.length === 0) return null;
        const boundId = bindings[vendor];
        // Group sections once any account has a group: the bound account's
        // group first, then the others under one "Other groups" divider. With
        // nothing bound no group is current. A pick in another group is allowed.
        const bound = vendorRows.find((r) => r.id === boundId);
        const buckets = groupAccountsBoundFirst(vendorRows, bound ? accountGroupOf(bound) : null);
        const sectioned = buckets.some((b) => b.group !== '');
        return (
          <div
            key={vendor}
            className="relative"
            onMouseEnter={() => setOpenVendor(vendor)}
            onMouseLeave={() => setOpenVendor((v) => (v === vendor ? null : v))}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
              style={{ color: 'var(--text-main)' }}
            >
              <span>{t(vendorLabelKey[vendor])}</span>
              {boundId && (
                <span className="text-[11px] text-[var(--text-sub)] truncate max-w-[90px]">
                  {vendorRows.find((r) => r.id === boundId)?.name ?? ''}
                </span>
              )}
              <span className="ml-auto text-[var(--text-muted)]"><IconChevron /></span>
            </button>
            {openVendor === vendor && (
              <div
                className={`absolute top-0 ${submenuPos} min-w-[200px] max-w-[300px] py-1 rounded-xl shadow-xl sidebar-popover-enter`}
                style={{ background: 'var(--bg-surface)', border: '1px solid color-mix(in srgb, var(--bg-overlay) 70%, transparent)' }}
              >
                {/* Default (unbind) */}
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left transition-colors hover:bg-[var(--bg-overlay)]"
                  style={{ color: 'var(--text-main)' }}
                  onClick={() => bind(vendor, undefined)}
                >
                  <span className="w-3 shrink-0 text-[var(--accent)]">{!boundId ? '●' : ''}</span>
                  <span className="text-[var(--text-muted)]">{t('accounts.defaultAccount')}</span>
                </button>
                {buckets.map(({ group, accounts }, i) => (
                  <Fragment key={group}>
                  {bound && i === 1 && (
                    <div className="px-3 pt-1.5 mt-1 border-t border-[var(--bg-overlay)] text-[11px] text-[var(--text-muted)]" data-account-menu-other-groups>
                      {t('accounts.otherGroups')}
                    </div>
                  )}
                  {sectioned && (
                    <div className="px-3 pt-1.5 pb-0.5 pl-8 text-[11px] text-[var(--text-sub)] truncate" data-account-menu-group={group}>
                      {group || t('accounts.noGroup')}
                    </div>
                  )}
                  {accounts.map((r) => (
                  <button
                    key={r.id}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left transition-colors hover:bg-[var(--bg-overlay)]"
                    style={{ color: 'var(--text-main)' }}
                    onClick={() => bind(vendor, r.id)}
                    title={r.status.loggedIn
                      ? (r.status.subscriptionType ? `${r.status.subscriptionType}` : t('accounts.loggedIn'))
                      : t('accounts.notLoggedIn')}
                  >
                    <span className="w-3 shrink-0 text-[var(--accent)]">{boundId === r.id ? '●' : ''}</span>
                    <span className="truncate flex-1">{r.name}</span>
                    {!r.status.loggedIn && (
                      <span className="text-[11px] text-[var(--accent-red)] shrink-0">{t('accounts.loggedOut')}</span>
                    )}
                    {r.status.subscriptionType && (
                      <span className="text-[11px] text-[var(--text-subtle)] shrink-0">{r.status.subscriptionType}</span>
                    )}
                  </button>
                  ))}
                  </Fragment>
                ))}
                <div className="px-3 pt-1 mt-1 border-t border-[var(--bg-overlay)] text-[10px] text-[var(--text-muted)] leading-snug">
                  {t('accounts.newTerminalsNote')}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
