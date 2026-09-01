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
  // Ctrl+T adds a SURFACE to the active pane (useKeyboard.ts → addSurface);
  // the key that makes a workspace is Ctrl+N (addWorkspace), listed below.
  // This row said "New workspace" and pointed users at the wrong key while
  // hiding the right one — the cheat-sheet overlay had it right all along.
  { combo: 'Ctrl+T', descriptionKey: 'settings.sc.newTerminalInPane' },
  { combo: 'Ctrl+N', descriptionKey: 'settings.sc.newWorkspace' },
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
  //
  // The zoom-in/out handlers accept the shifted and numpad spellings of the
  // same physical key and do NOT require `!shift`, so every alias below is
  // swallowed before a custom binding could see it. Listing only the plain
  // forms let a user bind e.g. Ctrl+Shift++ with no conflict warning and then
  // watch it never fire (Codex review on #854). Reset (Ctrl+0) does require
  // `!shift`, so it has no shifted alias.
  { combo: 'Ctrl+0', descriptionKey: null },
  { combo: 'Ctrl+=', descriptionKey: null },
  { combo: 'Ctrl++', descriptionKey: null },
  { combo: 'Ctrl+Shift+=', descriptionKey: null },
  { combo: 'Ctrl+Shift++', descriptionKey: null },
  { combo: 'Ctrl+-', descriptionKey: null },
  { combo: 'Ctrl+_', descriptionKey: null },
  { combo: 'Ctrl+Shift+-', descriptionKey: null },
  { combo: 'Ctrl+Shift+_', descriptionKey: null },
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
  //
  // Spelled `ArrowUp`, not `Up`: `combo` is the STORAGE form, and storage is
  // whatever `formatKeyCombo()` produces from `KeyboardEvent.key` — which is
  // `ArrowUp`. Writing `Up` here made the Settings conflict check (an exact
  // Set lookup) miss every directional binding (Codex review on #854). The
  // accelerator side is unaffected: `normalizeAcceleratorKey` already folds
  // `arrowup` onto Electron's `Up`.
  { combo: 'Ctrl+Shift+ArrowUp', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+Shift+ArrowDown', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+Shift+ArrowLeft', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+Shift+ArrowRight', literalCtrl: true, descriptionKey: null },
  { combo: 'Ctrl+Alt+ArrowUp', descriptionKey: null },
  { combo: 'Ctrl+Alt+ArrowDown', descriptionKey: null },
  { combo: 'Ctrl+Alt+ArrowLeft', descriptionKey: null },
  { combo: 'Ctrl+Alt+ArrowRight', descriptionKey: null },
  { combo: 'Alt+ArrowUp', descriptionKey: null },
  { combo: 'Alt+ArrowDown', descriptionKey: null },
];

/**
 * The combos Settings advertises, in render order. Pairs each with its i18n
 * key so the panel no longer keeps its own copy of the list.
 */
export const ADVERTISED_SHORTCUTS: readonly Required<KeymapEntry>[] =
  WMUX_KEYMAP.filter((e): e is KeymapEntry & { descriptionKey: string } => e.descriptionKey !== null)
    .map((e) => ({ literalCtrl: false, ...e }));

/**
 * The combos a CUSTOM keybinding can actually lose to on `platform`.
 *
 * Not simply every row: custom bindings are matched with literal `e.ctrlKey`
 * on every OS (see the `formatKeyCombo(literalCtrl, …)` call in useKeyboard),
 * while a non-`literalCtrl` row is dispatched on `e.metaKey` under macOS. So on
 * macOS a custom `Ctrl+Shift+A` never meets the built-in, which fires on
 * `⌘+Shift+A` — warning about it is a false conflict (Codex review on #854).
 * Rows that are `literalCtrl`, or that carry no Ctrl at all (`Alt+ArrowUp`),
 * stay reachable there and do collide.
 *
 * On Windows and Linux `cmdOrCtrl === literalCtrl`, so every row collides.
 */
export function builtinCombosFor(platform: NodeJS.Platform): ReadonlySet<string> {
  const rows = platform === 'darwin'
    ? WMUX_KEYMAP.filter((e) => e.literalCtrl || !e.combo.startsWith('Ctrl'))
    : WMUX_KEYMAP;
  return new Set(rows.map((e) => e.combo));
}

/**
 * Render a stored combo for display on macOS: `Ctrl` becomes `⌘` unless the
 * binding is literal-Ctrl on every OS. Mirrors `shortcutLabel()`'s old inline
 * logic in SettingsPanel and the `cmdOrCtrl` split in useKeyboard.ts.
 */
/** The subset of KeyboardEvent both disabled-shortcut gates match against. */
export interface ShortcutKeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// Physical-code → combo character, for the non-letter keys the keymap owns.
// Letters/digits are derived from the Key*/Digit* prefix; these are the rest.
const CODE_TO_COMBO_CHAR: Record<string, string> = {
  Backquote: '`',
  Comma: ',',
  Minus: '-',
  Equal: '=',
};

function comboCharFromCode(code: string): string | null {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return CODE_TO_COMBO_CHAR[code] ?? null;
}

/**
 * #1152 — does this keydown match a user-disabled built-in combo?
 *
 * ONE function shared by BOTH gates (useKeyboard's capture handler and
 * useTerminal's xterm handler) so they can never disagree about which keys
 * are off — a combo caught by only one side would die in both worlds
 * (swallowed by the other gate) or stay half-bound.
 *
 * Combos are stored in WMUX_KEYMAP's cross-OS form ('Ctrl+T'), which on
 * macOS means ⌘ for the cmdOrCtrl family and literal Ctrl only for
 * `literalCtrl` rows — the same platform reading `builtinCombosFor` and the
 * individual useKeyboard handlers apply. Matching literal Ctrl for
 * everything on mac would swallow readline bytes (Ctrl+D EOF et al.) that
 * were never app shortcuts there.
 *
 * Matches by e.key AND by physical code (KeyX, DigitN, Backquote, Comma, …)
 * so a Hangul / non-Latin IME — where e.key is a composed glyph or
 * 'Process' — disables the same keys a Latin layout does.
 */
export function matchesDisabledShortcut(
  disabled: readonly string[],
  e: ShortcutKeyEventLike,
  platform: NodeJS.Platform,
): boolean {
  if (disabled.length === 0 || e.altKey) return false;
  if (!e.ctrlKey && !e.metaKey) return false;

  const mods = e.shiftKey ? 'Ctrl+Shift+' : 'Ctrl+';
  const candidates: string[] = [];
  if (e.key.length === 1) candidates.push(mods + e.key.toUpperCase());
  else if (e.key !== 'Process' && e.key !== 'Dead') candidates.push(mods + e.key);
  const byCode = comboCharFromCode(e.code);
  if (byCode !== null) candidates.push(mods + byCode);

  const mac = platform === 'darwin';
  for (const combo of candidates) {
    if (!disabled.includes(combo)) continue;
    const entry = WMUX_KEYMAP.find((k) => k.combo === combo);
    const wantsLiteralCtrl = entry?.literalCtrl === true;
    const modifierMatches = mac
      ? (wantsLiteralCtrl ? e.ctrlKey && !e.metaKey : e.metaKey)
      : e.ctrlKey;
    if (modifierMatches) return true;
  }
  return false;
}

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
