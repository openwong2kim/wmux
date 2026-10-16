// ─── task.push — main pushes a worker's own task branch ─────────────────────
//
// A bot's fan-out worker may not run `git push` itself (its deny rules refuse
// every form, shared/botWorkerGuard.ts). Its branch reaches the remote here,
// from main, with a fixed shape the worker cannot change:
//
//   - WHICH branch: the task's own branch, from main's task record (the
//     worker's verified pane → its task workspace → the open ledger row →
//     the WorkTask main created). Never a name from the wire.
//   - WHERE: origin's URL, read from the repository config right before the
//     push and pushed to as a URL (not through the remote's name). Refused
//     when origin sets anything but its URL and fetch refspec, when any URL
//     rewrite or a program-running key is set (worktask/workerGit.ts), and —
//     for a bot's task — when the URL is not a plain https/ssh address of the
//     bot's own repository. A task of the operator's goes to the operator's
//     own origin.
//   - HOW: fast-forward only (no force, no `+`), the branch alone (no tags
//     follow it, no submodule is pushed), never onto a default branch
//     (main/master, every default branch main recorded, and the repository's
//     own), never for a task on a detached checkout (the verify preset grades
//     a commit; it has no branch to publish).
//   - main's git runs with no fsmonitor and the worktree's own hooks do not
//     run (`core.hooksPath` pointed at an empty folder, `--no-verify`).
//   - IN WHICH git: on Windows, a task whose repository lives inside a WSL
//     distro (its worktree's `.git` names a `\\wsl$\<distro>\…` or
//     `\\wsl.localhost\<distro>\…` gitdir) is pushed by that distro's own
//     git, through `wsl.exe -d <distro> --exec git --git-dir=<linux path>`
//     (argv only, no shell), so the distro's ssh keys and credential helpers
//     apply. Every step — the config check, the default-branch read, the push
//     and the upstream writes — runs in that one git. A gitdir under a WSL
//     host whose distro or path cannot be read is refused, never guessed.
//     Any other task is pushed by main's own git.
//   - The repository's own default branch is refused under every name it is
//     read by: GitHub's (by key), origin/HEAD, and the remote's own HEAD
//     (`ls-remote --symref` at the pushed URL), which needs no GitHub and no
//     ref the worker can write.
//
// Any fan-out worker may call it; for a bot's worker it is the only way to
// publish. Afterwards main sets the branch's upstream to origin, so
// `gh pr create` finds the pushed branch.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';
import { mergeWslEnv } from '../../shared/wsl';
import { decodeWslOutput, isValidWslDistroName } from '../../shared/wslDistro';
import { BOT_WORKER_FALLBACK_DEFAULT_BRANCHES, isDenyableBranchName } from '../../shared/botWorkerGuard';
import { normalizeRepoKey } from '../../shared/repoKey';
import { originUrlRepoKey, workerGitEnv, workerGitPreflight, workerGitSafeArgs, workerOriginRefusal } from './workerGit';

const execFileP = promisify(execFile);

export const TASK_PUSH_TIMEOUT_MS = 120_000;

/** Runs git in `cwd`; resolves with the exit code and output, never throws. */
export type TaskPushGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface TaskPushInput {
  /** The task's worktree (main's record). */
  worktreePath: string;
  /** The task's branch (main's record). */
  branch: string;
  /** Default branches main recorded for this instance (main/master are
   *  always added). */
  defaultBranches: readonly string[];
  /** An empty folder for `core.hooksPath`. */
  noHooksDir: string;
  /** A bot's task: the repository the push must land in (`host/owner/repo`
   *  or `owner/repo`). Absent for a task of the operator's. */
  expectedRepoKey?: string;
  /** The repository's own default branch, read by its key (never from the
   *  worktree). */
  repoDefaultBranch?: (repoKey: string) => Promise<string | null>;
}

export type TaskPushResult =
  | { ok: true; branch: string; remote: 'origin'; head: string; output: string }
  | { ok: false; reason: 'branch-refused' | 'no-origin' | 'remote-refused' | 'config-refused' | 'rejected' | 'git-failed'; error: string };

export async function defaultGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...workerGitEnv(getExecEnv()), GIT_TERMINAL_PROMPT: '0' };
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd, env, timeout: TASK_PUSH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' && e.stderr ? e.stderr : (e.message ?? String(err)),
    };
  }
}

/** Why main will not push this branch, or null. Pure. */
export function taskPushBranchRefusal(branch: string, defaultBranches: readonly string[]): string | null {
  if (!isDenyableBranchName(branch)) return 'the task branch name cannot be pushed as itself';
  const defaults = new Set([...BOT_WORKER_FALLBACK_DEFAULT_BRANCHES, ...defaultBranches]);
  if (defaults.has(branch)) return `the task branch ${branch} is a default branch; main never pushes onto one`;
  return null;
}

/** The git argv of main's push (after the safe `-c` options). Pure. */
export function taskPushArgs(branch: string, url: string): string[] {
  return ['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--porcelain', '--', url, `HEAD:refs/heads/${branch}`];
}

/** Which git pushes a worktree: main's own, or a WSL distro's. */
export type TaskPushGitTarget =
  | { kind: 'host' }
  | { kind: 'wsl'; distro: string; gitDir: string }
  | { kind: 'refused'; error: string };

const WSL_GITDIR_RE = /^(?:\\\\|\/\/)(?:wsl\$|wsl\.localhost)[\\/]([^\\/]*)(.*)$/i;

/** The git that pushes a worktree, from its `.git` file's text (null: a
 *  `.git` folder or none). Only on Windows is a gitdir under a WSL host a
 *  distro's; its Linux path must be absolute and plain. Pure. */
export function taskPushGitTarget(dotGit: string | null, platform: NodeJS.Platform = process.platform): TaskPushGitTarget {
  if (platform !== 'win32' || dotGit === null) return { kind: 'host' };
  const line = /^gitdir:[ \t]*(.*?)[ \t]*$/m.exec(dotGit.replace(/\r/g, ''));
  if (!line) return { kind: 'host' };
  const m = WSL_GITDIR_RE.exec(line[1]);
  if (!m) return { kind: 'host' };
  const distro = m[1];
  if (!isValidWslDistroName(distro)) {
    return { kind: 'refused', error: `the task's repository is inside WSL, but the distro in its gitdir (${JSON.stringify(line[1].slice(0, 300))}) cannot be read` };
  }
  const gitDir = m[2].replace(/\\/g, '/');
  const segs = gitDir.split('/').slice(1);
  // eslint-disable-next-line no-control-regex
  if (!gitDir.startsWith('/') || segs.some((s) => !s || s === '.' || s === '..') || /[\x00-\x1f\x7f]/.test(gitDir)) {
    return { kind: 'refused', error: `the task's repository is inside WSL distro ${distro}, but its gitdir path (${JSON.stringify(line[1].slice(0, 300))}) cannot be used` };
  }
  return { kind: 'wsl', distro, gitDir };
}

/** Runs `file` with `args`; resolves with the exit code and output, never
 *  throws. */
export type TaskPushExec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>;

async function defaultWslExec(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  // The Linux child's bytes are UTF-8 (a NUL in `config -z` is data). wsl.exe's
  // own failure text may be UTF-16 and lands on stdout or stderr; it is read
  // from stdout only when the run failed with nothing on stderr.
  const opts = { cwd: os.homedir(), env, timeout: TASK_PUSH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'buffer' as const };
  try {
    const { stdout, stderr } = await execFileP(file, args, opts);
    return { code: 0, stdout: stdout.toString('utf8'), stderr: decodeWslOutput(stderr) };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    let stderr = Buffer.isBuffer(e.stderr) && e.stderr.length > 0 ? decodeWslOutput(e.stderr).trim() : '';
    if (!stderr && Buffer.isBuffer(e.stdout) && e.stdout.length > 0) stderr = decodeWslOutput(e.stdout).trim();
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: Buffer.isBuffer(e.stdout) ? e.stdout.toString('utf8') : '',
      stderr: stderr || (e.message ?? String(err)),
    };
  }
}

/** The wsl.exe argv that runs `git <args>` on a gitdir inside a distro.
 *  `--exec` runs git with no shell; `--cd /` keeps the worktree's folder out
 *  of it. Pure. */
export function wslGitArgv(distro: string, gitDir: string, args: readonly string[]): string[] {
  return ['-d', distro, '--cd', '/', '--exec', 'git', `--git-dir=${gitDir}`, ...args];
}

/** A TaskPushGit that runs inside a WSL distro on its gitdir (the `cwd` it is
 *  handed — the worktree's Windows path — is not used). */
export function wslTaskPushGit(distro: string, gitDir: string, exec: TaskPushExec = defaultWslExec, systemRoot = process.env.SystemRoot): TaskPushGit {
  const wslExe = path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
  const base = getExecEnv();
  // GIT_TERMINAL_PROMPT reaches the distro only by name in WSLENV.
  const env = { ...base, GIT_TERMINAL_PROMPT: '0', WSL_UTF8: '1', WSLENV: mergeWslEnv(base.WSLENV, ['GIT_TERMINAL_PROMPT']) };
  return (args) => exec(wslExe, wslGitArgv(distro, gitDir, args), env);
}

export function readDotGitFile(worktreePath: string): string | null {
  try {
    const p = path.join(worktreePath, '.git');
    return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

export interface TaskPushDeps {
  platform?: NodeJS.Platform;
  /** The worktree's `.git` file text, or null (a folder, or none). */
  readDotGit?: (worktreePath: string) => string | null;
  /** Runs wsl.exe (a WSL distro's git). */
  wslExec?: TaskPushExec;
}

/** `ls-remote --symref` output → the remote HEAD's branch, or null. Pure. */
export function parseLsRemoteHead(stdout: string): string | null {
  const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(stdout.replace(/\r/g, ''));
  return m ? m[1] : null;
}

/** Push the task branch. Never throws. `git` is main's own git (a task in a
 *  WSL distro uses that distro's, see TaskPushGitTarget). */
export async function pushTaskBranch(input: TaskPushInput, git: TaskPushGit = defaultGit, deps: TaskPushDeps = {}): Promise<TaskPushResult> {
  const branchRefusal = taskPushBranchRefusal(input.branch, input.defaultBranches);
  if (branchRefusal) return { ok: false, reason: 'branch-refused', error: branchRefusal };
  const platform = deps.platform ?? process.platform;
  const target = taskPushGitTarget(platform === 'win32' ? (deps.readDotGit ?? readDotGitFile)(input.worktreePath) : null, platform);
  if (target.kind === 'refused') return { ok: false, reason: 'git-failed', error: target.error };
  // In a distro the hooks folder is a Linux path; /dev/null holds no hook.
  const safe = workerGitSafeArgs(target.kind === 'wsl' ? '/dev/null' : path.resolve(input.noHooksDir));
  const runner = target.kind === 'wsl' ? wslTaskPushGit(target.distro, target.gitDir, deps.wslExec) : git;
  const run = (args: string[]) => runner([...safe, ...args], input.worktreePath);
  const pre = await workerGitPreflight(run);
  if (!pre.ok) return { ok: false, reason: 'config-refused', error: pre.error };
  const origin = workerOriginRefusal(pre.entries);
  if ('error' in origin) {
    return { ok: false, reason: /no origin remote/.test(origin.error) ? 'no-origin' : 'remote-refused', error: origin.error };
  }
  const key = originUrlRepoKey(origin.url);
  if (input.expectedRepoKey !== undefined) {
    const expected = normalizeRepoKey(input.expectedRepoKey);
    if (!expected || !key || key !== expected) {
      return { ok: false, reason: 'remote-refused', error: `origin is not ${input.expectedRepoKey} (a plain https or ssh address of it)` };
    }
  }
  // The repository's own default branch, under every name it is read by:
  // GitHub's by the key, origin/HEAD, and the remote's HEAD at the pushed URL
  // (the one answer no worker-written ref can change, and no GitHub needed).
  const own: string[] = [];
  const byKey = key && input.repoDefaultBranch ? await input.repoDefaultBranch(key).catch(() => null) : null;
  if (byKey) own.push(byKey);
  const ref = await run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const name = ref.code === 0 ? ref.stdout.trim() : '';
  if (name.startsWith('refs/remotes/origin/')) own.push(name.slice('refs/remotes/origin/'.length));
  const remote = await run(['ls-remote', '--symref', '--', origin.url, 'HEAD']);
  const remoteHead = remote.code === 0 ? parseLsRemoteHead(remote.stdout) : null;
  if (remoteHead) own.push(remoteHead);
  if (own.length > 0) {
    const refusal = taskPushBranchRefusal(input.branch, [...input.defaultBranches, ...own]);
    if (refusal) return { ok: false, reason: 'branch-refused', error: refusal };
  }
  const head = await run(['rev-parse', 'HEAD']);
  if (head.code !== 0) return { ok: false, reason: 'git-failed', error: `git rev-parse HEAD failed: ${head.stderr.trim().slice(0, 500)}` };
  const sha = head.stdout.trim();
  const res = await run(taskPushArgs(input.branch, origin.url));
  const output = `${res.stdout}\n${res.stderr}`.trim().slice(0, 2000);
  if (res.code !== 0) {
    // --porcelain marks a refused ref with `!` (non-fast-forward, remote hook).
    const rejected = /^!\t/m.test(res.stdout);
    return { ok: false, reason: rejected ? 'rejected' : 'git-failed', error: output || `git push exited ${res.code}` };
  }
  // The upstream, as `--set-upstream origin` would set it.
  await run(['update-ref', `refs/remotes/origin/${input.branch}`, sha]);
  await run(['config', `branch.${input.branch}.remote`, 'origin']);
  await run(['config', `branch.${input.branch}.merge`, `refs/heads/${input.branch}`]);
  return { ok: true, branch: input.branch, remote: 'origin', head: sha, output };
}
