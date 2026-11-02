import { useMemo } from 'react';
import { displayCombo, effectiveBindings, type ShortcutActionId } from '../../shared/keymap';
import { useStore } from '../stores';
import { shortcutPlatform } from './shortcutBindings';

/** A shortcut as the keyboard labels it: ⌘K and ⇧⌘D on macOS, Ctrl+K elsewhere. */
export function shortcutLabel(platform: NodeJS.Platform, combo: string | undefined): string {
  return combo ? displayCombo(combo, platform) : '';
}

/** The key `action` runs on right now (rebinds included), labelled; '' when it has none. */
export function useShortcutLabel(action: ShortcutActionId): string {
  const overrides = useStore((s) => s.shortcutOverrides);
  const platform = shortcutPlatform();
  return useMemo(
    () => shortcutLabel(platform, effectiveBindings(platform, overrides).find((b) => b.action === action)?.combo),
    [platform, overrides, action],
  );
}

/** A tooltip with its key after it, "New workspace (⌘N)"; just the label when there is no key. */
export function withShortcut(label: string, key: string): string {
  return key ? `${label} (${key})` : label;
}
