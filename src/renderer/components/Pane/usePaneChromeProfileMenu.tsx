// Pane actions menu → per-pane Chrome profile (src/shared/chromePaneBinding.ts).
//
// The workspace card binds a whole workspace to one Chrome profile
// (Sidebar/WorkspaceChromeProfileMenu); this narrows it to one pane, so two
// panes in a workspace can drive two signed-in accounts. Binding is a user
// action only — the binding is the authorization.
//
// Items for the pane menu (PaneActionsMenu), not a component of its own: the
// submenu is the same popover with a different item list, the way the Moa
// header menu steps into Model/Mode — one popover language.
//
// Backend gate: a pane binding is only consulted on the 'chrome' path, so under
// any other backend the items would offer a choice that changes nothing. Same
// gate, same reason as the workspace menu.

import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { IconExternalLink, IconUsers } from '../icons';
import type { PaneActionItem } from './PaneActionsMenu';
import { PANE_UNBINDABLE_PROFILES, paneProfileNameFrom } from './paneChromeProfileName';

/** Key of the main-menu item that opens the profile submenu. */
export const PANE_BROWSER_PROFILE_KEY = 'browser-profile';

type Reply = { ok: boolean; error?: string };

export function usePaneChromeProfileMenu(opts: {
  paneId: string;
  workspaceId: string;
  /** The pane's display name — the source of a new profile's name. */
  paneLabel: string;
  /** False for a read-only mirror, whose paneIds are not this main's panes. */
  allowed: boolean;
  /** Switch the open menu to the profile submenu. */
  openSubmenu: () => void;
}): { mainItems: PaneActionItem[]; subItems: PaneActionItem[]; reload: () => void } {
  const { paneId, workspaceId, paneLabel, allowed, openSubmenu } = opts;
  const t = useT();
  const isChrome = useStore((s) => s.browserBackend) === 'chrome';
  // Old preloads lack the per-pane calls; hide rather than offer a dead row.
  const enabled = allowed && isChrome && !!window.electronAPI?.browser?.chromeProfiles?.bindPane;
  const [profiles, setProfiles] = useState<string[]>([]);
  const [bound, setBound] = useState<string | undefined>(undefined);
  // Profiles main would refuse for this pane (bound to a workspace, or to
  // another pane) → the i18n key of the reason, shown on a disabled row.
  const [inUse, setInUse] = useState<Map<string, string>>(new Map());

  // Fetched when the menu opens, not per pane mount: a layout holds a dozen
  // panes and none of them needs the list until its menu is up.
  const reload = useCallback(() => {
    const api = window.electronAPI?.browser?.chromeProfiles;
    if (!api || !enabled) return;
    void api.list().then((res) => {
      setProfiles(res.profiles);
      // A binding recorded under another workspace is ignored by main's lookup
      // (the pane moved), so it is not this pane's binding here either.
      const b = res.paneBindings?.[paneId];
      setBound(b && b.workspaceId === workspaceId ? b.profile : undefined);
      const taken = new Map<string, string>();
      for (const p of Object.values(res.bindings)) taken.set(p, 'pane.browserProfileInUseWorkspace');
      for (const [otherPane, pb] of Object.entries(res.paneBindings ?? {})) {
        if (otherPane !== paneId && !taken.has(pb.profile)) taken.set(pb.profile, 'pane.browserProfileInUsePane');
      }
      setInUse(taken);
    }).catch(() => { /* menu keeps the last rows */ });
  }, [enabled, paneId, workspaceId]);

  const fail = useCallback((res: Reply | undefined, fallbackKey: string) => {
    useStore.getState().pushToast({ level: 'error', message: res?.error || t(fallbackKey) });
  }, [t]);

  const bindPane = useCallback(async (profile: string | null) => {
    const api = window.electronAPI?.browser?.chromeProfiles;
    if (!api) return;
    try {
      const res = await api.bindPane(paneId, workspaceId, profile);
      if (!res.ok) { fail(res, 'pane.browserProfileFailed'); return; }
      reload();
    } catch {
      fail(undefined, 'pane.browserProfileFailed');
    }
  }, [paneId, workspaceId, reload, fail]);

  const createForPane = useCallback(async () => {
    const api = window.electronAPI?.browser?.chromeProfiles;
    if (!api) return;
    let name: string;
    try {
      // De-duplicate against a fresh list, never the menu's snapshot (empty if
      // the open-time list failed): create() is idempotent on an existing name,
      // so a collision would bind this pane to someone else's profile.
      const { profiles: current } = await api.list();
      name = paneProfileNameFrom(paneLabel, current);
      const res = await api.create(name);
      if (!res.ok) { fail(res, 'pane.browserProfileFailed'); return; }
    } catch {
      fail(undefined, 'pane.browserProfileFailed');
      return;
    }
    await bindPane(name);
  }, [paneLabel, bindPane, fail]);

  const reveal = useCallback(async () => {
    const api = window.electronAPI?.browser?.chromeProfiles;
    if (!api) return;
    try {
      const res = await api.revealPane(paneId, workspaceId);
      if (!res.ok) fail(res, 'pane.showInChromeFailed');
    } catch {
      fail(undefined, 'pane.showInChromeFailed');
    }
  }, [paneId, workspaceId, fail]);

  const mainItems: PaneActionItem[] = useMemo(() => (enabled ? [
    {
      key: PANE_BROWSER_PROFILE_KEY,
      label: bound ? `${t('pane.browserProfile')}: ${bound}` : t('pane.browserProfile'),
      icon: <IconUsers size={14} />,
      hasPopup: true,
      onSelect: openSubmenu,
    },
    {
      key: 'show-in-chrome',
      label: t('pane.showInChrome'),
      icon: <IconExternalLink size={14} />,
      onSelect: () => { void reveal(); },
    },
  ] : []), [enabled, bound, t, openSubmenu, reveal]);

  const subItems: PaneActionItem[] = useMemo(() => {
    const bindable = profiles.filter((p) => !PANE_UNBINDABLE_PROFILES.has(p));
    return [
      ...bindable.map((name) => {
        const reason = name === bound ? undefined : inUse.get(name);
        return {
          key: `profile:${name}`,
          label: name,
          active: name === bound,
          disabled: !!reason,
          title: reason ? t(reason) : undefined,
          onSelect: () => { if (name !== bound) void bindPane(name); },
        };
      }),
      {
        key: 'profile-new',
        label: t('pane.browserProfileNew'),
        separatorBefore: bindable.length > 0,
        onSelect: () => { void createForPane(); },
      },
      ...(bound ? [{
        key: 'profile-unbind',
        label: t('pane.browserProfileUseWorkspace'),
        onSelect: () => { void bindPane(null); },
      }] : []),
    ];
  }, [profiles, bound, inUse, t, bindPane, createForPane]);

  return { mainItems, subItems, reload };
}
