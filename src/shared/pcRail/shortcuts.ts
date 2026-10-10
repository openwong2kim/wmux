/**
 * Default keys for moving between computers in the PC rail.
 *
 * WMUX_KEYMAP spreads these rows into its table (with the action ids in
 * SHORTCUT_ACTION_IDS), so they are listed, rebindable and conflict-checked
 * like every built-in. The rail claims them only while a computer is paired
 * and no custom keybinding sits on the chord; otherwise the pane gets them.
 *
 * Shift+Alt+Up/Down cycles computers the way Alt+Up/Down cycles workspaces;
 * Shift+Alt+Home returns to this computer. No Ctrl+Alt+digit: on Windows that
 * chord is AltGr, which types `{[]}` on many layouts. Alt+Shift alone is the
 * Windows input-language switch, but with an arrow or Home it is a distinct
 * chord; the rows stay rebindable like every other. Modifiers are spelled in
 * the resolver's order (Ctrl, Meta, Shift, Alt).
 */

export const PC_RAIL_SHORTCUT_ACTION_IDS = ['prevPc', 'nextPc', 'thisPc'] as const;

export type PcRailShortcutActionId = typeof PC_RAIL_SHORTCUT_ACTION_IDS[number];

export interface PcRailShortcutEntry {
  action: PcRailShortcutActionId;
  /** Cross-OS storage form, as in KeymapEntry. No `Ctrl`, so macOS uses it as written. */
  combo: string;
  descriptionKey: string;
}

export const PC_RAIL_SHORTCUTS: readonly PcRailShortcutEntry[] = [
  { action: 'prevPc', combo: 'Shift+Alt+ArrowUp', descriptionKey: 'settings.sc.prevPc' },
  { action: 'nextPc', combo: 'Shift+Alt+ArrowDown', descriptionKey: 'settings.sc.nextPc' },
  { action: 'thisPc', combo: 'Shift+Alt+Home', descriptionKey: 'settings.sc.thisPc' },
];
