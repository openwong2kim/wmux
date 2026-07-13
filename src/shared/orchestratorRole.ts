// Orchestrator pane role (soft, operator-assigned "preferred role").
//
// A role is a human-set hint attached to a pane's metadata under
// `custom['orchestrator.role']`. It is GUIDANCE, not enforcement: the
// orchestrator reads it (injected into its per-turn workspace snapshot, see
// deckBrain.buildWorkspaceContextSummary) and prefers to route matching work
// to the matching pane, but may deviate when the operator says so or when no
// pane fits. The key lives in the `custom` map (not the deprecated `role`
// metadata field) so it round-trips through pane_set_metadata's deep-merge.

/** Custom-metadata key under which a pane's operator-assigned role is stored. */
export const ORCH_ROLE_KEY = 'orchestrator.role';

/** Built-in role vocabulary for the Fleet dropdown. Empty = Unassigned. A
 *  native <select> cannot accept free text; a custom-role combobox is a
 *  deferred follow-up. */
export const ORCH_ROLES = ['Builder', 'Reviewer', 'Tester', 'Planner'] as const;

export type OrchRole = (typeof ORCH_ROLES)[number];

/** Read a pane's assigned role from a metadata `custom` map. Empty string is
 *  the "unassigned" sentinel (additive custom-merge has no delete-one-key op),
 *  so normalize it to undefined on read. */
export function readOrchRole(
  custom: Record<string, string> | undefined,
): string | undefined {
  const raw = custom?.[ORCH_ROLE_KEY];
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
