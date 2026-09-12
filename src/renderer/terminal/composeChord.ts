/**
 * The ONE definition of the Rich Input chord (⌘G on macOS, Ctrl+G elsewhere).
 *
 * Two gates have to agree about this key, and #1280 is what their
 * disagreement costs:
 *
 *   • `useTerminal`'s xterm key handler decides whether the pane gets a byte.
 *   • `useComposeShortcut` (a document-level listener) decides whether the
 *     Rich Input popover opens.
 *
 * xterm's own encode path calls `stopPropagation` (its `cancel()`), so the
 * pane gate runs FIRST and the popover gate only ever sees keys the pane gate
 * let bubble. Any condition one gate applies and the other cannot see produces
 * a silently dead key: swallowed by the pane, declined by the popover. That is
 * exactly how the loose matcher shipped — the popover gate accepted
 * Ctrl+Shift+G (`key` is 'G' precisely when Shift is held) while the pane gate
 * was still writing BEL for plain Ctrl+G.
 *
 * So the chord is a pure predicate, exported, and both gates call it. It can
 * be wrong, but it cannot be inconsistent.
 *
 * What the predicate deliberately excludes:
 *
 *   • `isComposing` — every other control-letter path in the renderer defers
 *     during an IME composition (`resolveCtrlLetterByte`, `resolveNewlineKeyByte`,
 *     the IME-Escape branch). Without it a Hangul preedit plus the physical
 *     `KeyG` fallback below popped Rich Input mid-composition. Deferring hands
 *     the key to xterm, which drops keyCode-229 keydowns — the same no-op every
 *     other ctrl-letter already has while composing.
 *   • Shift and Alt — Ctrl+Shift+G is `clearMultiview`, and Ctrl+Alt+G /
 *     Ctrl+Meta+G are nobody's binding, so they must keep reaching the pane.
 *
 * What it deliberately INCLUDES:
 *
 *   • `key === 'G'` with Shift up, which happens under Caps Lock.
 *   • The physical `code` fallback, for a Hangul / non-Latin layout where
 *     `key` is a composed jamo or 'Process' (mirrors the Ctrl+C / Ctrl+J
 *     handlers in useTerminal).
 *   • Auto-repeat. Holding the chord is still the chord: the popover gate
 *     declines to TOGGLE on a repeat (flapping it open and shut is not what
 *     the user asked for), but both gates agree the key belongs to the
 *     binding, so a held Ctrl+G produces one toggle and then nothing —
 *     a non-repeating chord — instead of a stream of BEL.
 */

export interface ComposeChordEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}

export function isComposeChord(
  e: ComposeChordEventLike,
  platform: NodeJS.Platform,
): boolean {
  if (e.shiftKey || e.altKey || e.isComposing) return false;
  // macOS binds ⌘G — literal Ctrl+G there is a readline byte, and the toolbar
  // renders the chip as ⌘G. Windows/Linux bind literal Ctrl+G.
  const baseModifier = platform === 'darwin'
    ? e.metaKey && !e.ctrlKey
    : e.ctrlKey && !e.metaKey;
  if (!baseModifier) return false;
  return e.key === 'g' || e.key === 'G' || e.code === 'KeyG';
}

/**
 * Ownership, the other half of #1280 — and the half the first fix only wired
 * into ONE of the two gates.
 *
 * `useComposeShortcut` toggles Rich Input for the workspace's ACTIVE LEAF pty,
 * because that is the pane whose toolbar renders the popover. So only that
 * pane's terminal may fire the chord. Give the key to any other xterm and the
 * popover opens over the wrong pane: the live dogfood on the floating pane
 * (Cmd+` / Ctrl+`) hit exactly that — its own pty received 0 bytes while the
 * popover opened on a background pane, which on Windows is the original
 * complaint (`^G` in the floating pane AND a popover elsewhere).
 *
 * `useTerminal` stamps every terminal container with its ptyId, and adds the
 * owner marker only where `ownsComposeShortcut` is set (Terminal.tsx, the
 * pane-surface terminal — not FloatingPane, not Deck's BrainTerminalEmbed).
 * Both gates then read ownership from the same marker instead of each holding
 * an opinion.
 */
export const TERMINAL_PTY_ATTR = 'data-terminal-pty';
export const COMPOSE_OWNER_ATTR = 'data-compose-owner';

export interface ComposeOwnerHost {
  /** ptyId of the terminal the event came from, or null when it came from none. */
  ptyId: string | null;
  /** Does that terminal own the chord? Meaningless when `ptyId` is null. */
  owns: boolean;
}

/**
 * Which terminal did this keydown come from, and does it own the chord?
 *
 * `{ ptyId: null }` means the event did not originate inside any terminal at
 * all — focus on <body> after a popover closed, say. That is NOT a foreign
 * terminal, so the caller keeps its old behaviour there (act on the active
 * leaf); the point of this helper is to reject a DIFFERENT terminal's keydown,
 * not to require terminal focus the binding never required.
 */
export function composeOwnerHost(target: EventTarget | null): ComposeOwnerHost {
  const el = target as Element | null;
  const host = el?.closest?.(`[${TERMINAL_PTY_ATTR}]`) ?? null;
  if (!host) return { ptyId: null, owns: false };
  return {
    ptyId: host.getAttribute(TERMINAL_PTY_ATTR),
    owns: host.hasAttribute(COMPOSE_OWNER_ATTR),
  };
}
