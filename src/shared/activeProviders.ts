import type { OrchestratorRoleBindings } from './orchestratorRole';

export const ALL_ACTIVE_PROVIDERS = ['claude', 'codex', 'agy'] as const;
export type ActiveProviderId = (typeof ALL_ACTIVE_PROVIDERS)[number];

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
