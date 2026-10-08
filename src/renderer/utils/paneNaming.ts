import type { AgentSlug } from '../../shared/events';

// === P2 pane self-naming (pure helpers) ===
//
// A pane's *auto name* is a stable, unique coordinate `w<wsOrdinal>-<paneOrdinal>`
// plus an optional `(<agent>)` suffix. The coordinate pair never repeats among a
// session's live panes (ordinals are monotonic per workspace and never recycled),
// so it disambiguates two same-agent panes in the same workspace — the exact case
// the composer @-mention picker could not resolve before P2.
//
// A pane's *display name* is the user's explicit rename (`label`, persisted in
// MetadataStore) when present, else the auto name. Labels are display-only and
// MAY collide; routing always uses paneId (P1 infra), so a duplicate label is
// harmless — the insert token (auto name) stays unique.
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

