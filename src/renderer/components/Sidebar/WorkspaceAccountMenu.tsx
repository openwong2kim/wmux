// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/app/shell/Sidebar.tsx), MIT License, Copyright (c) 2026 Nick
import { Fragment, useState, useEffect, useCallback } from 'react';
import { keepSubmenuInWindow } from '../../utils/keepSubmenuInWindow';
import { IconChevron } from '../icons';
import { useT } from '../../hooks/useT';
import type { Account } from '../../../main/account/accountStore';
import type { CredentialStatus } from '../../../main/ipc/handlers/account.handler';
import { accountGroupOf, groupAccountsBoundFirst } from '../../../shared/accountGroup';
import { agentRow } from '../../../shared/agentIdentity';
import { useStore } from '../../stores';
import { useDaemonModeActive } from '../../hooks/useDaemonMode';
import { collectWorkspaceTerminalSurfaces } from '../../utils/paneTraversal';
import { continueOutcomeToast, continuePaneOnAccount } from '../Pane/usePaneContinueOnAccount';
import { accountSignInMark, switchWorkspacePanes, tallySwitch, workspaceContinuePanes, workspaceRunsInWsl } from './switchWorkspacePanes';

type Vendor = 'claude' | 'codex';
type AccountRow = Account & { status: CredentialStatus; tokenSignIn?: { createdAt: number; usable: boolean } };

/**
 * Workspace right-click → per-vendor account submenu.
 *
 * Selecting an account updates the workspace binding; already-running terminals
 * keep their spawn-time account (per-PTY generation) and only NEW terminals use
 * the new account, as the footer says. For an agent that can continue on
 * another account (Claude), the footer also offers "Switch open panes": after a
 * confirm it continues each open pane of that agent on the bound account
 * (switchWorkspacePanes.ts). It never runs on its own.
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
  /** The workspace's panes run in WSL, where an account's Windows sign-in says nothing. */
  const [inWsl, setInWsl] = useState(false);
  /** The vendor whose "switch open panes" confirm row is showing. */
  const [confirming, setConfirming] = useState<Vendor | null>(null);
  const [switching, setSwitching] = useState(false);
  const daemon = useDaemonModeActive();
  const continuePanes = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId);
    return ws ? workspaceContinuePanes(ws, s.surfaceAgent).length : 0;
  });

  const reload = useCallback(() => {
    const api = window.electronAPI?.accounts;
    if (!api) { setLoaded(true); return; }
    void api.list().then((res) => {
      setRows(res.accounts);
      setBindings(res.bindings[workspaceId] ?? {});
      setLoaded(true);
    }).catch(() => setLoaded(true));
    const st = useStore.getState();
    const ws = st.workspaces.find((w) => w.id === workspaceId);
    const ptyIds = ws ? collectWorkspaceTerminalSurfaces(ws).map((x) => x.ptyId).filter(Boolean) : [];
    const sessions = ptyIds.length > 0 && window.electronAPI?.pty?.list ? window.electronAPI.pty.list() : Promise.resolve([]);
    void sessions.then((list) => setInWsl(workspaceRunsInWsl(ptyIds, [...list], st.defaultShell))).catch(() => setInWsl(false));
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  const bind = useCallback((vendor: Vendor, accountId: string | undefined) => {
    const api = window.electronAPI?.accounts;
    if (!api) return;
    void api.setBinding({ workspaceId, vendor, accountId }).then(reload).catch(() => { /* surfaced by useIpc */ });
  }, [workspaceId, reload]);

  // Bind (again) and continue each open pane of the vendor's agent on the
  // account, one at a time. A pane that fails or is skipped never stops the
  // rest, and the binding stays changed.
  const switchPanes = useCallback(async (vendor: Vendor, account: { id: string; name: string }) => {
    const api = window.electronAPI?.accounts;
    setConfirming(null);
    if (!api) return;
    const { pushToast } = useStore.getState();
    setSwitching(true);
    try {
      try {
        await api.setBinding({ workspaceId, vendor, accountId: account.id });
      } catch {
        pushToast({ level: 'error', message: t('accounts.switchPanesBindFailed') });
        return;
      }
      reload();
      const st = useStore.getState();
      const ws = st.workspaces.find((w) => w.id === workspaceId);
      const panes = ws ? workspaceContinuePanes(ws, st.surfaceAgent) : [];
      const results = await switchWorkspacePanes(panes, (ptyId) => continuePaneOnAccount(ptyId, account.id, workspaceId));
      for (const r of results) {
        const { kind } = r.outcome;
        if (kind === 'done' || kind === 'new_pane' || (kind === 'refused' && r.outcome.code === 'same_account')) continue;
        const toast = continueOutcomeToast(r.outcome, account.name, t);
        pushToast({ ...toast, message: `${r.title}: ${toast.message}` });
      }
      const n = tallySwitch(results);
      const summary = t('accounts.switchPanesSummary', {
        name: account.name, switched: String(n.switched + n.already), skipped: String(n.skipped), failed: String(n.failed),
      });
      pushToast({
        level: n.failed > 0 ? 'warn' : 'info',
        message: n.failed > 0 ? `${summary} ${t('accounts.switchPanesBindingKept', { name: account.name })}` : summary,
      });
    } finally {
      setSwitching(false);
    }
  }, [workspaceId, reload, t]);

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
                ref={keepSubmenuInWindow}
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
                  {accounts.map((r) => {
                  const mark = accountSignInMark(r, inWsl);
                  return (
                  <button
                    key={r.id}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left transition-colors hover:bg-[var(--bg-overlay)]"
                    style={{ color: 'var(--text-main)' }}
                    onClick={() => bind(vendor, r.id)}
                    title={mark === 'in'
                      ? (r.status.subscriptionType ? `${r.status.subscriptionType}` : t('accounts.loggedIn'))
                      : t(mark === 'wsl' ? 'accounts.wslSignInUnchecked' : 'accounts.notLoggedIn')}
                  >
                    <span className="w-3 shrink-0 text-[var(--accent)]">{boundId === r.id ? '●' : ''}</span>
                    <span className="truncate flex-1">{r.name}</span>
                    {/* A long-lived token signs the account's new panes in without a browser login. */}
                    {/* In WSL the account signs in on its home in the distro, not read here: neutral. */}
                    {mark === 'out' && (
                      <span className="text-[11px] text-[var(--accent-red)] shrink-0">{t('accounts.loggedOut')}</span>
                    )}
                    {mark === 'wsl' && (
                      <span className="text-[11px] text-[var(--text-muted)] shrink-0" data-account-menu-wsl-sign-in>{t('accounts.signInInWsl')}</span>
                    )}
                    {r.status.subscriptionType && (
                      <span className="text-[11px] text-[var(--text-subtle)] shrink-0">{r.status.subscriptionType}</span>
                    )}
                  </button>
                  );
                  })}
                  </Fragment>
                ))}
                <div className="px-3 pt-1 mt-1 border-t border-[var(--bg-overlay)] text-[10px] text-[var(--text-muted)] leading-snug">
                  {t('accounts.newTerminalsNote')}
                </div>
                {bound && daemon && continuePanes > 0 && agentRow(vendor)?.continueOnAccount && (
                  confirming === vendor ? (
                    <div className="px-3 py-1.5 text-[12px]" style={{ color: 'var(--text-main)' }} data-account-menu-switch-confirm>
                      <div className="leading-snug">{t('accounts.switchPanesConfirm', { count: String(continuePanes), name: bound.name })}</div>
                      <div className="flex gap-2 mt-1.5">
                        <button className="px-2 py-0.5 rounded text-[12px] hover:bg-[var(--bg-overlay)] text-[var(--accent)]" onClick={() => { void switchPanes(vendor, bound); }}>
                          {t('accounts.switchPanesRun')}
                        </button>
                        <button className="px-2 py-0.5 rounded text-[12px] hover:bg-[var(--bg-overlay)] text-[var(--text-sub)]" onClick={() => setConfirming(null)}>
                          {t('common.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors hover:bg-[var(--bg-overlay)] disabled:opacity-50"
                      style={{ color: 'var(--text-main)' }}
                      disabled={switching}
                      onClick={() => setConfirming(vendor)}
                      data-account-menu-switch-panes
                    >
                      {t('accounts.switchPanes', { name: bound.name })}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
