import { ORCH_ROLES } from '../../../shared/orchestratorRole';

/** The roles a pane can be given: the built-in vocabulary, led by the pane's
 *  current role when it is a custom one (a value set over MCP), so a picker
 *  never shows a known-but-custom role as unset. Shared by the Deck roster and
 *  the Fleet row's Role editor. */
export function paneRoleOptions(role: string): string[] {
  return role && !(ORCH_ROLES as readonly string[]).includes(role) ? [role, ...ORCH_ROLES] : [...ORCH_ROLES];
}
