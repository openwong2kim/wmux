import { FOCUS_RING } from '../focusRing';

/**
 * Shared look for the deck's icon entry points (owner decision 2026-08-14:
 * the deck header stopped being a text tab strip — `Agent (Default) | Git |
 * Channels` — and became icons, orca-style).
 *
 * One surface uses it: DeckTabs (horizontal, deck open) — the collapsed
 * vertical rail is gone (2026-08-18). WebToggle is a button on it, and it lives
 * under StatusBar/, so the classes sit in their own module rather than being
 * imported back out of either component.
 */

/** One 36px cell — the chrome module (DESIGN.md "Spacing & Geometry"). */
export const DECK_ICON_BUTTON =
  `relative flex items-center justify-center shrink-0 w-9 h-9 transition-colors duration-150 ${FOCUS_RING}`;

/**
 * Icon colour: active = main (the steel underline carries "you are here") ·
 * signal = warm (unread / dirty / server running) · rest = muted.
 */
export function deckIconTone(active: boolean, signal: boolean): string {
  if (active) return 'text-[var(--text-main)] bg-[rgba(var(--bg-surface-rgb),0.5)]';
  if (signal) return 'text-[var(--accent)] hover:opacity-80';
  return 'text-[var(--text-muted)] hover:text-[var(--text-sub)]';
}

/**
 * Warm count badge, pinned to the glyph's top-right corner. A solid warm fill
 * is reserved for tiny count badges (DESIGN.md two-accent grammar); with the
 * label gone there is no inline room left for it.
 */
export const DECK_ICON_BADGE =
  'absolute top-0.5 right-0.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-[3px] rounded-full text-[10px] font-semibold tabular-nums leading-none bg-[var(--accent)] text-[var(--bg-base)]';

/** Counts sit on a 36px cell — clamp so a big number can't overflow it. */
export function formatDeckCount(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}
