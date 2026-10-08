import type { AgentSlug } from '../../shared/events';
import type { PaneLabelRejection } from '../../shared/paneLabelRules';
import type { TranslationKey } from '../i18n/locales/en';

// === P2 pane self-naming (pure helpers) ===
//
// A pane's *auto name* is a stable, unique coordinate `w<wsOrdinal>-<paneOrdinal>`
// plus an optional `(<agent>)` suffix. The coordinate pair never repeats among a
// session's live panes (ordinals are monotonic per workspace and never recycled),
// so it disambiguates two same-agent panes in the same workspace — the exact case
// the composer @-mention picker could not resolve before P2.
//
// A pane's *display name* is the user's explicit rename (`label`, persisted in
// MetadataStore) when present, else the auto name. A label is also an address:
// `#backend` (like `#w1-2`) resolves to the pane through `pane.resolveName`, so
// MetadataStore enforces the label policy (src/shared/paneLabelRules.ts) — one
// token, no `#`/`@`, no leading digit, not shaped like an auto name, unique
// among live panes. Labels persisted before that policy may still break it and
// even collide; resolution reports such a collision as ambiguous rather than
// guessing, and the auto coordinate (`paneTag`) always stays unique.
//
// Both functions are pure + store-free so they are trivially unit-testable and
// safe to call from selectors/render. Callers resolve the ordinals (layout
// state) and slug (surfaceAgent mirror) and pass them in.

/**
 * Build a pane's auto display name from its workspace + pane coordinates.
 *
 * Examples: `(1, 2, 'claude')` → `"w1-2(claude)"`; `(3, 1)` → `"w3-1"`.
 */
export function computePaneAutoName(
  wsOrdinal: number,
  paneOrdinal: number,
  agentSlug?: AgentSlug | null,
): string {
  const base = `w${wsOrdinal}-${paneOrdinal}`;
  return agentSlug ? `${base}(${agentSlug})` : base;
}

/**
 * The name shown to the user for a pane: the user's rename (`label`) when set,
 * otherwise the dynamic auto name. A blank/whitespace-only label falls through
 * to the auto name so an accidental empty rename never renders an invisible tab.
 */
export function paneDisplayName(label: string | undefined, autoName: string): string {
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : autoName;
}

/**
 * A pane's name exactly as its header shows it: the user's label (the
 * `paneLabel` mirror, else the leaf's own) or the auto coordinate with the
 * agent suffix. Everything that names a pane to another PC (exposure, link
 * cards, the remote alias) uses this one, so the names never drift apart.
 */
export function leafDisplayName(
  paneLabel: Record<string, string> | undefined,
  ws: { wsOrdinal?: number },
  leaf: { id: string; ordinal?: number; metadata?: { label?: string } },
  agentSlug?: AgentSlug | null,
): string {
  return paneDisplayName(paneLabel?.[leaf.id] ?? leaf.metadata?.label, computePaneAutoName(ws.wsOrdinal ?? 0, leaf.ordinal ?? 0, agentSlug));
}

/** The agent slug of a leaf's active surface (the header's name suffix). */
export function activeAgentSlug(
  surfaceAgent: Record<string, { slug?: AgentSlug }> | undefined,
  leaf: { activeSurfaceId?: string; surfaces: Array<{ id: string; ptyId?: string }> },
): AgentSlug | undefined {
  const surface = leaf.surfaces.find((x) => x.id === leaf.activeSurfaceId) ?? leaf.surfaces[0];
  return surface?.ptyId ? surfaceAgent?.[surface.ptyId]?.slug : undefined;
}


/** The always-unique tag of a pane: its auto coordinate without the agent
 *  suffix, e.g. `#w1-2`. */
export function paneTag(ws: { wsOrdinal?: number }, leaf: { ordinal?: number }): string {
  return `#${computePaneAutoName(ws.wsOrdinal ?? 0, leaf.ordinal ?? 0)}`;
}

/** `paneName` (what the header shows) + `paneTag` (the unique address), the
 *  pair every agent-facing pane listing carries so an agent can echo either. */
export function paneNameFields(
  paneLabel: Record<string, string> | undefined,
  surfaceAgent: Record<string, { slug?: AgentSlug }> | undefined,
  ws: { wsOrdinal?: number },
  leaf: { id: string; ordinal?: number; metadata?: { label?: string }; activeSurfaceId?: string; surfaces: Array<{ id: string; ptyId?: string }> },
): { paneName: string; paneTag: string } {
  return {
    paneName: leafDisplayName(paneLabel, ws, leaf, activeAgentSlug(surfaceAgent, leaf)),
    paneTag: paneTag(ws, leaf),
  };
}

const LABEL_REJECTION_KEYS: Record<PaneLabelRejection, TranslationKey> = {
  whitespace: 'pane.renameError.whitespace',
  'reserved-char': 'pane.renameError.reservedChar',
  'leading-digit': 'pane.renameError.leadingDigit',
  'auto-name': 'pane.renameError.autoName',
  duplicate: 'pane.renameError.duplicate',
};

/** The localized reason for a refused rename; an unknown code reads as a plain failure. */
export function paneLabelRejectionKey(code: string | undefined): TranslationKey {
  return code && Object.prototype.hasOwnProperty.call(LABEL_REJECTION_KEYS, code)
    ? LABEL_REJECTION_KEYS[code as PaneLabelRejection]
    : 'pane.renameError.failed';
}
