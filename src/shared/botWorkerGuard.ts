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

/** The deny rules that send a merge through the lane instead of `gh`. */
export const BOT_WORKER_MERGE_DENY: readonly string[] = [...ghSubcommandDeny('pr', 'merge'), ...ghApiDeny('*merge*')];

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
   *  instance's worker, run on that build's hook bridge (#2231). */
  settingSources?: 'project';
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
    && (r.settingSources === undefined || r.settingSources === 'project');
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
        ? { settingsFile: r.launch.settingsFile, mcpConfigFile: r.launch.mcpConfigFile, level: r.launch.level, ...(r.launch.connectionKeys?.length ? { connectionKeys: [...r.launch.connectionKeys] } : {}), ...(r.launch.settingSources ? { settingSources: r.launch.settingSources } : {}) }
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
