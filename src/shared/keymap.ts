/**
 * Canonical table of the key combos wmux's renderer keymap owns.
 *
 * This exists because the same list used to be hand-copied into three places
 * (`useKeyboard.ts`'s if-chain, `SettingsPanel.tsx`'s BUILTIN_KEYS + shortcut
 * rows, `KeyboardCheatSheet.buildShortcuts()`), and nothing kept them in sync.
 * Issue #818 is what that costs: the application menu was never defined, so
 * Electron's default menu quietly owned `Cmd+Shift+R`, `Cmd+W`, and the three
 * zoom keys, and no single place in the codebase could be consulted to notice.
 *
 * `src/main/menu/appMenu.ts` is built against this table and
 * `appMenu.template.test.ts` fails CI if a menu item ever declares one of these
 * combos again. `useKeyboard.ts` still expresses its bindings as an if-chain —
 * converting that is deliberately a separate change — so when a binding is
 * added there, add its row here too.
 *
 *                       WMUX_KEYMAP (this file)
 *                          │        │        │
 *          ┌───────────────┘        │        └───────────────┐
 *          ▼                        ▼                        ▼
 *   SettingsPanel            appMenu.template.test    (useKeyboard.ts:
 *   BUILTIN_KEYS +           reserved-accelerator      manual, see above)
 *   shortcut rows            assertions
 *
 * `combo` is stored in the literal `Ctrl+…` form on every OS — the same form
 * `formatKeyCombo()` produces for custom keybindings, and the form the settings
 * UI persists. Rendering to `⌘` for macOS is a display concern; see
 * `macDisplayCombo()`.
 */

export interface KeymapEntry {
  /** Cross-OS storage form, e.g. `Ctrl+Shift+D`. */
  combo: string;
  /**
   * When true the binding uses literal Ctrl on macOS as well (the tmux prefix
   * and bookmark family — see the `literalCtrl` branches in useKeyboard.ts).
   * When false/absent, macOS substitutes ⌘ (the `cmdOrCtrl` branches).
   */
  literalCtrl?: boolean;
  /**
   * i18n key for the Settings → Shortcuts list. `null` means the binding is
   * real but not advertised there (it still reserves its accelerator).
   */
  descriptionKey: string | null;
}

/**
 * Every combo `useKeyboard.ts` binds, in the order Settings renders the
 * advertised subset. Rows with `descriptionKey: null` are bound but unlisted.
 */
export const WMUX_KEYMAP: readonly KeymapEntry[] = [
  // ── Advertised in Settings → Shortcuts (order is the render order) ────────
  { combo: 'Ctrl+D', descriptionKey: 'settings.sc.splitHorizontal' },
  { combo: 'Ctrl+Shift+D', descriptionKey: 'settings.sc.splitVertical' },
  { combo: 'Ctrl+T', descriptionKey: 'settings.sc.newWorkspace' },
  { combo: 'Ctrl+W', descriptionKey: 'settings.sc.closeSurface' },
  { combo: 'Ctrl+Shift+Q', descriptionKey: 'settings.sc.closePane' },
  { combo: 'Ctrl+F', descriptionKey: 'settings.sc.searchTerminal' },
  { combo: 'Ctrl+K', descriptionKey: 'settings.sc.commandPalette' },
  { combo: 'Ctrl+I', descriptionKey: 'settings.sc.toggleNotifications' },
  { combo: 'Ctrl+Shift+X', descriptionKey: 'settings.sc.viCopyMode' },
  { combo: 'Ctrl+Shift+R', descriptionKey: 'settings.sc.renameWorkspace' },
  { combo: 'Ctrl+Shift+H', descriptionKey: 'settings.sc.highlightPane' },
  { combo: 'Ctrl+`', descriptionKey: 'settings.sc.floatingPane' },

  // ── Bound but not advertised in the Settings list ─────────────────────────
  { combo: 'Ctrl+N', descriptionKey: null },
  { combo: 'Ctrl+M', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+B', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+Shift+B', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+Shift+M', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+,', descriptionKey: null },
  { combo: 'Ctrl+Shift+W', descriptionKey: null },
  { combo: 'Ctrl+Shift+A', descriptionKey: null },
  { combo: 'Ctrl+Shift+U', descriptionKey: null },
  { combo: 'Ctrl+Shift+L', descriptionKey: null },
  { combo: 'Ctrl+Shift+O', descriptionKey: null },
  { combo: 'Ctrl+Shift+G', descriptionKey: null },
  { combo: 'Ctrl+Shift+]', descriptionKey: null },
  { combo: 'Ctrl+Shift+[', descriptionKey: null },
  { combo: 'Ctrl+Tab', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+Shift+Tab', literalCtrl: true, descriptionKey: null },
  // Terminal font zoom. These are the combos Electron's default View menu
  // owned as resetZoom / zoomIn / zoomOut, so on macOS they hit webFrame zoom
  // instead of the terminal font — the reason the menu must not declare them.
  { combo: 'Ctrl+0', descriptionKey: null },
  { combo: 'Ctrl+=', descriptionKey: null },
  { combo: 'Ctrl+-', descriptionKey: null },
  // Workspace jump: Ctrl+1 … Ctrl+9.
  { combo: 'Ctrl+1', descriptionKey: null },
  { combo: 'Ctrl+2', descriptionKey: null },
  { combo: 'Ctrl+3', descriptionKey: null },
  { combo: 'Ctrl+4', descriptionKey: null },
  { combo: 'Ctrl+5', descriptionKey: null },
  { combo: 'Ctrl+6', descriptionKey: null },
  { combo: 'Ctrl+7', descriptionKey: null },
  { combo: 'Ctrl+8', descriptionKey: null },
  { combo: 'Ctrl+9', descriptionKey: null },
  // Directional movement. Ctrl+Shift+Arrow moves focus; Ctrl+Alt+Arrow is the
  // alternate (⌘+Alt+Arrow on mac) focus combo; Alt+Arrow cycles workspaces.
  { combo: 'Ctrl+Shift+Up', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+Shift+Down', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+Shift+Left', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+Shift+Right', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+Alt+Up', descriptionKey: null },
  { combo: 'Ctrl+Alt+Down', descriptionKey: null },
  { combo: 'Ctrl+Alt+Left', descriptionKey: null },
  { combo: 'Ctrl+Alt+Right', descriptionKey: null },
  { combo: 'Alt+Up', descriptionKey: null },
  { combo: 'Alt+Down', descriptionKey: null },
];

/**
 * The combos Settings advertises, in render order. Pairs each with its i18n
 * key so the panel no longer keeps its own copy of the list.
 */
export const ADVERTISED_SHORTCUTS: readonly Required<KeymapEntry>[] =
  WMUX_KEYMAP.filter((e): e is KeymapEntry & { descriptionKey: string } => e.descriptionKey !== null)
    .map((e) => ({ literalCtrl: false, ...e }));

/** Every combo wmux binds, as a Set of the literal storage form. */
export const WMUX_BUILTIN_COMBOS: ReadonlySet<string> = new Set(WMUX_KEYMAP.map((e) => e.combo));

/**
 * Render a stored combo for display on macOS: `Ctrl` becomes `⌘` unless the
 * binding is literal-Ctrl on every OS. Mirrors `shortcutLabel()`'s old inline
 * logic in SettingsPanel and the `cmdOrCtrl` split in useKeyboard.ts.
 */
export function macDisplayCombo(entry: KeymapEntry): string {
  return entry.literalCtrl ? entry.combo : entry.combo.replace(/Ctrl/g, '⌘');
}

/**
 * The same combos in Electron accelerator syntax, resolved for one platform.
 *
 * Resolving matters: the cmdOrCtrl family is `⌘` on macOS and `Ctrl` elsewhere,
 * while the literal-Ctrl family is `Ctrl` everywhere. On macOS that difference
 * is the whole reason the Window menu can keep `role: 'minimize'` — its ⌘M does
 * not touch wmux's Ctrl+M bookmark. A platform-agnostic comparison reports that
 * as a collision, which is wrong.
 */
export function reservedAccelerators(platform: NodeJS.Platform): readonly string[] {
  const cmdOrCtrl = platform === 'darwin' ? 'Command' : 'Control';
  return WMUX_KEYMAP.map((e) =>
    e.combo.replace(/^Ctrl/, e.literalCtrl ? 'Control' : cmdOrCtrl),
  );
}

/**
 * Resolve `CommandOrControl` / `CmdOrCtrl` to the concrete modifier `platform`
 * uses. Electron reports role accelerators in the agnostic form, so both sides
 * of a comparison have to be resolved before they can be compared exactly.
 */
export function resolveForPlatform(accelerator: string, platform: NodeJS.Platform): string {
  const concrete = platform === 'darwin' ? 'Command' : 'Control';
  return normalizeAccelerator(accelerator)
    .split('+')
    .map((part) => (part === 'CommandOrControl' ? concrete : part))
    .join('+');
}

/**
 * Normalize an Electron accelerator to the comparison form used above, so a
 * menu declaring `Cmd+W`, `Command+W`, `CmdOrCtrl+W`, or `Ctrl+W` all collapse
 * to one string. Modifier ORDER is normalized too — Electron accepts
 * `Shift+CmdOrCtrl+R` and `CmdOrCtrl+Shift+R` as the same chord.
 */
export function normalizeAccelerator(accelerator: string): string {
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts[parts.length - 1];
  const mods = new Set(
    parts.slice(0, -1).map((m) => {
      const lower = m.toLowerCase();
      if (lower === 'cmd' || lower === 'command' || lower === 'super' || lower === 'meta') return 'Command';
      if (lower === 'cmdorctrl' || lower === 'commandorcontrol') return 'CommandOrControl';
      if (lower === 'ctrl' || lower === 'control') return 'Control';
      if (lower === 'alt' || lower === 'option') return 'Alt';
      if (lower === 'shift') return 'Shift';
      return m;
    }),
  );
  // Fixed modifier order so chord equality is order-insensitive.
  const ordered = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift'].filter((m) => mods.has(m));
  const rest = [...mods].filter((m) => !ordered.includes(m));
  return [...ordered, ...rest, normalizeAcceleratorKey(key)].join('+');
}

/**
 * Fold the key half of an accelerator onto one spelling. Electron accepts
 * several names for the same physical key (`Plus`/`=`, `Up`/`Arrow Up`,
 * `Backquote`/`` ` ``), and the default menu's zoom roles use `Plus` where
 * wmux's table says `=`.
 */
function normalizeAcceleratorKey(key: string): string {
  const map: Record<string, string> = {
    plus: '=',
    numadd: '=',
    numsub: '-',
    minus: '-',
    backquote: '`',
    'arrowup': 'Up',
    'arrowdown': 'Down',
    'arrowleft': 'Left',
    'arrowright': 'Right',
  };
  const lower = key.toLowerCase();
  if (map[lower]) return map[lower];
  // Single characters compare case-insensitively (`W` vs `w`); named keys keep
  // their capitalized spelling (`Tab`, `Up`).
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
}

/**
 * True when two accelerators name the same chord on `platform`. Both sides are
 * normalized (spelling, modifier order, `Plus` vs `=`) and resolved, so
 * `CmdOrCtrl+W`, `Cmd+W`, and `Command+W` all compare equal on macOS while
 * `Cmd+M` and `Ctrl+M` stay distinct there.
 */
export function acceleratorsMatch(a: string, b: string, platform: NodeJS.Platform): boolean {
  return resolveForPlatform(a, platform) === resolveForPlatform(b, platform);
}

/** True when `accelerator` collides with a combo wmux's keymap owns on `platform`. */
export function collidesWithKeymap(accelerator: string, platform: NodeJS.Platform): boolean {
  return reservedAccelerators(platform).some((reserved) =>
    acceleratorsMatch(reserved, accelerator, platform),
  );
}
