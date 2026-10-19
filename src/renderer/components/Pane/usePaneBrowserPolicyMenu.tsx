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
import { resolvePanePolicy, type BlockedHost, type BrowserPolicyReadResult } from '../../../shared/browserPolicy';
import {
  allowListWithHost,
  allowRuleForHost,
  compileHostPolicy,
  type HostPolicy,
  type HostPolicyMode,
} from '../../../shared/browserHostPolicy';

/** A recently refused host the operator can allow, with the rule Allow adds. */
export interface AllowableBlockedHost extends BlockedHost {
  /** What the row shows and Allow adds: `host`, or `host:port` off 80/443. */
  rule: string;
  /** The pane's allow list after Allow. */
  nextAllow: string[];
}

/**
 * The recently refused hosts (#2063) an Allow would actually open, under the
 * pane's stored `hosts`. Only an "Only these sites" policy offers any; a host
 * a block rule refuses stays refused whatever the allow list says, and one a
 * rule already covers needs nothing, so neither is offered.
 */
export function allowableBlockedHosts(hosts: HostPolicy | undefined, blocked: readonly BlockedHost[]): AllowableBlockedHost[] {
  if (!hosts || hosts.mode !== 'allowlist') return [];
  const out: AllowableBlockedHost[] = [];
  for (const b of blocked) {
    const rule = allowRuleForHost(b.host, b.port);
    const nextAllow = allowListWithHost(hosts.allow, b.host, b.port);
    if (!rule || !nextAllow || nextAllow.length === hosts.allow.length) continue;
    if (!compileHostPolicy({ ...hosts, allow: nextAllow }).allows(b.host, b.port)) continue;
    // http and https to one host are one row: the bare rule opens both.
    const same = out.find((o) => o.rule === rule);
    if (same) {
      same.count += b.count;
      same.lastSeen = Math.max(same.lastSeen, b.lastSeen);
      continue;
    }
    out.push({ ...b, rule, nextAllow });
  }
  return out;
}

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
  // Recently refused hosts an Allow would open (#2063), so the menu row can
  // say there is something to look at in the editor.
  const [blockedCount, setBlockedCount] = useState(0);

  const reload = useCallback(() => {
    const api = window.electronAPI?.browser?.policy;
    if (!api || !available) return;
    void api.get(workspaceId, paneId).then(async (res) => {
      const next = paneProtection(res, workspaceId);
      setProtection(next);
      const hosts = res?.ok ? res.policy?.hosts : undefined;
      if (next.kind !== 'protected' || hosts?.mode !== 'allowlist' || !api.blocked) {
        setBlockedCount(0);
        return;
      }
      const blocked = await api.blocked(workspaceId, paneId);
      setBlockedCount(blocked?.ok ? allowableBlockedHosts(hosts, blocked.hosts ?? []).length : 0);
    }).catch(() => { /* keep the last answer */ });
  }, [available, workspaceId, paneId]);

  // Read on mount (the pane-level lock); the menu and a save re-read it.
  useEffect(() => {
    if (available) reload();
    else {
      setProtection({ kind: 'off' });
      setBlockedCount(0);
    }
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
    const detail = summary && blockedCount > 0
      ? `${summary} · ${t('pane.browserPolicySummaryBlocked', { count: blockedCount })}`
      : summary;
    return [{
      key: PANE_BROWSER_POLICY_KEY,
      label: t('pane.browserPolicy'),
      icon: <IconLock size={14} />,
      disabled: !openable,
      detail: openable ? detail : t('pane.browserPolicyNeedsProfile'),
      title: openable ? undefined : t('pane.browserPolicyNeedsProfile'),
      onSelect: openDialog,
    }];
  }, [available, boundProfile, protection.kind, summary, blockedCount, t, locale, openDialog]);

  return { mainItems, protection, summary, reload };
}
