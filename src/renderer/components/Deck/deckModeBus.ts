// ─── Command Deck — agent-mode change notification ───────────────────────────
//
// The per-workspace agent mode lives in MAIN (deck-autonomy.json) and reaches
// the renderer only through `electronAPI.deck.mode.get`. The chip that WRITES
// it (AgentModeChip) and the surfaces that must REACT to it (the composer,
// which is disabled while the mode is `off`) are siblings with no shared store
// between them, so without a nudge the composer stayed enabled until the next
// remount — the operator turned the orchestrator off and could still type into
// a brain that would refuse every send.
//
// A window CustomEvent is the established pattern for this kind of cross-surface
// nudge in the renderer (BRIEFING_CONFIG_EVENT / HOOKS_PROMPT_EVENT). Payload-
// free on purpose: listeners re-read the authoritative value from main rather
// than trusting one passed between components.

export const DECK_MODE_EVENT = 'wmux:deck-agent-mode';

/** Tell any mounted surface that a workspace's agent mode changed in main. */
export function notifyAgentModeChanged(): void {
  window.dispatchEvent(new CustomEvent(DECK_MODE_EVENT));
}

/** Subscribe to agent-mode changes; returns the unsubscribe. */
export function onAgentModeChanged(cb: () => void): () => void {
  const handler = (): void => cb();
  window.addEventListener(DECK_MODE_EVENT, handler);
  return () => window.removeEventListener(DECK_MODE_EVENT, handler);
}
