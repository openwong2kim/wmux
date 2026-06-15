// Capability grouping for the permission approval surfaces (Phase 2.2).
//
// Pure, JSX-free derivation extracted from `PermissionApprovalDialog.tsx` so
// the store selector (`stores/selectors/approvalInbox.ts`) and other
// non-UI consumers can reuse the classification without pulling a `.tsx`
// component (and its JSX module graph) into their dependency / test graph.

import {
  CAPABILITY_RISK_CLASS,
  RISK_CLASS_COPY,
  type RiskClass,
  type RiskClassCopy,
} from '../../../main/mcp/methodCapabilityMap';
import { parsePermission } from '../../../main/mcp/permissionGrammar';

/**
 * One row in the dialog's grouped capability list. Exported so tests can
 * verify the grouping logic separately from the render.
 */
export interface CapabilityGroup {
  riskClass: RiskClass;
  copy: RiskClassCopy;
  capabilities: { raw: string; capability: string; pathGlob?: string }[];
}

/**
 * Group declared capabilities by risk class. Order of groups follows
 * `GROUP_RENDER_ORDER` so critical items always appear first regardless of
 * declaration order in the wire payload.
 */
const GROUP_RENDER_ORDER: RiskClass[] = [
  'terminal-content',
  'terminal-input',
  'browser',
  'a2a',
  'metadata',
  'events',
  'pane-lifecycle',
  'workspace',
  'internal',
];

export function groupCapabilities(
  declared: readonly string[],
): CapabilityGroup[] {
  const groups = new Map<RiskClass, CapabilityGroup>();
  for (const raw of declared) {
    const parsed = parsePermission(raw);
    if (!parsed.ok) continue; // skip malformed; substrate already rejected at declare-time
    const cap = parsed.permission.capability;
    const risk =
      CAPABILITY_RISK_CLASS[cap] ?? ('metadata' as RiskClass); // safe fallback
    let group = groups.get(risk);
    if (!group) {
      group = {
        riskClass: risk,
        copy: RISK_CLASS_COPY[risk],
        capabilities: [],
      };
      groups.set(risk, group);
    }
    group.capabilities.push({
      raw,
      capability: cap,
      pathGlob: parsed.permission.pathGlob,
    });
  }
  return GROUP_RENDER_ORDER.filter((r) => groups.has(r)).map(
    (r) => groups.get(r) as CapabilityGroup,
  );
}
