/**
 * Pure decision core for the focus-independent Ctrl+C copy shortcut.
 *
 * The bug (RCA): when the channel dock / composer textarea owns DOM keyboard
 * focus, the user can still drag-select terminal text, but Ctrl+C never reaches
 * xterm's `attachCustomKeyEventHandler` (it only runs while the terminal's
 * `.xterm-helper-textarea` is focused). The keypress lands on the empty composer
 * and silently does nothing — no copy, no `^C`, no toast.
 *
 * This function decides, from a DOM-free snapshot, whether a document-level
 * Ctrl+C should copy a terminal selection or YIELD (do nothing) so that the
 * pre-existing behavior is preserved. It performs NO DOM / registry access so it
 * can be exhaustively unit-tested in the repo's node (no-JSDOM) vitest env. The
 * thin hook (`useTerminalCopyShortcut`) reads the live DOM into this snapshot and
 * acts on the verdict.
 *
 * Yield (return null) — and thus preserve existing behavior — when:
 *   1. focus is already on a terminal's xterm helper textarea → the existing
 *      `useTerminal` Ctrl+C handler owns copy / SIGINT for that pane.
 *   2. focus is on an editable element that has its OWN non-empty selection →
 *      the user is copying out of an input/textarea/contenteditable (composer),
 *      so its native copy must win.
 *   3. no terminal currently holds a non-empty selection → there is nothing to
 *      copy; let the keystroke fall through to SIGINT (`^C`).
 *   4. the choice is ambiguous: multiple terminals hold selections and none of
 *      them is the active pane → refuse to guess.
 *
 * Otherwise it returns the terminal to copy from: the active pane's terminal if
 * it has a selection, else the single unambiguous selected terminal.
 */

/** DOM-free description of `document.activeElement` at keypress time. */
export interface ActiveElementInfo {
  /** activeElement carries the `xterm-helper-textarea` class (terminal focus). */
  isXtermTextarea: boolean;
  /** activeElement is an INPUT / TEXTAREA / contenteditable element. */
  isEditable: boolean;
  /** That editable element holds a non-empty selection of its own. */
  hasOwnSelection: boolean;
}

/** A single terminal's current xterm `getSelection()` snapshot. */
export interface TerminalSelectionSnapshot {
  ptyId: string;
  selection: string;
}

export interface CopyTargetInput {
  /** Current `getSelection()` for every live registered terminal. */
  selections: TerminalSelectionSnapshot[];
  /** ptyId of the active pane's terminal, or null when none resolves. */
  activePtyId: string | null;
  /** Snapshot of the focused element, or null when nothing is focused. */
  activeElement: ActiveElementInfo | null;
}

/**
 * Resolve which terminal (if any) a focus-independent Ctrl+C should copy from.
 * Returns the chosen `{ ptyId, selection }`, or null to YIELD (preserve the
 * existing copy / SIGINT / composer-copy behavior).
 */
export function resolveCopyTarget(
  input: CopyTargetInput,
): TerminalSelectionSnapshot | null {
  const { selections, activePtyId, activeElement } = input;

  // (1) Terminal already focused — defer to its own xterm Ctrl+C handler.
  if (activeElement?.isXtermTextarea) return null;

  // (2) An editable element with its own selection owns the copy (composer).
  if (activeElement?.isEditable && activeElement.hasOwnSelection) return null;

  // Only terminals with a non-empty selection are copy candidates.
  const withSelection = selections.filter((s) => s.selection.length > 0);

  // (3) Nothing selected anywhere — fall through to SIGINT.
  if (withSelection.length === 0) return null;

  // Prefer the active pane's terminal when it is one of the candidates.
  const active = activePtyId
    ? withSelection.find((s) => s.ptyId === activePtyId)
    : undefined;
  if (active) return active;

  // No active candidate: only act when the choice is unambiguous.
  if (withSelection.length === 1) return withSelection[0];

  // (4) Multiple selected terminals, none active — refuse to guess.
  return null;
}
