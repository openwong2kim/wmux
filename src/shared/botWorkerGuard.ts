// ─── The bot-worker merge guard's pure parts, shared by main and the daemon ─
//
// A fan-out worker a bot started merges only through main's merge executor
// (the merge lane, or an approval the owner or a remembered rule gave),
// publishes its branch only through main's push (`task.push`: its own task
// branch, fast-forward only), and leaves every other irreversible or public
// act to an owner approval: claude launches in its pane carry `--settings`
// naming `<wmuxDir>/factory/worker-settings.json`, whose `permissions.deny`
// refuses them (BOT_WORKER_DENY). Main guards the launches it
// types (src/main/agents/botWorkerMergeGuard.ts); the daemon guards the ones a
// phone asks it to type into an existing pane. Both recognise a bot worker's
// pane by `<wmuxDir>/factory/bot-worker-sessions.json`, which only main
// writes; a file that exists but cannot be read counts every pane as a bot
// worker's (fail-closed).
//
// Threat model: this is an intent guard against a confused or misdirected
// model, not isolation. The rules match the commands the agent's own tool
// runs in their usual spellings; a worker runs as the owner's user, so a
// script, an interpreter or another program can still reach the same effects.

import fs from 'node:fs';
import path from 'node:path';
import { tokenize, launcherStem, isPlausibleResumeSessionId, PERMISSION_FLAG, type PermissionMode } from './agentResume';
import { splitModelEnvMarker } from './workerLaunch';
import { stripPromptFileArgument } from './promptFileArgument';
import { wslClaudeHooks } from './wslIntegration';

/** `gh <group> <verb>` in every spelling gh runs it: with global options
 *  (`-R o/r`, `--repo=o/r`, `--hostname h`) before the group, between the
 *  group and the verb, or both. The verb is a whole word after options, so
 *  `gh pr -R o/r view 3 --json mergeable` is not `merge`. Pure. */
export function ghSubcommandDeny(group: string, verb: string): string[] {
  return [
    `Bash(gh ${group} ${verb}*)`,
    `Bash(gh -* ${group} ${verb}*)`,
    ...['', '-* '].flatMap((pre) => [`Bash(gh ${pre}${group} -* ${verb})`, `Bash(gh ${pre}${group} -* ${verb} *)`]),
  ];
}

/** `gh api<rest>`, also after global options. Pure. */
export function ghApiDeny(rest: string): string[] {
  return [`Bash(gh api${rest})`, `Bash(gh -* api${rest})`];
}

/** glab's built-in aliases for a command group. */
export const GLAB_GROUP_ALIASES: Readonly<Record<string, readonly string[]>> = { repo: ['project'], variable: ['var'], stack: ['stacks'], ci: ['pipe', 'pipeline'] };

/** `glab <group…> <verb>` up to the verb, in every option placement glab
 *  takes (`-R g/p` before the group, between the group's words, before the
 *  verb), the group also under its aliases. `optionBeforeVerb`: the spelling
 *  ends in ` -* <verb>`. */
function glabCommandPrefixes(group: string, verb: string): { prefix: string; optionBeforeVerb: boolean }[] {
  const [head, ...rest] = group.split(' ');
  return [head, ...(GLAB_GROUP_ALIASES[head] ?? [])].flatMap((h) => {
    let spellings = ['glab ', 'glab -* '].map((s) => `${s}${h}`);
    for (const word of [...rest, verb]) spellings = spellings.flatMap((s) => [`${s} ${word}`, `${s} -* ${word}`]);
    return spellings.map((prefix) => ({ prefix, optionBeforeVerb: prefix.endsWith(` -* ${verb}`) }));
  });
}

/** `glab <group…> <verb>` in every spelling glab runs it, as
 *  ghSubcommandDeny: options before the group, between its words and the
 *  verb, or both; the verb a whole word after options. Callers name each of
 *  a verb's aliases (`mr accept` is `mr merge`). Pure. */
export function glabSubcommandDeny(group: string, verb: string): string[] {
  return glabCommandPrefixes(group, verb).flatMap(({ prefix, optionBeforeVerb }) =>
    optionBeforeVerb ? [`Bash(${prefix})`, `Bash(${prefix} *)`] : [`Bash(${prefix}*)`]);
}

/** `glab <group…> <verb> <rest>` in every option placement before the verb. Pure. */
function glabCommandWithDeny(group: string, verb: string, rest: string): string[] {
  return glabCommandPrefixes(group, verb).map(({ prefix }) => `Bash(${prefix} ${rest})`);
}

/** `glab api<rest>`, also after options. Pure. */
export function glabApiDeny(rest: string): string[] {
  return [`Bash(glab api${rest})`, `Bash(glab -* api${rest})`];
}

/** The deny rules that send a merge through the lane instead of `gh` or
 *  `glab` (an approval counts toward a GitLab merge; glab's API merge and
 *  approval are writes, refused with the other `glab api` writes below). */
export const BOT_WORKER_MERGE_DENY: readonly string[] = [
  ...ghSubcommandDeny('pr', 'merge'), ...ghApiDeny('*merge*'),
  ...['merge', 'accept', 'approve'].flatMap((v) => glabSubcommandDeny('mr', v)),
  // A new merge request set to merge itself once its checks pass.
  ...['create', 'new'].flatMap((v) => glabCommandWithDeny('mr', v, '*--auto-merge*')),
];

/** The default branch names main always treats as a repository's default
 *  branch, whatever its own default branch reads (see the default-branches
 *  file below for the others). Main's push never lands on one. */
export const BOT_WORKER_FALLBACK_DEFAULT_BRANCHES: readonly string[] = ['main', 'master'];

/** Characters a branch name may not hold to read as itself in a rule or a
 *  refspec: git's forbidden ones, the rule syntax's (`*`, parentheses),
 *  quotes, shell expansion and whitespace. */
const UNDENYABLE_CHAR = /[\s~^:?*[\\()"'`$]/u;

/** A branch name that reads as itself in a rule or a refspec: a valid git
 *  branch name (any script) with none of UNDENYABLE_CHAR, not shaped like an
 *  option. */
export function isDenyableBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return !UNDENYABLE_CHAR.test(name) && !name.startsWith('-') && !name.startsWith('.') && !name.startsWith('/')
    && !name.includes('..') && !name.includes('//') && !name.includes('@{') && !name.includes('/.')
    && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock') && name !== '@';
}

/** Every push: a worker's branch reaches the remote only through main's push
 *  (`task.push`), so the worker's own `git push` is refused in every form —
 *  directly or after git's global options (`-C <dir>`, `-c <key>=<value>`).
 *  Plus what would redirect where main's push lands: a remote's URL, a push
 *  URL, a URL rewrite or the remotes themselves; git's lower-level pushes;
 *  and a git alias, which can name any of these. */
export const BOT_WORKER_PUSH_DENY: readonly string[] = [
  'Bash(git push)', 'Bash(git push *)', 'Bash(git -* push)', 'Bash(git -* push *)',
  'Bash(git remote set-url*)', 'Bash(git -* remote set-url*)',
  'Bash(git*config*remote.*.push*)', 'Bash(git*config*remote.*.url*)', 'Bash(git*config*url.*)',
  // A remote added, renamed or removed changes what `origin` names.
  ...['add', 'rename', 'remove', 'rm'].flatMap((v) => [`Bash(git remote ${v}*)`, `Bash(git -* remote ${v}*)`]),
  // git's lower-level pushes.
  ...['send-pack', 'http-push'].flatMap((v) => [`Bash(git ${v}*)`, `Bash(git -* ${v}*)`]),
  // An alias names any of the acts above under another word.
  'Bash(git*config*alias.*)', 'Bash(git*-c*alias.*)',
  // glab's own pushes: `mr create --fill` (`-f`) or `--push` pushes the
  // branch and `--create-source-branch` creates one, a stack sync pushes the
  // stack, `mr rebase` rewrites the source branch on the server and `mr for`
  // creates one there. A plain `glab mr create --source-branch <branch>`
  // opens the request for the branch main pushed. `--attach` uploads a file
  // to the project, a public act like the ones below.
  // `-f` also in a bundle with create's other switches (`-yf`, `-wf`).
  ...['create', 'new'].flatMap((v) => [
    '*--fill*', '*--push*', '*--create-source-branch*', '*--attach*',
    ...['f', 'yf', 'wf', 'ywf', 'wyf'].flatMap((b) => [`-${b}*`, `* -${b}*`]),
  ].flatMap((rest) => glabCommandWithDeny('mr', v, rest))),
  ...['rebase', 'for', 'new-for', 'create-for'].flatMap((v) => glabSubcommandDeny('mr', v)), ...glabSubcommandDeny('stack', 'sync'),
];

/** Public acts under the owner's GitHub identity — issues, comments,
 *  reviews, closing or editing a PR, releases, repository settings — and
 *  every `gh api` write (an explicit write method, or fields, which make gh
 *  send a POST). They go to the owner as approval requests
 *  (shared/botApproval.ts). Reads (`gh release view`, a `gh api` GET) pass. */
export const BOT_WORKER_PUBLIC_DENY: readonly string[] = [
  ...['create', 'close', 'comment', 'delete', 'reopen', 'edit', 'transfer', 'lock', 'unlock', 'pin', 'unpin'].flatMap((v) => ghSubcommandDeny('issue', v)),
  ...['comment', 'review', 'close', 'reopen', 'edit', 'lock', 'unlock'].flatMap((v) => ghSubcommandDeny('pr', v)),
  ...['create', 'edit', 'delete', 'upload', 'delete-asset'].flatMap((v) => ghSubcommandDeny('release', v)),
  ...['create', 'edit', 'delete', 'rename', 'archive', 'unarchive', 'sync'].flatMap((v) => ghSubcommandDeny('repo', v)),
  ...['secret', 'variable'].flatMap((g) => [...ghSubcommandDeny(g, 'set'), ...ghSubcommandDeny(g, 'delete')]),
  ...['POST', 'PATCH', 'PUT', 'DELETE'].flatMap((m) => [m, m.toLowerCase()].flatMap((x) => [...ghApiDeny(`*-X*${x}*`), ...ghApiDeny(`*--method*${x}*`)])),
  ...['* -f*', '* -F*', '*--field*', '*--raw-field*', '*--input*'].flatMap(ghApiDeny),
  // An alias names any of the acts above under another word.
  ...ghSubcommandDeny('alias', 'set'), ...ghSubcommandDeny('alias', 'import'),
  // The same acts through glab, under the owner's GitLab identity, and every
  // `glab api` write. Editing a merge request (`mr update`, which also marks
  // one ready) is the owner's.
  // Each verb with its aliases (`issue new`, `mr comment`, `variable remove`).
  ...['create', 'new', 'close', 'note', 'comment', 'delete', 'del', 'reopen', 'update'].flatMap((v) => glabSubcommandDeny('issue', v)),
  ...['note', 'comment', 'revoke', 'unapprove', 'close', 'reopen', 'delete', 'del', 'update'].flatMap((v) => glabSubcommandDeny('mr', v)),
  ...['create', 'delete', 'upload'].flatMap((v) => glabSubcommandDeny('release', v)),
  ...['create', 'new'].flatMap((v) => glabSubcommandDeny('issue board', v)),
  ...['create', 'fork', 'update', 'delete', 'transfer', 'mirror', 'publish'].flatMap((v) => glabSubcommandDeny('repo', v)),
  ...['add', 'remove'].flatMap((v) => glabSubcommandDeny('repo members', v)),
  ...['set', 'new', 'create', 'update', 'delete', 'remove', 'import', 'im'].flatMap((v) => glabSubcommandDeny('variable', v)),
  // Starting a pipeline or job runs under the owner's GitLab identity;
  // cancelling or deleting one changes the owner's pipelines.
  ...['run', 'create', 'trigger', 'run-trig', 'retry', 'cancel', 'delete'].flatMap((v) => glabSubcommandDeny('ci', v)),
  // Also bundled after api's one other switch, `-i` (`-iX PUT`, `-if`).
  ...['POST', 'PATCH', 'PUT', 'DELETE'].flatMap((m) => [m, m.toLowerCase()].flatMap((x) => [`*-X*${x}*`, `*-iX*${x}*`, `*--method*${x}*`].flatMap(glabApiDeny))),
  ...['* -f*', '* -F*', '* -if*', '* -iF*', '*--field*', '*--raw-field*', '*--form*', '*--input*'].flatMap(glabApiDeny),
  ...glabSubcommandDeny('alias', 'set'),
];

/** Everything a bot's worker is refused. */
export const BOT_WORKER_DENY: readonly string[] = [...BOT_WORKER_MERGE_DENY, ...BOT_WORKER_PUSH_DENY, ...BOT_WORKER_PUBLIC_DENY];

/** The worker's `--settings` document: every rule. */
export function buildBotWorkerSettings(): Record<string, unknown> {
  // Only a WSL pane's worker launches with this file alone (#2261). The WSL
  // claude shim passes wmux's hooks as its own `--settings`, and of two
  // `--settings` flags the last one wins, so this file carries those hooks
  // too: without them no turn end and no session id reached wmux, so the
  // worker was never paused when idle and could not be resumed.
  return { permissions: { deny: [...BOT_WORKER_DENY] }, disableAllHooks: false, hooks: wslClaudeHooks() };
}

// ── factory/worker-default-branches.json ─────────────────────────────────────
// The default branches of the repositories bots' workers run in, as main read
// them (GitHub's default branch, else origin/HEAD). Only main writes and reads
// it: main's push (`task.push`) never lands on one. Missing or unreadable:
// main/master only.

export const BOT_WORKER_DEFAULT_BRANCHES_VERSION = 1;
/** Most names kept (oldest dropped first). */
export const BOT_WORKER_DEFAULT_BRANCHES_MAX = 64;

export function botWorkerDefaultBranchesPath(dir: string): string {
  return path.join(dir, 'factory', 'worker-default-branches.json');
}

/** The recorded default branches (valid names only, main/master left out). */
export function readBotWorkerDefaultBranches(dir: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(botWorkerDefaultBranchesPath(dir), 'utf8')) as { version?: unknown; branches?: unknown };
    if (raw?.version !== BOT_WORKER_DEFAULT_BRANCHES_VERSION || !Array.isArray(raw.branches)) return [];
    const names = raw.branches.filter((b): b is string => isDenyableBranchName(b) && !BOT_WORKER_FALLBACK_DEFAULT_BRANCHES.includes(b));
    return [...new Set(names)].slice(-BOT_WORKER_DEFAULT_BRANCHES_MAX);
  } catch {
    return [];
  }
}

/** Main: add one repository's default branch (written whole, only when it
 *  is new). False when the name cannot be held (isDenyableBranchName) or the
 *  file cannot be written; main/master need no record. */
export function recordBotWorkerDefaultBranch(dir: string, name: string): boolean {
  if (!isDenyableBranchName(name)) return false;
  if (BOT_WORKER_FALLBACK_DEFAULT_BRANCHES.includes(name)) return true;
  const known = readBotWorkerDefaultBranches(dir);
  if (known.includes(name)) return true;
  const branches = [...known, name].slice(-BOT_WORKER_DEFAULT_BRANCHES_MAX);
  const file = botWorkerDefaultBranchesPath(dir);
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${JSON.stringify({ version: BOT_WORKER_DEFAULT_BRANCHES_VERSION, branches })}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    return false;
  }
}

/**
 * A path that reads back byte-identical from inside double quotes on a POSIX,
 * PowerShell or cmd line: no quotes, no `$`/backtick (POSIX and PowerShell
 * expand them), no `%`/`!` (cmd expands them), and no run of backslashes
 * (POSIX collapses `\\` to `\`). Anything else could make the file written
 * and the path passed to --settings differ.
 */
export function isQuotable(p: string): boolean {
  return !/['"`$%!]/.test(p) && !/\\\\/.test(p);
}

/** The settings file's path under the instance data dir. */
export function botWorkerSettingsPath(dir: string): string {
  return path.join(dir, 'factory', 'worker-settings.json');
}

/**
 * Write the worker settings under `<dir>/factory/` (rewritten only when they
 * drift) and return the path. The file is replaced whole (a temporary file
 * renamed over it), so a worker starting meanwhile reads the old or the new
 * content, never a partial one. Throws when it cannot be written.
 */
export function writeBotWorkerSettings(dir: string): string {
  const file = botWorkerSettingsPath(dir);
  const content = `${JSON.stringify(buildBotWorkerSettings(), null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (fs.readFileSync(file, 'utf8') === content) return file;
  } catch {
    /* missing: write it */
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
  return file;
}

/**
 * One plain command: no unquoted command separator, pipe, background `&`,
 * comment, command substitution or line break. The prompt argument's
 * double-quoted `$(...)` (FanOutService.buildInitialCommand) is quoted and
 * passes; a line that could start a second program does not.
 */
export function isSingleCommand(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (/[;&|#`\n\r]/.test(c) || (c === '$' && command[i + 1] === '(')) return false;
  }
  return quote === null;
}

/**
 * A launch line for a cmd.exe pane. cmd has its own quoting: only `"…"`
 * (and `^` escapes) quote, and `%`/`!` expand even inside double quotes, so
 * isSingleCommand's reading does not hold there. With wmux's own prompt
 * argument taken out, the rest may hold none of `'`, `&`, `|`, `^`, `%`, `!`,
 * `<`, `>` or a line break. A `$(` anywhere is refused too: cmd evaluates
 * none, so a prompt argument left in the PowerShell or POSIX shape (a prompt
 * path cmdPromptFileArgument cannot name) would reach claude as its prompt.
 * Pure.
 */
export function isPlainCmdLaunchLine(line: string): boolean {
  return !line.includes('$(') && !/['&|^%!<>\r\n]/.test(stripPromptFileArgument(line));
}

/** Command or process substitution, quoted or not. */
const SUBSTITUTION = /\$\(|`|<\(|>\(/;

/**
 * Could the shell turn an argument after the launcher into a word the line
 * does not show? An escape, a variable, a brace list, a tilde or a glob can
 * each spell a flag the guard looks for (`--set\tings`, `--set${X}tings`,
 * `--{settings,x}`) without the word reading as one. Outside quotes each of
 * them counts; inside double quotes a `\` or `$` (the shell still reads
 * them there); inside single quotes nothing. Pass the line without its
 * prompt-file argument. Pure.
 */
export function argumentsMayExpand(command: string): boolean {
  const tokens = tokenize(command);
  if (tokens.length === 0) return false;
  const args = command.slice(tokens[0].end);
  let quote: '"' | "'" | null = null;
  for (const c of args) {
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' || c === '$') return true;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/[\\${}~*?[\]]/.test(c)) {
      return true;
    }
  }
  return false;
}

export function isClaudeLauncher(word: string): boolean {
  return launcherStem(word) === 'claude';
}

/**
 * Splice `--settings="<path>"` right after a `claude` launcher, keeping a
 * leading model-env marker. Returns the line unchanged when this file is
 * already the launcher's first argument and no other settings flag follows,
 * and null when it cannot carry it: another launcher, an empty line, more than
 * one command, an argument the shell could expand (argumentsMayExpand), an
 * end-of-options `--`, another `--settings`, or a path that cannot be quoted.
 */
export function spliceSettingsFlag(fullCommand: string, settingsPath: string): string | null {
  const { marker, command } = splitModelEnvMarker(fullCommand);
  if (!isQuotable(settingsPath)) return null;
  // The prompt-file argument fan-out builds (FanOutService.buildInitialCommand)
  // is the one substitution a launch line may hold, by its exact shape.
  const rest = stripPromptFileArgument(command);
  const spliced = ` --settings="${settingsPath}"`;
  // Our own flag, already spliced, holds a path (a Windows one has `\`).
  if (SUBSTITUTION.test(rest) || !isSingleCommand(rest) || argumentsMayExpand(rest.split(spliced).join(''))) return null;
  const tokens = tokenize(command);
  if (tokens.length === 0 || !isClaudeLauncher(tokens[0].value)) return null;
  if (tokens.some((t) => t.value === '--')) return null;
  const ours = `--settings=${settingsPath}`;
  // Quoting does not hide a flag from the shell, so a quoted one counts too.
  const passed = tokens.slice(1).filter((t) => /^--settings(=|$)/.test(t.value));
  if (passed.length > 0) return passed.length === 1 && tokens[1] === passed[0] && passed[0].value === ours ? fullCommand : null;
  // The `=` form, like --mcp-config in toolSurfaceLaunch: one word on both shells.
  const at = tokens[0].end;
  return `${marker}${command.slice(0, at)}${spliced}${command.slice(at)}`;
}

/** A claude launcher as a word of its own, a path's last part, or right
 *  next to a shell operator, quote or parenthesis. */
const CLAUDE_LAUNCHER_ANYWHERE = /(?:^|[\s;&|()`'"/=])claude(?:\.(?:exe|cmd|bat|ps1))?(?=$|[\s;&|()`'"<>])/i;

/** Does the line start claude anywhere? Every claude launcher in a line is
 *  seen, including one written next to a shell operator, so the line is
 *  guarded (and refused when it is not one plain command). Over-matching is
 *  the safe side. */
export function namesClaude(line: string): boolean {
  return tokenize(splitModelEnvMarker(line).command).some((t) => isClaudeLauncher(t.value))
    || CLAUDE_LAUNCHER_ANYWHERE.test(line);
}

// ── The worker folder's own Claude settings ──────────────────────────────────
//
// A worker's claude still reads its folder's project settings
// (`.claude/settings.json`, `.claude/settings.local.json`): `--setting-sources
// user` would leave them out, but it also leaves out the repository's
// CLAUDE.md (measured on claude 2.1.300), which a worker needs. So a launch
// goes ahead only when those files set nothing that runs a program or sets
// the worker's environment, the way a codex worker launches only without a
// project `.codex/config.toml`.

/** Project settings keys that run a program or set the environment. */
export const WORKER_PROJECT_SETTINGS_REFUSED: readonly string[] = [
  'hooks', 'env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper',
  'statusLine', 'fileSuggestion', 'enabledPlugins', 'extraKnownMarketplaces',
];

/** Why a claude worker cannot launch in `cwd` because of its project
 *  settings, or null. A file that cannot be read or parsed counts. */
export function workerProjectSettingsRefusal(cwd: string): string | null {
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(cwd, '.claude', name);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      return `.claude/${name} could not be read`;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return `.claude/${name} is not valid JSON`;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `.claude/${name} is not a settings object`;
    const set = WORKER_PROJECT_SETTINGS_REFUSED.filter((k) => k in (parsed as Record<string, unknown>));
    if (set.length > 0) return `.claude/${name} sets ${set.join(', ')}`;
  }
  return null;
}

// ── factory/bot-worker-sessions.json ─────────────────────────────────────────

export const BOT_WORKER_SESSIONS_VERSION = 1;

/** The files a session's claude launches carry (shared/botWorkerMcp.ts),
 *  so a re-fire or a resume reads the same servers and rules as the first
 *  launch. */
export interface BotWorkerLaunchFiles {
  settingsFile: string;
  mcpConfigFile: string;
  level: 'core' | 'full';
  /** The connection keys the launch's environment was given (names), kept
   *  out of every other connection's server on a re-fire or resume. */
  connectionKeys?: string[];
  /** `project`: the launch loads no user settings (`--setting-sources
   *  project`), its hooks come from its own settings file — an isolated
   *  instance's worker, run on that build's hook bridge (#2231). `none`: it
   *  loads no settings but its own file (`--setting-sources=`), a worker
   *  with a signed-in connection. */
  settingSources?: 'project' | 'none';
  /** The worker fence the launch ran in (main/agents/botWorkerFence.ts):
   *  `full`, `weaker` (no OS sandbox), or `off` (turned off for its
   *  workspace), the worker's own temp folder, and the branch its first
   *  fenced launch ran on (null: detached), which a later launch must still
   *  be on. A later launch of the session is never fenced less. */
  fence?: { strength: 'full' | 'weaker' | 'off'; tempDir?: string; branch?: string | null };
}

/** One bot worker session. `workspaceId` and `at` are the version-1 record
 *  every reader knows. The rest are optional additions (no version bump: a
 *  reader keeps what it knows, and an older one ignores them): where a codex
 *  worker was launched and for which repository, so a re-fire or a resume of
 *  that pane is guarded the same way (main/agents/codexWorkerGuard.ts); the
 *  files a claude launch carried (`launch`); `wsl`: the pane's shell is WSL,
 *  whose launches keep the worker settings file alone. */
export interface BotWorkerSessionRecord {
  workspaceId: string;
  at: number;
  /** The CLI main launched there (`codex`), when it recorded one. */
  agent?: string;
  /** The worktree the launch was guarded in (absolute). */
  cwd?: string;
  /** The bot repository's key. */
  repoKey?: string;
  /** The CODEX_HOME the launch was checked with (an account's), when set. */
  codexHome?: string;
  launch?: BotWorkerLaunchFiles;
  wsl?: boolean;
  /** The bot task whose own fan-out (or resume) launch created this pane;
   *  absent for any other pane of the task's workspace. */
  taskId?: string;
  /** The conversation the launch line pinned (`--session-id`), and the
   *  permission mode its flags started it in: what a resume of that
   *  conversation falls back to when no hook recorded a mode. */
  launchSessionId?: string;
  permissionMode?: PermissionMode;
}

/** The per-launch files under `<dir>/factory/`: only these folders, a JSON
 *  file name, a path that can be quoted. Pure. */
export function isWorkerLaunchFiles(raw: unknown, dir: string): raw is BotWorkerLaunchFiles {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  const inside = (p: unknown, sub: string): boolean => typeof p === 'string' && isQuotable(p)
    && path.dirname(p) === path.join(dir, 'factory', sub) && /^[0-9a-f]{12}\.json$/.test(path.basename(p));
  const keys = r.connectionKeys === undefined
    || (Array.isArray(r.connectionKeys) && r.connectionKeys.length <= 32 && r.connectionKeys.every((k) => typeof k === 'string' && /^[A-Z_][A-Z0-9_]{0,63}$/.test(k)));
  return inside(r.settingsFile, 'worker-settings') && inside(r.mcpConfigFile, 'worker-mcp') && (r.level === 'core' || r.level === 'full') && keys
    && (r.settingSources === undefined || r.settingSources === 'project' || r.settingSources === 'none')
    && (r.fence === undefined || isLaunchFence(r.fence, dir));
}

/** A worker temp folder's name (main/agents/botWorkerFence.ts). */
export const WORKER_TEMP_NAME = /^[0-9a-f]{32}$/;

/** Where workers' own temp folders are made. */
export function workerTempRoot(dir: string): string {
  return path.join(dir, 'factory', 'worker-tmp');
}

/** A recorded fence: a known strength, the branch it started on (null:
 *  detached) when recorded, and a temp folder (when any) directly under
 *  workerTempRoot. Pure. */
function isLaunchFence(raw: unknown, dir: string): raw is NonNullable<BotWorkerLaunchFiles['fence']> {
  if (!raw || typeof raw !== 'object') return false;
  const f = raw as Record<string, unknown>;
  if (f.strength !== 'full' && f.strength !== 'weaker' && f.strength !== 'off') return false;
  if (f.branch !== undefined && f.branch !== null && (typeof f.branch !== 'string' || f.branch.length === 0)) return false;
  return f.tempDir === undefined
    || (typeof f.tempDir === 'string' && path.dirname(f.tempDir) === workerTempRoot(dir) && WORKER_TEMP_NAME.test(path.basename(f.tempDir)));
}

export function botWorkerSessionsPath(dir: string): string {
  return path.join(dir, 'factory', 'bot-worker-sessions.json');
}

/** Read the sessions record now: its sessions (none when the file is
 *  missing), or why it is unreadable. Never cached here. */
export function readBotWorkerSessions(dir: string): { sessions: Map<string, BotWorkerSessionRecord> } | { unreadable: string } {
  const out = new Map<string, BotWorkerSessionRecord>();
  try {
    const raw = JSON.parse(fs.readFileSync(botWorkerSessionsPath(dir), 'utf8')) as { version?: unknown; sessions?: unknown };
    if (raw?.version !== BOT_WORKER_SESSIONS_VERSION || !raw.sessions || typeof raw.sessions !== 'object') throw new Error('not a version 1 sessions file');
    for (const [id, rec] of Object.entries(raw.sessions as Record<string, unknown>)) {
      const r = rec as Partial<BotWorkerSessionRecord> | null;
      if (!id || typeof r?.workspaceId !== 'string' || typeof r.at !== 'number') throw new Error(`a malformed record (${id})`);
      // Launch files that are not main's own are not used (the launch is then
      // guarded as a record without them).
      const launch = isWorkerLaunchFiles(r.launch, dir)
        ? { settingsFile: r.launch.settingsFile, mcpConfigFile: r.launch.mcpConfigFile, level: r.launch.level, ...(r.launch.connectionKeys?.length ? { connectionKeys: [...r.launch.connectionKeys] } : {}), ...(r.launch.settingSources ? { settingSources: r.launch.settingSources } : {}), ...(r.launch.fence ? { fence: { strength: r.launch.fence.strength, ...(r.launch.fence.tempDir ? { tempDir: r.launch.fence.tempDir } : {}), ...(r.launch.fence.branch !== undefined ? { branch: r.launch.fence.branch } : {}) } } : {}) }
        : undefined;
      out.set(id, {
        workspaceId: r.workspaceId,
        at: r.at,
        // Optional additions: kept when well-formed, ignored otherwise.
        ...(typeof r.agent === 'string' && r.agent.length <= 32 ? { agent: r.agent } : {}),
        ...(typeof r.cwd === 'string' && r.cwd.length <= 4096 ? { cwd: r.cwd } : {}),
        ...(typeof r.repoKey === 'string' && r.repoKey.length <= 256 ? { repoKey: r.repoKey } : {}),
        ...(typeof r.codexHome === 'string' && r.codexHome.length <= 4096 ? { codexHome: r.codexHome } : {}),
        ...(launch ? { launch } : {}),
        ...(r.wsl === true ? { wsl: true } : {}),
        ...(typeof r.taskId === 'string' && r.taskId.length > 0 && r.taskId.length <= 128 ? { taskId: r.taskId } : {}),
        ...(typeof r.launchSessionId === 'string' && isPlausibleResumeSessionId('claude', r.launchSessionId) ? { launchSessionId: r.launchSessionId } : {}),
        ...(typeof r.permissionMode === 'string' && Object.prototype.hasOwnProperty.call(PERMISSION_FLAG, r.permissionMode) ? { permissionMode: r.permissionMode } : {}),
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { unreadable: String(err) };
  }
  return { sessions: out };
}

// ── The worker fence (main/agents/workerFence.ts, botWorkerFence.ts) ────────
// Its pure parts the daemon's phone launch checks too.

/** The permission mode a launch line starts claude in, from its flags,
 *  wherever they are: quoted words and the words inside them count too (a
 *  wrapper's `sh -c "claude …"`), so a line that may run unattended is
 *  never taken for one that does not. An unattended mode named anywhere
 *  wins: the skip flag first (claude's own order), then bypassPermissions,
 *  then auto; else the last mode named. Undefined: none named. */
export function linePermissionMode(line: string): PermissionMode | undefined {
  const words = tokenize(splitModelEnvMarker(line).command).flatMap((t) => t.value.split(/\s+/)).filter(Boolean);
  if (words.includes('--dangerously-skip-permissions')) return 'bypassPermissions';
  const named: PermissionMode[] = [];
  for (let i = 0; i < words.length; i++) {
    const v = words[i];
    const m = v === '--permission-mode' ? words[i + 1] : v.startsWith('--permission-mode=') ? v.slice('--permission-mode='.length) : undefined;
    const known = PERMISSION_MODES.find((k) => k === m);
    if (known) named.push(known);
  }
  if (named.includes('bypassPermissions')) return 'bypassPermissions';
  if (named.includes('auto')) return 'auto';
  return named[named.length - 1];
}

export const PERMISSION_MODES: readonly PermissionMode[] = ['bypassPermissions', 'acceptEdits', 'plan', 'auto', 'default'];

/** A JSON object file, or null. */
export function readJsonObject(p: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The `permissions.defaultMode` claude would start a line with no mode flag
 *  in, from the folder's local and project settings and every user settings
 *  folder the pane may run with (`configDirs`): an unattended mode named in
 *  any of them wins, else the first mode named. Undefined: none. */
export function settingsDefaultMode(cwd: string | undefined, configDirs: readonly string[]): PermissionMode | undefined {
  const files = [
    ...(cwd ? [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json')] : []),
    ...configDirs.map((d) => path.join(d, 'settings.json')),
  ];
  const named: PermissionMode[] = [];
  for (const f of files) {
    const perms = readJsonObject(f)?.permissions;
    const mode = perms && typeof perms === 'object' && !Array.isArray(perms) ? (perms as Record<string, unknown>).defaultMode : undefined;
    const known = PERMISSION_MODES.find((m) => m === mode);
    if (known) named.push(known);
  }
  return named.find(isFencedMode) ?? named[0];
}

/** The modes an unattended worker runs in: the fence is for them. */
export function isFencedMode(mode: PermissionMode | undefined): boolean {
  return mode === 'bypassPermissions' || mode === 'auto';
}


/** The wmux MCP tools a fenced worker does not get, as claude names them
 *  (`mcp__wmux__<tool>`): they run code, type into a pane, open a pane or a
 *  remote worker, drive the desktop, or move a file in or out of the
 *  browser, all from wmux's own processes, which the OS sandbox does not
 *  cover, or start more workers, or take work from or add it to the owner's
 *  To hand out list. The reads, task_push and send_message stay
 *  (send_message without `execute` on a new task: a2a.rpc.ts). */
export const WORKER_FENCE_REFUSED_WMUX_TOOLS: readonly string[] = [
  'repl_run', 'browser_repl', 'terminal_send', 'terminal_send_key', 'surface_new', 'pane_split', 'remote_spawn', 'computer', 'fanout_start',
  'hand_out', 'browser_file_upload', 'browser_download', 'browser_wait_for_download', 'browser_pdf', 'browser_trace',
].map((t) => `mcp__wmux__${t}`);

/** The pipe methods behind those of WORKER_FENCE_REFUSED_WMUX_TOOLS that
 *  main runs, which main refuses to a fenced worker's pane as well. The
 *  others (the REPLs and the browser's file tools) run in the MCP server
 *  itself and are refused by the fence's settings and hook only. */
export const WORKER_FENCE_REFUSED_RPC: ReadonlySet<string> = new Set([
  'input.send', 'input.sendKey', 'surface.new', 'pane.split', 'a2a.remote.spawn', 'computer.act', 'task.fanout.start',
  'handOut.list', 'handOut.add',
]);

/** Top-level settings keys: a sandbox of their own, or hooks turned off. */
export const WORKER_FENCE_REFUSED_SETTINGS_KEYS: readonly string[] = ['sandbox', 'disableAllHooks'];

/** `permissions` keys claude also opens the sandbox's writes by. */
export const WORKER_FENCE_REFUSED_PERMISSION_KEYS: readonly string[] = ['additionalDirectories'];

/** An allow rule for a file tool: claude widens the sandbox's writes by it. */
export const WORKER_FENCE_FILE_ALLOW_RULE = /^\s*(Read|Edit|Write|MultiEdit|NotebookEdit)\s*(\(|$)/;

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}


/**
 * Why the fence cannot start in `worktree` because of its own Claude files,
 * or null: `.claude`, `.claude/settings.json`, `.claude/settings.local.json`
 * or `.mcp.json` is a link that leads out of the worktree (or nowhere): a
 * command inside the fence could have pointed it at settings of its own; or
 * the project settings turn on a sandbox of their own, turn hooks off, open
 * more folders (`permissions.additionalDirectories`) or allow a file tool,
 * each of which claude would apply on top of the fence. Checked at every
 * launch, resume and re-fire.
 */
export function workerFenceFolderRefusal(worktree: string): string | null {
  let wt: string;
  try {
    wt = fs.realpathSync(worktree);
  } catch {
    return 'the worker\'s folder could not be read';
  }
  for (const rel of ['.claude', '.mcp.json', path.join('.claude', 'settings.json'), path.join('.claude', 'settings.local.json')]) {
    const p = path.join(wt, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    let real: string;
    try {
      real = fs.realpathSync(p);
    } catch {
      return `${rel} is a link that leads nowhere`;
    }
    if (!isInside(real, wt)) return `${rel} is a link out of the worktree`;
  }
  for (const name of ['settings.json', 'settings.local.json']) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(wt, '.claude', name), 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return `.claude/${name} is not valid JSON`;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `.claude/${name} is not a settings object`;
    const s = parsed as Record<string, unknown>;
    const keys = WORKER_FENCE_REFUSED_SETTINGS_KEYS.filter((k) => k in s);
    if (keys.length > 0) return `.claude/${name} sets ${keys.join(', ')}`;
    const perms = s.permissions && typeof s.permissions === 'object' && !Array.isArray(s.permissions) ? s.permissions as Record<string, unknown> : {};
    const wide = WORKER_FENCE_REFUSED_PERMISSION_KEYS.filter((k) => k in perms);
    if (wide.length > 0) return `.claude/${name} sets permissions.${wide.join(', permissions.')}`;
    if (Array.isArray(perms.allow) && perms.allow.some((r) => typeof r !== 'string' || WORKER_FENCE_FILE_ALLOW_RULE.test(r))) {
      return `.claude/${name} allows a file tool, which widens the fence`;
    }
  }
  return null;
}
