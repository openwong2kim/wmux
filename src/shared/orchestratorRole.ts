import { launcherStem, tokenize } from './agentResume';

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

// ─── D2: Role → agent/model binding (ENFORCED, unlike the soft role hint) ─────
//
// A soft role (above) is a routing HINT the orchestrator may ignore. A binding
// turns a role into policy: "every agent launched in a Reviewer pane runs
// `codex --model o3`". Enforcement happens at wmux-owned command-assembly time
// (input.send rewrite is the backbone) — see applyRoleBinding. The map is a
// GLOBAL operator-level concept (the owner's cross-repo "빌더1 리뷰어2" team),
// persisted next to deckBrainModel; all roles are unbound until the operator
// sets them in Settings.

/** A role's enforced launch policy. All fields optional: an empty binding is a
 *  no-op. `args` is the injection-risk surface — it carries arbitrary launch
 *  flags — so it is control-char stripped + length-capped at every boundary. */
export interface RoleBinding {
  /** Launcher stem this role expects: 'claude' | 'codex' | 'opencode' | 'gemini'.
   *  When set, the model flag is injected ONLY if the actual launcher matches
   *  (so a codex model alias is never forced into a claude launch). */
  agent?: string;
  /** Model alias/id passed to the agent's model flag, e.g. 'haiku'. */
  model?: string;
  /** Extra launch args appended verbatim (advanced). Normalized/capped. */
  args?: string;
}

/** Operator-level, cross-workspace. Keyed by role name (ORCH_ROLES ∪ custom). */
export type OrchestratorRoleBindings = Record<string, RoleBinding>;

/** Per-agent model-flag grammar (sibling of agentResume's RESUME_BY_LAUNCHER).
 *  ONLY agents whose `--model` grammar is empirically verified live here; an
 *  absent agent (gemini/aider/opencode) yields a no-op + advisory note rather
 *  than a guessed, possibly-broken flag. claude + codex `--model <m>` are
 *  verified in agentResume.test.ts (`codex --model gpt-5.5`, `claude --model`). */
interface ModelFlagGrammar {
  /** Render the model flag tokens inserted right after the launcher token. */
  flag: (model: string) => string;
}
const MODEL_FLAG_BY_LAUNCHER: Readonly<Record<string, ModelFlagGrammar>> = {
  claude: { flag: (m) => `--model ${m}` },
  codex: { flag: (m) => `--model ${m}` },
  // opencode/gemini/aider deliberately absent — their `--model` CLI grammar is
  // NOT verified anywhere in the repo (integrations/ + agentResume both cover
  // only claude/codex). Binding a role to them is a no-op + note (D-5), never a
  // fabricated flag. Add them here once their grammar is confirmed.
};

/** Whether wmux knows how to inject a model flag for a launcher stem. */
export function launcherSupportsModelFlag(stem: string): boolean {
  return stem in MODEL_FLAG_BY_LAUNCHER;
}

/** Launcher stems wmux recognizes as agent CLIs. Used ONLY to decide whether an
 *  agent-mismatch is worth reporting: launching `ls` in a bound pane is normal
 *  and silent, launching a DIFFERENT agent than the role binding names is a
 *  policy deviation the operator should hear about. Mirrors the AgentSlug
 *  vocabulary (shared/events.ts). */
const KNOWN_AGENT_STEMS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'gemini',
  'aider',
  'opencode',
  'copilot',
  'openclaude',
]);

/** Max lengths for the binding fields at the normalization boundary. `args` is
 *  the widest surface (arbitrary flags) so it gets the command-sized cap. */
export const ROLE_BINDING_AGENT_MAX = 48;
export const ROLE_BINDING_MODEL_MAX = 64;
export const ROLE_BINDING_ARGS_MAX = 200;
/** Cap on how many role→binding entries we persist/read (defensive). */
export const ROLE_BINDINGS_MAX_ENTRIES = 64;

/** Strip control chars (incl. newline/CR/tab → space), collapse runs of
 *  whitespace, trim, and length-cap. Shared shape for all binding fields so a
 *  crafted value can never forge extra command lines when written to a shell.
 *  Mirrors readOrchRole's control-char posture + normalizeCommand's length cap. */
function normalizeBindingField(input: unknown, max: number): string | undefined {
  if (typeof input !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- intentional control-char strip
  const cleaned = input.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, max);
}

/** Build a clean RoleBinding from untrusted input (Settings write / session.json
 *  load), or undefined when the result carries no usable field. */
export function normalizeRoleBinding(input: unknown): RoleBinding | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const src = input as { agent?: unknown; model?: unknown; args?: unknown };
  const binding: RoleBinding = {};
  // Agent normalizes to a launcher stem so it compares cleanly against a live
  // command's stem (drops a path/extension a hand-edited value might carry).
  const agentRaw = normalizeBindingField(src.agent, ROLE_BINDING_AGENT_MAX);
  const agent = agentRaw ? launcherStem(agentRaw) : undefined;
  const model = normalizeBindingField(src.model, ROLE_BINDING_MODEL_MAX);
  const args = normalizeBindingField(src.args, ROLE_BINDING_ARGS_MAX);
  if (agent) binding.agent = agent;
  if (model) binding.model = model;
  if (args) binding.args = args;
  if (binding.agent === undefined && binding.model === undefined && binding.args === undefined) {
    return undefined;
  }
  return binding;
}

/** Normalize a whole role→binding map from untrusted input: sanitize each role
 *  key + binding, drop empties, cap the entry count. Never throws. */
export function normalizeRoleBindings(input: unknown): OrchestratorRoleBindings {
  const out: OrchestratorRoleBindings = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out;
  let count = 0;
  for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
    if (count >= ROLE_BINDINGS_MAX_ENTRIES) break;
    const key = normalizeBindingField(rawKey, ORCH_ROLE_MAX);
    if (!key) continue;
    const binding = normalizeRoleBinding(rawVal);
    if (!binding) continue;
    out[key] = binding;
    count++;
  }
  return out;
}

/** Unquoted tokens that mean an explicit model flag is already present, so the
 *  rewrite must NOT add a second one (D-4: a manual `--model` wins for that
 *  launch). Checked on UNQUOTED tokens only, so `claude "explain --model"` is
 *  not a false match. */
function hasExplicitModelFlag(tokens: ReturnType<typeof tokenize>): boolean {
  for (const tkn of tokens) {
    if (tkn.quoted) continue;
    if (tkn.value === '--model' || tkn.value.startsWith('--model=') || tkn.value === '-m') {
      return true;
    }
  }
  return false;
}

/**
 * Pure transform: given a launch command + a role's binding, return the command
 * with the bound agent's model (and any extra args) enforced.
 *
 * Rules:
 *  - No binding, or a binding with neither model nor args → unchanged.
 *  - `binding.agent` set and the command's launcher stem differs → unchanged
 *    (the binding targets a different agent; never force a codex model alias
 *    into a claude launch).
 *  - `binding.model` set but the launcher has no known `--model` grammar
 *    (gemini/aider/custom) → unchanged + advisory `note` (D-5).
 *  - An explicit `--model` already in the (unquoted) command → model NOT
 *    re-injected (D-4), though `binding.args` may still be appended.
 *  - Otherwise: inject `--model <m>` right after the launcher token and append
 *    normalized `binding.args` at the end.
 *
 * Idempotent: re-applying never double-adds the model flag (an explicit
 * `--model` short-circuits) nor the args (guarded by a trailing-match check).
 */
export function applyRoleBinding(
  command: string,
  binding: RoleBinding | undefined,
): { command: string; changed: boolean; note?: string } {
  if (!binding) return { command, changed: false };
  const model = binding.model?.trim() || undefined;
  const args = binding.args?.trim() || undefined;
  if (!model && !args) return { command, changed: false };

  const tokens = tokenize(command);
  if (tokens.length === 0) return { command, changed: false };
  const stem = launcherStem(tokens[0].value);

  // Agent gate: a binding that names an agent only applies to that launcher —
  // never force a codex model alias into a claude launch. Launching a DIFFERENT
  // known agent than the role names is a silent policy deviation, so say so;
  // an ordinary shell command (`ls`) in a bound pane stays silent.
  if (binding.agent && binding.agent !== stem) {
    if (KNOWN_AGENT_STEMS.has(stem)) {
      return {
        command,
        changed: false,
        note: `Role is bound to "${binding.agent}", but "${stem}" was launched here; the binding does not apply and nothing was enforced.`,
      };
    }
    return { command, changed: false };
  }

  const grammar = MODEL_FLAG_BY_LAUNCHER[stem];

  // Model requested but this launcher has no known flag → no-op + note.
  if (model && !grammar) {
    return {
      command,
      changed: false,
      note: `Role bound to model "${model}", but launcher "${stem}" has no known --model flag; launched unchanged.`,
    };
  }

  let out = command;
  // Inject the model flag unless an explicit one is already present (D-4).
  if (model && grammar && !hasExplicitModelFlag(tokens)) {
    const at = tokens[0].end;
    out = `${command.slice(0, at)} ${grammar.flag(model)}${command.slice(at)}`;
  }
  // Append extra args verbatim, but only when not already trailing (idempotence).
  if (args && !out.trimEnd().endsWith(args)) {
    out = `${out} ${args}`;
  }

  return { command: out, changed: out !== command };
}
