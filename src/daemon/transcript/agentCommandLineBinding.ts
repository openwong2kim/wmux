// Bind a pane to the exact conversation its agent's command line names.
//
// A person who types `claude --resume <uuid>` or `codex resume <uuid>` in a
// pane, and a fresh Claude that wmux pinned with `--session-id <uuid>`, name
// the conversation on the agent's own command line. Read it from the process
// table on the agent's launch edge, so the pane holds its exact id without
// waiting for a hook (Codex has none; its notify arrives only when a turn ends,
// and its cwd binder only adopts threads STARTED after the launch, so an old
// thread resumed by hand never bound — #1891).
//
// It never guesses: only an id written on the command line counts. `--last`,
// `--continue` and the bare session pickers name no id and are skipped. A
// resumed id binds only when its transcript is on disk now (exact-id lookup,
// containment-checked); a pinned fresh id binds without a path, like a
// SessionStart, and transcript discovery adopts the file once it exists.

import type { ResumeBinding } from '../../shared/agentResume';
import { resumeGrammarFor } from '../../shared/agentResume';
import { agentRow } from '../../shared/agentIdentity';
import fs from 'node:fs';
import { checkNativeTranscriptPath } from './providers';
import { findCodexTranscriptCandidates, scanForTranscript, type ScanReport } from './TranscriptDiscovery';
import { findQwenTranscriptCandidates } from './qwenTranscript';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** What an agent's command line says about its conversation. */
export interface CommandLineSession {
  sessionId: string;
  /** `resume`: an existing conversation. `pin`: a new one started under this id. */
  kind: 'resume' | 'pin';
}

/** One command-line word; `quoted` when any part of it sat inside double quotes. */
interface Word {
  value: string;
  quoted: boolean;
}

/**
 * Words of a process command line. Double quotes group (Windows keeps them in
 * `Win32_Process.CommandLine`, the CommandLineToArgvW convention); a single
 * quote is an ordinary character there, so it is too here. A quoted word is
 * never a flag, a subcommand or an id: it is a prompt or a path.
 *
 * On macOS and Linux `ps` joins argv with spaces, so quoting is already lost
 * and `claude -- '--resume <uuid>'` reads as `claude -- --resume <uuid>`. What
 * keeps a prompt from naming the conversation there: the id is taken only from
 * its canonical position (among the leading options, or right after the
 * `resume` subcommand), scanning stops at an unquoted `--`, and a resumed id
 * binds only when its transcript exists.
 */
function words(cmdline: string): Word[] {
  const out: Word[] = [];
  let value = '';
  let quoted = false;
  let inQuote = false;
  let started = false;
  for (const ch of cmdline) {
    if (ch === '"') { inQuote = !inQuote; quoted = true; started = true; continue; }
    if (!inQuote && (ch === ' ' || ch === '\t')) {
      if (started) out.push({ value, quoted });
      value = ''; quoted = false; started = false;
      continue;
    }
    value += ch; started = true;
  }
  if (started) out.push({ value, quoted });
  return out;
}

/** `C:\…\node.exe` → `node`, `/…/codex.js` → `codex`. */
function stemOf(word: string): string {
  return (word.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/, '');
}

/** Script runtimes: their script argument, not argv[0], is the agent. */
const RUNTIMES: ReadonlySet<string> = new Set(['node', 'bun', 'deno']);

/**
 * Index of the agent's own word: argv[0] (the process the tracker attributed
 * to the agent), or, under a script runtime, the script, which must be the
 * agent's (`…/codex.js`, `…/node_modules/@anthropic-ai/claude-code/cli.js`).
 */
function launcherIndex(argv: readonly Word[], agent: string): number {
  if (argv.length === 0) return -1;
  if (!RUNTIMES.has(stemOf(argv[0].value))) return 0;
  const i = argv.findIndex((w, k) => k > 0 && (w.quoted || !w.value.startsWith('-')));
  if (i < 0) return -1;
  const script = argv[i].value.replace(/\\/g, '/').toLowerCase();
  const packages = agentRow(agent)?.process?.packages ?? [];
  return stemOf(script) === agent || packages.some((pkg) => script.includes(`/node_modules/${pkg.toLowerCase()}/`)) ? i : -1;
}

/** How many values an option takes: 1, or 'many' (up to the next option). Unknown options take none. */
type Arity = 1 | 'many';
interface OptionTable {
  readonly options: ReadonlyMap<string, Arity>;
}

/** Each agent's options that take values (from its `--help`). An option not
 *  listed is read as a switch; a value it really takes then reads as the first
 *  positional, which ends the scan, so a gap here fails closed. */
const OPTIONS: Readonly<Record<string, OptionTable>> = {
  claude: {
    options: new Map<string, Arity>([
      ...['--model', '--fallback-model', '--settings', '--setting-sources', '--permission-mode', '--append-system-prompt',
        '--system-prompt', '--system-prompt-file', '--append-system-prompt-file', '--output-format', '--input-format',
        '--max-turns', '--max-budget-usd', '--agent', '--agents', '--json-schema', '--permission-prompt-tool', '--name',
        '--from-pr', '--session-id'].map((o) => [o, 1 as Arity] as const),
      ...['--add-dir', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--mcp-config',
        '--betas', '--plugin-dir', '--tools', '--file'].map((o) => [o, 'many' as Arity] as const),
    ]),
  },
  codex: {
    options: new Map<string, Arity>([
      ...['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval',
        '--enable', '--disable', '--remote', '--remote-auth-token-env', '--local-provider', '--add-dir'].map((o) => [o, 1 as Arity] as const),
      ...['-i', '--image'].map((o) => [o, 'many' as Arity] as const),
    ]),
  },
  // Qwen Code's value options (packages/cli/src/config/top-level-options.ts).
  qwen: {
    options: new Map<string, Arity>([
      ...['-m', '--model', '--advisor', '-p', '--prompt', '-i', '--prompt-interactive', '--system-prompt', '--append-system-prompt',
        '--output-style', '-s', '--sandbox', '--sandbox-image', '--approval-mode', '--channel', '--mcp-config', '--openai-logging-dir',
        '--openai-api-key', '--openai-base-url', '--input-format', '-o', '--output-format', '--json-fd', '--json-file', '--json-schema',
        '--input-file', '--session-id', '--worktree', '--max-session-turns', '--max-wall-time', '--max-tool-calls', '--max-subagent-depth',
        '--auth-type', '--telemetry-target', '--telemetry-otlp-endpoint', '--telemetry-otlp-protocol', '--telemetry-outfile', '--proxy',
      ].map((o) => [o, 1 as Arity] as const),
      ...['--fallback-model', '--allowed-mcp-server-names', '--disable-mcp-server', '--allowed-tools', '-e', '--extensions',
        '--include-directories', '--add-dir', '--core-tools', '--exclude-tools', '--disabled-slash-commands',
      ].map((o) => [o, 'many' as Arity] as const),
    ]),
  },
};

/** The index just past option `argv[i]` and its values. */
function skipOption(argv: readonly Word[], i: number, table: OptionTable | undefined): number {
  const name = argv[i].value;
  if (name.includes('=')) return i + 1;
  const arity = table?.options.get(name);
  if (arity === 1) return i + 2;
  if (arity === 'many') {
    let j = i + 1;
    while (j < argv.length && (argv[j].quoted || !argv[j].value.startsWith('-'))) j++;
    return j;
  }
  return i + 1;
}

const isOption = (w: Word | undefined): boolean => !!w && !w.quoted && w.value.startsWith('-') && w.value !== '--';
const uuidOf = (w: Word | undefined): string | undefined =>
  w && !w.quoted && UUID.test(w.value) ? w.value.toLowerCase() : undefined;

/** An `--opt <uuid>` / `--opt=<uuid>` value at `argv[i]`, or undefined. */
function inlineOrNext(argv: readonly Word[], i: number, flag: string): string | undefined {
  const w = argv[i];
  if (w.value.startsWith(`${flag}=`)) {
    const v = w.value.slice(flag.length + 1);
    return UUID.test(v) ? v.toLowerCase() : undefined;
  }
  return w.value === flag ? uuidOf(argv[i + 1]) : undefined;
}

/**
 * Flag form (Claude): read the leading options up to the first positional (the
 * prompt), an unquoted `--`, or the end. Only there does `--resume <uuid>`
 * resume and the pin flag (`--session-id <uuid>`) pin. A pin wins: with
 * `--fork-session` it is the new conversation's id, and a fresh launch has
 * nothing else. `--fork-session` without a pin starts an id the line does not
 * name, so it names nothing.
 */
function flagFormSession(argv: readonly Word[], from: number, resumeFlag: string, pin: string | undefined, table: OptionTable | undefined): CommandLineSession | undefined {
  let resumed: string | undefined;
  let pinned: string | undefined;
  let fork = false;
  let i = from;
  while (i < argv.length && isOption(argv[i])) {
    const name = argv[i].value;
    if (name === resumeFlag || name.startsWith(`${resumeFlag}=`)) {
      resumed ??= inlineOrNext(argv, i, resumeFlag);
      // `--resume <term>` opens the picker on a search term: the term is its value.
      i += name === resumeFlag && argv[i + 1] && !isOption(argv[i + 1]) && argv[i + 1].value !== '--' && !argv[i + 1].quoted ? 2 : 1;
      continue;
    }
    if (pin && (name === pin || name.startsWith(`${pin}=`))) pinned ??= inlineOrNext(argv, i, pin);
    if (name === '--fork-session') fork = true;
    i = skipOption(argv, i, table);
  }
  if (pinned) return { sessionId: pinned, kind: 'pin' };
  if (fork || !resumed) return undefined;
  return { sessionId: resumed, kind: 'resume' };
}

/**
 * Subcommand form (Codex): skip the global options (with their values), the
 * first positional must be the unquoted subcommand (`resume`), then skip its
 * options; the first positional after them is the id. `--last` names none, and
 * so does an unquoted `--` before the id.
 */
function subcommandFormSession(argv: readonly Word[], from: number, subcommand: string, table: OptionTable | undefined): CommandLineSession | undefined {
  let i = from;
  while (i < argv.length && isOption(argv[i])) i = skipOption(argv, i, table);
  const sub = argv[i];
  if (!sub || sub.quoted || sub.value !== subcommand) return undefined;
  i++;
  while (i < argv.length && isOption(argv[i])) {
    if (argv[i].value === '--last') return undefined;
    i = skipOption(argv, i, table);
  }
  const id = uuidOf(argv[i]);
  return id ? { sessionId: id, kind: 'resume' } : undefined;
}

/**
 * The conversation id `cmdline` names for `agent` (a registry slug), or
 * undefined when it names none. The agent's word is argv[0], or the script a
 * runtime runs (`node …/codex.js`). Grammar comes from the registry row:
 *   - flag form (Claude `--resume {id}`), see flagFormSession;
 *   - subcommand form (Codex `resume {id}`), see subcommandFormSession.
 * Pure — exported for tests.
 */
export function sessionFromCommandLine(agent: string, cmdline: string | undefined): CommandLineSession | undefined {
  const grammar = resumeGrammarFor(agent);
  // A picker-only agent's ids are never bound (agentIdentity.ts `idFormat`).
  if (!grammar || !cmdline || agentRow(agent)?.resume?.idFormat === 'picker-only') return undefined;
  const argv = words(cmdline);
  const launcher = launcherIndex(argv, agent);
  if (launcher < 0) return undefined;
  const table = Object.hasOwn(OPTIONS, agent) ? OPTIONS[agent] : undefined;
  const [head] = grammar.withId('{id}').split(' ');
  return head.startsWith('-')
    ? flagFormSession(argv, launcher + 1, head, grammar.pin, table)
    : subcommandFormSession(argv, launcher + 1, head, table);
}

/**
 * Whether a live Claude process was launched in bypass: among its leading
 * options (up to the first positional, an unquoted `--`, or the end), the last
 * of `--dangerously-skip-permissions` / `--permission-mode <mode>` starts it in
 * `bypassPermissions`. Everything else, an unreadable line included, says no.
 * Pure — exported for tests.
 */
export function claudeLaunchedInBypass(cmdline: string | undefined): boolean {
  if (!cmdline) return false;
  const argv = words(cmdline);
  const launcher = launcherIndex(argv, 'claude');
  if (launcher < 0) return false;
  const table = OPTIONS.claude;
  let bypass = false;
  for (let i = launcher + 1; i < argv.length && isOption(argv[i]);) {
    const w = argv[i].value;
    if (w === '--dangerously-skip-permissions') bypass = true;
    else if (w.startsWith('--permission-mode=')) bypass = w.slice('--permission-mode='.length) === 'bypassPermissions';
    else if (w === '--permission-mode') bypass = !argv[i + 1]?.quoted && argv[i + 1]?.value === 'bypassPermissions';
    i = skipOption(argv, i, table);
  }
  return bypass;
}

/** A pane's agent process as its command line was read: pid, start time, and whether it is a Claude launched in bypass. */
export interface AgentLaunchFact {
  readonly pid: number;
  readonly startedAt?: number;
  readonly bypass: boolean;
}

/**
 * A pane runs a Claude that bypasses permissions right now: its live tracked
 * process is the one whose command line was read, that line started it in
 * bypass, and the newest binding captured since that launch still reports
 * bypass (a `/permissions` switch, or a conversation resumed without the
 * flag, says no). An unknown start time, a WSL pane (its line is never read)
 * or a dead process says no. Pure — exported for tests.
 */
export function paneRunsBypassClaude(
  fact: AgentLaunchFact | undefined,
  tracked: { alive?: boolean; slug?: string } | undefined,
  livePid: number | undefined,
  binding: ResumeBinding | undefined,
): boolean {
  if (!tracked?.alive || tracked.slug !== 'claude') return false;
  if (!fact?.bypass || fact.startedAt === undefined || fact.pid !== livePid) return false;
  return binding?.agent === 'claude' && binding.permissionMode === 'bypassPermissions' && binding.ts >= fact.startedAt;
}

/** How far ahead of the daemon's clock a captured resume binding may be dated. */
export const RESUME_BINDING_TS_SKEW_MS = 5_000;

/**
 * A captured binding is never dated ahead of the daemon's clock (beyond a small
 * skew): a far-future ts would make every later real capture look stale and
 * pin this binding, its permission mode included. Pure — exported for tests.
 */
export function withCaptureTsNotAhead(binding: ResumeBinding, now: number): ResumeBinding {
  return typeof binding.ts === 'number' && binding.ts > now + RESUME_BINDING_TS_SKEW_MS ? { ...binding, ts: now } : binding;
}

/** Exact-id transcript candidates, per agent with a file transcript; `report` says whether "none" is certain. */
const CANDIDATES: Readonly<Record<string, (id: string, env: Record<string, string> | undefined, report: ScanReport) => string[]>> = {
  claude: (id, env, report) => scanForTranscript(id, env, report),
  codex: (id, env, report) => findCodexTranscriptCandidates(id, env, report),
  qwen: (id, env, report) => findQwenTranscriptCandidates(id, env, report),
};

/** A transcript that holds a conversation: a non-empty file. An empty one is
 *  what an agent leaves before its first record, and resuming it finds nothing. */
function holdsConversation(file: string): boolean {
  try { return fs.statSync(file).size > 0; } catch { return false; }
}

/**
 * The transcript `id` names for `agent`: `file` when exactly one contained,
 * non-empty one exists; otherwise `certain` says whether the lookup proves
 * there is none (a scan cut short by its bounds, an unreadable folder or
 * duplicate copies prove nothing, so more than one contained copy binds none).
 */
function findTranscript(agent: string, id: string, env?: Record<string, string>): { file?: string; certain: boolean } {
  const report: ScanReport = { complete: true };
  const contained = CANDIDATES[agent](id, env, report).filter((f) => checkNativeTranscriptPath(agent, f, id, env).ok);
  if (contained.length > 1) return { certain: false };
  const file = contained[0];
  if (file && holdsConversation(file)) return { file, certain: true };
  // A contained file that is empty, or one outside the account, is not a conversation either.
  return { certain: report.complete || file !== undefined };
}

/**
 * Settle a binding whose agent has stopped (every agent of a recovered pane
 * has). A binding recorded before its conversation was written carries no
 * transcript path: a pinned `--session-id`, or a SessionStart without one. Its
 * id names a conversation only if the agent wrote one before it stopped, and a
 * stopped agent writes nothing more. Returns the binding with the transcript
 * its id names, or `null` when there is none: `--resume <id>` would answer "No
 * conversation found", so the pane offers the session picker instead. An
 * empty transcript counts as none. A binding that already has a path, whose
 * agent keeps no file transcript, or whose lookup could not finish (see
 * findTranscript), is returned unchanged.
 */
export function settleStoppedBinding(binding: ResumeBinding, env?: Record<string, string>): ResumeBinding | null {
  if (binding.transcriptPath || !Object.hasOwn(CANDIDATES, binding.agent)) return binding;
  const found = findTranscript(binding.agent, binding.sessionId, env);
  if (found.file) return { ...binding, transcriptPath: found.file };
  // Dropped only when absence is certain: a scan its bounds cut short keeps the binding.
  return found.certain ? null : binding;
}

/**
 * The binding `cmdline` proves for a pane whose agent runs in `cwd`, or
 * undefined. A resumed id must have its transcript on disk now; a pinned id
 * binds without one (its transcript is written on the first turn).
 *
 * Hooks, the Codex relay and notify are authoritative and win over the command
 * line: the binding is stamped with the agent's launch time (`launchAt`), so
 * any of them captured during this run is newer and the stale-capture guard in
 * the daemon's writer keeps it, and a later one replaces this. A pane that
 * already holds a binding from this run (`prev.ts >= launchAt`) is left alone,
 * and so is one holding any binding when the launch time is unknown.
 */
export function commandLineBinding(
  agent: string,
  cmdline: string | undefined,
  cwd: string,
  env?: Record<string, string>,
  order: { launchAt?: number; prev?: ResumeBinding; now?: number } = {},
): ResumeBinding | undefined {
  const { launchAt, prev } = order;
  if (prev && (launchAt === undefined || prev.ts >= launchAt)) return undefined;
  const found = sessionFromCommandLine(agent, cmdline);
  if (!found || !cwd || !Object.hasOwn(CANDIDATES, agent)) return undefined;
  const transcriptPath = findTranscript(agent, found.sessionId, env).file;
  if (!transcriptPath && found.kind === 'resume') return undefined;
  return { agent, sessionId: found.sessionId, cwd, ...(transcriptPath ? { transcriptPath } : {}), ts: launchAt ?? order.now ?? Date.now() };
}
