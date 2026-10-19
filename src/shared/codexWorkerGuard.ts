// ─── The Codex bot-worker guard's pure parts ────────────────────────────────
//
// The Codex twin of shared/botWorkerGuard.ts. A codex worker a bot started
// launches only on a line main rebuilt from an allowlist, with Codex's own
// command rules (execpolicy) refusing what the Claude worker settings refuse:
// a merge (`gh pr merge`, `gh api`), every `git push` (main pushes the task
// branch, `task.push`), the git settings that redirect a push, and the public
// `gh` acts that go to the owner as approvals. The rules are a Starlark file
// main writes into the worktree's project layer
// (`<worktree>/.codex/rules/wmux-bot-worker.rules`, CODEX_WORKER_RULES_PATH);
// main/agents/codexWorkerGuard.ts writes it, checks the folder and proves the
// rules load before the launch.
//
// Codex rules match a command's leading words (a prefix, with alternatives
// per word, no wildcards), so the rules forbid whole option families before a
// verb rather than spellings of one value, and `gh api` entirely.
//
// The launch: `-a never -s workspace-write`, network on, and as the only
// extra writable roots what a commit writes (codexWorkerWritableRoots): the
// worktree's own git folder and the repository's objects, refs and logs —
// never the repository's config, hooks or info, which the owner's checkout
// and main's git read.
// Under `-a never` codex refuses every MCP tool call it would ask about. The
// line sets the wmux server's default to ask (so: refused), approves exactly
// the wmux tools a Claude bot worker may call (every tool its
// --disallowedTools does not name, FANOUT_WORKER_DISALLOWED_TOOLS), and sets
// every tool that list names, and every other one the owner's codex config
// approves, back to ask. The owner's own codex settings therefore never give
// a bot worker a wmux tool a Claude worker is denied (measured on codex-cli
// 0.162.1: a `-c` table merges into the config's, key by key).
// The project `.codex/` folder stays read-only to the worker in that sandbox,
// so it cannot change the rules its session loaded, and Codex reads them once,
// when the session starts (both measured on codex-cli 0.162.1).
//
// Threat model: an intent guard against a confused or misdirected model, not
// isolation. A worker runs as the owner's user; a script, an interpreter or a
// command the rules do not match can still reach the same effects.

import path from 'node:path';
import { isPlausibleResumeSessionId, launcherStem, tokenize } from './agentResume';
import { EFFORT_TOKEN_RE } from './agentLaunchOptions';
import { FANOUT_MODEL_RE, codexTrustOverride } from './fanoutPreset';
import { ORCH_ROLES, ROLE_BINDING_MODEL_MAX, type OrchRole, type WmuxTools } from './orchestratorRole';
import { ROLE_MODE_ARG_PREFIX, toolSurfaceShellFlags } from './roleSurfaces';
import { stripPromptFileArgument } from './promptFileArgument';
import { BROWSER_TOOL_SURFACE, CORE_TOOL_SURFACE } from './coreSurface';
import { UNLISTED_TOOLS } from './unlistedTools';
import { FANOUT_WORKER_DISALLOWED_TOOLS, splitModelEnvMarker } from './workerLaunch';
import type { Connector } from './botConnector';
import { CONNECTOR_NPM_REGISTRY } from './botWorkerMcp';

/** The rules file, relative to the worktree. */
export const CODEX_WORKER_RULES_PATH = '.codex/rules/wmux-bot-worker.rules';
/** The anchored line main adds to the repository's `info/exclude`. */
export const CODEX_WORKER_EXCLUDE_LINE = `/${CODEX_WORKER_RULES_PATH}`;
/** Every rule's justification starts with this (the model reads it). */
export const CODEX_WORKER_JUSTIFICATION_PREFIX = 'wmux bot worker:';
/** The oldest codex-cli the guard was measured on. */
export const CODEX_WORKER_MIN_VERSION = '0.162.1';

/** gh groups and the verbs that write (same intent as BOT_WORKER_PUBLIC_DENY
 *  plus the merge). */
const GH_WRITE_VERBS: Readonly<Record<string, readonly string[]>> = {
  pr: ['merge', 'comment', 'review', 'close', 'reopen', 'edit', 'lock', 'unlock'],
  issue: ['create', 'close', 'comment', 'delete', 'reopen', 'edit', 'transfer', 'lock', 'unlock', 'pin', 'unpin'],
  release: ['create', 'edit', 'delete', 'upload', 'delete-asset'],
  repo: ['create', 'edit', 'delete', 'rename', 'archive', 'unarchive', 'sync'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
  alias: ['set', 'import'],
};
/** gh options that take a value, spelled as their own word. */
const GH_VALUE_OPTIONS = ['-R', '--repo', '--hostname'];
/** git options before the command that take a value or change where git
 *  runs, spelled as their own word. */
const GIT_GLOBAL_OPTIONS = [
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix',
  '-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch', '--no-advice',
];

export interface CodexWorkerRulesInput {
  /** The bot repository's key (`owner/repo` or `host/owner/repo`), when known:
   *  its one-word `--repo=<key>` spellings are refused too. */
  repoKey?: string;
  /** The worktree and its git folders: their one-word `--git-dir=` /
   *  `--work-tree=` spellings are refused too. */
  cwd: string;
  gitDirs: readonly string[];
}

/** The repository's one-word spellings for gh (`--repo=<k>`, `-R<k>`). Pure. */
function repoOptionWords(repoKey: string | undefined): string[] {
  if (!repoKey) return [];
  const parts = repoKey.split('/');
  const short = parts.length === 3 ? parts.slice(1).join('/') : repoKey;
  const host = parts.length === 3 ? parts[0] : 'github.com';
  const keys = [...new Set([short, `${host}/${short}`, `https://${host}/${short}`])];
  return keys.flatMap((k) => [`--repo=${k}`, `-R${k}`]);
}

/** The rules document. Pure. */
export function buildCodexWorkerRules(input: CodexWorkerRulesInput): string {
  const rules: { pattern: (string | string[])[]; why: string }[] = [];
  const forbid = (pattern: (string | string[])[], why: string): void => { rules.push({ pattern, why }); };
  const repoWords = repoOptionWords(input.repoKey);
  for (const [group, verbs] of Object.entries(GH_WRITE_VERBS)) {
    forbid(['gh', group, [...verbs]], group === 'pr'
      ? 'a merge goes through the merge lane, and pull request writes go to the owner as approvals'
      : `gh ${group} writes go to the owner as approvals`);
    forbid(['gh', group, [...GH_VALUE_OPTIONS, ...repoWords]], `name the gh ${group} command first, options after it`);
  }
  forbid(['gh', [...GH_VALUE_OPTIONS, ...repoWords]], 'name the gh command first, options after it');
  forbid(['gh', 'api'], 'gh api is not available; read with gh pr view / gh issue view');
  forbid(['git', 'push'], 'wmux pushes your task branch: use the task_push tool');
  forbid(['git', ['send-pack', 'http-push']], 'wmux pushes your task branch: use the task_push tool');
  forbid(['git', 'remote', ['set-url', 'add', 'rename', 'remove', 'rm']], 'the remotes are not yours to change');
  forbid(['git', 'config'], 'git config is not available to a bot worker');
  const pathWords = [`--work-tree=${input.cwd}`, ...input.gitDirs.map((d) => `--git-dir=${d}`)];
  forbid(['git', [...GIT_GLOBAL_OPTIONS, ...pathWords]], 'run git from your worktree, command first');
  const word = (t: string): string => JSON.stringify(t);
  const pattern = (p: (string | string[])[]): string => `[${p.map((t) => (Array.isArray(t) ? `[${t.map(word).join(', ')}]` : word(t))).join(', ')}]`;
  const body = rules
    .map((r) => `prefix_rule(pattern=${pattern(r.pattern)}, decision="forbidden", justification=${word(`${CODEX_WORKER_JUSTIFICATION_PREFIX} ${r.why}`)})`)
    .join('\n');
  return `# Written by wmux for a bot's fan-out worker. Rewritten before every launch.\n${body}\n`;
}

/** Does the line start codex anywhere: as a word, a path's last part, or
 *  right next to a shell operator (`codex;…`, `x&&codex`)? Over-matching is
 *  the safe side (the line is refused). Pure. */
export function namesCodex(line: string): boolean {
  return /(?:^|[\s;&|()`'"/=])codex(?:\.(?:exe|cmd|bat|ps1))?(?=$|[\s;&|()`'"<>])/i.test(line);
}

/** A path the guard writes into a shell word and a TOML string: absolute,
 *  no quote, backslash, `$`, backtick or control character. Pure. */
export function isGuardablePath(p: string): boolean {
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  return p.startsWith('/') && !/['"`$\\\u0000-\u001f\u007f]/.test(p);
}

/** What a bot's worker on `agent` is told about its rules, one line (or ''):
 *  a codex worker, what its rules leave out. Pure. */
export function botWorkerAgentPromptNote(agent: string | undefined): string {
  return agent === 'codex'
    ? '- `gh api` and `git config` are not available to you: read a pull request or an issue with `gh pr view` / `gh issue view`, and run git and gh with the command first, options after it.\n'
    : '';
}

/** Is this a codex line (its first word launches codex)? Pure. */
export function launchesCodex(line: string | undefined): boolean {
  if (!line) return false;
  const first = tokenize(splitModelEnvMarker(line).command)[0];
  return !!first && launcherStem(first.value) === 'codex';
}

/** The parts of an accepted codex worker line. */
export interface CodexWorkerLine {
  model?: string;
  effort?: string;
  /** The wmux tool level the line asked for (`-c mcp_servers.wmux…`): only
   *  the level is kept; main writes the server's arguments itself. */
  wmuxTools?: CodexWorkerToolLevel;
  /** `codex resume <id>`: the conversation to resume (session lines only). */
  resumeId?: string;
  /** The prompt-file argument, verbatim; '' for a resume without one. */
  promptArgument: string;
}

/** A wmux tool level: off, or the server at a level roleSurfaces names. */
export type CodexWorkerToolLevel = { off: true } | { tools: WmuxTools; role?: OrchRole };

/** `mcp_servers.wmux.enabled=false` or `mcp_servers.wmux.args=['<entry>'…]`,
 *  the two shapes roleSurfaces.toolSurfaceShellFlags writes, read as a level:
 *  the entry is never kept (main names its own). Null for any other
 *  argument list. Pure. */
export function parseCodexToolLevel(value: string): CodexWorkerToolLevel | null {
  if (value === 'mcp_servers.wmux.enabled=false') return { off: true };
  const m = /^mcp_servers\.wmux\.args=\[((?:'[^'\s"`$\\]*',)*'[^'\s"`$\\]*')\]$/.exec(value);
  if (!m) return null;
  const rest = m[1].split(',').map((a) => a.slice(1, -1)).slice(1);
  if (rest.length === 0) return { tools: 'full' };
  if (rest.length > 1) return null;
  if (rest[0] === '--core') return { tools: 'core' };
  const role = rest[0].startsWith(ROLE_MODE_ARG_PREFIX) ? rest[0].slice(ROLE_MODE_ARG_PREFIX.length) : '';
  return (ORCH_ROLES as readonly string[]).includes(role) ? { tools: 'role', role: role as OrchRole } : null;
}

/** The `-c` word for a level, with main's own MCP entry; null when it cannot
 *  be written. Pure. */
function codexToolLevelWord(level: CodexWorkerToolLevel, entry: string | undefined): string | null {
  if ('off' in level) return '-c mcp_servers.wmux.enabled=false';
  if (!entry) return null;
  return toolSurfaceShellFlags('codex', level.tools, entry, level.role, '');
}

/** Is `tool` (a wmux tool name) one a Claude bot worker's --disallowedTools
 *  names, as `mcp__wmux__<tool>` or a `*` family? Pure. */
function claudeWorkerDisallows(tool: string): boolean {
  return FANOUT_WORKER_DISALLOWED_TOOLS.some((rule) => {
    const name = rule.replace(/^mcp__wmux__/, '');
    return name.endsWith('*') ? tool.startsWith(name.slice(0, -1)) : tool === name;
  });
}

/** The wmux tools that run code in the wmux MCP server (the `repl_` family).
 *  That server is codex's child outside codex's sandbox, so a codex worker is
 *  refused them; a Claude worker keeps them, since its own shell runs outside
 *  any sandbox already and they give it nothing it does not have. */
function runsCodeInServer(tool: string): boolean {
  return tool.startsWith('repl_');
}

/** Every wmux tool the server registers: listed and unlisted, browser included. */
const WMUX_TOOLS: readonly string[] = [...new Set([...CORE_TOOL_SURFACE, ...BROWSER_TOOL_SURFACE, ...UNLISTED_TOOLS])];
/** The wmux tools a codex bot worker runs without a prompt: those a Claude
 *  bot worker may call, less those that run code outside codex's sandbox. */
export const CODEX_WORKER_APPROVED_TOOLS: readonly string[] = WMUX_TOOLS.filter((t) => !claudeWorkerDisallows(t) && !runsCodeInServer(t));
/** The wmux tools a codex bot worker is refused: every other one. */
export const CODEX_WORKER_REFUSED_TOOLS: readonly string[] = WMUX_TOOLS.filter((t) => claudeWorkerDisallows(t) || runsCodeInServer(t));
/** A tool name a `-c` table can name as a bare TOML key. */
const TOOL_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Can a codex launch line override `name`'s approval? Pure. */
export function isCodexToolKey(name: string): boolean {
  return TOOL_KEY.test(name);
}
const DEFAULT_ASK_VALUE = 'mcp_servers.wmux.default_tools_approval_mode=prompt';
const TOOL_TABLE_VALUE = /^mcp_servers\.wmux\.tools=\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}$/;
const TOOL_ENTRY = /^([A-Za-z0-9_-]{1,64})=\{approval_mode="(approve|prompt)"\}$/;

/**
 * The `-c` words that set a codex bot worker's wmux tool approvals: the
 * server default to ask, CODEX_WORKER_APPROVED_TOOLS approved, and
 * CODEX_WORKER_REFUSED_TOOLS plus `ownerApproved` (the tools the codex config
 * approves) that are not in the approved list back to ask. Pure.
 */
export function codexWorkerToolApprovals(ownerApproved: readonly string[] = []): string[] {
  const ask = [...new Set([...CODEX_WORKER_REFUSED_TOOLS, ...ownerApproved.filter((t) => TOOL_KEY.test(t) && !CODEX_WORKER_APPROVED_TOOLS.includes(t))])];
  const table = [
    ...CODEX_WORKER_APPROVED_TOOLS.map((t) => `${t}={approval_mode="approve"}`),
    ...ask.map((t) => `${t}={approval_mode="prompt"}`),
  ].join(',');
  return [`-c ${DEFAULT_ASK_VALUE}`, `-c ${shellWord(`mcp_servers.wmux.tools={${table}}`)}`];
}

/** A tool table codexWorkerToolApprovals writes: each entry once, and
 *  `approve` only for an approved tool. Pure. */
function isWorkerToolTable(value: string): boolean {
  const m = TOOL_TABLE_VALUE.exec(value);
  if (!m) return false;
  const seen = new Set<string>();
  for (const entry of m[1].split(',')) {
    const e = TOOL_ENTRY.exec(entry);
    if (!e || seen.has(e[1])) return false;
    if (e[2] === 'approve' && !CODEX_WORKER_APPROVED_TOOLS.includes(e[1])) return false;
    seen.add(e[1]);
  }
  return true;
}

// ── A codex worker's MCP servers: wmux and its task's connections only ──────
//
// The Codex twin of shared/botWorkerMcp.ts, measured on codex-cli 0.162.1:
//  - `-c mcp_servers.<k>.enabled=false` turns an owner's server off; an
//    override of a server the config does not define stops codex at startup,
//    so only the servers the config names are turned off;
//  - `features.apps=false` drops the ChatGPT apps server (`codex_apps`, 265
//    tools on a signed-in account, GitHub writes among them) and
//    `features.plugins=false` the plugins;
//  - a `-c mcp_servers.<n>={...}` table MERGES with a config table of the same
//    name (the owner's `env` reached our server), so a connection named like an
//    owner server is refused;
//  - a server's environment is a short default set (PATH and HOME kept) plus
//    its `env` table and the variables `env_vars` names: a key goes by name;
//  - `bearer_token_env_var` sends `Authorization: Bearer <value>`,
//    `env_http_headers` a header's raw value;
//  - `enabled_tools` exposes only the tools it lists, `disabled_tools` hides
//    the ones it lists, and `default_tools_approval_mode="approve"` runs the
//    rest under `-a never`.

/** An owner server a launch line can turn off by name (a bare TOML key). */
const OWNER_SERVER_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const OWNER_SERVER_OFF_VALUE = /^mcp_servers\.([A-Za-z0-9_-]{1,64})\.enabled=false$/;
/** A connection's table as codexWorkerMcpWords writes it (read back on a
 *  re-fire, then rebuilt). */
const CONNECTION_TABLE_VALUE = /^mcp_servers\.([a-z][a-z0-9-]{0,30}[a-z0-9])=\{.*\}$/;
const FEATURES_OFF = ['features.apps=false', 'features.plugins=false'] as const;

export interface CodexWorkerMcpInput {
  /** The servers the owner's codex config defines (`wmux` is left on). */
  ownerServers: readonly string[];
  connectors: readonly Connector[];
  /** A stdio connection's run folder (outside every worktree). */
  runDir: (c: Connector) => string;
  /** The empty npm user config in that folder. */
  npmrc: (c: Connector) => string;
}

/** Why a connection cannot reach a codex worker, or null. Pure. */
export function codexConnectorRefusal(c: Connector): string | null {
  if (c.transport === 'sse') return `${c.name}: codex workers do not connect to SSE servers`;
  const bearer = c.secrets.find((s) => s.as === 'header' && s.scheme === 'bearer' && s.header.toLowerCase() !== 'authorization');
  if (bearer) return `${c.name}: codex workers send a Bearer key only in the Authorization header`;
  if (c.secrets.filter((s) => s.as === 'header' && s.scheme === 'bearer').length > 1) return `${c.name}: codex workers send one Bearer key`;
  return null;
}

/** A TOML inline table of `[key, toml value]` pairs (keys quoted). Pure. */
function tomlTable(entries: Array<[string, string]>): string {
  return `{${entries.map(([k, v]) => `${tomlString(k)}=${v}`).join(',')}}`;
}

const tomlArray = (values: readonly string[]): string => `[${values.map(tomlString).join(',')}]`;

/**
 * The `-c` words that give a codex worker exactly wmux and its task's
 * connections: apps and plugins off, every other server of the owner's
 * config off, and one table per connection. Null when that cannot be written:
 * an owner server name that is not a bare key, a connection named like an
 * owner server, one codexConnectorRefusal names, or text that would not read
 * back as plain words (a quote or backslash). Pure.
 */
export function codexWorkerMcpWords(input: CodexWorkerMcpInput): string[] | null {
  const words: string[] = FEATURES_OFF.map((v) => `-c ${v}`);
  for (const name of input.ownerServers) {
    if (name === 'wmux') continue;
    if (!OWNER_SERVER_KEY.test(name)) return null;
    words.push(`-c mcp_servers.${name}.enabled=false`);
  }
  for (const c of input.connectors) {
    if (input.ownerServers.includes(c.name) || codexConnectorRefusal(c)) return null;
    const tools: Array<[string, string]> = c.tools.mode === 'all'
      ? [['default_tools_approval_mode', '"approve"'], ['disabled_tools', tomlArray(c.tools.blocked)]]
      : [['default_tools_approval_mode', '"approve"'], ['enabled_tools', tomlArray(c.tools.allowed)]];
    let table: string;
    if (c.transport === 'stdio' && c.stdio) {
      const env = { ...c.stdio.env, npm_config_userconfig: input.npmrc(c), npm_config_registry: CONNECTOR_NPM_REGISTRY };
      table = tomlTable([
        ['command', tomlString('/usr/bin/env')],
        ['args', tomlArray(['-C', input.runDir(c), c.stdio.command, ...c.stdio.args])],
        ['env', tomlTable(Object.entries(env).map(([k, v]) => [k, tomlString(v)]))],
        ['env_vars', tomlArray(c.secrets.filter((s) => s.as === 'env').map((s) => s.secret))],
        ...tools,
      ]);
    } else if (c.remote && c.transport === 'http') {
      const bearer = c.secrets.find((s) => s.as === 'header' && s.scheme === 'bearer');
      const raw = c.secrets.filter((s): s is Extract<typeof s, { as: 'header' }> => s.as === 'header' && s.scheme === 'raw');
      table = tomlTable([
        ['url', tomlString(c.remote.url)],
        ['http_headers', tomlTable(Object.entries(c.remote.headers).map(([k, v]) => [k, tomlString(v)]))],
        ...(bearer ? [['bearer_token_env_var', tomlString(bearer.secret)] as [string, string]] : []),
        ...(raw.length > 0 ? [['env_http_headers', tomlTable(raw.map((s) => [s.header, tomlString(s.secret)]))] as [string, string]] : []),
        ...tools,
      ]);
    } else {
      return null;
    }
    const value = `mcp_servers.${c.name}=${table}`;
    if (/['\\]/.test(value) || !CONNECTION_TABLE_VALUE.test(value)) return null;
    words.push(`-c ${shellWord(value)}`);
  }
  return words;
}

const POSIX_PROMPT_ARGUMENT = /^"\$\(cat '(?:[^']|'\\'')*'\)"$/;
/** The writable-roots override main builds: a TOML array of guardable paths. */
const WRITABLE_ROOTS_VALUE = /^sandbox_workspace_write\.writable_roots=\[(?:"\/[^"'`$\\]*",)*"\/[^"'`$\\]*"\]$/;

/**
 * A codex fan-out line, checked against an ALLOWLIST: the launcher `codex`,
 * the trust override for exactly `cwd`, `-a never`, `-s workspace-write` (the
 * fan-out unattended flags), `--model`/`-m <model>`, the effort override, the
 * operator's wmux tool level, and one prompt-file argument at the end. Each
 * at most once. Anything else — another flag, a subcommand, a second shell
 * command — returns null. POSIX shells only. Pure.
 */
export function parseCodexWorkerLine(fullLine: string, cwd: string, opts: { resume?: boolean } = {}): CodexWorkerLine | null {
  if (!isGuardablePath(cwd)) return null;
  // A leading model-env marker is wmux's own prefix (workerLaunch.ts), about a
  // Claude variable codex never reads: read past it, and the rebuilt line
  // leaves it out.
  const { command } = splitModelEnvMarker(fullLine);
  const trimmed = command.trim();
  const lastSpace = trimmed.lastIndexOf(' "$(cat ');
  const promptArgument = lastSpace < 0 ? '' : trimmed.slice(lastSpace + 1);
  if (promptArgument && !POSIX_PROMPT_ARGUMENT.test(promptArgument)) return null;
  // The line main builds puts `--` before the prompt.
  const head = (lastSpace < 0 ? trimmed : trimmed.slice(0, lastSpace)).replace(/ --$/, '');
  if (stripPromptFileArgument(head) !== head || !plainQuotedWords(head) || /[;&|`\n\r<>]|\$\(/.test(head.replace(/'[^']*'/g, "''"))) return null;
  const tokens = tokenize(head);
  if (tokens.length === 0 || tokens[0].value !== 'codex' || tokens[0].quoted) return null;
  const first = 1;
  let resumeId: string | undefined;
  const trust = codexTrustOverride(cwd, 'darwin');
  const trustValue = trust ? trust.slice(4, -1) : undefined;
  const seen = new Set<string>();
  const once = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const out: Omit<CodexWorkerLine, 'promptArgument'> = {};
  for (let k = first; k < tokens.length; k++) {
    const flag = tokens[k].value;
    const value = tokens[k + 1]?.value;
    if (tokens[k].quoted || value === undefined) return null;
    k++;
    // `resume <id>` (session lines only), once, among the flags: the resume
    // chip may put a model flag before it.
    if (opts.resume && flag === 'resume') {
      if (resumeId !== undefined || tokens[k].quoted || !isPlausibleResumeSessionId('codex', value) || !/^[A-Za-z0-9-]+$/.test(value)) return null;
      resumeId = value;
    } else if (flag === '-a' && value === 'never') {
      if (!once('-a')) return null;
    } else if (flag === '-s' && value === 'workspace-write') {
      if (!once('-s')) return null;
    } else if ((flag === '--model' || flag === '-m') && value.length <= ROLE_BINDING_MODEL_MAX && FANOUT_MODEL_RE.test(value)) {
      if (!once('model')) return null;
      out.model = value;
    } else if (flag === '-c' && trustValue !== undefined && value === trustValue) {
      if (!once('trust')) return null;
    } else if (flag === '-c' && value.startsWith('model_reasoning_effort=') && EFFORT_TOKEN_RE.test(value.slice('model_reasoning_effort='.length))) {
      if (!once('effort')) return null;
      out.effort = value.slice('model_reasoning_effort='.length);
    } else if (flag === '-c' && value.startsWith('mcp_servers.wmux.') && parseCodexToolLevel(value)) {
      if (!once('wmux')) return null;
      out.wmuxTools = parseCodexToolLevel(value)!;
    // What main itself adds to a line it built (a re-fire or a resume brings it
    // back): accepted and then rebuilt, never taken as given.
    } else if (flag === '-c' && WRITABLE_ROOTS_VALUE.test(value)) {
      if (!once('roots')) return null;
    } else if (flag === '-c' && value === 'sandbox_workspace_write.network_access=true') {
      if (!once('network')) return null;
    } else if (flag === '-c' && value === DEFAULT_ASK_VALUE) {
      if (!once('default-ask')) return null;
    } else if (flag === '-c' && isWorkerToolTable(value)) {
      if (!once('tool-table')) return null;
    } else if (flag === '-C' && path.posix.resolve(value) === path.posix.resolve(cwd)) {
      if (!once('-C')) return null;
    // The MCP words main adds (codexWorkerMcpWords): rebuilt from main's own
    // records, never taken from the line.
    } else if (flag === '-c' && (FEATURES_OFF as readonly string[]).includes(value)) {
      if (!once(value)) return null;
    } else if (flag === '-c' && OWNER_SERVER_OFF_VALUE.test(value)) {
      if (!once(value)) return null;
    } else if (flag === '-c' && CONNECTION_TABLE_VALUE.test(value) && !value.startsWith('mcp_servers.wmux=')) {
      if (!once(`table:${CONNECTION_TABLE_VALUE.exec(value)![1]}`)) return null;
    } else {
      return null;
    }
  }
  // A launch names the prompt and the trust override; a resume names neither
  // necessarily (main rebuilds the trust from its own record of the folder).
  if (!resumeId && (!promptArgument || !seen.has('trust'))) return null;
  return { ...out, ...(resumeId ? { resumeId } : {}), promptArgument };
}

/** Every quote on the line is closed, and nothing is escaped: a backslash
 *  anywhere, or an unterminated quote, is not a word this guard reads. Pure. */
function plainQuotedWords(head: string): boolean {
  if (head.includes('\\')) return false;
  let quote: string | null = null;
  for (const c of head) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    }
  }
  return quote === null;
}

/** A POSIX single-quoted shell word. Pure. */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A TOML basic string. Pure. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The line main launches: its own sandbox, approval, writable roots and
 * working root, the caller's model, effort and tool level, the worker's wmux
 * tool approvals when `opts.toolApprovals`, its MCP words (`opts.mcpWords`),
 * then `--` and the prompt. `writableRoots` are
 * codexWorkerWritableRoots. Returns null when a path cannot be written as
 * one shell word. Pure.
 */
export function buildCodexWorkerLaunchLine(
  parsed: CodexWorkerLine,
  cwd: string,
  writableRoots: readonly string[],
  opts: { toolApprovals?: { ownerApproved: readonly string[] }; mcpEntry?: string; mcpWords?: readonly string[] } = {},
): string | null {
  const trust = codexTrustOverride(cwd, 'darwin');
  if (!trust || writableRoots.length === 0 || ![cwd, ...writableRoots].every(isGuardablePath)) return null;
  const roots = `sandbox_workspace_write.writable_roots=[${writableRoots.map(tomlString).join(',')}]`;
  const toolLevel = parsed.wmuxTools ? codexToolLevelWord(parsed.wmuxTools, opts.mcpEntry) : undefined;
  if (toolLevel === null) return null;
  return [
    'codex',
    ...(parsed.resumeId ? [`resume ${parsed.resumeId}`] : []),
    trust,
    '-a never',
    '-s workspace-write',
    `-c ${shellWord(roots)}`,
    '-c sandbox_workspace_write.network_access=true',
    ...(parsed.model ? [`--model ${parsed.model}`] : []),
    ...(parsed.effort ? [`-c model_reasoning_effort=${parsed.effort}`] : []),
    ...(toolLevel ? [toolLevel] : []),
    // Only with a wmux server in the codex config: an override of a server
    // the config does not define stops codex at startup.
    ...(opts.toolApprovals ? codexWorkerToolApprovals(opts.toolApprovals.ownerApproved) : []),
    // Wmux and the task's connections only (codexWorkerMcpWords).
    ...(opts.mcpWords ?? []),
    // Codex's working root, pinned to the folder the rules were written into.
    `-C ${shellWord(cwd)}`,
    // The prompt is never read as an option, whatever its text starts with.
    ...(parsed.promptArgument ? ['--', parsed.promptArgument] : []),
  ].join(' ');
}

/** The folders and files a worker's commit writes, and nothing else of the
 *  repository's: the worktree's git folder, and the common folder's objects,
 *  refs, logs and packed refs (measured on codex-cli 0.162.1: commit, fetch,
 *  branch create and delete work; config writes are refused). Null when the
 *  folder is not a linked worktree. Pure. */
export function codexWorkerWritableRoots(gitDir: string, commonDir: string): string[] | null {
  if (path.posix.resolve(gitDir) === path.posix.resolve(commonDir)) return null;
  return [gitDir, ...['objects', 'refs', 'logs', 'packed-refs', 'packed-refs.lock'].map((p) => path.posix.join(commonDir, p))];
}

/** `codex-cli 0.162.1` → [0, 162, 1], or null. Pure. */
export function parseCodexVersion(text: string): [number, number, number] | null {
  const m = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `version` at least CODEX_WORKER_MIN_VERSION? Pure. */
export function codexVersionAtLeastFloor(version: [number, number, number]): boolean {
  const floor = CODEX_WORKER_MIN_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (version[i] !== floor[i]) return version[i] > floor[i];
  }
  return true;
}
