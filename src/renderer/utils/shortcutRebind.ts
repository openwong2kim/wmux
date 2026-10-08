import { useStore } from '../stores';
import { t } from '../i18n';
import {
  UNBOUND_SHORTCUTS,
  builtinOwning,
  customKeybindingsOn,
  displayCombo,
  rebindProblem,
  shortcutDescription,
  type CustomKeyLike,
  type ShortcutActionId,
} from '../../shared/keymap';
import { currentShortcutBindings, shortcutPlatform } from './shortcutBindings';

/**
 * Rebinding a built-in from anywhere — Settings → Shortcuts and the command
 * palette both go through here, so the two can never disagree on what a key
 * may be moved to, or on how a refusal reads.
 */

/** The user-facing name of `action` (its Settings → Shortcuts label). */
export function describeShortcut(action: ShortcutActionId): string {
  const { key, vars } = shortcutDescription(action);
  return t(key as Parameters<typeof t>[0], vars);
}

/** Why `combo` cannot run `action`, as a sentence — or null when it can. */
export function rebindProblemText(action: ShortcutActionId, combo: string): string | null {
  const platform = shortcutPlatform();
  const problem = rebindProblem(
    action, combo, currentShortcutBindings(), platform, useStore.getState().prefixConfig.key,
  );
  if (!problem) return null;
  const shown = displayCombo(combo, platform);
  switch (problem.kind) {
    case 'needsModifier': return t(needsModifierKey(platform));
    case 'clipboard': return t('settings.sc.reservedKey', { combo: shown });
    case 'prefix': return t('settings.sc.prefixConflict', { combo: shown });
    case 'taken': return t('settings.sc.conflict', { name: describeShortcut(problem.by) });
  }
}

/**
 * The "needs a modifier" hint names the keys the platform has: ⌘ and ⌥ on
 * macOS, Ctrl and Alt elsewhere (#1885). Shift alone is not enough
 * (invalidShortcutCombo), so neither sentence offers it.
 */
export function needsModifierKey(
  platform: NodeJS.Platform,
): 'settings.sc.needsModifier' | 'settings.sc.needsModifierMac' {
  return platform === 'darwin' ? 'settings.sc.needsModifierMac' : 'settings.sc.needsModifier';
}

/** How a custom keybinding is named in a warning: its label, else its command. */
export function customKeybindingName(kb: CustomKeyLike): string {
  return kb.label.trim() || kb.command.trim() || kb.key;
}

/**
 * The key conflict to confirm before a save goes through (#1885), or null.
 * Built-ins are dispatched before custom keybindings, so either direction
 * leaves the custom keybinding dead on that key: the owner's call is to say
 * so and let the user go ahead anyway.
 */
export interface KeyConflict {
  /** `shadowsCustom`: a built-in is moving onto a custom keybinding's key.
   *  `builtinWins`: a custom keybinding is being put on a built-in's key. */
  kind: 'shadowsCustom' | 'builtinWins';
  /** The key as the user reads it (⌘ / ⌥ on macOS). */
  combo: string;
  /** Who loses (shadowsCustom) or who wins (builtinWins), ready to show. */
  name: string;
}

/**
 * Moving `action` to `combo` would take the key from these custom
 * keybindings. Null when none, or when `action` already runs on `combo`
 * (nothing changes, so there is nothing to warn about).
 */
export function customKeyConflict(action: ShortcutActionId, combo: string): KeyConflict | null {
  if (currentShortcutBindings().some((b) => b.action === action && b.combo === combo)) return null;
  // Only the first custom keybinding on a key ever fires (useKeyboard's
  // dispatch takes the first match), so that is the one that stops working.
  const [hit] = customKeybindingsOn(combo, useStore.getState().customKeybindings);
  if (!hit) return null;
  return {
    kind: 'shadowsCustom',
    combo: displayCombo(combo, shortcutPlatform()),
    name: customKeybindingName(hit),
  };
}

/** A custom keybinding on `key` would never fire: this built-in owns it. */
export function builtinKeyConflict(key: string): KeyConflict | null {
  const owner = builtinOwning(key, currentShortcutBindings(), useStore.getState().prefixConfig.key);
  if (owner === null) return null;
  return {
    kind: 'builtinWins',
    combo: displayCombo(key, shortcutPlatform()),
    name: owner === 'prefix' ? t('settings.prefixMode') : describeShortcut(owner),
  };
}

/** True for actions that ship with no key (see UNBOUND_SHORTCUTS). */
export function isUnboundByDefault(action: ShortcutActionId): boolean {
  return UNBOUND_SHORTCUTS.some((e) => e.action === action);
}

/**
 * Take the key off `action`. A built-in with a default is switched off (a
 * `null` override, so the key reaches the pane); an action that ships with no
 * key just loses its override, which leaves it unbound the same way.
 */
export function clearShortcut(action: ShortcutActionId): void {
  const state = useStore.getState();
  if (isUnboundByDefault(action)) state.resetShortcut(action);
  else state.setShortcutOverride(action, null);
}

/** The combo `action` runs on right now, in concrete form, or null if none. */
export function boundCombo(action: ShortcutActionId): string | null {
  return currentShortcutBindings().find((b) => b.action === action)?.combo ?? null;
}
