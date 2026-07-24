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
 *  orchestrator LLM's workspace snapshot, and `custom` values — unlike the
 *  `label`/`role` metadata fields — are NOT length-capped by MetadataStore (only
 *  the ~8KB whole-blob cap applies). So we neutralize the value at the read
 *  boundary: single line, no control chars, length-capped. Matches the label
 *  cap so a role can't out-inject a label.
 *
 *  The write boundary is now operator-only — `pane.setMetadata` strips this key
 *  from any non-first-party caller (see pane.rpc.ts guardRoleKey), so a worker
 *  pane can no longer assign its own role. The read-boundary sanitization below
 *  stays as defense in depth: it still covers metadata.json entries written
 *  before that gate existed or hand-edited since, and the first-party path
 *  (Fleet dropdown / plugin host), which is trusted for AUTHORITY but is not a
 *  reason to inject unvalidated text into an LLM prompt. */
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
  return sanitizeOrchRole(custom?.[ORCH_ROLE_KEY]);
}

/** The role read-boundary neutralizer readOrchRole applies, exposed so any OTHER
 *  entry point for a role string (today: a trusted `wmux.json` layout leaf) is
 *  held to the same rule instead of re-deriving it. */
export function sanitizeOrchRole(raw: unknown): string | undefined {
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
// turns a role into policy: "an agent launched into a Reviewer pane BY WMUX runs
// `codex --model o3`". The scope is exactly the commands wmux assembles itself —
// see applyRoleBinding — which today means three sites:
//   1. input.send (the pipe RPC behind the orchestrator's terminal_send),
//   2. a pane's seeded initialCommand (ptyCreateOptions.withRoleBinding),
//   3. the per-pane resume command (ResumeInfoChip.buildPaneResumeCommand).
// A human's KEYSTROKES are NOT covered: Terminal.tsx writes straight to the pty
// IPC handler and never passes through any of the three. The map is a GLOBAL
// operator-level concept (the owner's cross-repo "빌더1 리뷰어2" team), persisted
// next to deckBrainModel; all roles are unbound until the operator sets them in
// Settings.

/** A role's enforced launch policy. All fields optional: an empty binding is a
 *  no-op. `args` is the widest surface — it carries arbitrary launch flags — so
 *  it is control-char stripped, shell-metachar rejected, and length-capped at
 *  every boundary (see normalizeArgsField). */
export interface RoleBinding {
  /** Launcher stem this role expects: 'claude' | 'codex' | 'opencode' | 'gemini'.
   *  REQUIRED for model injection: a model alias is meaningless without knowing
   *  whose `--model` grammar it belongs to (`codex --model haiku` is an invalid
   *  launch), so a model-only binding never injects — see applyRoleBinding. */
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

/**
 * Will this binding actually cause a model flag to be spliced into a launch?
 *
 * The three conditions are exactly applyRoleBinding's: a model to pin, an agent
 * to say whose `--model` grammar it belongs to, and a verified grammar for that
 * agent. A binding failing any of them is stored and shown in Settings — with
 * the inline hint explaining why — but the launch goes out UNCHANGED.
 *
 * Every affordance that tells the operator "this pane runs that model" must gate
 * on this. Rendering the model because it is merely CONFIGURED is how an
 * operator ends up believing a pane is pinned to a cheap model while it launches
 * on the expensive default.
 */
export function bindingEnforcesModel(binding: RoleBinding | undefined): boolean {
  return (
    !!binding?.model && !!binding.agent && launcherSupportsModelFlag(binding.agent)
  );
}

/** Launcher stems wmux recognizes as agent CLIs. This is applyRoleBinding's
 *  OUTER gate: a command whose stem is absent here is never rewritten in any
 *  way, so `git commit -m "wip"` and `npm test` in a bound pane come back
 *  byte-identical. It also decides whether a mismatch is worth reporting —
 *  launching a DIFFERENT known agent than the role names is a policy deviation
 *  the operator should hear about. Mirrors the AgentSlug vocabulary
 *  (shared/events.ts). */
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
 *  whitespace, trim, and length-cap.
 *
 *  What this guarantees: the value is single-line and bounded, so it cannot
 *  forge an extra COMMAND LINE (a `\n` that a shell would read as a second
 *  command) and cannot crowd out a length budget.
 *
 *  What it does NOT guarantee: shell safety. `;`, `|`, `&`, backticks and
 *  `$(...)` all survive this pass, so a value that reaches a shell still runs
 *  as whatever that shell makes of it. That is acceptable ONLY because every
 *  writer of a binding value is already trusted at least as much as the shell
 *  it lands in (the Settings dropdowns, operator-typed args, and session.json —
 *  editing which already requires filesystem access). The per-field validators
 *  below carry the actual safety posture; if a binding is ever made writable
 *  over RPC/MCP/wmux.json/team presets, THOSE are the checks to revisit. */
function normalizeBindingField(input: unknown, max: number): string | undefined {
  if (typeof input !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- intentional control-char strip
  const cleaned = input.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, max);
}

/** A model alias/id is a single opaque token — `haiku`, `gpt-5.5`,
 *  `claude-opus-4-8`, `us.anthropic.claude:1`. Anything else is rejected rather
 *  than passed through: a model containing a SPACE (`claude sonnet 4`, easy to
 *  hand-write into session.json) would split into positional args, and for the
 *  claude CLI a trailing positional is a PROMPT — so a malformed model silently
 *  injects text into the agent instead of failing. */
const MODEL_TOKEN_RE = /^[A-Za-z0-9._:-]+$/;

/** Shell metacharacters that make a token do something other than "be an
 *  argument". `args` is rejected WHOLESALE when any of its tokens contains one
 *  (rather than dropping the offending token) so the accepted value is always
 *  the operator's string verbatim — re-serializing a tokenized command would
 *  lose the original quoting. Conservative on purpose: a quoted `'a;b'` is
 *  rejected too, since the tokenizer strips quotes before this check. */
const SHELL_METACHAR_RE = /[;|&`$()<>{}!*?~#[\]]/;

/** Normalize + validate the `model` field. Returns undefined for a value that
 *  is not a single safe token (see MODEL_TOKEN_RE). */
function normalizeModelField(input: unknown): string | undefined {
  const cleaned = normalizeBindingField(input, ROLE_BINDING_MODEL_MAX);
  if (!cleaned) return undefined;
  return MODEL_TOKEN_RE.test(cleaned) ? cleaned : undefined;
}

/** Normalize + validate the `args` field. `args` is operator-controlled and
 *  appended verbatim — it is equivalent to typing those flags yourself — but it
 *  is still rejected outright when any token carries a shell metacharacter, so
 *  a hand-edited session.json cannot turn a launch into a chained command. */
function normalizeArgsField(input: unknown): string | undefined {
  const cleaned = normalizeBindingField(input, ROLE_BINDING_ARGS_MAX);
  if (!cleaned) return undefined;
  for (const tkn of tokenize(cleaned)) {
    if (SHELL_METACHAR_RE.test(tkn.value)) return undefined;
  }
  return cleaned;
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
  const model = normalizeModelField(src.model);
  const args = normalizeArgsField(src.args);
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

/** Does this token's VALUE carry an explicit model flag?
 *
 *  Decided on the value alone, because that is what the CLI receives: the shell
 *  hands `claude "--model=opus"` to claude as the single argument
 *  `--model=opus`, exactly as the unquoted spelling would. Reading the quoting
 *  instead used to miss that form and inject a second `--model`.
 *
 *  The prose exclusion is the whitespace test, not the quote flag. A `--model`
 *  mentioned inside a longer string (`claude "explain the --model flag"`) is a
 *  sentence, and a sentence always carries whitespace — no single argv entry
 *  ever does. So a value with whitespace is never a flag, and a value without
 *  it is judged purely on shape. */
function isExplicitModelFlagToken(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (value === '--model' || value === '-m') return true;
  // `--model=opus` / `-m=opus`. Suppressing on the short `=` form even if a CLI
  // rejects it errs toward "never emit a duplicate flag": a bad hand-written
  // flag fails visibly, a silently doubled one does not.
  return value.startsWith('--model=') || value.startsWith('-m=');
}

/** Is an explicit model flag already present, so the rewrite must NOT add a
 *  second one (D-4: a manual `--model` wins for that launch)? */
function hasExplicitModelFlag(tokens: ReturnType<typeof tokenize>): boolean {
  return tokens.some((tkn) => isExplicitModelFlagToken(tkn.value));
}

/** Sub-commands that may legitimately follow a launcher as a bare word.
 *  `codex resume --last` / `codex exec …` are launches, not prose. */
const LAUNCH_SUBCOMMANDS: ReadonlySet<string> = new Set(['resume', 'exec', 'e']);

/**
 * Does everything after the launcher token look like SHELL ARGUMENTS rather
 * than prose?
 *
 * This is the guard that keeps the rewrite off `terminal_send`'s main use: the
 * orchestrator instructing a RUNNING TUI. "claude code is failing on windows"
 * starts with the token `claude` but is a sentence typed into an agent's
 * composer — splicing `--model haiku` into it corrupts the message. A real bare
 * invocation only ever carries flags, flag values, quoted arguments, or a known
 * sub-command, so we require exactly that and treat any other bare word as
 * prose. Erring toward NOT rewriting is the right failure direction: a missed
 * enforcement is recoverable, a mangled prompt is not.
 */
function looksLikeLaunchInvocation(tokens: ReturnType<typeof tokenize>): boolean {
  for (let i = 1; i < tokens.length; i++) {
    const tkn = tokens[i];
    // A quoted span is a deliberate shell argument (`claude "explain this"`).
    if (tkn.quoted) continue;
    if (tkn.value.startsWith('-')) continue;
    // A bare word directly after a flag is that flag's value (`--model opus`).
    // Quoting of the FLAG is irrelevant here — `claude "--model" opus` passes a
    // real flag — and a quoted prose span never starts with `-`.
    const prev = tokens[i - 1];
    if (prev.value.startsWith('-') && !prev.value.includes('=')) continue;
    if (i === 1 && LAUNCH_SUBCOMMANDS.has(tkn.value)) continue;
    // ...and that sub-command's own argument (`codex resume <session-id>`).
    if (i === 2 && !tokens[1].quoted && LAUNCH_SUBCOMMANDS.has(tokens[1].value)) continue;
    return false;
  }
  return true;
}

/** Is `args` already the trailing token run of `command`? Compared on TOKEN
 *  boundaries, not as a suffix string: `endsWith('--foo')` also matched a
 *  command ending in `--bar-foo` and silently skipped the append. */
function alreadyEndsWithArgs(command: string, args: string): boolean {
  const cmdTokens = tokenize(command).map((t) => t.value);
  const argTokens = tokenize(args).map((t) => t.value);
  if (argTokens.length === 0 || argTokens.length > cmdTokens.length) return false;
  const tail = cmdTokens.slice(cmdTokens.length - argTokens.length);
  return tail.every((v, i) => v === argTokens[i]);
}

/**
 * Pure transform: given a launch command + a role's binding, return the command
 * with the bound agent's model (and any extra args) enforced.
 *
 * The rewrite fires ONLY on something that is recognizably an agent launch.
 * Both gates below are load-bearing, because this runs on every submitted line
 * in a bound pane — including shell commands and prose sent to a live TUI:
 *  1. the launcher stem must be a known agent CLI (KNOWN_AGENT_STEMS). Chosen
 *     over MODEL_FLAG_BY_LAUNCHER so that `args`-only enforcement still reaches
 *     an agent whose `--model` grammar we haven't verified (opencode/gemini),
 *     while `git`/`ls`/`npm` are never touched by any part of the binding.
 *  2. the rest of the line must look like arguments, not prose — see
 *     {@link looksLikeLaunchInvocation}. A caller that SPAWNS the string rather
 *     than submitting it to a pane knows this without guessing, and says so with
 *     {@link ApplyRoleBindingOptions.spawnedProcess}.
 *
 * Rules once past the gates:
 *  - `binding.agent` set and the launcher stem differs → unchanged + a note
 *    (a policy deviation the operator should hear about).
 *  - `binding.model` without `binding.agent` → NOT injected + note. A model
 *    alias is only meaningful for a specific launcher's grammar; injecting it
 *    blind produced `codex --model haiku`, an invalid launch.
 *  - `binding.model` set but the launcher has no known `--model` grammar
 *    (gemini/opencode/aider) → not injected + advisory note (D-5). `args` still
 *    applies — it is launcher-agnostic.
 *  - An explicit `--model` already on the line → model NOT re-injected (D-4),
 *    though `binding.args` may still be appended.
 *  - Otherwise: inject `--model <m>` right after the launcher token and append
 *    normalized `binding.args` at the end.
 *
 * `modelInjected` reports whether the model flag was ACTUALLY spliced in, so a
 * caller never advertises an enforced model when only `args` changed.
 *
 * Idempotent: re-applying never double-adds the model flag (an explicit
 * `--model` short-circuits) nor the args (token-boundary trailing check).
 */
export interface ApplyRoleBindingOptions {
  /**
   * The command will be SPAWNED as a process, not submitted as a line into a
   * pane that may already be running an agent.
   *
   * That distinction is what {@link looksLikeLaunchInvocation} exists to guess
   * at, and on this path it is known rather than guessed: an X8 supervised leaf's
   * `exec` string becomes the pane's root process, so there is no live TUI for it
   * to be prose for. Skipping the prose gate here keeps enforcement on the shape
   * a supervised agent leaf actually uses — `claude /loop`, a launch whose
   * argument is a bare word — which the gate must otherwise reject, since on the
   * submitted-line path that same string is far more likely to be a slash command
   * typed at a running agent.
   *
   * Gate 1 is NOT affected: a non-agent stem (`npm run dev`) is still never
   * touched, on any path. Set this only where the caller genuinely spawns the
   * string; defaulting it on would re-open the mangled-prompt hazard the gate
   * was built for.
   */
  spawnedProcess?: boolean;
}

export function applyRoleBinding(
  command: string,
  binding: RoleBinding | undefined,
  options?: ApplyRoleBindingOptions,
): { command: string; changed: boolean; modelInjected: boolean; note?: string } {
  const unchanged = { command, changed: false, modelInjected: false };
  if (!binding) return unchanged;
  const model = binding.model?.trim() || undefined;
  const args = binding.args?.trim() || undefined;
  if (!model && !args) return unchanged;

  const tokens = tokenize(command);
  if (tokens.length === 0) return unchanged;
  const stem = launcherStem(tokens[0].value);

  // Gate 1 — only agent launches are ever rewritten (see the doc block).
  if (!KNOWN_AGENT_STEMS.has(stem)) return unchanged;
  // Gate 2 — and only when the line is an invocation, not prose. A spawned
  // process is one by construction (see ApplyRoleBindingOptions.spawnedProcess).
  if (!options?.spawnedProcess && !looksLikeLaunchInvocation(tokens)) return unchanged;

  // A binding that names an agent only applies to that launcher. Launching a
  // DIFFERENT known agent than the role names is a silent policy deviation.
  if (binding.agent && binding.agent !== stem) {
    return {
      ...unchanged,
      note: `Role is bound to "${binding.agent}", but "${stem}" was launched here; the binding does not apply and nothing was enforced.`,
    };
  }

  const grammar = MODEL_FLAG_BY_LAUNCHER[stem];
  let note: string | undefined;
  let injectModel = false;

  if (model) {
    if (!binding.agent) {
      note =
        `Role is bound to model "${model}" but to no agent, so wmux cannot tell whose ` +
        `--model grammar applies; nothing was enforced. Set the role's agent in Settings.`;
    } else if (!grammar) {
      note = `Role bound to model "${model}", but launcher "${stem}" has no known --model flag; launched unchanged.`;
    } else if (!hasExplicitModelFlag(tokens)) {
      injectModel = true;
    }
  }

  let out = command;
  if (injectModel && grammar) {
    const at = tokens[0].end;
    out = `${command.slice(0, at)} ${grammar.flag(model as string)}${command.slice(at)}`;
  }
  // Append extra args verbatim, but only when not already trailing (idempotence).
  if (args && !alreadyEndsWithArgs(out, args)) {
    out = `${out} ${args}`;
  }

  return {
    command: out,
    changed: out !== command,
    modelInjected: injectModel,
    ...(note ? { note } : {}),
  };
}
