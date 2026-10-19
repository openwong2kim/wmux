// ─── A bot's codex fan-out worker: the launch main allows ───────────────────
//
// pty:create's stage for a codex line in a bot's worker pane (shared/
// codexWorkerGuard.ts holds the pure parts and the threat model). A codex
// worker starts as the fan-out's own first launch (strict); main records where
// (the session record's optional `agent`/`cwd`/`repoKey`), and a re-fire or a
// resume typed into that pane later is guarded from that record
// (guardBotWorkerSessionText). Every other codex start in a bot's worker pane
// — a later pane, the factory's worker resume, a phone launch — is refused.
// Before a line is handed on, main:
//
//   1. checks the line against the allowlist and rebuilds it with its own
//      sandbox, approval, writable roots and network (POSIX hosts only), and
//      its MCP servers: wmux and the task's connections, with every other
//      server of the owner's codex config, the apps and the plugins off
//      (shared/codexWorkerGuard.ts codexWorkerMcpWords);
//   2. checks the worktree's `.codex/`: no symlink on the way to the rules
//      file, and no file the repository does not track other than ours (a
//      project config, hook or rules file there would load with ours);
//   3. writes the rules file and lists it, anchored, in the repository's
//      `info/exclude` (shared by every worktree; written under a lock);
//   4. finds the codex the pane will run (the login shell's PATH), refuses
//      one older than the measured floor, and proves the rules load: Codex's
//      own `execpolicy check` over every rules file the session reads (the
//      user's and the worktree's) must refuse a push with our rule. A rules
//      file that does not parse makes an interactive codex start with no
//      rules at all, so this check is what keeps the guard from failing open.
//
// Any failure throws: the create fails and the fan-out reports the task as
// not launched. Once the folder is resolved, pty:create refuses a guarded
// create that would start anywhere else (botWorkerMergeGuard
// guardedCodexCwdRefusal), and the line pins Codex's working root (`-C`).
//
// Not covered: a rules file another process changes between this check and
// the session's start, and commands the prefix rules do not match (see
// shared/codexWorkerGuard.ts).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { agentExecEnv } from '../../shared/execEnv';
import {
  CODEX_WORKER_EXCLUDE_LINE,
  CODEX_WORKER_JUSTIFICATION_PREFIX,
  CODEX_WORKER_RULES_PATH,
  buildCodexWorkerLaunchLine,
  buildCodexWorkerRules,
  codexConnectorRefusal,
  codexVersionAtLeastFloor,
  codexWorkerMcpWords,
  codexWorkerWritableRoots,
  isCodexToolKey,
  parseCodexVersion,
  launchesCodex,
  namesCodex,
  parseCodexWorkerLine,
  CODEX_WORKER_MIN_VERSION,
} from '../../shared/codexWorkerGuard';
import { codexDefinesWmuxServer, codexMcpServerNames, codexWmuxApprovedTools } from '../../shared/mcpRegistration';
import type { Connector } from '../../shared/botConnector';

import { resolveOnPath } from '../factory/botEngines';
import { locateWmuxMcpEntry } from './toolSurfaceLaunch';
import { getBotStore } from '../factory/botStore';
import { botWorkerSessionRecord, claimInflightCodexLaunch, guardRefireLine, guardSessionLaunch, isBotWorkerSession, ledgerTaskConnectors, markGuardedCodexCreate, prepareConnectorRunDirs, taskConnectors } from './botWorkerMergeGuard';
import { getWmuxDir } from '../../daemon/config';
import { workerGitEnv, workerGitPreflight, workerGitSafeArgs } from '../worktask/workerGit';
import { excludeLineOnce } from '../git/infoExclude';

const execFileP = promisify(execFile);
const RUN_TIMEOUT_MS = 15_000;

export interface CodexGuardRun { code: number; stdout: string; stderr: string }

export interface CodexWorkerGuardDeps {
  /** Runs a program (no shell). Never throws. */
  run?: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<CodexGuardRun>;
  /** The codex binary the pane's shell resolves, or null. */
  resolveCodex?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** The env a pane's agent launch sees (login-shell PATH). */
  paneEnv?: () => Promise<NodeJS.ProcessEnv>;
  /** The bot repository's key, for the one-word gh repository options. */
  repoKey?: (botIds: readonly string[]) => string | undefined;
  /** Claims the in-flight fan-out spawn's one codex launch (botWorkerMergeGuard). */
  claimLaunch?: (ownerWorkspaceId: string, cwd: string) => boolean;
  platform?: NodeJS.Platform;
  home?: string;
  /** An empty folder for `core.hooksPath` on main's git calls (outside every
   *  worker's writable roots). */
  noHooksDir?: string;
  /** The wmux MCP bundle main registers (a line's wmux tool level is
   *  rewritten with it, never taken from the line). */
  mcpEntry?: () => string | null;
  /** The instance data dir (default: getWmuxDir()): connections' run folders. */
  dir?: string;
  /** Codex's system config folder (default /etc/codex), whose config.toml
   *  and managed_config.toml codex loads with the user's. */
  systemCodexDir?: string;
  /** A re-fire's or resume's connections (default: the task's, from the
   *  ledger, still this bot's in the library). */
  sessionConnectors?: (record: { workspaceId?: string }) => Connector[];
}

/** The MCP bundle this app registers (packaged stable copy or dev dist). */
function currentMcpEntry(): string | null {
  try {
    return locateWmuxMcpEntry({ home: app.getPath('home'), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  } catch {
    return null;
  }
}

/** What pty:create knows about this create (botWorkerMergeGuard's record). */
export interface CodexGuardWorker { strict: boolean; spawns?: { botId: string; connectors?: Connector[] }[] }

/** The pty:create options this stage reads. */
interface CodexGuardOptions { initialCommand?: string; cwd?: string; env?: Record<string, string>; fanoutTaskOf?: unknown }

async function defaultRun(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<CodexGuardRun> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: typeof e.stdout === 'string' ? e.stdout : '', stderr: typeof e.stderr === 'string' && e.stderr ? e.stderr : (e.message ?? String(err)) };
  }
}

function refuse(why: string, where = 'PTY_CREATE'): Error {
  return new Error(`${where}: a bot's codex worker was not launched: ${why}`);
}

const SCAN_MAX = 500;

/** Every file under `dir` (relative, `/`-separated); a symlink anywhere is
 *  reported as such. Past SCAN_MAX entries `exhausted` is set (the caller
 *  refuses: what was not read was not checked). */
function listFiles(dir: string, rel = '', out: { files: string[]; symlink: string | null; exhausted: boolean } = { files: [], symlink: null, exhausted: false }): typeof out {
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (out.symlink || out.exhausted) break;
    if (out.files.length >= SCAN_MAX) {
      out.exhausted = true;
      break;
    }
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isSymbolicLink()) out.symlink = r;
    else if (ent.isDirectory()) listFiles(dir, r, out);
    else out.files.push(r);
  }
  return out;
}

/** The rules files a codex session in `cwd` may read, absolute: the system's
 *  (`/etc/codex/rules`), the user's (`$CODEX_HOME/rules`), and every
 *  `.codex/rules` from the filesystem root down to `cwd`. Reading more than
 *  the session loads only makes the check stricter. */
function rulesFiles(cwd: string, codexHome: string): string[] {
  const out: string[] = [];
  const ancestors: string[] = [];
  for (let d = cwd; ; d = path.dirname(d)) {
    ancestors.unshift(path.join(d, '.codex', 'rules'));
    if (path.dirname(d) === d || ancestors.length > 64) break;
  }
  for (const dir of ['/etc/codex/rules', path.join(codexHome, 'rules'), ...ancestors]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names.sort()) if (n.endsWith('.rules')) out.push(path.join(dir, n));
  }
  return out;
}

/**
 * pty:create's stage. Returns `options` unchanged unless this is a bot
 * worker's codex line; then the guarded line, or this throws.
 */
export async function guardCodexBotWorker<T extends CodexGuardOptions>(
  options: T | undefined,
  worker: CodexGuardWorker | null,
  deps: CodexWorkerGuardDeps = {},
): Promise<T | undefined> {
  if (!options || !worker || !launchesCodex(options.initialCommand)) return options;
  // The fan-out's own launch: main marked this spawn in flight (never the
  // renderer's word alone), and it launches codex once.
  const owner = typeof options.fanoutTaskOf === 'string' ? options.fanoutTaskOf : '';
  if (!worker.strict || !worker.spawns || worker.spawns.length === 0 || !options.cwd
    || !(deps.claimLaunch ?? claimInflightCodexLaunch)(owner, options.cwd)) {
    throw refuse('codex runs in a bot\'s worker pane only as the fan-out\'s own first launch');
  }
  if ((deps.platform ?? process.platform) === 'win32') throw refuse('the codex worker guard is not available on Windows yet');
  const cwd = path.resolve(options.cwd);
  const parsed = parseCodexWorkerLine(options.initialCommand ?? '', cwd);
  if (!parsed) throw refuse('the launch line is not one the guard allows');
  const botIds = worker.spawns.map((s) => s.botId);
  const repoKey = (deps.repoKey ?? ((ids: readonly string[]) => (ids.length > 0 ? getBotStore()?.get(ids[0])?.repo?.repoKey : undefined)))(botIds);
  const connectors = taskConnectors(worker);
  const { line, codexHome } = await guardedCodexLine(parsed, cwd, repoKey, options.env, deps, connectors);
  // The session reads the rules and the config main checked: the codex home
  // goes into the pane's env, and into the record a resume rebuilds from.
  const out = { ...options, initialCommand: line, env: { ...(options.env ?? {}), CODEX_HOME: codexHome } };
  markGuardedCodexCreate(out, line, cwd, repoKey, codexHome, connectors);
  return out;
}

/**
 * A re-fire or a resume typed into a bot worker's codex pane: the folder and
 * repository come from main's session record (written at the guarded first
 * launch), never from the caller; the line is checked against the same
 * allowlist (a resume may name `codex resume <id>`), the worktree is checked
 * and the rules rewritten and proven again, and the line is rebuilt.
 */
export async function guardCodexSessionLine(
  record: { workspaceId?: string; agent?: string; cwd?: string; repoKey?: string; codexHome?: string } | null,
  line: string,
  deps: CodexWorkerGuardDeps = {},
  where = 'pty:write-launch',
): Promise<string> {
  if (!record || record.agent !== 'codex' || !record.cwd) {
    throw refuse('this pane has no guarded codex launch on record', where);
  }
  if ((deps.platform ?? process.platform) === 'win32') throw refuse('the codex worker guard is not available on Windows yet', where);
  const parsed = parseCodexWorkerLine(line, record.cwd, { resume: true });
  if (!parsed) throw refuse('the launch line is not one the guard allows', where);
  try {
    const connectors = (deps.sessionConnectors ?? sessionTaskConnectors)(record);
    return (await guardedCodexLine(parsed, record.cwd, record.repoKey, record.codexHome ? { CODEX_HOME: record.codexHome } : undefined, deps, connectors)).line;
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    throw message.startsWith('PTY_CREATE:') ? new Error(message.replace(/^PTY_CREATE:/, `${where}:`)) : refuse(message, where);
  }
}

/**
 * The stage for a line typed into an existing pane (worktask:refire,
 * pty:write-launch): in a bot worker's pane, a codex line goes through
 * guardCodexSessionLine and every other line through the merge guard's own
 * stage; any other pane's line is returned as given. Throws on a refusal
 * (nothing is typed).
 */
export async function guardBotWorkerSessionText(
  sessionId: string,
  text: string,
  kind: 'refire' | 'write-launch',
  deps: CodexWorkerGuardDeps & { dir?: string; folders?: readonly string[] } = {},
): Promise<string> {
  if (namesCodex(text) && isBotWorkerSession(sessionId, deps.dir)) {
    return guardCodexSessionLine(botWorkerSessionRecord(sessionId, deps.dir), text, deps, kind === 'refire' ? 'worktask:refire' : 'pty:write-launch');
  }
  const guardDeps = { ...(deps.dir ? { dir: deps.dir } : {}), ...(deps.folders ? { folders: deps.folders } : {}) };
  return kind === 'refire' ? guardRefireLine(sessionId, text, guardDeps) : guardSessionLaunch(sessionId, text, guardDeps);
}

/** A re-fire's or resume's connections: its task's that are still its
 *  bot's (botWorkerMergeGuard ledgerTaskConnectors). */
function sessionTaskConnectors(record: { workspaceId?: string }): Connector[] {
  return record.workspaceId ? ledgerTaskConnectors(record.workspaceId) : [];
}

/** Steps 2-4 and the rebuilt line (see the file header). Throws on any refusal. */
async function guardedCodexLine(
  parsed: NonNullable<ReturnType<typeof parseCodexWorkerLine>>,
  cwd: string,
  repoKey: string | undefined,
  createEnv: Record<string, string> | undefined,
  deps: CodexWorkerGuardDeps,
  connectors: readonly Connector[] = [],
): Promise<{ line: string; codexHome: string }> {
  for (const c of connectors) {
    const why = codexConnectorRefusal(c);
    if (why) throw refuse(why);
  }
  if ((deps.platform ?? process.platform) === 'win32') throw refuse('the codex worker guard is not available on Windows yet');
  const run = deps.run ?? defaultRun;
  // The pane's environment as far as main knows it: the login shell's PATH,
  // then the create's own env (a profile's, an account's CODEX_HOME).
  const env = { ...(await (deps.paneEnv ?? (() => agentExecEnv(process.env)))()), ...(createEnv ?? {}) };
  // Main's git in the worktree: never with a config key that runs a program
  // (worktask/workerGit.ts), no fsmonitor, no hooks.
  const safe = workerGitSafeArgs(deps.noHooksDir ?? path.join(getWmuxDir(), 'factory', 'no-hooks'));
  const gitEnv = workerGitEnv(env);
  const gitRun = (args: string[]) => run('git', [...safe, ...args], { cwd, env: gitEnv });
  const pre = await workerGitPreflight(gitRun);
  if (!pre.ok) throw refuse(pre.error);
  const git = async (args: string[]): Promise<string> => {
    const r = await gitRun(args);
    if (r.code !== 0) throw refuse(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 300)}`);
    return r.stdout.trim();
  };

  // 2. The worktree's .codex/: no symlink, nothing untracked but ours.
  const gitDir = await git(['rev-parse', '--path-format=absolute', '--git-dir']);
  const commonDir = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const tracked = new Set((await git(['ls-files', '-z', '--', '.codex'])).split('\0').filter(Boolean));
  if (tracked.has(CODEX_WORKER_RULES_PATH)) throw refuse(`the repository tracks ${CODEX_WORKER_RULES_PATH}`);
  // Codex reads a trusted project's .codex/config.toml over the user's config
  // (its MCP servers and tool approvals included), and the worktree is
  // trusted: a worker launches only without one.
  if (fs.existsSync(path.join(cwd, '.codex', 'config.toml'))) throw refuse('the worktree has a .codex/config.toml; a bot\'s codex worker runs only on the owner\'s codex config');
  const codexDir = path.join(cwd, '.codex');
  for (const p of [codexDir, path.join(codexDir, 'rules')]) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw refuse(`${path.relative(cwd, p)} is a symlink`);
  }
  if (fs.existsSync(codexDir)) {
    const listed = listFiles(codexDir);
    if (listed.symlink) throw refuse(`.codex/${listed.symlink} is a symlink`);
    if (listed.exhausted) throw refuse(`.codex/ holds more than ${SCAN_MAX} files`);
    const stray = listed.files.map((f) => `.codex/${f}`).filter((f) => f !== CODEX_WORKER_RULES_PATH && !tracked.has(f));
    if (stray.length > 0) throw refuse(`.codex/ holds files the repository does not track (${stray.slice(0, 3).join(', ')})`);
  }

  // 3. The rules file, and the exclude line.
  const rules = buildCodexWorkerRules({ ...(repoKey ? { repoKey } : {}), cwd, gitDirs: [...new Set([gitDir, commonDir])] });
  const rulesFile = path.join(cwd, CODEX_WORKER_RULES_PATH);
  fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
  const tmp = `${rulesFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, rules, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(tmp, rulesFile);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw refuse(`the rules file could not be written: ${String(err)}`);
  }
  await excludeLineOnce(path.join(commonDir, 'info', 'exclude'), CODEX_WORKER_EXCLUDE_LINE).catch((err) => { throw refuse(`info/exclude could not be written: ${String(err)}`); });

  // 4. The pane's codex: its version, and the rules it will load. The line
  // still names plain `codex`, so the pane shell's own codex wrapper (shell
  // integration: no shared app-server, the pane's identity) runs it; the
  // binary checked here is the one the same PATH resolves.
  const codex = await (deps.resolveCodex ?? (async (e: NodeJS.ProcessEnv) => resolveOnPath('codex', e)))(env);
  if (!codex) throw refuse('codex is not on the pane\'s PATH');
  const version = parseCodexVersion((await run(codex, ['--version'], { cwd, env })).stdout);
  if (!version || !codexVersionAtLeastFloor(version)) throw refuse(`codex ${version ? version.join('.') : '(unknown version)'} is older than ${CODEX_WORKER_MIN_VERSION}`);
  const home = deps.home ?? os.homedir();
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const files = rulesFiles(cwd, codexHome);
  const canary = await run(codex, ['execpolicy', 'check', ...files.flatMap((f) => ['--rules', f]), 'git', 'push', 'origin', 'HEAD'], { cwd, env });
  type Decision = { decision?: unknown; matchedRules?: { prefixRuleMatch?: { justification?: unknown } }[] };
  let decision: Decision | null;
  try {
    decision = JSON.parse(canary.stdout) as Decision;
  } catch {
    decision = null;
  }
  const ours = (decision?.matchedRules ?? []).some((m) => typeof m.prefixRuleMatch?.justification === 'string' && m.prefixRuleMatch.justification.startsWith(CODEX_WORKER_JUSTIFICATION_PREFIX));
  if (canary.code !== 0 || decision?.decision !== 'forbidden' || !ours) {
    throw refuse(`the codex rules do not load as written (${(canary.stderr || canary.stdout).trim().slice(0, 300) || 'no forbidden decision'})`);
  }

  // 1. The line main launches.
  // The wmux tool approvals: only when the config defines the server (an
  // override of an undefined one stops codex), and never past a tool the
  // config approves under a name the line cannot set back to ask.
  const configPath = path.join(codexHome, 'config.toml');
  const ownerApproved = codexWmuxApprovedTools(configPath);
  const unwritable = ownerApproved.filter((t) => !isCodexToolKey(t));
  if (unwritable.length > 0) throw refuse(`the codex config approves wmux tools a launch cannot set back to ask (${unwritable.slice(0, 3).join(', ')})`);
  const roots = codexWorkerWritableRoots(gitDir, commonDir);
  if (!roots) throw refuse('the worker\'s folder is not a linked git worktree');
  // The worker's MCP servers: wmux and the task's connections, every other
  // server of the owner's and the system's codex config off (an override of
  // a server no config defines stops codex, so the names come from them).
  const system = deps.systemCodexDir ?? '/etc/codex';
  const layers = [configPath, path.join(system, 'config.toml'), path.join(system, 'managed_config.toml')].map(codexMcpServerNames);
  if (layers.some((l) => l === null)) throw refuse('a codex config could not be read, so its MCP servers could not be turned off');
  const ownerServers = [...new Set(layers.flatMap((l) => l ?? []))];
  const clash = connectors.find((c) => ownerServers.includes(c.name));
  if (clash) throw refuse(`the codex config has its own server named ${clash.name}, the name of a connection`);
  const unnamed = ownerServers.filter((n) => n !== 'wmux' && !/^[A-Za-z0-9_-]{1,64}$/.test(n));
  if (unnamed.length > 0) throw refuse(`the codex config has a server a launch cannot turn off by name (${unnamed[0].slice(0, 64)})`);
  let mcpWords: string[] | null;
  try {
    const { runDir, npmrc } = prepareConnectorRunDirs(deps.dir ?? getWmuxDir(), connectors);
    mcpWords = codexWorkerMcpWords({ ownerServers, connectors, runDir, npmrc });
  } catch (err) {
    throw refuse(`a connection's run folder could not be made: ${String(err)}`);
  }
  if (!mcpWords) throw refuse('a connection cannot be written into the launch line (a quote or backslash in its settings)');
  const line = buildCodexWorkerLaunchLine(parsed, cwd, roots, {
    ...(codexDefinesWmuxServer(configPath) ? { toolApprovals: { ownerApproved } } : {}),
    ...(parsed.wmuxTools ? { mcpEntry: (deps.mcpEntry ?? currentMcpEntry)() ?? undefined } : {}),
    mcpWords,
  });
  if (!line) throw refuse('a worktree path cannot be written into the launch line');
  return { line, codexHome };
}
