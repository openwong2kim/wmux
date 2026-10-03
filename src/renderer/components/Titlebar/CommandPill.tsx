import type { CSSProperties } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { Icon } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { displayCombo, effectiveBindings } from '../../../shared/keymap';

/** The palette shortcut as the keyboard labels it (⌘K on macOS, Ctrl+K elsewhere). */
export function paletteShortcutLabel(platform: NodeJS.Platform, combo: string | undefined): string {
  if (!combo) return '';
  const shown = displayCombo(combo, platform);
  return platform === 'darwin' ? shown.replace(/^Ctrl\+/, '⌘').replace(/^⌘\+/, '⌘') : shown;
}

/**
 * The titlebar's entry to the search & command palette — a palette, not a
 * page, so it lives here rather than on the rail. A faint filled pill; only
 * the pill opts out of window dragging, the gap around it still drags. When
 * the gap is narrow it shrinks to the icon and the shortcut (ui.css).
 */
export default function CommandPill() {
  const t = useT();
  const overrides = useStore((s) => s.shortcutOverrides);
  const platform = (typeof window === 'undefined' ? undefined : window.electronAPI?.platform) ?? 'linux';
  const combo = effectiveBindings(platform, overrides).find((b) => b.action === 'commandPalette')?.combo;
  const shortcut = paletteShortcutLabel(platform, combo);
  const label = t('sidebar.search');
  return (
    <div className="wmux-command-pill-lane">
      <button
        type="button"
        className={`wmux-command-pill ${FOCUS_RING}`}
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        onClick={() => useStore.getState().toggleCommandPalette()}
        aria-label={shortcut ? `${label} (${shortcut})` : label}
        aria-haspopup="dialog"
        data-command-pill
      >
        <Icon size={13}><circle cx="6" cy="6" r="3.75" /><path d="m9 9 3.5 3.5" /></Icon>
        <span className="wmux-command-pill-label">{label}</span>
        {shortcut && <kbd className="wmux-command-pill-kbd">{shortcut}</kbd>}
      </button>
    </div>
  );
}
