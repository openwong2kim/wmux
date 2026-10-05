import { useCallback, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { Icon, IconGear, IconKeyboard, IconRefresh } from '../icons';
import PaneActionsMenu, { PANE_ACTIONS_MENU_WIDTH, type PaneActionItem } from '../Pane/PaneActionsMenu';
import { effectiveBindings } from '../../../shared/keymap';
import { paletteShortcutLabel } from '../Titlebar/CommandPill';

/** `__APP_VERSION__` is a build-time define; tests run without it. */
function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
}

/**
 * The rail's foot: one "⋯" More button whose menu holds Settings (⌘,),
 * Keyboard shortcuts, Check for updates and the version line. The sidebar
 * toggle lives in the titlebar (SidebarToggle), so the foot no longer needs a
 * chevron, and Settings left the titlebar for this menu.
 */
export default function RailMoreMenu() {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const overrides = useStore((s) => s.shortcutOverrides);
  const platform = (typeof window === 'undefined' ? undefined : window.electronAPI?.platform) ?? 'linux';
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; right: number; bottom: number } | null>(null);
  const close = useCallback(() => setAnchor(null), []);

  const toggle = () => {
    if (anchor) { close(); return; }
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    // Beside the rail, on the side facing the content, its foot level with
    // the button's (placePopover flips it above the anchor near the bottom).
    const left = sidebarPosition === 'right' ? r.left - 4 - PANE_ACTIONS_MENU_WIDTH : r.right + 4;
    setAnchor({ top: r.bottom, bottom: r.bottom, left, right: left + PANE_ACTIONS_MENU_WIDTH });
  };

  const settingsCombo = effectiveBindings(platform, overrides).find((b) => b.action === 'openSettings')?.combo;
  const settingsShortcut = paletteShortcutLabel(platform, settingsCombo) || undefined;
  const items: PaneActionItem[] = [
    {
      key: 'settings',
      label: t('settings.title'),
      shortcut: settingsShortcut,
      icon: <IconGear size={13} />,
      onSelect: () => useStore.getState().setSettingsPanelVisible(true),
    },
    {
      key: 'shortcuts',
      label: t('settings.shortcuts'),
      icon: <IconKeyboard size={13} />,
      onSelect: () => useStore.getState().openSettingsTab('shortcuts'),
    },
    {
      key: 'check-updates',
      label: t('settings.checkUpdate'),
      icon: <IconRefresh size={13} />,
      // Settings › General shows the check's progress and result (it listens
      // to the updater's events), so the menu opens it and starts the check.
      onSelect: () => {
        useStore.getState().openSettingsTab('general');
        const check = window.electronAPI?.updater?.checkForUpdates;
        // Failures surface in Settings through the updater's error event.
        check?.().catch(() => undefined);
      },
    },
  ];
  const version = appVersion();

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`w-8 h-8 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--hover-fill)] transition-colors duration-150 ${FOCUS_RING}`}
        onClick={toggle}
        title={t('rail.more')}
        aria-label={t('rail.more')}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        data-rail-more
        data-onboarding-target="settings-button"
      >
        <Icon size={16}>
          <circle cx="3" cy="7" r="0.6" fill="currentColor" />
          <circle cx="7" cy="7" r="0.6" fill="currentColor" />
          <circle cx="11" cy="7" r="0.6" fill="currentColor" />
        </Icon>
      </button>
      {anchor && (
        <PaneActionsMenu
          anchor={anchor}
          triggerRef={buttonRef}
          items={items}
          onClose={close}
          footer={version ? t('rail.version', { version }) : undefined}
        />
      )}
    </>
  );
}
