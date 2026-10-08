import { agentSlugsWith, type AgentSlugWith } from './agentIdentity';
import type { OrchestratorRoleBindings } from './orchestratorRole';

/** The agents listed in Settings -> Token usage: the registry rows that declare
 *  `tokenUsage` (src/shared/agentIdentity.ts), in table order. */
export const ALL_ACTIVE_PROVIDERS: readonly ActiveProviderId[] = agentSlugsWith('tokenUsage');
export type ActiveProviderId = AgentSlugWith<'tokenUsage'>;

export function activeProviders(bindings?: OrchestratorRoleBindings | null): ActiveProviderId[] {
  if (!bindings || Object.keys(bindings).length === 0) {
    return [...ALL_ACTIVE_PROVIDERS];
  }
  const agents = new Set<string>();
  for (const b of Object.values(bindings)) {
    if (b && typeof b.agent === 'string' && b.agent.trim()) {
      agents.add(b.agent.trim());
    }
  }
  return ALL_ACTIVE_PROVIDERS.filter((p) => agents.has(p));
}
