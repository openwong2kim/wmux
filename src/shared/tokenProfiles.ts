// ─── Token profiles (Settings → Agents → Token usage) ─────────────────────────
//
// A profile is a SHORTCUT that writes model, effort and the wmux tool level into
// the role bindings; the bindings stay the source of truth and remain editable
// in Roles & fan-out. Nothing is stored about the profile itself: the tab
// derives which profile the current bindings match (or "custom"), so editing a
// row by hand can never leave a stale label behind.
//
// A profile acts on a bound role whatever agent it is bound to, through that
// agent's own grammar:
//   - claude: the profile's Claude model + effort;
//   - codex:  the operator's model is kept, effort only;
//   - agy:    effort is the model id suffix (low|medium|high); a Flash family is
//             kept, any other family moves to the default Flash;
//   - other agents: tool level only.
// Agent, extra args, skip-permissions and fresh-context are never touched.
//
//   Full      best models, high effort, every wmux tool      — maximum capability
//   Coding    strong planner, medium workers, no browser tools (core)
//   Balanced  medium planner, cheaper checkers, only each role's tools
//   Minimal   lowest effort everywhere, only each role's tools — least tokens

import { agyEffortOf, agyFamilyOf } from './modelCatalog';
import type { OrchestratorRoleBindings, RoleBinding, WmuxTools } from './orchestratorRole';

export const TOKEN_PROFILES = ['full', 'coding', 'balanced', 'minimal'] as const;
export type TokenProfile = (typeof TOKEN_PROFILES)[number];

type Tier = 'low' | 'medium' | 'high';

interface ProfileSpec {
  /** Claude model for every claude-bound role. */
  claudeModel: string;
  /** Effort per role; roles not listed (custom roles) use `other`. */
  effort: Readonly<Record<string, Tier>> & { other: Tier };
  tools: WmuxTools;
}

export const TOKEN_PROFILE_SPECS: Readonly<Record<TokenProfile, ProfileSpec>> = {
  full: {
    claudeModel: 'claude-opus-5-5',
    effort: { Planner: 'high', Builder: 'high', Tester: 'high', Reviewer: 'high', other: 'high' },
    tools: 'full',
  },
  coding: {
    claudeModel: 'claude-sonnet-5-5',
    effort: { Planner: 'high', Builder: 'medium', Tester: 'medium', Reviewer: 'medium', other: 'medium' },
    tools: 'core',
  },
  balanced: {
    claudeModel: 'claude-sonnet-5-5',
    effort: { Planner: 'medium', Builder: 'medium', Tester: 'low', Reviewer: 'low', other: 'medium' },
    tools: 'role',
  },
  minimal: {
    claudeModel: 'claude-sonnet-5-5',
    effort: { Planner: 'low', Builder: 'low', Tester: 'low', Reviewer: 'low', other: 'low' },
    tools: 'role',
  },
};

const DEFAULT_AGY_FLASH = 'gemini-3.8-flash';
const ORCH = new Set(['Planner', 'Builder', 'Tester', 'Reviewer']);

function applySpec(role: string, binding: RoleBinding, spec: ProfileSpec): RoleBinding {
  const tier = spec.effort[role] ?? spec.effort.other;
  // 'role' needs a known orchestrator role; a custom role gets core instead.
  const tools: WmuxTools = spec.tools === 'role' && !ORCH.has(role) ? 'core' : spec.tools;
  const next: RoleBinding = { ...binding, tools };
  if (binding.agent === 'claude') {
    next.model = spec.claudeModel;
    next.effort = tier;
  } else if (binding.agent === 'codex') {
    next.effort = tier;
  } else if (binding.agent === 'agy') {
    const current = binding.model ? agyFamilyOf(binding.model) : '';
    const family = /-flash$/.test(current) ? current : DEFAULT_AGY_FLASH;
    next.model = `${family}-${tier}`;
    delete next.effort;
  }
  return next;
}

/** The bindings a profile would produce. Unbound roles are not created. */
export function applyTokenProfile(bindings: OrchestratorRoleBindings, profile: TokenProfile): OrchestratorRoleBindings {
  const spec = TOKEN_PROFILE_SPECS[profile];
  const out: OrchestratorRoleBindings = {};
  for (const [role, binding] of Object.entries(bindings)) {
    out[role] = binding.agent ? applySpec(role, binding, spec) : binding;
  }
  return out;
}

function effortOf(b: RoleBinding): string {
  return (b.agent === 'agy' && b.model ? agyEffortOf(b.model) : b.effort) ?? '';
}

function sameProfileFields(a: RoleBinding, b: RoleBinding): boolean {
  return (a.model ?? '') === (b.model ?? '') && effortOf(a) === effortOf(b) && (a.tools ?? '') === (b.tools ?? '');
}

/** Which profile the bindings currently match, else 'custom'. */
export function matchTokenProfile(bindings: OrchestratorRoleBindings): TokenProfile | 'custom' {
  const roles = Object.keys(bindings).filter((r) => bindings[r].agent);
  if (roles.length === 0) return 'custom';
  for (const profile of TOKEN_PROFILES) {
    const next = applyTokenProfile(bindings, profile);
    if (roles.every((r) => sameProfileFields(bindings[r], next[r]))) return profile;
  }
  return 'custom';
}

/** Roles whose binding a profile would change (for the Apply preview). */
export function tokenProfileChanges(
  bindings: OrchestratorRoleBindings,
  profile: TokenProfile,
): Array<{ role: string; before: RoleBinding; after: RoleBinding }> {
  const next = applyTokenProfile(bindings, profile);
  return Object.keys(bindings)
    .filter((role) => !sameProfileFields(bindings[role], next[role]))
    .map((role) => ({ role, before: bindings[role], after: next[role] }));
}
