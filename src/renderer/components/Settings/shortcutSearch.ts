/**
 * Matching for the Settings → Keyboard shortcuts search field.
 *
 * macOS shows modifiers as symbols (⌘K, ⌥…), so a query typed in words —
 * "cmd k", "option", "control" — would never match. Both sides are folded to
 * one spelling per modifier (⌘/cmd/command → cmd, ⌥/alt/option/opt → alt,
 * ⌃/ctrl/control → ctrl, ⇧/shift → shift) and put in one order, then
 * compared case-insensitively with spaces and '+' ignored, so "ctrl n",
 * "ctrl+n" and "ctrln" all find Ctrl+N, and "cmd shift d" finds ⇧⌘D.
 */

const MODIFIER_SYMBOLS: Record<string, string> = {
  '⌘': 'cmd', '⌥': 'alt', '⌃': 'ctrl', '⇧': 'shift',
  // Arrow keys are shown as arrows; "up", "arrow up" and "ArrowUp" find them.
  '↑': 'up', '↓': 'down', '←': 'left', '→': 'right',
};
const MODIFIER_WORDS: Record<string, string> = { command: 'cmd', control: 'ctrl', option: 'alt', opt: 'alt', arrow: '', esc: 'escape' };
// Longest names first, so "option" is not read as "opt" + "ion".
const MODIFIER_WORD_RE = /command|control|option|opt|arrow|escape|esc/g;

const squash = (text: string): string => text.toLowerCase().replace(/[\s+]/g, '');
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'cmd'] as const;

/**
 * Modifier symbols and names folded to one spelling, then squashed. Names are
 * folded after squashing, so a joined query ("optionk", "commandk") folds the
 * same as a spaced one ("option k").
 */
export function foldShortcutText(text: string): string {
  const spelled = squash(text.replace(/[⌘⌥⌃⇧↑↓←→]/g, (sym) => MODIFIER_SYMBOLS[sym]));
  const words = spelled.replace(MODIFIER_WORD_RE, (word) => MODIFIER_WORDS[word] ?? word);
  // Modifiers in one order (macOS lists ⇧⌘D, a query says "cmd shift d").
  const mods = MODIFIER_ORDER.filter((m) => words.includes(m));
  return mods.join('') + MODIFIER_ORDER.reduce((rest, m) => rest.replace(m, ''), words);
}

/** Whether a shortcut row (its action name and displayed keys) matches the query. */
export function matchesShortcutQuery(query: string, description: string, keys: string): boolean {
  const plain = squash(query);
  if (!plain) return true;
  // A query that folds to nothing ("arrow") must not match every row.
  const folded = foldShortcutText(query);
  return squash(description).includes(plain)
    || squash(keys).includes(plain)
    || (folded !== '' && foldShortcutText(keys).includes(folded));
}
