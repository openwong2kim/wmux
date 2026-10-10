// Pane actions menu → "Browser protection…" (src/shared/browserPolicy.ts),
// and whether the pane is protected now (the tab's lock glyph).
//
// Offered under the same gate as the per-pane profile rows (chrome backend,
// not read-only, a preload that carries the calls). Protection needs a Chrome
// profile bound to this pane alone, so without one the row is disabled and
// says what to do first. The row opens BrowserPolicyDialog; nothing else here
// writes.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { IconLock } from '../icons';
import type { PaneActionItem } from './PaneActionsMenu';

/** Key of the main-menu item that opens the protection editor. */
export const PANE_BROWSER_POLICY_KEY = 'browser-policy';

export function usePaneBrowserPolicyMenu(opts: {
  paneId: string;
  workspaceId: string;
  /** The per-pane profile rows are offered (usePaneChromeProfileMenu). */
  enabled: boolean;
  /** The pane's own exclusive Chrome profile, if any. */
  boundProfile: string | undefined;
  /** The pane holds a browser tab — the only place the lock is drawn. */
  hasBrowserSurface: boolean;
  openDialog: () => void;
}): { mainItems: PaneActionItem[]; isProtected: boolean; reload: () => void } {
  const { paneId, workspaceId, enabled, boundProfile, hasBrowserSurface, openDialog } = opts;
  const t = useT();
  // t() is one stable function; the locale keys the memo so labels follow it.
  const locale = useStore((st) => st.locale);
  const available = enabled && !!window.electronAPI?.browser?.policy?.get;
  const [isProtected, setIsProtected] = useState(false);

  const reload = useCallback(() => {
    const api = window.electronAPI?.browser?.policy;
    if (!api || !available) return;
    void api.get(workspaceId, paneId).then((res) => {
      setIsProtected(!!res.ok && !!res.policy?.protected);
    }).catch(() => { /* keep the last answer */ });
  }, [available, workspaceId, paneId]);

  // Read once a browser tab is there to carry the lock; the menu and a save
  // re-read it. A pane with no browser tab never asks.
  useEffect(() => {
    if (available && hasBrowserSurface) reload();
    else if (!available) setIsProtected(false);
  }, [available, hasBrowserSurface, reload]);

  const mainItems: PaneActionItem[] = useMemo(() => (available ? [{
    key: PANE_BROWSER_POLICY_KEY,
    label: t('pane.browserPolicy'),
    icon: <IconLock size={14} />,
    disabled: !boundProfile,
    detail: boundProfile ? undefined : t('pane.browserPolicyNeedsProfile'),
    title: boundProfile ? undefined : t('pane.browserPolicyNeedsProfile'),
    onSelect: openDialog,
  }] : []), [available, boundProfile, t, locale, openDialog]);

  return { mainItems, isProtected, reload };
}
