// Pane actions menu → "Browser protection…" (src/shared/browserPolicy.ts),
// and what the pane's protection is now (the pane-level lock).
//
// Offered under the same gate as the per-pane profile rows (chrome backend,
// not read-only, a preload that carries the calls). Protection needs a Chrome
// profile bound to this pane alone, so without one the row is disabled and
// says what to do first. The row opens BrowserPolicyDialog; nothing else here
// writes.
//
// Protection covers the pane's own Chrome, not the in-app browser tabs it may
// also hold, so the lock belongs to the pane, never to one of its tabs.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { IconLock } from '../icons';
import type { PaneActionItem } from './PaneActionsMenu';
import { resolvePanePolicy, type BrowserPolicyReadResult } from '../../../shared/browserPolicy';
import type { HostPolicyMode } from '../../../shared/browserHostPolicy';

/** Key of the main-menu item that opens the protection editor. */
export const PANE_BROWSER_POLICY_KEY = 'browser-policy';

/** What a pane's protection is right now. */
export type PaneProtection =
  | { kind: 'off' }
  /** Protected, but every site is refused until the operator confirms. */
  | { kind: 'refused' }
  | { kind: 'protected'; mode: HostPolicyMode; allowCount: number };

/**
 * The pane's protection from a policy read. Main's `decision` is the answer
 * (it knows which panes were ever protected). Without it (an older main), an
 * unreadable policy file counts as refused.
 */
export function paneProtection(res: BrowserPolicyReadResult | undefined, workspaceId: string): PaneProtection {
  if (!res?.ok) return { kind: 'off' };
  const entry = res.policy ?? undefined;
  const hosts = entry?.hosts;
  const protectedAs = (): PaneProtection => hosts
    ? { kind: 'protected', mode: hosts.mode, allowCount: hosts.allow.length }
    : { kind: 'refused' };
  if (res.decision !== undefined) {
    if (res.decision === 'legacy') return { kind: 'off' };
    if (res.decision === 'denied' || res.confirmed === false) return { kind: 'refused' };
    return protectedAs();
  }
  if (res.state === 'corrupt' || res.state === 'unsupported-version') return { kind: 'refused' };
  if (!entry?.protected) return { kind: 'off' };
  const decision = resolvePanePolicy(entry, { workspaceId, currentProfile: res.currentProfile }, res.epoch ?? 0);
  return decision.kind === 'protected' && decision.confirmed ? protectedAs() : { kind: 'refused' };
}

export function usePaneBrowserPolicyMenu(opts: {
  paneId: string;
  workspaceId: string;
  /** The per-pane profile rows are offered (usePaneChromeProfileMenu). */
  enabled: boolean;
  /** The pane's own exclusive Chrome profile, if any. */
  boundProfile: string | undefined;
  openDialog: () => void;
}): { mainItems: PaneActionItem[]; protection: PaneProtection; summary: string | undefined; reload: () => void } {
  const { paneId, workspaceId, enabled, boundProfile, openDialog } = opts;
  const t = useT();
  // t() is one stable function; the locale keys the memo so labels follow it.
  const locale = useStore((st) => st.locale);
  const available = enabled && !!window.electronAPI?.browser?.policy?.get;
  const [protection, setProtection] = useState<PaneProtection>({ kind: 'off' });

  const reload = useCallback(() => {
    const api = window.electronAPI?.browser?.policy;
    if (!api || !available) return;
    void api.get(workspaceId, paneId).then((res) => {
      setProtection(paneProtection(res, workspaceId));
    }).catch(() => { /* keep the last answer */ });
  }, [available, workspaceId, paneId]);

  // Read on mount (the pane-level lock); the menu and a save re-read it.
  useEffect(() => {
    if (available) reload();
    else setProtection({ kind: 'off' });
  }, [available, reload]);

  const summary = useMemo(() => {
    if (protection.kind === 'off') return undefined;
    if (protection.kind === 'refused') return t('pane.browserPolicySummaryRefused');
    return protection.mode === 'allowlist'
      ? t('pane.browserPolicySummarySites', { count: protection.allowCount })
      : t('pane.browserPolicySummaryAny');
  }, [protection, t, locale]);

  const mainItems: PaneActionItem[] = useMemo(() => {
    if (!available) return [];
    // A pane that is protected already stays editable without its own
    // profile: turning protection off is how a refused pane is lifted.
    const openable = !!boundProfile || protection.kind !== 'off';
    return [{
      key: PANE_BROWSER_POLICY_KEY,
      label: t('pane.browserPolicy'),
      icon: <IconLock size={14} />,
      disabled: !openable,
      detail: openable ? summary : t('pane.browserPolicyNeedsProfile'),
      title: openable ? undefined : t('pane.browserPolicyNeedsProfile'),
      onSelect: openDialog,
    }];
  }, [available, boundProfile, protection.kind, summary, t, locale, openDialog]);

  return { mainItems, protection, summary, reload };
}
