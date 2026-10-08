import { AGENT_ROWS, agentLauncherStem } from './agentIdentity';
import { launcherStem, tokenize } from './agentResume';
import {
  EFFORT_TOKEN_RE, freshContextGrammarFor, hasPermissionChoice, isSkipPermissionsToken, launchGrammarFor,
  permissionChoiceIndexes,
} from './agentLaunchOptions';

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
  /** Reasoning effort, spliced with the agent's own grammar
   *  (agentLaunchOptions). Ignored for agy, whose effort is the model id suffix. */
  effort?: string;
  /** Launch with the agent's own skip-permission-prompts flag. */
  skipPermissions?: boolean;
  /**
   * Start each dispatched task in a fresh conversation (#1680): when a caller
   * marks a send as a NEW task (`input.send` `newTask`, or the new-task branch
   * of an a2a send), wmux types the bound agent's fresh-context command
   * (agentLaunchOptions) first. The operator's half of a two-key opt-in: it
   * does nothing without the caller's signal, and the caller's signal does
   * nothing without it. Not a launch option, so applyRoleBinding ignores it.
   */
  freshContext?: boolean;
  /** wmux MCP tools the agent sees: 'full' (every tool), 'core' (no browser
   *  tools), 'role' (only this role's tools, src/shared/roleSurfaces.ts).
   *  Unset = whatever the CLI's own wmux registration gives it. */
  tools?: WmuxTools;
}

export const WMUX_TOOLS = ['full', 'core', 'role'] as const;
export type WmuxTools = (typeof WMUX_TOOLS)[number];

/** Operator-level, cross-workspace. Keyed by role name (ORCH_ROLES ∪ custom). */
export type OrchestratorRoleBindings = Record<string, RoleBinding>;

/** Per-agent model-flag grammar (sibling of agentResume's resume grammar).
 *  Derived from the registry's `modelFlag` (src/shared/agentIdentity.ts), and
 *  ONLY agents whose model flag is empirically verified declare one; an absent
 *  agent (gemini/aider/opencode) yields a no-op + advisory note rather than a
 *  guessed, possibly-broken flag. claude + codex `--model <m>` are verified in
 *  agentResume.test.ts (`codex --model gpt-5.5`, `claude --model`); grok and
 *  agy carry their verification dates on their rows. grok is a fan-out-only
 *  launcher (`roleBinding: false`), so a role binding never reaches it. */
interface ModelFlagGrammar {
  /** Render the model flag tokens inserted right after the launcher token. */
  flag: (model: string) => string;
}
const MODEL_FLAG_BY_LAUNCHER: ReadonlyMap<string, ModelFlagGrammar> = new Map(
  AGENT_ROWS.flatMap((row): [string, ModelFlagGrammar][] => {
    const modelFlag = row.modelFlag;
    return modelFlag ? [[agentLauncherStem(row), { flag: (m) => `${modelFlag} ${m}` }]] : [];
  }),
);

/** Whether wmux knows how to inject a model flag for a launcher stem. */
export function launcherSupportsModelFlag(stem: string): boolean {
  return MODEL_FLAG_BY_LAUNCHER.has(stem);
}

/**
 * Swap the agent CLI in a launch command for the one a role is bound to.
 *
 * Deliberately NOT part of {@link applyRoleBinding}, which refuses to touch a
 * command whose launcher differs from the binding's agent and only reports a
 * note. That refusal is right for what it governs — a line a HUMAN typed at a
 * live pane, where silently launching a different program than the one written
 * would be indefensible.
 *
 * A fan-out task is the other case: nobody typed the command, wmux assembled it
 * (`<agent> "$(cat <prompt file>)"`), and the operator's whole reason for
 * binding Reviewer to codex is that review tasks should run on codex. Without
 * this, every task in a fan-out launches on the same default agent and the
 * binding is silently inert — the model flag never even applies, because
 * applyRoleBinding bails on the stem mismatch first.
 *
 * Refuses in three cases, each fail-soft (command unchanged, note explains):
 *  - the bound agent is not a launcher wmux recognises;
 *  - the command's own launcher is not one either (it is not an agent launch);
 *  - the command carries flags. `claude --dangerously-skip-permissions` is a
 *    Claude-only spelling, so swapping the stem under it would produce
 *    `codex --dangerously-skip-permissions` — a launch that just fails, and one
 *    nobody asked for. A command with flags was written by a person who meant
 *    those flags; their command wins over the binding.
 */
export function applyRoleAgent(
  command: string,
  binding: RoleBinding | undefined,
  options?: Pick<ApplyRoleBindingOptions, 'extraAgents'>,
): { command: string; changed: boolean; note?: string } {
  const unchanged = { command, changed: false };
  const agent = binding?.agent?.trim();
  if (!agent) return unchanged;
  const known = (stem: string): boolean => KNOWN_AGENT_STEMS.has(stem) || options?.extraAgents?.has(stem) === true;
  if (!known(agent)) {
    return { ...unchanged, note: `Role is bound to "${agent}", which wmux does not recognise as an agent CLI; launched unchanged.` };
  }
  const tokens = tokenize(command);
  if (tokens.length === 0) return unchanged;
  const stem = launcherStem(tokens[0].value);
  if (!known(stem)) return unchanged;
  if (stem === agent) return unchanged;
  const flagged = tokens.slice(1).some((t) => !t.quoted && t.value.startsWith('-'));
  if (flagged) {
    return {
      ...unchanged,
      note:
        `Role is bound to "${agent}", but the launch command carries flags written for ` +
        `"${stem}"; the agent was NOT swapped (the flags would not survive it).`,
    };
  }
  // Replace only the launcher token; everything after it (the prompt argument)
  // is spliced back byte-identical. A CLI that takes its first prompt only from
  // a flag gets that flag right before the argument (agy: `-i "<prompt>"`);
  // later rewrites insert their flags after the launcher, so `-i` stays adjacent.
  const rest = command.slice(tokens[0].end);
  const promptFlag = PROMPT_FLAG_BY_STEM.get(agent)?.flag;
  if (promptFlag && tokens.length > 1) return { command: `${agent} ${promptFlag}${rest}`, changed: true };
  return { command: agent + rest, changed: true };
}

/** Agent CLIs that refuse a positional first prompt, keyed by launcher stem: the
 *  flag that takes the prompt instead, and every flag the CLI reads a first
 *  prompt from (a line already carrying one needs no other). The fan-out worker
 *  line is `<agent> "$(cat <prompt file>)"`. Derived from the registry's
 *  `promptFlag` (agy, verified 2026-09-30 in a real PTY). */
const PROMPT_FLAG_BY_STEM: ReadonlyMap<string, { readonly flag: string; readonly accepts: readonly string[] }> = new Map(
  AGENT_ROWS.flatMap((row) => (row.promptFlag ? [[agentLauncherStem(row), row.promptFlag] as const] : [])),
);

/** Stem of the raw first word: tokenize() treats `\` as an escape, which would
 *  mangle a Windows launcher path (`C:\Tools\agy.exe`). */
function rawLauncherStem(command: string): string {
  return launcherStem(/^\s*(\S+)/.exec(command)?.[1] ?? '');
}

function hasPromptTakingFlag(stem: string, args: readonly { value: string; quoted: boolean }[]): boolean {
  const flags = PROMPT_FLAG_BY_STEM.get(stem)?.accepts ?? [];
  return args.some((t) => !t.quoted && flags.some((f) => t.value === f || t.value.startsWith(`${f}=`)));
}

/**
 * The flag a prompt argument appended to `agentCmd` must be preceded by, or
 * undefined when none is needed: the CLI takes a positional prompt, or the
 * command already carries a prompt-taking flag. Used where wmux assembles
 * `<agentCmd> "<prompt>"` itself (fan-out worker lines), so a human-typed
 * `agy` in the Fan-out dialog launches as `agy -i "<prompt>"` too.
 */
export function promptFlagForLauncher(agentCmd: string): string | undefined {
  const tokens = tokenize(agentCmd);
  if (tokens.length === 0) return undefined;
  const stem = rawLauncherStem(agentCmd);
  const flag = PROMPT_FLAG_BY_STEM.get(stem)?.flag;
  if (!flag) return undefined;
  return hasPromptTakingFlag(stem, tokens.slice(1)) ? undefined : flag;
}

/**
 * Will this fan-out worker line be refused for its prompt? For a line wmux
 * assembled as `<agentCmd> "<prompt>"` (any argument means a prompt is
 * there): true when the launcher rejects a positional first prompt and no
 * prompt-taking flag is present (agy answers "Prompts are read only from
 * -p/--print, -i/--prompt-interactive, or stdin" and exits). A bare launcher
 * (no prompt) is never refused.
 */
export function launchRefusesPositionalPrompt(command: string): boolean {
  const tokens = tokenize(command);
  if (tokens.length < 2) return false;
  const stem = rawLauncherStem(command);
  if (!PROMPT_FLAG_BY_STEM.has(stem)) return false;
  return !hasPromptTakingFlag(stem, tokens.slice(1));
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

/**
 * The skip-permissions flag a launch in this role will carry, or undefined when
 * it carries none. The sibling of {@link bindingEnforcesModel}, with the same
 * contract: an affordance claiming "this pane skips permission prompts" gates
 * on this, never on the setting merely being stored.
 *
 * Mirrors applyRoleBinding on a fresh launch of the bound agent. The binding
 * must name the agent, and the agent must have a verified skip grammar
 * (agentLaunchOptions). Then, in order:
 *  1. a skip spelling in the role's `args` → that spelling. The args are
 *     appended as written, and a skip flag next to a permission flag on one
 *     line still runs bypass.
 *  2. `skipPermissions` with a permission flag in the args → none. The args are
 *     the role's own permission choice, so the rewrite adds no skip flag.
 *  3. `skipPermissions` → the agent's skip flag.
 *
 * An agentless binding answers undefined even when its args carry a skip
 * spelling: the args still apply to any agent launched, but no grammar says
 * which spelling is the skip. A line that makes its own permission choice can
 * still withhold the skip for that one launch (#1681); this answers for the
 * role, not for a particular line.
 */
export function bindingSkipPermissionsFlag(binding: RoleBinding | undefined): string | undefined {
  const agent = binding?.agent;
  const launch = agent ? launchGrammarFor(agent) : undefined;
  const flag = launch?.skipPermissionsFlag;
  if (!binding || !launch || !flag) return undefined;
  const argValues = tokenize(binding.args?.trim() ?? '').map((t) => t.value);
  const inArgs = argValues.find((v) => isSkipPermissionsToken(launch, v));
  if (inArgs) return inArgs;
  if (!binding.skipPermissions || hasPermissionChoice(launch, argValues)) return undefined;
  return flag;
}

/** Does a launch in this role skip permission prompts? See {@link bindingSkipPermissionsFlag}. */
export function bindingEnforcesSkipPermissions(binding: RoleBinding | undefined): boolean {
  return bindingSkipPermissionsFlag(binding) !== undefined;
}

/**
 * Does a new task sent to a pane in this role start a fresh conversation?
 * Same contract as {@link bindingEnforcesModel}: the setting alone is not
 * enough, the bound agent must also have a verified fresh-context command
 * (claude, codex). A stored `freshContext` on any other agent is inert.
 */
export function bindingEnforcesFreshContext(binding: RoleBinding | undefined): boolean {
  return binding?.freshContext === true && freshContextGrammarFor(binding.agent) !== undefined;
}

/** Launcher stems wmux recognizes as agent CLIs. This is applyRoleBinding's
 *  OUTER gate: a command whose stem is absent here is never rewritten in any
 *  way, so `git commit -m "wip"` and `npm test` in a bound pane come back
 *  byte-identical. It also decides whether a mismatch is worth reporting —
 *  launching a DIFFERENT known agent than the role names is a policy deviation
 *  the operator should hear about. Derived from the registry
 *  (shared/agentIdentity.ts): every row's launcher stem (`kiro-cli` for kiro),
 *  except a fan-out-only launcher (`roleBinding: false`, grok). */
export const KNOWN_AGENT_STEMS: ReadonlySet<string> = new Set(
  AGENT_ROWS.filter((row) => row.roleBinding !== false).map(agentLauncherStem),
);

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
  const src = input as {
    agent?: unknown; model?: unknown; args?: unknown;
    effort?: unknown; skipPermissions?: unknown; freshContext?: unknown; tools?: unknown;
  };
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
  if (typeof src.effort === 'string' && EFFORT_TOKEN_RE.test(src.effort)) binding.effort = src.effort;
  // Strict booleans only: a hand-edited "true" string does not switch it on.
  if (src.skipPermissions === true) binding.skipPermissions = true;
  if (src.freshContext === true) binding.freshContext = true;
  if ((WMUX_TOOLS as readonly unknown[]).includes(src.tools)) binding.tools = src.tools as WmuxTools;
  if (
    binding.agent === undefined && binding.model === undefined && binding.args === undefined &&
    binding.effort === undefined && !binding.skipPermissions && !binding.freshContext && !binding.tools
  ) {
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

/**
 * D-4 as a public question about a whole command line: does this launch already
 * choose its own model?
 *
 * The quote-aware tokenizer is the point — a fan-out launch ends in
 * `"$(cat '<prompt path>')"`, one quoted argument, and a naive whitespace split
 * would read a path's words as flags. Exported so the fan-out launch assembly
 * (shared/workerLaunch) asks the same question this file already answers for
 * the role rewrite, rather than growing a second, looser copy of it.
 */
export function commandChoosesModel(command: string): boolean {
  return hasExplicitModelFlag(tokenize(command));
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

/** `args` without the tokens `drop` matches (by value and index), the rest
 *  kept as written (quotes included). `args` is normalized to single spaces, so
 *  rejoining with one space loses nothing. */
function dropArgTokens(args: string, drop: (value: string, index: number) => boolean): string {
  const kept: string[] = [];
  let start = 0;
  tokenize(args).forEach((tkn, i) => {
    const raw = args.slice(start, tkn.end).trim();
    start = tkn.end;
    if (!drop(tkn.value, i)) kept.push(raw);
  });
  return kept.join(' ');
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
 *  - `binding.effort` / `binding.skipPermissions` splice the agent's own flag
 *    (agentLaunchOptions) next to the model, unless that flag is already on the
 *    line or in the args. A permission flag in the args (`--permission-mode`)
 *    also stops the skip injection: the role's own config wins.
 *  - An explicit permission choice wins over the role's skip (#1681):
 *    {@link ApplyRoleBindingOptions.suppressSkipPermissions} (a toggle the user
 *    set OFF) or a permission flag typed on the line itself withholds the skip
 *    flag and drops the skip spellings from `binding.args`. A typed permission
 *    flag also drops the permission flags in `binding.args`, so the user's
 *    mode is the one that runs. The other args stay.
 *
 * `modelInjected` reports whether the model flag was ACTUALLY spliced in, so a
 * caller never advertises an enforced model when only `args` changed;
 * `optionsInjected` does the same for effort and skip permissions.
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
  /**
   * Launcher stems to treat as agents on top of KNOWN_AGENT_STEMS. Fan-out
   * passes its own closed list (FANOUT_EXTRA_AGENT_STEMS) so a CLI it verified
   * can be launched through this rewrite without becoming an agent identity
   * everywhere else (detection, resume, the role-binding dropdown).
   */
  extraAgents?: ReadonlySet<string>;
  /**
   * Do not inject the binding's skip-permissions flag on this launch. Set by the
   * resume chip and the recovery pill when the user explicitly turned their
   * "skip permissions" toggle OFF: that per-launch choice wins over the role
   * (owner decision, #1677). The skip spellings in the binding's args are
   * dropped too (#1681); model, effort and the other args are still applied,
   * and a skip flag already on the line is left alone.
   */
  suppressSkipPermissions?: boolean;
  /**
   * #1916: the line resumes no exact session (the session picker `claude
   * --resume` / `codex resume`, #1946, or a cwd-relative `--continue` /
   * `resume --last`), so it may reach an unrelated conversation. The
   * role's permission settings are withheld entirely: its skip flag, and every
   * permission choice in its args (`--permission-mode ...`, `-a never`, ...),
   * as well as the skip spellings. Model, effort and the other args still apply.
   */
  suppressPermissionChoices?: boolean;
}

/** The launch options a rewrite ACTUALLY spliced in, each present only when it
 *  was (a flag already on the line or in the args, or a withheld skip, is not
 *  reported). The sibling of `modelInjected`. */
export interface InjectedLaunchOptions {
  /** The effort level whose flag was added. */
  effort?: string;
  /** The agent's skip-permissions flag was added. */
  skipPermissions?: true;
}

export function applyRoleBinding(
  command: string,
  binding: RoleBinding | undefined,
  options?: ApplyRoleBindingOptions,
): {
  command: string;
  changed: boolean;
  modelInjected: boolean;
  /** Present only when at least one launch option was injected. */
  optionsInjected?: InjectedLaunchOptions;
  note?: string;
} {
  const unchanged = { command, changed: false, modelInjected: false };
  if (!binding) return unchanged;
  const model = binding.model?.trim() || undefined;
  const roleArgs = binding.args?.trim() || undefined;
  const effort = binding.effort && EFFORT_TOKEN_RE.test(binding.effort) ? binding.effort : undefined;
  if (!model && !roleArgs && !effort && !(binding.skipPermissions && !options?.suppressSkipPermissions)) {
    return unchanged;
  }

  const tokens = tokenize(command);
  if (tokens.length === 0) return unchanged;
  const stem = launcherStem(tokens[0].value);

  // Gate 1 — only agent launches are ever rewritten (see the doc block).
  if (!KNOWN_AGENT_STEMS.has(stem) && options?.extraAgents?.has(stem) !== true) return unchanged;
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

  const grammar = MODEL_FLAG_BY_LAUNCHER.get(stem);
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

  // Permission precedence (owner decision, #1681): an explicit, user-stated
  // permission choice wins over the role's. Two sources count as explicit: the
  // caller's suppressSkipPermissions (a toggle the user set OFF) and a
  // permission flag the user typed on the line itself (`--permission-mode plan`,
  // codex `-a never`, `-c approval_policy=never`).
  //  - Either one withholds the role's skip flag AND drops the skip spellings
  //    from the role's args, which would otherwise override the choice (claude
  //    runs bypass when both flags are on one line).
  //  - A typed permission flag also drops the permission flags (and their
  //    values) from the role's args: they are appended after the user's, and
  //    the last one wins.
  // A permission flag inside the role's args is otherwise the role's own
  // config, not the user's: it only stops the skip injection below. The role's
  // args already trailing the line (a re-apply) are the role's too, so they are
  // not read as the user's.
  const stemGrammar = launchGrammarFor(stem);
  const userTokens = roleArgs && alreadyEndsWithArgs(command, roleArgs)
    ? tokens.slice(0, tokens.length - tokenize(roleArgs).length)
    : tokens;
  const userChosePermission = !!stemGrammar &&
    hasPermissionChoice(stemGrammar, userTokens.slice(1).map((t) => t.value));
  const fallbackLine = !!options?.suppressPermissionChoices;
  const withholdRoleSkip = !!options?.suppressSkipPermissions || userChosePermission || fallbackLine;
  let args = roleArgs;
  let argsPermissionDropped = false;
  if (args && withholdRoleSkip && stemGrammar) {
    const argValues = tokenize(args).map((t) => t.value);
    const choices = userChosePermission || fallbackLine ? permissionChoiceIndexes(stemGrammar, argValues) : [];
    const kept = dropArgTokens(
      args,
      (v, i) => isSkipPermissionsToken(stemGrammar, v) || choices.indexOf(i) !== -1,
    );
    if (kept !== args) {
      argsPermissionDropped = true;
      args = kept || undefined;
    }
  }
  const skipPermissions = !!binding.skipPermissions && !withholdRoleSkip;
  if (
    userChosePermission && !options?.suppressSkipPermissions &&
    ((binding.skipPermissions && binding.agent) || argsPermissionDropped)
  ) {
    const withheld =
      "The role's permission settings were not applied: the command makes its own permission choice.";
    note = note ? `${note} ${withheld}` : withheld;
  }

  // Launch options (effort, skip permissions) use the agent's verified grammar
  // and, like the model, need the binding to name the agent. A flag already on
  // the line OR in the binding's own args wins (D-4 for options): the args are
  // appended below, so checking the line alone put two `--effort` on it. A
  // permission flag in the args counts too: the role's own permission choice.
  const launch = binding.agent ? stemGrammar : undefined;
  const present = [...tokens, ...(args ? tokenize(args) : [])].map((t) => t.value);
  const optionTokens: string[] = [];
  const optionsInjected: InjectedLaunchOptions = {};
  if (effort && launch?.effortFlag && !present.some((v) => launch.hasEffort?.(v))) {
    optionTokens.push(...launch.effortFlag(effort));
    optionsInjected.effort = effort;
  }
  if (
    skipPermissions && launch?.skipPermissionsFlag &&
    !present.some((v) => isSkipPermissionsToken(launch, v)) && !hasPermissionChoice(launch, present)
  ) {
    optionTokens.push(launch.skipPermissionsFlag);
    optionsInjected.skipPermissions = true;
  }

  let out = command;
  const at = tokens[0].end;
  const inserted = [
    ...(injectModel && grammar ? [grammar.flag(model as string)] : []),
    ...optionTokens,
  ];
  if (inserted.length > 0) {
    out = `${command.slice(0, at)} ${inserted.join(' ')}${command.slice(at)}`;
  }
  // Append extra args verbatim, but only when not already trailing (idempotence).
  if (args && !alreadyEndsWithArgs(out, args)) {
    out = `${out} ${args}`;
  }

  return {
    command: out,
    changed: out !== command,
    modelInjected: injectModel,
    ...(optionTokens.length > 0 ? { optionsInjected } : {}),
    ...(note ? { note } : {}),
  };
}
