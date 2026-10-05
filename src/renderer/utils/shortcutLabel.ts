import { displayCombo } from '../../shared/keymap';

/** A shortcut as the keyboard labels it: ⌘K and ⌘, on macOS, Ctrl+K elsewhere. */
export function shortcutLabel(platform: NodeJS.Platform, combo: string | undefined): string {
  if (!combo) return '';
  const shown = displayCombo(combo, platform);
  return platform === 'darwin' ? shown.replace(/^Ctrl\+/, '⌘').replace(/^⌘\+/, '⌘') : shown;
}
