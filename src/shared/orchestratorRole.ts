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

/** Max length of a role once read. This value is injected VERBATIM into the
 *  orchestrator LLM's workspace snapshot, and the `custom['orchestrator.role']`
 *  key is writable by ANY `pane_set_metadata` caller (a worker pane can set its
 *  own role, not just the operator dropdown) — and `custom` values, unlike the
 *  `label`/`role` metadata fields, are NOT length-capped by MetadataStore (only
 *  the ~8KB whole-blob cap applies). So we neutralize the value at the read
 *  boundary: single line, no control chars, length-capped. Matches the label
 *  cap so a role can't out-inject a label. */
export const ORCH_ROLE_MAX = 64;

/** Read a pane's assigned role from a metadata `custom` map, sanitized for
 *  verbatim prompt injection. Empty string is the "unassigned" sentinel
 *  (additive custom-merge has no delete-one-key op), normalized to undefined.
 *  Newlines/control chars are collapsed to spaces so a crafted role cannot
 *  forge extra pane lines or instructions in the orchestrator snapshot, and the
 *  result is capped so an oversized role cannot crowd out the snapshot budget. */
export function readOrchRole(
  custom: Record<string, string> | undefined,
): string | undefined {
  const raw = custom?.[ORCH_ROLE_KEY];
  if (typeof raw !== 'string') return undefined;
  // Collapse C0 control chars + DEL (incl. newline/CR/tab) to spaces so a
  // crafted role can't forge extra lines/instructions when injected.
  // eslint-disable-next-line no-control-regex -- intentional control-char strip
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, ORCH_ROLE_MAX);
  return cleaned.length > 0 ? cleaned : undefined;
}
