/**
 * wmux's built-in keyboard shortcuts: the ONE table, and the ONE matcher.
 *
 * Every built-in is a row here — a default combo paired with the action it
 * runs. Everything that has an opinion about a keydown reads this file:
 *
 *                       WMUX_KEYMAP (defaults)
 *                                 │   + user overrides (Settings → Shortcuts)
 *                                 ▼
 *                      effectiveBindings()
 *                                 │
 *        ┌─────────────────┬──────┴─────────┬──────────────────────┐
 *        ▼                 ▼                ▼                      ▼
 *   useKeyboard       useTerminal      useComposeShortcut      SettingsPanel
 *   runs the action   decides which    (Rich Input chord)      lists, rebinds,
 *   resolveShortcut   keys leave xterm resolveShortcut         disables rows
 *   returned          (same resolver)
 *
 *   appMenu.template.test — the defaults reserve their accelerators, so the
 *   application menu can never claim one (#818).
 *
 * Before #1455 the bindings lived in an if-chain in useKeyboard.ts, each
 * branch with its own modifier test, while this table and useTerminal's
 * bubble lists were hand-kept copies of it. Every disagreement between those
 * copies was a dead key: the #1152 disable gate had to re-derive the
 * modifier rules, a combo one side swallowed and the other declined reached
 * neither the app nor the pane, and no built-in could be moved off a key a TUI
 * needs (Alt+Up/Down, #1455). Now one resolver decides for everyone, and a
 * user override changes the one table they all read.
 *
 * `combo` is stored in the cross-OS form (`Ctrl+…`), the form custom
 * keybindings use too. On macOS a row that is not `literalCtrl` fires on ⌘:
 * `concreteCombo()` turns the storage form into the literal modifier set the
 * event carries (`Ctrl`, `Meta`, `Shift`, `Alt`), and that concrete form is
 * what the resolver and user overrides speak.
 */

/**
 * Every action a built-in shortcut can run. `prefix` is the tmux-style prefix
 * trigger: its key is configured separately (Settings → Prefix mode) and
 * useKeyboard handles it before the table is consulted, so its row only
 * reserves the default accelerator.
 */
export const SHORTCUT_ACTION_IDS = [
  'splitHorizontal', 'splitVertical', 'newSurface', 'newWorkspace',
  'closeSurface', 'closePane', 'searchTerminal', 'commandPalette',
  'toggleNotifications', 'richInput', 'viCopyMode', 'renameWorkspace',
  'highlightPane', 'floatingPane',
  'prevWorkspace', 'nextWorkspace',
  'workspace1', 'workspace2', 'workspace3', 'workspace4', 'workspace5',
  'workspace6', 'workspace7', 'workspace8', 'workspace9',
  'closeWorkspace', 'jumpToUnread',
  'nextSurface', 'prevSurface', 'nextPane', 'prevPane',
  'focusUp', 'focusDown', 'focusLeft', 'focusRight',
  'focusUpAlt', 'focusDownAlt', 'focusLeftAlt', 'focusRightAlt',
  'toggleSidebar', 'openSettings', 'toggleFleetView', 'toggleCompanyView',
  'clearMultiview', 'openBrowser', 'addBookmark', 'toggleMessageFeed',
  'zoomIn', 'zoomOut', 'zoomReset',
] as const;

export type ShortcutActionId = typeof SHORTCUT_ACTION_IDS[number];

export interface KeymapEntry {
  /** What the combo does. Several rows can share an action (aliases). */
  action: ShortcutActionId | 'prefix';
  /** Cross-OS storage form, e.g. `Ctrl+Shift+D`. */
  combo: string;
  /**
   * When true the binding uses literal Ctrl on macOS as well (the tmux prefix
   * and bookmark family). When false/absent, macOS substitutes ⌘.
   */
  literalCtrl?: boolean;
  /**
   * i18n key for the Settings → Shortcuts list, set on each action's primary
   * row. `null` on alias rows and on the prefix row, which Settings does not
   * list here.
   */
  descriptionKey: string | null;
  /** Interpolation vars for `descriptionKey` (the workspace number). */
  descriptionVars?: Record<string, number>;
}

const ws = (n: number): KeymapEntry => ({
  action: `workspace${n}` as ShortcutActionId,
  combo: `Ctrl+${n}`,
  descriptionKey: 'settings.sc.jumpWorkspace',
  descriptionVars: { n },
});

/**
 * Every default binding, in the order Settings renders them. The first row of
 * an action is its primary (the one Settings shows); later rows of the same
 * action are aliases that the resolver also accepts until the user rebinds or
 * disables that action, which replaces all of them at once.
 */
export const WMUX_KEYMAP: readonly KeymapEntry[] = [
  { action: 'splitHorizontal', combo: 'Ctrl+D', descriptionKey: 'settings.sc.splitHorizontal' },
  { action: 'splitVertical', combo: 'Ctrl+Shift+D', descriptionKey: 'settings.sc.splitVertical' },
  // Ctrl+T adds a SURFACE to the active pane; the key that makes a workspace
  // is Ctrl+N.
  { action: 'newSurface', combo: 'Ctrl+T', descriptionKey: 'settings.sc.newTerminalInPane' },
  { action: 'newWorkspace', combo: 'Ctrl+N', descriptionKey: 'settings.sc.newWorkspace' },
  { action: 'closeSurface', combo: 'Ctrl+W', descriptionKey: 'settings.sc.closeSurface' },
  { action: 'closePane', combo: 'Ctrl+Shift+Q', descriptionKey: 'settings.sc.closePane' },
  { action: 'searchTerminal', combo: 'Ctrl+F', descriptionKey: 'settings.sc.searchTerminal' },
  { action: 'commandPalette', combo: 'Ctrl+K', descriptionKey: 'settings.sc.commandPalette' },
  { action: 'toggleNotifications', combo: 'Ctrl+I', descriptionKey: 'settings.sc.toggleNotifications' },
  // Rich Input. Run by useComposeShortcut (ToolbarHost), a document-level
  // listener, not by useKeyboard — but it is a real binding, resolved by the
  // same resolver, so it can be switched off or moved: turning it off hands
  // Ctrl+G back to the pane (Claude Code's external editor, readline's abort),
  // the escape hatch #1280 asked for.
  { action: 'richInput', combo: 'Ctrl+G', descriptionKey: 'settings.sc.richInput' },
  { action: 'viCopyMode', combo: 'Ctrl+Shift+X', descriptionKey: 'settings.sc.viCopyMode' },
  { action: 'renameWorkspace', combo: 'Ctrl+Shift+R', descriptionKey: 'settings.sc.renameWorkspace' },
  { action: 'highlightPane', combo: 'Ctrl+Shift+H', descriptionKey: 'settings.sc.highlightPane' },
  { action: 'floatingPane', combo: 'Ctrl+`', descriptionKey: 'settings.sc.floatingPane' },

  // Workspaces. Alt+Up/Down cycle on the sidebar order; TUIs (Codex, Crush, …)
  // bind these keys too, which is why every row here can be moved (#1455).
  { action: 'prevWorkspace', combo: 'Alt+ArrowUp', descriptionKey: 'settings.sc.prevWorkspace' },
  { action: 'nextWorkspace', combo: 'Alt+ArrowDown', descriptionKey: 'settings.sc.nextWorkspace' },
  ws(1), ws(2), ws(3), ws(4), ws(5), ws(6), ws(7), ws(8),
  // Ctrl+9 jumps to the LAST workspace, whatever the count (browser tabs).
  { action: 'workspace9', combo: 'Ctrl+9', descriptionKey: 'settings.sc.lastWorkspace' },
  { action: 'closeWorkspace', combo: 'Ctrl+Shift+W', descriptionKey: 'settings.sc.closeWorkspace' },
  { action: 'jumpToUnread', combo: 'Ctrl+Shift+U', descriptionKey: 'settings.sc.jumpToUnread' },

  // Tabs and panes.
  { action: 'nextSurface', combo: 'Ctrl+Shift+]', descriptionKey: 'settings.sc.nextSurface' },
  { action: 'prevSurface', combo: 'Ctrl+Shift+[', descriptionKey: 'settings.sc.prevSurface' },
  // Browser-style cycling; literal Ctrl on every OS (Chrome / VS Code).
  { action: 'nextPane', combo: 'Ctrl+Tab', literalCtrl: true, descriptionKey: 'settings.sc.nextPane' },
  { action: 'prevPane', combo: 'Ctrl+Shift+Tab', literalCtrl: true, descriptionKey: 'settings.sc.prevPane' },
  // Ctrl+Shift+Arrow moves focus (panes, or tiles in multiview). Spelled
  // `ArrowUp`, not `Up`: storage is whatever KeyboardEvent.key says (#854).
  { action: 'focusUp', combo: 'Ctrl+Shift+ArrowUp', literalCtrl: true, descriptionKey: 'settings.sc.focusUp' },
  { action: 'focusDown', combo: 'Ctrl+Shift+ArrowDown', literalCtrl: true, descriptionKey: 'settings.sc.focusDown' },
  { action: 'focusLeft', combo: 'Ctrl+Shift+ArrowLeft', literalCtrl: true, descriptionKey: 'settings.sc.focusLeft' },
  { action: 'focusRight', combo: 'Ctrl+Shift+ArrowRight', literalCtrl: true, descriptionKey: 'settings.sc.focusRight' },
  // The alternate pane-focus combo (⌘+Alt+Arrow on macOS).
  { action: 'focusUpAlt', combo: 'Ctrl+Alt+ArrowUp', descriptionKey: 'settings.sc.focusUpAlt' },
  { action: 'focusDownAlt', combo: 'Ctrl+Alt+ArrowDown', descriptionKey: 'settings.sc.focusDownAlt' },
  { action: 'focusLeftAlt', combo: 'Ctrl+Alt+ArrowLeft', descriptionKey: 'settings.sc.focusLeftAlt' },
  { action: 'focusRightAlt', combo: 'Ctrl+Alt+ArrowRight', descriptionKey: 'settings.sc.focusRightAlt' },

  // Panels and views.
  // Sidebar pairs with the tmux prefix → literal Ctrl on every OS.
  { action: 'toggleSidebar', combo: 'Ctrl+Shift+B', literalCtrl: true, descriptionKey: 'settings.sc.toggleSidebar' },
  { action: 'openSettings', combo: 'Ctrl+,', descriptionKey: 'settings.sc.openSettings' },
  { action: 'toggleFleetView', combo: 'Ctrl+Shift+A', descriptionKey: 'settings.sc.toggleFleetView' },
  { action: 'toggleCompanyView', combo: 'Ctrl+Shift+O', descriptionKey: 'settings.sc.toggleCompanyView' },
  { action: 'clearMultiview', combo: 'Ctrl+Shift+G', descriptionKey: 'settings.sc.clearMultiview' },
  { action: 'openBrowser', combo: 'Ctrl+Shift+L', descriptionKey: 'settings.sc.openBrowser' },
  // Bookmark / message-feed convention → literal Ctrl on every OS.
  { action: 'addBookmark', combo: 'Ctrl+M', literalCtrl: true, descriptionKey: 'settings.sc.addBookmark' },
  { action: 'toggleMessageFeed', combo: 'Ctrl+Shift+M', literalCtrl: true, descriptionKey: 'settings.sc.toggleMessageFeed' },

  // Terminal font zoom. These are the combos Electron's default View menu
  // owned as resetZoom / zoomIn / zoomOut, so on macOS they hit webFrame zoom
  // instead of the terminal font — the reason the menu must not declare them.
  // Zoom in/out accept the shifted and numpad spellings of the same physical
  // key, so each alias is its own row (Codex review on #854).
  { action: 'zoomIn', combo: 'Ctrl+=', descriptionKey: 'settings.sc.zoomIn' },
  { action: 'zoomIn', combo: 'Ctrl++', descriptionKey: null },
  { action: 'zoomIn', combo: 'Ctrl+Shift+=', descriptionKey: null },
  { action: 'zoomIn', combo: 'Ctrl+Shift++', descriptionKey: null },
  { action: 'zoomIn', combo: 'Ctrl+NumpadAdd', descriptionKey: null },
  { action: 'zoomIn', combo: 'Ctrl+Shift+NumpadAdd', descriptionKey: null },
  { action: 'zoomOut', combo: 'Ctrl+-', descriptionKey: 'settings.sc.zoomOut' },
  { action: 'zoomOut', combo: 'Ctrl+_', descriptionKey: null },
  { action: 'zoomOut', combo: 'Ctrl+Shift+-', descriptionKey: null },
  { action: 'zoomOut', combo: 'Ctrl+Shift+_', descriptionKey: null },
  { action: 'zoomOut', combo: 'Ctrl+NumpadSubtract', descriptionKey: null },
  { action: 'zoomOut', combo: 'Ctrl+Shift+NumpadSubtract', descriptionKey: null },
  { action: 'zoomReset', combo: 'Ctrl+0', descriptionKey: 'settings.sc.zoomReset' },
  { action: 'zoomReset', combo: 'Ctrl+Numpad0', descriptionKey: null },

  // The default prefix trigger. Configured in Settings → Prefix mode.
  { action: 'prefix', combo: 'Ctrl+B', literalCtrl: true, descriptionKey: null },
];

/** One row per configurable action — the primary rows, in render order. */
export const ADVERTISED_SHORTCUTS: readonly (KeymapEntry & { action: ShortcutActionId; descriptionKey: string })[] =
  WMUX_KEYMAP.filter(
    (e): e is KeymapEntry & { action: ShortcutActionId; descriptionKey: string } =>
      e.descriptionKey !== null && e.action !== 'prefix',
  );

/**
 * The user's changes to the defaults, per action: a concrete combo moves the
 * action there (replacing every default row of it, aliases included), `null`
 * switches it off. Actions not listed keep their defaults.
 */
export type ShortcutOverrides = Partial<Record<ShortcutActionId, string | null>>;

/** A combo in concrete form, bound to what it runs. */
export interface ShortcutBinding {
  action: ShortcutActionId;
  /** Concrete form: literal `Ctrl` / `Meta` / `Shift` / `Alt` + key. */
  combo: string;
}

/** The default rows of `action`: its primary combo, then any aliases. */
export function defaultRowsFor(action: ShortcutActionId): KeymapEntry[] {
  return WMUX_KEYMAP.filter((e) => e.action === action);
}

/**
 * The storage form resolved to the literal modifiers `platform` presses:
 * on macOS a non-`literalCtrl` row's `Ctrl` is ⌘ (`Meta`).
 */
export function concreteCombo(entry: Pick<KeymapEntry, 'combo' | 'literalCtrl'>, platform: NodeJS.Platform): string {
  if (platform !== 'darwin' || entry.literalCtrl || !entry.combo.startsWith('Ctrl+')) return entry.combo;
  return 'Meta+' + entry.combo.slice('Ctrl+'.length);
}

export function isShortcutActionId(value: unknown): value is ShortcutActionId {
  return typeof value === 'string' && (SHORTCUT_ACTION_IDS as readonly string[]).includes(value);
}

/** The default bindings on `platform` (the prefix row excluded). */
export function defaultBindings(platform: NodeJS.Platform): ShortcutBinding[] {
  const out: ShortcutBinding[] = [];
  for (const entry of WMUX_KEYMAP) {
    if (entry.action === 'prefix') continue;
    out.push({ action: entry.action, combo: concreteCombo(entry, platform) });
  }
  return out;
}

/** The bindings in force: the defaults with the user's overrides applied. */
export function effectiveBindings(platform: NodeJS.Platform, overrides: ShortcutOverrides): ShortcutBinding[] {
  const out = defaultBindings(platform).filter((b) => !(b.action in overrides));
  for (const [action, combo] of Object.entries(overrides)) {
    if (isShortcutActionId(action) && typeof combo === 'string') out.push({ action, combo });
  }
  return out;
}

/** The subset of KeyboardEvent the resolver reads. */
export interface ShortcutKeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const MODIFIER_KEYS: readonly string[] = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'];

// Physical code → combo key for the non-letter keys. Letters and digits are
// derived from the Key*/Digit* prefix.
const CODE_TO_COMBO_KEY: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

// Codes whose name IS the combo key (KeyboardEvent.key spells them the same).
const NAMED_CODE = /^(Arrow(Up|Down|Left|Right)|Tab|Enter|Escape|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|F\d{1,2}|Numpad\w+)$/;

/** The combo key a physical `code` stands for, or null. */
export function comboKeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (CODE_TO_COMBO_KEY[code]) return CODE_TO_COMBO_KEY[code];
  return NAMED_CODE.test(code) ? code : null;
}

function modifierPrefix(e: ShortcutKeyEventLike): string {
  let s = '';
  if (e.ctrlKey) s += 'Ctrl+';
  if (e.metaKey) s += 'Meta+';
  if (e.shiftKey) s += 'Shift+';
  if (e.altKey) s += 'Alt+';
  return s;
}

/**
 * The key names a keydown can be matched by, most specific first.
 *
 * The LOGICAL key (`e.key`) comes first, so a Dvorak or AZERTY user presses
 * the letter printed on their keycap (#1227). The PHYSICAL code is a fallback
 * only when `e.key` is not a plain ASCII letter or digit — under a Hangul /
 * non-Latin IME `key` is a composed glyph or 'Process', and with Shift held a
 * bracket arrives as `{`/`}` — so those keys still reach their binding.
 */
function keyCandidates(e: ShortcutKeyEventLike): string[] {
  const out: string[] = [];
  const k = e.key;
  if (k === ' ') out.push('Space');
  else if (k.length === 1) out.push(k.toUpperCase());
  else if (k !== 'Process' && k !== 'Dead' && k !== 'Unidentified') out.push(k);
  if (!/^[A-Za-z0-9]$/.test(k)) {
    const physical = comboKeyFromCode(e.code);
    if (physical !== null && !out.includes(physical)) out.push(physical);
  }
  return out;
}

/**
 * THE matcher: which action, if any, this keydown runs under `bindings`.
 *
 * Modifiers match exactly — Ctrl, ⌘/Meta, Shift and Alt are each either part
 * of the combo or not held — so a binding can never swallow a chord that is
 * some other binding's (or the pane's): Alt+Up is not Meta+Alt+Up is not
 * Ctrl+Alt+Up.
 */
export function resolveShortcut(
  e: ShortcutKeyEventLike,
  bindings: readonly ShortcutBinding[],
): ShortcutActionId | null {
  if (MODIFIER_KEYS.includes(e.key)) return null;
  const mods = modifierPrefix(e);
  for (const k of keyCandidates(e)) {
    const combo = mods + k;
    const hit = bindings.find((b) => b.combo === combo);
    if (hit) return hit.action;
  }
  return null;
}

/**
 * The tmux-style prefix trigger: literal Ctrl + the configured physical key
 * (`prefixConfig.key`, a `KeyboardEvent.code` so a Hangul IME cannot mangle
 * it — commit 60e39b0), on every OS. useKeyboard enters prefix mode on it and
 * useTerminal keeps it out of the pane; both ask this.
 */
export function isPrefixTrigger(e: ShortcutKeyEventLike, prefixKeyCode: string): boolean {
  return e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.code === prefixKeyCode;
}

// A keydown whose `key` an IME replaced: 'Process', or a composed glyph.
function isImeKey(key: string): boolean {
  return key === 'Process' || (key.length === 1 && key > '\x7e');
}

/**
 * One physical press runs a shortcut at most once.
 *
 * While a Windows IME composition is open (Hangul ㄱ pending), Chromium
 * delivers TWO keydowns for one Ctrl+T: first `key='Process', code='KeyT'`,
 * then — after the IME commits — `key='t', code='KeyT'`. Both resolve (the
 * first through the physical-code fallback), so without this every letter
 * shortcut fired twice: one Ctrl+W closed two tabs. The first keydown cannot
 * simply be ignored, because the follow-up does not always come.
 *
 * So every gate that ACTS on a keydown notes it, and asks before acting
 * whether a keydown is the plain-key follow-up of an IME keydown it already
 * acted on: same physical code, same modifiers, before that key's keyup.
 * The follow-up is then swallowed whole — no second action and no byte to
 * the pane. `repeat` is not consulted: a held key may repeat as the same
 * pair. A plain press never arms the guard, so key repeat and two separate
 * presses behave as before.
 */
export class ShortcutPressGuard {
  private armed: { event: object; code: string; mods: string } | null = null;
  private swallowed: object | null = null;

  /** A gate acted on `e` (ran an action, wrote a byte, entered prefix mode). */
  noteActed(e: ShortcutKeyEventLike): void {
    if (e === this.armed?.event) return;
    this.armed = isImeKey(e.key) ? { event: e, code: e.code, mods: modifierPrefix(e) } : null;
  }

  /**
   * Is `e` the IME follow-up of a press a gate already acted on? One-shot,
   * but stable for the event it matched, so every gate the same keydown
   * passes through gets the same answer.
   */
  isDuplicate(e: ShortcutKeyEventLike): boolean {
    if (e === this.swallowed) return true;
    const armed = this.armed;
    if (!armed || e === armed.event || MODIFIER_KEYS.includes(e.key)) return false;
    this.armed = null;
    if (isImeKey(e.key) || e.code !== armed.code || modifierPrefix(e) !== armed.mods) return false;
    this.swallowed = e;
    return true;
  }

  /** The press is over: its follow-up, if any, has come and gone. */
  onKeyUp(e: { code: string }): void {
    if (this.armed?.code === e.code) this.armed = null;
  }
}

/**
 * The concrete combo a keydown spells, for recording a new binding — or null
 * while only modifiers are held. Uses the same key naming the resolver
 * matches first, so a recorded combo always resolves again.
 */
export function comboFromEvent(e: ShortcutKeyEventLike): string | null {
  if (MODIFIER_KEYS.includes(e.key)) return null;
  const [first] = keyCandidates(e);
  if (!first) return null;
  // Record the physical key when the logical one is a non-ASCII glyph (IME):
  // the glyph changes with the input mode, the code does not.
  const physical = comboKeyFromCode(e.code);
  const key = /^[\x20-\x7e]$/.test(first) || first.length > 1 || physical === null ? first : physical;
  return modifierPrefix(e) + key;
}

/**
 * Why a combo cannot be a shortcut, or null when it can. A binding with no
 * Ctrl / ⌘ / Alt would eat a character the user types (a bare `A` or
 * Shift+`A`), so it needs one — function keys excepted.
 */
export function invalidShortcutCombo(combo: string): 'empty' | 'needsModifier' | null {
  const parts = combo.split('+');
  const key = combo.endsWith('+') ? '+' : parts[parts.length - 1];
  if (!key || MODIFIER_KEYS.includes(key)) return 'empty';
  const mods = combo.slice(0, combo.length - key.length);
  if (/^F\d{1,2}$/.test(key)) return null;
  return /(^|\+)(Ctrl|Meta|Alt)\+/.test(mods) ? null : 'needsModifier';
}

/**
 * Combos the terminal itself owns for the clipboard (useTerminal's copy /
 * paste handlers run AFTER shortcuts are resolved, so a shortcut moved onto
 * one would silently take copy or paste away). On macOS copy/paste is ⌘ and
 * Ctrl+C stays SIGINT, so only the ⌘ pair and the Ctrl+Shift fallbacks count.
 */
export function clipboardCombos(platform: NodeJS.Platform): readonly string[] {
  return platform === 'darwin'
    ? ['Meta+C', 'Meta+V', 'Ctrl+Shift+C', 'Ctrl+Shift+V']
    : ['Ctrl+C', 'Ctrl+V', 'Ctrl+Shift+C', 'Ctrl+Shift+V'];
}

export type RebindProblem =
  | { kind: 'needsModifier' }
  | { kind: 'clipboard' }
  | { kind: 'prefix' }
  | { kind: 'taken'; by: ShortcutActionId };

/**
 * Why `action` cannot move to `combo` right now, or null when it can. The one
 * rule set Settings checks before it writes an override: a combo must be
 * pressable without eating a typed character, must not take copy / paste or
 * the prefix trigger, and must not already run another action — two actions
 * on one key would leave one of them unreachable with no sign why.
 */
export function rebindProblem(
  action: ShortcutActionId,
  combo: string,
  bindings: readonly ShortcutBinding[],
  platform: NodeJS.Platform,
  prefixKeyCode: string,
): RebindProblem | null {
  if (invalidShortcutCombo(combo) !== null) return { kind: 'needsModifier' };
  if (clipboardCombos(platform).includes(combo)) return { kind: 'clipboard' };
  const prefixKey = comboKeyFromCode(prefixKeyCode);
  if (prefixKey !== null && combo === 'Ctrl+' + prefixKey) return { kind: 'prefix' };
  const other = bindings.find((b) => b.combo === combo && b.action !== action);
  return other ? { kind: 'taken', by: other.action } : null;
}

/**
 * Keep only well-formed overrides for configurable actions. Session files are
 * hand-editable and outlive versions, so anything else is dropped rather than
 * trusted — an unknown action would have no Settings row to undo it from.
 */
export function sanitizeShortcutOverrides(raw: unknown): ShortcutOverrides {
  const out: ShortcutOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const configurable = new Set<string>(ADVERTISED_SHORTCUTS.map((e) => e.action));
  for (const [action, combo] of Object.entries(raw as Record<string, unknown>)) {
    if (!isShortcutActionId(action) || !configurable.has(action)) continue;
    if (combo === null) out[action] = null;
    else if (typeof combo === 'string' && invalidShortcutCombo(combo) === null) out[action] = combo;
  }
  return out;
}

/**
 * #1152 sessions stored switched-off built-ins as a list of storage-form
 * combos. Each becomes a `null` override for the action it named.
 */
export function overridesFromDisabledCombos(disabled: unknown): ShortcutOverrides {
  const out: ShortcutOverrides = {};
  if (!Array.isArray(disabled)) return out;
  for (const combo of disabled) {
    const row = ADVERTISED_SHORTCUTS.find((e) => e.combo === combo);
    if (row) out[row.action] = null;
  }
  return out;
}

/**
 * The combos the built-ins hold on `platform`, in concrete form — what a
 * CUSTOM keybinding (matched on literal Ctrl/Shift/Alt, never ⌘) can collide
 * with. On macOS a ⌘ built-in cannot meet a custom `Ctrl+…` binding, so
 * it is not reported as a conflict (Codex review on #854).
 */
export function builtinCombosFor(
  platform: NodeJS.Platform,
  overrides: ShortcutOverrides = {},
): ReadonlySet<string> {
  return new Set(effectiveBindings(platform, overrides).map((b) => b.combo));
}

/**
 * Render a concrete combo the way the keyboard labels it: ⌘ and ⌥ on macOS,
 * Win / Super for the Meta key elsewhere.
 */
export function displayCombo(combo: string, platform: NodeJS.Platform): string {
  const mac = platform === 'darwin';
  return combo
    .replace(/(^|\+)Meta(?=\+)/g, `$1${mac ? '⌘' : platform === 'win32' ? 'Win' : 'Super'}`)
    .replace(/(^|\+)Alt(?=\+)/g, `$1${mac ? '⌥' : 'Alt'}`);
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
