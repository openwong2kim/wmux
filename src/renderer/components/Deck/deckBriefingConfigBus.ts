// ─── Command Deck — briefing config change notification ──────────────────────
//
// The briefing config lives in MAIN (deck-briefing.json), so Settings and the
// mounted DeckBriefingCard are two renderer surfaces reading the same remote
// value with no shared store between them. Without a notification, turning the
// briefing off in Settings left the already-mounted card on screen indefinitely
// (and re-enabling it did nothing until a workspace switch or a stream tick).
//
// A window CustomEvent is the established pattern for this kind of cross-surface
// nudge in the renderer (HOOKS_PROMPT_EVENT / FIRST_RUN_REOPEN_EVENT). Payload-
// free on purpose: the card re-reads the authoritative config from main rather
// than trusting a value passed between components.

export const BRIEFING_CONFIG_EVENT = 'wmux:deck-briefing-config';

/** Tell any mounted briefing card that the config changed in main. */
export function notifyBriefingConfigChanged(): void {
  window.dispatchEvent(new CustomEvent(BRIEFING_CONFIG_EVENT));
}

/** Subscribe to config changes; returns the unsubscribe. */
export function onBriefingConfigChanged(cb: () => void): () => void {
  const handler = (): void => cb();
  window.addEventListener(BRIEFING_CONFIG_EVENT, handler);
  return () => window.removeEventListener(BRIEFING_CONFIG_EVENT, handler);
}
