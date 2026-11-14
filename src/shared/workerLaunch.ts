// ─── Fan-out worker launch line — the model-env marker (F15) ────────────────
//
// A fan-out worker's launch command is not spawned: it is TYPED into the pane's
// interactive login shell after that shell has booted (scheduleInitialCommand).
// By then the operator's rc files have run, so an `ANTHROPIC_MODEL` exported by
// `~/.zshrc` has overwritten whatever environment wmux resolved for the spawn.
// Three dogfood runs died there — every worker's first turn came back "There's
// an issue with the selected model (glm-5.3)" — so the neutralisation has to be
// part of the command line itself, which is the only thing that runs later than
// the rc files.
//
// This module owns the exact text of that prefix, because TWO processes handle
// it and a drifting private regex in either one silently disarms the fix:
//
//   - main (FanOutService) attaches it to an eligible launch;
//   - the renderer (useRpcBridge, fanout.spawnWorkspace) splits it off before
//     the operator's role binding is applied — `applyRoleAgent` and
//     `applyRoleBinding` both gate on the FIRST TOKEN of the command, so a
//     prefix in front of the launcher would silently drop the role's agent AND
//     its model — and re-attaches it only if the rewritten command still names
//     no model of its own.
//
// ── Why `unset` and not `env -u` ────────────────────────────────────────────
//
// `env -u VAR claude …` execs a BINARY named claude. `claude migrate-installer`
// leaves many machines with `alias claude="$HOME/.claude/local/claude"` and no
// `claude` on PATH at all, so that form dies with `env: claude: No such file or
// directory` — a worker that fails to start is strictly worse than one on the
// wrong model. `unset VAR; claude …` runs in the shell that owns the alias, and
// alias expansion applies to the first word of a command after `;`.
//
// ── Why the gateway test is in the SHELL, not in main ───────────────────────
//
// An operator routing claude through a gateway (`ANTHROPIC_BASE_URL`, e.g. a
// z.ai/GLM endpoint) NEEDS their `ANTHROPIC_MODEL`: unset it and claude asks
// that gateway for a default `claude-*` model it does not serve, and every
// worker dies the same way this fix exists to prevent. So the marker tests for
// it — and it tests in the PANE's shell rather than in main's `process.env`,
// because main's environment is not the one that has the problem. The whole
// finding is that the rc files export variables main never saw (and when wmux
// is opened from Finder/Dock, main inherits no shell environment at all), so a
// main-side `process.env.ANTHROPIC_BASE_URL` check would read absent for
// exactly the gateway operator it is meant to protect.
//
// Bedrock and Vertex (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`) set
// no base URL, yet their `ANTHROPIC_MODEL` is a provider id (a Bedrock ARN, a
// Vertex `model@version`) that claude's own default is not, so either flag
// cancels the neutralisation the same way.

import { AGENT_ROWS, type AgentIdentityRow } from './agentIdentity';
import { permissionChoiceIndexes } from './agentLaunchOptions';
import { commandChoosesModel } from './orchestratorRole';
import { stripPromptFileArgument } from './promptFileArgument';

/** The variable the launch neutralises. */
export const WORKER_MODEL_ENV = 'ANTHROPIC_MODEL';

/** The gateway variable whose presence CANCELS the neutralisation (see above). */
export const WORKER_GATEWAY_ENV = 'ANTHROPIC_BASE_URL';

/** Every variable whose presence cancels it: the gateway and the Bedrock and
 *  Vertex backend flags. */
export const WORKER_MODEL_KEEP_ENVS = [WORKER_GATEWAY_ENV, 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'] as const;

/**
 * The prefix, verbatim. Compared and sliced as a literal on both sides — never
 * re-derived from a regex — so main and the renderer cannot drift apart.
 *
 * `ANTHROPIC_AUTH_TOKEN` is deliberately NOT touched here, nor is
 * `ANTHROPIC_BASE_URL` itself: routing every pane's claude through a proxy is a
 * legitimate whole-machine choice, and a worker that quietly bypassed it would
 * be talking to a different endpoint than every other pane the operator opens.
 * Model SELECTION is the one part of that environment wmux owns for a worker,
 * because wmux is what decided to launch this agent at all.
 */
export const MODEL_ENV_MARKER = `${WORKER_MODEL_KEEP_ENVS.map((v) => `[ -n "$${v}" ]`).join(' || ')} || unset ${WORKER_MODEL_ENV}; `;

/** Split a leading {@link MODEL_ENV_MARKER} off a launch command. */
export function splitModelEnvMarker(command: string): { marker: string; command: string } {
  return command.startsWith(MODEL_ENV_MARKER)
    ? { marker: MODEL_ENV_MARKER, command: command.slice(MODEL_ENV_MARKER.length) }
    : { marker: '', command };
}

/**
 * Shell basenames the marker's grammar is written for.
 *
 * fish spells this `set -e` and has no `unset` at all; csh/tcsh need `unsetenv`;
 * PowerShell, nushell, xonsh and elvish share none of the syntax. So a shell the
 * operator NAMED but this list does not know drops the marker: the worst case
 * of dropping it is the original bug, and the worst case of keeping it is a
 * worker that never starts.
 *
 * An ABSENT shell is the one case that still gets the marker — it means "the
 * pane inherits the platform default", and the attaching side has already
 * refused every platform whose default is not a Bourne shell.
 */
const POSIX_MARKER_SHELLS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ksh93', 'mksh', 'ash', 'busybox',
]);

/** Can this pane's shell run the marker? `undefined` = the platform default. */
export function shellSupportsModelEnvMarker(shell: string | undefined): boolean {
  if (!shell) return true;
  const base = (shell.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
  return POSIX_MARKER_SHELLS.has(base);
}

/**
 * Is `agentCmd` a single simple command the marker can safely precede?
 *
 * `unset X; a && b` would leave `b` running with the variable unset in a way the
 * operator never wrote, and a `VAR=value claude` form puts the assignment where
 * the marker's `;` would split it off. Neither is a shape wmux assembles — both
 * would have to come from an explicit `agentCmd` — so the honest answer for one
 * is to leave the command exactly as written and say why.
 */
export function isSimpleLaunchCommand(agentCmd: string): boolean {
  if (/[;|&\n\r`]/.test(agentCmd)) return false;
  if (/\$\(/.test(agentCmd)) return false;
  return !/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(agentCmd);
}

/**
 * Re-attach `marker` to a command the role rewrite has been through.
 *
 * Dropped when the rewritten command now names a model itself (the operator's
 * role binding IS wmux deciding the model, and a CLI flag beats the environment
 * anyway) or when the pane's shell cannot run the marker. `reason` says which,
 * so the caller can log a dropped neutralisation rather than lose it silently.
 */
export function reattachModelEnvMarker(
  marker: string,
  command: string,
  shell: string | undefined,
): { command: string; dropped?: 'model-bound' | 'shell' } {
  if (!marker) return { command };
  if (commandChoosesModel(command)) return { command, dropped: 'model-bound' };
  if (!shellSupportsModelEnvMarker(shell)) return { command, dropped: 'shell' };
  return { command: marker + command };
}

// ─── Fan-out worker permission mode + tool lists ────────────────────────────
//
// A worker runs unattended, so the boundary that actually holds is its Claude
// Code permission mode and tool rules, not wmux's approval dialog. The mode is
// an operator setting (main-side, because it can loosen what a worker may do);
// the tool lists are fixed: a minimal ALLOW list so the worker can report
// without a prompt, and a DENY list for the wmux tools that would let it act
// on other panes or fan out. Deny rules win over allow rules and over every
// permission mode, bypass included, so the deny list is what holds even when
// the operator picks bypassPermissions.

/** The operator's choice for fan-out workers, and for the agents this PC
 *  starts for another PC. `manual` means the agent asks before it acts
 *  (Claude's `--permission-mode default`, an agent row's `askMode` for others); an agent
 *  with no flag wmux knows for that is not started in it (workerModeRefusal).
 *  Not a PermissionMode value, which describes what a transcript recorded
 *  rather than what wmux launches. */
export type FanoutWorkerPermissionMode = 'auto' | 'acceptEdits' | 'bypassPermissions' | 'manual';

export const FANOUT_WORKER_PERMISSION_MODES: readonly FanoutWorkerPermissionMode[] = [
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'manual',
];

export const DEFAULT_FANOUT_WORKER_PERMISSION_MODE: FanoutWorkerPermissionMode = 'auto';

export function isFanoutWorkerPermissionMode(v: unknown): v is FanoutWorkerPermissionMode {
  return typeof v === 'string' && (FANOUT_WORKER_PERMISSION_MODES as readonly string[]).includes(v);
}

/**
 * The worker mode a bot worker respawns in, from the mode its pane recorded: a worker mode as it is, anything else
 * (`plan`, `default`, nothing) `manual`, which asks and keeps an asking mode already on the resume line (a plan
 * worker resumes in plan).
 */
export function respawnWorkerMode(recorded: unknown): FanoutWorkerPermissionMode {
  return isFanoutWorkerPermissionMode(recorded) ? recorded : 'manual';
}

/** What a task's orchestrator may answer on its workers' panes by key or
 *  text: every prompt, Claude Code's selection menus only, or none (the gate
 *  every other caller gets). */
export type FanoutOwnerAnswers = 'all' | 'menus' | 'off';

export const DEFAULT_FANOUT_OWNER_ANSWERS: FanoutOwnerAnswers = 'all';

export function isFanoutOwnerAnswers(v: unknown): v is FanoutOwnerAnswers {
  return v === 'all' || v === 'menus' || v === 'off';
}

/**
 * The wmux tools a worker may call without a prompt: record its ledger row,
 * publish its own task branch (main pushes it) and fetch origin into it (main
 * fetches), READ its mission channel,
 * and ask who it is / what it was asked. Nothing
 * that writes into another agent's prompt: `channel_post` is left out because
 * a post can pin a mention to any pane and land in that agent's prompt, and
 * `send_message` / `terminal_send` type into panes outright. Never `mcp__wmux`
 * as a whole — that would pre-approve every tool wmux exposes.
 */
export const FANOUT_WORKER_ALLOWED_TOOLS: readonly string[] = [
  'mcp__wmux__ledger_update',
  'mcp__wmux__task_push',
  'mcp__wmux__task_fetch',
  'mcp__wmux__channel_read',
  'mcp__wmux__channel_unread',
  'mcp__wmux__channel_ack',
  'mcp__wmux__a2a_task_query',
  'mcp__wmux__a2a_whoami',
];

/**
 * The wmux tools a worker may not call at all, in any permission mode: fan
 * out again, type into or open panes, message other agents, drive a browser.
 */
export const FANOUT_WORKER_DISALLOWED_TOOLS: readonly string[] = [
  'mcp__wmux__fanout_start',
  'mcp__wmux__terminal_send',
  'mcp__wmux__terminal_send_key',
  'mcp__wmux__send_message',
  // send_message under its older name (same handler).
  'mcp__wmux__a2a_task_send',
  'mcp__wmux__surface_new',
  'mcp__wmux__pane_split',
  'mcp__wmux__browser_*',
];

const PERMISSION_FLAG_FOR_WORKER: Readonly<Record<FanoutWorkerPermissionMode, string>> = {
  auto: '--permission-mode auto',
  acceptEdits: '--permission-mode acceptEdits',
  bypassPermissions: '--dangerously-skip-permissions',
  // `default` asks before it acts. Claude 2.1.322 lists it as `manual` and still takes `default`; older
  // releases know only `default`.
  manual: '--permission-mode default',
};

/** Claude modes that already ask before acting: `manual` keeps one of these on the line (a `plan` resume stays in plan). */
const ASKING_CLAUDE_MODES = new Set(['plan', 'default', 'manual']);

/** The flags wmux appends for `mode`, as they appear on the line. */
export function workerLaunchFlags(mode: FanoutWorkerPermissionMode, extraDisallowed: readonly string[] = []): string {
  return launchFlags(PERMISSION_FLAG_FOR_WORKER[mode], extraDisallowed);
}

/** `permission` (empty for none) and the tool lists, as they appear on the line. */
function launchFlags(permission: string, extraDisallowed: readonly string[]): string {
  // Extra rules join the SAME quoted list: claude splits it on commas and
  // spaces outside parentheses, so `Bash(git push*)` stays one rule. A rule
  // the list already holds, or one a rule before it covers, is not repeated.
  const denied: string[] = [...FANOUT_WORKER_DISALLOWED_TOOLS];
  for (const rule of extraDisallowed) {
    if (!denied.some((d) => d === rule || toolRuleCovers(d, rule))) denied.push(rule);
  }
  // A tool denied is not also allowed: the two lists never contradict.
  const allowed = FANOUT_WORKER_ALLOWED_TOOLS.filter((tool) => !denied.some((rule) => toolRuleCovers(rule, tool)));
  return [
    permission,
    // Nothing left to allow: no list at all, rather than an empty word.
    allowed.length > 0 ? `--allowedTools "${allowed.join(',')}"` : '',
    `--disallowedTools "${denied.join(',')}"`,
  ]
    .filter((p) => p.length > 0)
    .join(' ');
}

/**
 * Whether a tool rule names `tool`: the same rule, a `prefix*` rule it starts
 * with, or an MCP server's rule (`mcp__wmux`), which claude reads as every
 * tool of that server.
 */
export function toolRuleCovers(rule: string, tool: string): boolean {
  return (
    rule === tool ||
    // A tool-name glob (`mcp__wmux__*`, `mcp__wmux__*update`, `*`); a rule with an argument names no tool by glob.
    (rule.includes('*') && !rule.includes('(') && new RegExp(`^${rule.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(tool)) ||
    (/^mcp__[^_]+(?:_[^_]+)*$/.test(rule) && tool.startsWith(`${rule}__`))
  );
}

/** A tool-list value split into rules the way claude reads it: on commas and whitespace outside parentheses. */
function toolRules(value: string): string[] {
  const out: string[] = [];
  let rule = '';
  let depth = 0;
  for (const c of value) {
    if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
    if (depth === 0 && (c === ',' || /\s/.test(c))) {
      if (rule) out.push(rule);
      rule = '';
    } else {
      rule += c;
    }
  }
  if (rule) out.push(rule);
  return out;
}

/**
 * A deny rule wmux can put inside the double-quoted list on the worker's line
 * and have claude read unchanged, in a POSIX shell, PowerShell and cmd alike:
 * no quote, `$`, backtick, backslash, `!` (history expansion in an interactive
 * bash or zsh), `%` (cmd's variables) or line break.
 */
const CARRIABLE_RULE = /^(?:\*|[A-Za-z_][\w*.:-]*(\([^"'`$\\!%\r\n“”„‘’]*\))?)$/;

interface Span {
  /** Unquoted value (quotes stripped). */
  value: string;
  start: number;
  end: number;
}

/**
 * Shell-ish word spans: splits on unquoted whitespace, keeps single- and
 * double-quoted runs (and a backslash-escaped character) inside one word.
 * Same rules as agentResume.tokenize, plus the start offset, so a word can be
 * cut out of the line without touching anything else on it.
 */
function spans(line: string): Span[] {
  const out: Span[] = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    const start = i;
    let value = '';
    while (i < n && !/\s/.test(line[i])) {
      const c = line[i];
      if (c === '"' || c === "'") {
        i++;
        while (i < n && line[i] !== c) {
          if (c === '"' && line[i] === '\\' && i + 1 < n) i++;
          value += line[i];
          i++;
        }
        if (i < n) i++;
      } else if (c === '\\' && i + 1 < n) {
        value += line[i + 1];
        i += 2;
      } else {
        value += c;
        i++;
      }
    }
    out.push({ value, start, end: i });
  }
  return out;
}

const BARE_PERMISSION_FLAGS = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']);
const VALUE_FLAGS = new Set(['--permission-mode']);
const LIST_FLAGS = new Set(['--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools']);
/** A tool rule as it appears after a space-form list flag (`Bash(git *)`,
 *  `mcp__x__y`, `Edit,Read`). The prompt argument never looks like one. */
const TOOL_RULE = /^(?:\*|[A-Za-z_][\w*-]*(\(.*\))?)(,(?:\*|[A-Za-z_][\w*-]*(\(.*\))?))*$/;
/** A quoted space-separated list (`"Bash PowerShell"`, claude splits on spaces
 *  too). Only tool-shaped names: a built-in tool's capitalised name or an MCP
 *  name, so a quoted sentence ("Read the README first") is never taken. */
const SPACED_TOOL_RULE = /^(?:\*|(?:[A-Z][A-Za-z0-9]*|mcp__[\w*-]+)(\([^)]*\))?)([,\s]+(?:\*|(?:[A-Z][A-Za-z0-9]*|mcp__[\w*-]+)(\([^)]*\))?))+$/;
/** Either form; `*` (claude's every-tool rule) is one in both. */
const isToolRuleWord = (value: string): boolean => TOOL_RULE.test(value) || SPACED_TOOL_RULE.test(value);

/** The launcher of a line: its first word's file name, lower case, without a Windows extension. */
function launcherStemOf(words: readonly Span[]): string {
  return (words[0]?.value.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** The registry row a launcher stem names (its `launcher`, else its slug). */
function rowOfStem(stem: string): AgentIdentityRow | undefined {
  return AGENT_ROWS.find((r) => (r.launcher ?? r.slug) === stem);
}

const DENY_FLAGS = new Set(['--disallowedTools', '--disallowed-tools']);
/** The prompt file FanOutService writes for a task, `<dir>/.meta/<task>/prompt.md`, as quoted in its prompt argument. */
const WMUX_PROMPT_FILE = /[\\/]\.meta[\\/][^\\/']+[\\/]prompt\.md'/;

/** What a line's permission and tool-list flags are, read once. */
interface LineFlags {
  /** The bare bypass flags, and every tool-list flag with its rules: always cut. */
  cut: Span[];
  /** The line's own `--permission-mode` words and values. */
  modes: { words: Span[]; value: string }[];
  bypass: boolean;
  /** The rules of its own deny lists. */
  denied: string[];
  /** Those of them wmux can write onto a worker's line as the launcher wrote them. */
  carriable: string[];
  /** Whether one of those cannot be carried onto a worker's line as written. */
  uncarriable: boolean;
}

/**
 * The line's permission and tool-list flags. Word-based: a flag spelled inside
 * a quoted argument (a prompt, an --append-system-prompt value) is part of
 * that word and is never matched. A deny word written with PowerShell's `''`
 * escape or with a backslash is uncarriable too: the words drop those, while
 * a shell may keep them, so the rule read here may not be the rule the
 * launcher denied. So is a space-form deny flag followed by a word that is no
 * tool rule (claude would read it as one): it is not carried as a rule, and
 * dropping it would leave a deny out.
 */
function lineFlags(command: string, words: readonly Span[]): LineFlags {
  const out: LineFlags = { cut: [], modes: [], bypass: false, denied: [], carriable: [], uncarriable: false };
  /**
   * The index of wmux's own prompt argument, or -1: the last word of exactly
   * its shape, and only when it names a fan-out prompt file. A task with no
   * prompt gets none, and a launcher's own word of that shape is then the last one.
   */
  let promptAt = -1;
  for (let k = words.length - 1; k > 0; k--) {
    const raw = command.slice(words[k].start, words[k].end);
    if (stripPromptFileArgument(raw) !== '') continue;
    if (WMUX_PROMPT_FILE.test(raw)) promptAt = k;
    break;
  }
  const deny = (word: Span, value: string): void => {
    const rules = toolRules(value);
    out.denied.push(...rules);
    const raw = command.slice(word.start, word.end);
    const escaped = raw.includes("''") || raw.includes('\\');
    for (const rule of rules) {
      if (!escaped && CARRIABLE_RULE.test(rule)) out.carriable.push(rule);
      else out.uncarriable = true;
    }
  };
  for (let k = 1; k < words.length; k++) {
    const v = words[k].value;
    const eq = v.indexOf('=');
    const flag = eq >= 0 ? v.slice(0, eq) : v;
    if (BARE_PERMISSION_FLAGS.has(v)) {
      out.cut.push(words[k]);
      out.bypass = true;
    } else if (VALUE_FLAGS.has(flag)) {
      const own = [words[k]];
      if (eq < 0 && k + 1 < words.length) own.push(words[++k]);
      out.modes.push({ words: own, value: eq >= 0 ? v.slice(eq + 1) : own[1]?.value ?? '' });
    } else if (LIST_FLAGS.has(flag)) {
      out.cut.push(words[k]);
      const denies = DENY_FLAGS.has(flag);
      if (eq >= 0) {
        if (denies) deny(words[k], v.slice(eq + 1));
        continue;
      }
      while (k + 1 < words.length && isToolRuleWord(words[k + 1].value)) {
        out.cut.push(words[++k]);
        if (denies) deny(words[k], words[k].value);
      }
      // claude's list flags are variadic: it reads every word up to the next
      // flag as a rule. The one word wmux puts there itself is the prompt
      // argument, exactly as promptFileArgument builds it (`"$(cat '…')"`,
      // `"$(Get-Content …)"`), appended after the whole launcher, so it is the
      // last word of that shape on the line. Any other word, a launcher's own
      // `"$(…)"` included (even one of the same shape), would be a deny wmux
      // cannot carry.
      const next = k + 1;
      if (denies && next < words.length && !words[next].value.startsWith('-') && next !== promptAt) out.uncarriable = true;
    }
  }
  return out;
}

/**
 * The tools a fan-out worker reports with (FANOUT_WORKER_ALLOWED_TOOLS) that
 * the deny list of a claude worker's line covers. Only a line wmux gave the
 * worker lists to counts (its own deny list is on it): a launcher's deny
 * stays on that line, so the worker may not be able to report.
 */
export function deniedWorkerReportTools(command: string): string[] {
  const { denied } = lineFlags(command, spans(command));
  if (!denied.includes(FANOUT_WORKER_DISALLOWED_TOOLS[0])) return [];
  return FANOUT_WORKER_ALLOWED_TOOLS.filter((tool) => denied.some((rule) => toolRuleCovers(rule, tool)));
}

/**
 * Why a launch line may not start in `mode`, or null when it may.
 *
 * `manual` must make the agent ask, and wmux knows how only for an agent whose
 * row declares it (`permissions` for Claude's permission mode, or `askMode`):
 * any other agent (or a wrapper wmux cannot see through) would run on its own
 * settings, so it is refused instead.
 *
 * A claude line's own deny rules are carried onto the worker's line
 * (applyWorkerPermissionFlags). One that cannot be quoted there is refused
 * rather than dropped, which would leave that tool allowed. The refusal does
 * not repeat the rule.
 */
export function workerModeRefusal(command: string, mode: FanoutWorkerPermissionMode): string | null {
  const words = spans(command);
  const stem = launcherStemOf(words);
  const row = rowOfStem(stem);
  if (mode === 'manual' && !(row?.permissions === 'permission-mode' || row?.askMode)) {
    return `the manual worker mode makes the agent ask before it acts, and wmux knows no flag that does that for ${stem ? `\`${stem}\`` : 'this launch line'}; it was not started. Choose another worker mode, or an agent it can make ask`;
  }
  if (workerLineKind(stem, mode).lists && lineFlags(command, words).uncarriable) {
    return 'the launch line denies a tool with a rule wmux cannot carry onto the worker\'s line (one that holds a quote, `$`, `!`, `%`, a backtick or a backslash, or a value that is no tool rule); it was not started, so that tool is not left allowed. Write the rule without those characters';
  }
  return null;
}

/**
 * How applyWorkerPermissionFlags treats a line with this launcher: `ask`, the
 * ask flags of a `manual` agent that declares them (manualOnLine); `lists`,
 * a claude line that gets the worker's permission flag and tool lists.
 * Anything else is left as it is.
 */
function workerLineKind(stem: string, mode: FanoutWorkerPermissionMode): { ask?: NonNullable<AgentIdentityRow['askMode']>; lists: boolean } {
  const ask = mode === 'manual' ? rowOfStem(stem)?.askMode : undefined;
  return { ask, lists: !ask && stem === 'claude' };
}

/** `line` without the words in `cut`, each with the whitespace in front of it; nothing else is re-spaced. */
function withoutWords(line: string, cut: readonly Span[]): string {
  // Cut from the end so earlier offsets stay valid.
  for (const w of [...cut].sort((a, b) => b.start - a.start)) {
    let from = w.start;
    while (from > 0 && /\s/.test(line[from - 1])) from--;
    line = line.slice(0, from) + line.slice(w.end);
  }
  return line;
}

/**
 * A line in `manual` for an agent whose row declares `askMode`: every
 * permission choice its `replaces` names (the unattended flags an agent
 * choice added among them) is taken off, and its ask flags go right after
 * the launcher, ahead of the prompt (anything after it is read as part of
 * the prompt).
 */
function manualOnLine(command: string, words: readonly Span[], ask: NonNullable<AgentIdentityRow['askMode']>): string {
  const values = words.slice(1).map((w) => w.value);
  const cut = permissionChoiceIndexes(
    { permissionFlags: ask.replaces.flags, permissionSwitches: ask.replaces.switches ?? [], ...(ask.replaces.config ? { permissionConfig: ask.replaces.config } : {}) },
    values,
  );
  const line = withoutWords(command, cut.map((i) => words[i + 1]));
  const launcher = words[0];
  return `${line.slice(0, launcher.end)} ${ask.flags}${line.slice(launcher.end)}`;
}

/**
 * Append the worker's permission flag and tool lists to a launch line.
 *
 * Only a `claude` launch is touched, and in `manual` one whose agent row declares `askMode` (manualOnLine)
 * — a role binding may have swapped the agent
 * to one that rejects these flags, and a wrapper (`env …`, `sh -c …`) is left
 * alone because wmux cannot see which word is the launcher. Everything goes
 * AFTER what is already on the line, i.e. after the prompt argument: the list
 * flags are variadic, so before the prompt they would swallow it as a tool
 * name. Each list is ONE quoted comma-separated word (the documented form), so
 * a list ends at the next flag and PowerShell does not read the commas as an
 * array; `*` inside the quotes is not globbed.
 *
 * Any permission or tool-list flag already on the line (a role binding's args,
 * a typed agentCmd) is removed first so the setting is the one that applies.
 * The line's own deny rules are the exception: they join wmux's deny list, so
 * a tool the launcher denied stays denied for its workers (a deny only
 * narrows; its allow list and permission mode are still replaced). A rule
 * that cannot be quoted there is refused by workerModeRefusal first.
 * Removal is word-based: a flag spelled inside a quoted argument (a prompt, an
 * --append-system-prompt value) is part of that word and is never matched.
 * The tool lists are applied in every mode. `extraDisallowed` adds deny rules to
 * the same list (the goal worker profile); a non-claude line gets none of
 * this, which is why a goal refuses non-claude workers outright.
 */
export function applyWorkerPermissionFlags(
  command: string,
  mode: FanoutWorkerPermissionMode,
  extraDisallowed: readonly string[] = [],
): string {
  const words = spans(command);
  const { ask, lists } = workerLineKind(launcherStemOf(words), mode);
  if (ask) return manualOnLine(command, words, ask);
  if (!lists) return command;

  const { cut, modes, bypass, carriable } = lineFlags(command, words);
  // Manual keeps a mode of the line's own that already asks (a resumed `plan` worker stays in plan); any other mode,
  // or one beside a bypass, gives way to the worker's.
  const keep = mode === 'manual' && !bypass && modes.length > 0 && modes.every((m) => ASKING_CLAUDE_MODES.has(m.value));
  if (!keep) for (const m of modes) cut.push(...m.words);
  // Never written unquotable: such a line does not launch (workerModeRefusal).
  return `${withoutWords(command, cut)} ${launchFlags(keep ? '' : PERMISSION_FLAG_FOR_WORKER[mode], [...extraDisallowed, ...carriable])}`;
}
