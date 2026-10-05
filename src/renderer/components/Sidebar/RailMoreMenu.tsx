import { useCallback, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { Icon, IconGear, IconKeyboard, IconRefresh } from '../icons';
import PaneActionsMenu, { PANE_ACTIONS_MENU_WIDTH, type PaneActionItem } from '../Pane/PaneActionsMenu';
import { effectiveBindings } from '../../../shared/keymap';
import { shortcutLabel } from '../../utils/shortcutLabel';
import { selectMoaOn } from '../Layout/moaDockGate';

/** Focus an element once it is on screen. Settings mounts lazily, so it is
 *  looked for over the next frames (about a second), then given up. */
function focusWhenShown(selector: string, frames = 60): void {
  if (typeof requestAnimationFrame !== 'function') return;
  const el = document.querySelector<HTMLElement>(selector);
  if (el) {
    el.focus();
    el.scrollIntoView?.({ block: 'center' });
    return;
  }
  if (frames > 0) requestAnimationFrame(() => focusWhenShown(selector, frames - 1));
}

/** `__APP_VERSION__` is a build-time define; tests run without it. */
function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
}

/**
 * The rail's foot: one "⋯" More button whose menu holds Command palette (⌘K),
 * Settings (⌘,),
 * Keyboard shortcuts, Check for updates and the version line. The sidebar
 * toggle lives in the titlebar (SidebarToggle), so the foot no longer needs a
 * chevron, and Settings left the titlebar for this menu.
 */
export default function RailMoreMenu() {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const overrides = useStore((s) => s.shortcutOverrides);
  // With Moa off there is no right panel and no titlebar toggle: this entry
  // (and Settings › Moa) is where Moa is turned on.
  // Same answer as the dock gate, including the boot moment before main
  // has said whether Moa is on.
  const moaOff = useStore((s) => !selectMoaOn(s));
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
  const settingsShortcut = shortcutLabel(platform, settingsCombo) || undefined;
  const paletteCombo = effectiveBindings(platform, overrides).find((b) => b.action === 'commandPalette')?.combo;
  const items: PaneActionItem[] = [
    {
      // The palette's only visible entry now that the titlebar has no pill.
      key: 'command-palette',
      label: t('rail.commandPalette'),
      shortcut: shortcutLabel(platform, paletteCombo) || undefined,
      icon: <Icon size={13}><circle cx="6" cy="6" r="3.75" /><path d="m9 9 3.5 3.5" /></Icon>,
      onSelect: () => useStore.getState().toggleCommandPalette(),
    },
    {
      key: 'settings',
      label: t('settings.title'),
      shortcut: settingsShortcut,
      icon: <IconGear size={13} />,
      onSelect: () => useStore.getState().setSettingsPanelVisible(true),
    },
    ...(moaOff ? [{
      key: 'turn-on-moa',
      label: t('rail.turnOnMoa'),
      // A power mark, not Moa's mascot: the mascot is Moa's own titlebar icon.
      icon: <Icon size={13}><path d="M7 2v5" /><path d="M4.2 4.2a4 4 0 1 0 5.6 0" /></Icon>,
      onSelect: () => useStore.getState().openSettingsTab('moa'),
    }] : []),
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
      // Settings › General owns the check: its button shows checking and
      // progress and is disabled while one runs. The menu opens it and puts
      // focus on that button, so the check itself is one more press there and
      // never runs twice or out of the widget's sight.
      onSelect: () => {
        useStore.getState().openSettingsTab('general');
        focusWhenShown('[data-settings-check-update]');
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
