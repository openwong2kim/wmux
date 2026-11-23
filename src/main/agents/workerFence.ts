// ─── The worker fence: the one settings file an unattended worker runs with ─
//
// An unattended claude worker (a bot preset in `bypassPermissions`, a fan-out
// worker in `auto`) runs with ONE `--settings` document that confines it to
// its worktree and its own temp folder:
//   - Claude Code's OS sandbox (Seatbelt on macOS, bubblewrap on Linux) for
//     Bash: writes only in the worktree, the worker's temp folder and the
//     repository's trusted test paths; the shared `.git` narrowed to what a
//     commit on the worker's own branch needs; the named credential files
//     unreadable;
//   - a PreToolUse hook (matcher `.*`) for claude's built-in file tools, which
//     run in claude's own process, outside the sandbox: a write lands only
//     inside the worktree or the temp folder (workerFenceHookScript);
//   - a permission deny on the same credential files, because the Read tool
//     does not go through the sandbox's denyRead.
// Where the sandbox cannot run (Windows, WSL, Linux without bubblewrap) the
// document carries the hook and the permission denies only, and says so
// (`weaker`).
//
// Everything here is pure: main computes the git facts and paths at launch
// and passes them in. Wiring it into a launch is the caller's job.

import os from 'node:os';
import path from 'node:path';
import { launcherStem, tokenize, type PermissionMode } from '../../shared/agentResume';
import { WORKER_FENCE_FILE_ALLOW_RULE, WORKER_FENCE_REFUSED_PERMISSION_KEYS, WORKER_FENCE_REFUSED_SETTINGS_KEYS, WORKER_FENCE_REFUSED_WMUX_TOOLS, isClaudeLauncher, namesClaude, spliceSettingsFlag } from '../../shared/botWorkerGuard';
import { splitModelEnvMarker } from '../../shared/workerLaunch';
import { WRAPPER_STEMS } from '../../shared/paneFence';
import { botSandboxDenyRead, type BotSandboxInput } from '../factory/botExecSandbox';
import { WORKER_GATE_TIMEOUT_S } from './workerToolGate';

// ── The credential set ───────────────────────────────────────────────────────

/**
 * The paths no fenced worker reads: the bot sandbox's named list
 * (botSandboxDenyRead), without the whole home folder (a worker works in it),
 * without GitHub's CLI config (a worker reads GitHub through `gh`), and with
 * each Claude config folder narrowed to its sign-in files (`.credentials.json`,
 * and `.claude.json` in a folder other than `~/.claude`, as `~/.claude.json`
 * is for it; the rest, its shell snapshots included, is what the worker's own
 * commands read).
 */
export function workerFenceCredentialPaths(input: BotSandboxInput): string[] {
  const home = path.resolve(input.home ?? os.homedir());
  const claudeDirs = new Set(
    [path.join(home, '.claude'), input.env.CLAUDE_CONFIG_DIR, ...(input.accountConfigDirs ?? [])]
      .filter((d): d is string => typeof d === 'string' && path.isAbsolute(d))
      .map((d) => path.resolve(d)),
  );
  const gh = path.join(home, '.config', 'gh');
  const out = new Set<string>();
  for (const raw of botSandboxDenyRead({ ...input, home })) {
    const p = path.resolve(raw);
    if (p === home || p === gh) continue;
    if (path.basename(p) === 'shell-snapshots' && claudeDirs.has(path.dirname(p))) continue;
    if (!claudeDirs.has(p)) {
      out.add(p);
      continue;
    }
    out.add(path.join(p, '.credentials.json'));
    if (p !== path.join(home, '.claude')) out.add(path.join(p, '.claude.json'));
  }
  return [...out];
}

// ── The builder ──────────────────────────────────────────────────────────────

export interface WorkerFenceInput {
  /** The worker's worktree (absolute, real path). */
  worktree: string;
  /** The worker's own temp folder, made by main (absolute, real path). */
  workerTempDir: string;
  /** The repository's git common dir (absolute, real path). */
  gitCommonDir: string;
  /** The worktree is a linked one (`git worktree add`), not the main checkout. */
  isLinkedWorktree: boolean;
  /** A linked worktree's folder name under `<gitCommonDir>/worktrees/`; null
   *  for the main checkout. */
  ownWorktreeName: string | null;
  /** The worker's own branch (null when detached). */
  ownBranch: string | null;
  /** Every other local branch at launch. */
  otherBranches: readonly string[];
  /** Every other linked worktree's folder name under `<gitCommonDir>/worktrees/`. */
  otherWorktrees: readonly string[];
  /** Claude Code's sandbox runs here (platform tools and claude version). */
  platformCapable: boolean;
  /** Extra write paths the repository's trusted wmux.json names for its tests. */
  repoTestWritePaths: readonly string[];
  /** The worker's permission mode. */
  permissionMode: PermissionMode;
  /** The hook's command (workerFenceHookCommand). */
  hookCommand: string;
  /** The credential paths (workerFenceCredentialPaths). */
  credentialPaths: readonly string[];
  /** The owner's home folder (permission rules name paths in it by `~/`). */
  home: string;
  /** More paths the sandbox's commands may not write (absolute; a glob
   *  where the platform's sandbox takes one): other sessions' folders in
   *  claude's own temp folder, which the sandbox always lets commands write. */
  extraDenyWrite?: readonly string[];
  /** Which of the git denies to keep (default: all). On Linux main keeps
   *  only the paths that exist, as bubblewrap binds each one. */
  keepGitDeny?: (p: string) => boolean;
}

export interface WorkerFence {
  /** The worker's settings document (before WorkerFenceLaunch merges in what
   *  the launch also needs). */
  settings: Record<string, unknown>;
  /** The sandbox is not part of it: only the hook and the permission denies. */
  weaker: boolean;
}

/** Domains the sandbox lets through without asking. The list is not strict:
 *  another domain is asked about (auto) or let through (bypass). */
export const WORKER_FENCE_ALLOWED_DOMAINS: readonly string[] = ['github.com', 'api.github.com', 'registry.npmjs.org'];

const FILE_RULE_TOOLS: readonly string[] = ['Read', 'Edit', 'Write'];

function requireAbsolute(what: string, p: string): string {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw new Error(`worker fence: ${what} is not an absolute path`);
  return path.resolve(p);
}

/** A name that joins under a folder as itself: no separator, not `.`/`..`. */
function requireFolderName(what: string, name: string): string {
  if (typeof name !== 'string' || name.length === 0 || /[\\/\0]/.test(name) || name === '.' || name === '..') {
    throw new Error(`worker fence: ${what} ${JSON.stringify(name)} is not a folder name`);
  }
  return name;
}

/** A branch name that joins under `refs/heads/` as itself: no empty, `.` or
 *  `..` part, no backslash and no control character. Git refuses all of them,
 *  so a real branch always passes; anything else stops the build rather than
 *  leave a branch without its deny. */
function requireBranchPath(name: string): string[] {
  const parts = typeof name === 'string' ? name.split('/') : [];
  const control = [...(typeof name === 'string' ? name : '')].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
  if (parts.length === 0 || control || name.includes('\\') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`worker fence: branch ${JSON.stringify(name)} cannot be named under refs/heads`);
  }
  return parts;
}

/** `child` is `parent` or inside it (both absolute, resolved). Pure. */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * The paths in the git common dir the worker's commands may write. A linked
 * worktree: the loose objects, its own folder under `worktrees/`, and the
 * folder its branch's ref and reflog sit in (`refs/heads/` and
 * `logs/refs/heads/` themselves for a branch with no `/`); nothing for the
 * refs of a detached one. The main checkout's git dir is the common dir, so
 * it is the whole of it. The denies (workerFenceGitDenies) narrow both.
 * Pure.
 */
export function workerFenceGitWrites(input: Pick<WorkerFenceInput, 'gitCommonDir' | 'isLinkedWorktree' | 'ownWorktreeName' | 'ownBranch'>): string[] {
  const git = requireAbsolute('the git common dir', input.gitCommonDir);
  if (!input.isLinkedWorktree) return [git];
  if (input.ownWorktreeName === null) throw new Error('worker fence: a linked worktree needs its folder name under worktrees/');
  const out = [path.join(git, 'objects'), path.join(git, 'worktrees', requireFolderName('worktree', input.ownWorktreeName))];
  if (input.ownBranch !== null) {
    const parent = requireBranchPath(input.ownBranch).slice(0, -1);
    out.push(path.join(git, 'refs', 'heads', ...parent), path.join(git, 'logs', 'refs', 'heads', ...parent));
  }
  return out;
}

/**
 * The paths in the git common dir the worker's commands may not write. What
 * a commit on its own branch writes (loose objects, its own ref, its own
 * index, the logs) stays open; its own HEAD (a commit on a branch moves the
 * ref, not HEAD) does not while it is on a branch; packs, every other ref, replace refs
 * and notes, the main checkout's HEAD, hooks, config, `info/` (grafts,
 * attributes), `shallow`, `objects/info/` (alternates), submodules' git dirs,
 * the reftable store (a reftable repository's refs are not files) and every
 * other worktree's metadata do not, nor a linked worktree's own pointers back
 * to the repository (`commondir`, `gitdir`).
 * A linked worktree also keeps off the main checkout's index; a main-checkout
 * worker needs its own. Each other branch is denied by its own ref file: a
 * deny on `refs/heads` would win over the worker's own ref inside it. Pure.
 */
export function workerFenceGitDenies(input: Pick<WorkerFenceInput, 'gitCommonDir' | 'isLinkedWorktree' | 'ownWorktreeName' | 'ownBranch' | 'otherBranches' | 'otherWorktrees'>): string[] {
  const git = requireAbsolute('the git common dir', input.gitCommonDir);
  let ownGitDir = git;
  if (input.isLinkedWorktree) {
    if (input.ownWorktreeName === null) throw new Error('worker fence: a linked worktree needs its folder name under worktrees/');
    ownGitDir = path.join(git, 'worktrees', requireFolderName('worktree', input.ownWorktreeName));
  }
  const out = new Set<string>([
    path.join(git, 'objects', 'pack'),
    path.join(git, 'packed-refs'),
    path.join(git, 'refs', 'remotes'),
    path.join(git, 'refs', 'tags'),
    path.join(git, 'refs', 'replace'),
    path.join(git, 'refs', 'notes'),
    path.join(git, 'HEAD'),
    path.join(git, 'hooks'),
    path.join(git, 'config'),
    path.join(git, 'info'),
    path.join(git, 'objects', 'info'),
    path.join(git, 'modules'),
    path.join(git, 'shallow'),
    path.join(git, 'reftable'),
    // Remotes git still reads from files of their own.
    path.join(git, 'remotes'),
    path.join(git, 'branches'),
    path.join(ownGitDir, 'config.worktree'),
  ]);
  if (input.isLinkedWorktree) {
    out.add(path.join(git, 'index'));
    out.add(path.join(ownGitDir, 'commondir'));
    out.add(path.join(ownGitDir, 'gitdir'));
    if (input.ownBranch !== null) out.add(path.join(ownGitDir, 'HEAD'));
  } else {
    // The main checkout's git dir is the common dir, all of it writable but
    // for these: no linked worktree's metadata, made before launch or after.
    out.add(path.join(git, 'worktrees'));
  }
  for (const name of input.otherWorktrees) {
    if (name === input.ownWorktreeName) continue;
    out.add(path.join(git, 'worktrees', requireFolderName('worktree', name)));
  }
  for (const branch of input.otherBranches) {
    const parts = requireBranchPath(branch);
    if (branch === input.ownBranch) continue;
    out.add(path.join(git, 'refs', 'heads', ...parts));
  }
  return [...out];
}

/** The most patterns workerFenceWorktreeComplement gives: a second guard
 *  under WORKER_FENCE_DENY_WRITE_MAX_BYTES, which is the bound the
 *  self-test proves. Measured with Claude Code 2.1.311 on macOS: 199 and 799
 *  applied, 1599 did not ("profile too large", and then no command runs).
 *  wmux names a task's folder in at most 33 characters, about 170 patterns. */
export const WORKER_FENCE_COMPLEMENT_MAX = 200;
/** The most a launch's denied write paths may take, as JSON in UTF-8 bytes,
 *  with the patterns: the profile's limit is its size, and the macOS
 *  self-test applies a profile this large before any launch adds them. 799
 *  patterns, 131 KB of them, applied in the measurement above. */
export const WORKER_FENCE_DENY_WRITE_MAX_BYTES = 64 * 1024;

const COMPLEMENT_NAME = /^[0-9A-Za-z._-]+$/;
/** A common dir's path the patterns may start with: only characters a glob
 *  and the profile's regex read as themselves (measured: space too). */
const PLAIN_PATH = /^[A-Za-z0-9._/ -]+$/;

/** `lo-hi` without `c`, as a class's ranges. */
function rangeWithout(lo: string, hi: string, c: string): string {
  if (c < lo || c > hi) return `${lo}-${hi}`;
  const out: string[] = [];
  const before = String.fromCharCode(c.charCodeAt(0) - 1);
  const after = String.fromCharCode(c.charCodeAt(0) + 1);
  if (c > lo) out.push(before === lo ? lo : `${lo}-${before}`);
  if (c < hi) out.push(after === hi ? hi : `${after}-${hi}`);
  return out.join('');
}

/** Every letter and digit but `c`, in either case: the sandbox matches
 *  paths without regard to case, so `[A-Z]` would match `w` too. */
function classWithout(c: string): string {
  return `[${rangeWithout('0', '9', c)}${rangeWithout('A', 'Z', c.toUpperCase())}${rangeWithout('a', 'z', c.toLowerCase())}]`;
}

/**
 * macOS: claude keeps a linked worktree's whole git common dir writable,
 * so the snapshot of other worktrees (workerFenceGitDenies) misses one made
 * after launch. These globs deny every folder under `worktrees/` but the
 * worker's own: a name that differs from it at some position (a letter,
 * digit, `.`, `_` or `-` other than its own there), a shorter name it
 * starts with, and a longer one that starts with it. Every one is a glob
 * (a shorter name's last character in a class), read the same way: without
 * regard to case, the folder and what it holds. Classes take ranges only: a
 * negated class is not one, and a long list of characters breaks the
 * profile. Null (keep to the snapshot) when the name has another
 * character, the common dir's path has one other than a letter, digit,
 * space, `.`, `_`, `-` or `/`, or the
 * patterns would pass WORKER_FENCE_COMPLEMENT_MAX. What it leaves: a name
 * with another character where it differs, or one that differs from the
 * worker's only in case. Pure.
 */
export function workerFenceWorktreeComplement(gitCommonDir: string, ownName: string): string[] | null {
  const git = requireAbsolute('the git common dir', gitCommonDir);
  if (!COMPLEMENT_NAME.test(ownName) || ownName === '.' || ownName === '..' || !PLAIN_PATH.test(git)) return null;
  const root = path.join(git, 'worktrees');
  const out: string[] = [];
  for (let i = 0; i < ownName.length; i++) {
    const head = ownName.slice(0, i);
    const c = ownName[i];
    out.push(`${head}${classWithout(c)}*`);
    if (c !== '.') out.push(`${head}[.]*`);
    if (c !== '_') out.push(`${head}_*`);
    if (c !== '-') out.push(`${head}-*`);
  }
  for (let i = 1; i < ownName.length; i++) out.push(`${ownName.slice(0, i - 1)}[${ownName[i - 1]}]`);
  out.push(`${ownName}?*`);
  return out.length > WORKER_FENCE_COMPLEMENT_MAX ? null : out.map((p) => `${root}/${p}`);
}

/** The files at the worktree's root through which claude runs a program
 *  outside the fence when its next session starts there: project settings
 *  (hooks) and MCP servers. Paths relative to the worktree, `/`-separated.
 *  Instructions (CLAUDE.md, the rest of `.claude/`) are not among them. */
export const WORKER_FENCE_CONFIG_FILES: readonly string[] = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];

/** The paths in the worktree the worker's commands may not write: the
 *  WORKER_FENCE_CONFIG_FILES and a linked worktree's `.git` file, which names
 *  the repository git works in. Pure. */
export function workerFenceWorktreeDenies(worktree: string, isLinkedWorktree: boolean): string[] {
  const wt = requireAbsolute('the worktree', worktree);
  return [...WORKER_FENCE_CONFIG_FILES.map((f) => path.join(wt, ...f.split('/'))), ...(isLinkedWorktree ? [path.join(wt, '.git')] : [])];
}

/** A permission rule's path: `~/…` inside home, `//…` (from the root) else. */
function rulePath(p: string, home: string): string {
  const posix = (s: string) => s.split(path.sep).join('/');
  const rel = path.relative(home, p);
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${posix(rel)}`;
  return `//${posix(p).replace(/^\/+/, '')}`;
}

/**
 * The permission denies on the credential set, for Read, Edit and Write, on
 * each path and everything under it. A path that holds one of the worker's
 * own folders is left out: a deny beats every allow, so it would close the
 * worktree itself to the file tools. Pure.
 */
export function workerFencePermissionDenies(credentialPaths: readonly string[], ownFolders: readonly string[], home: string): string[] {
  const homeAbs = requireAbsolute('home', home);
  const own = ownFolders.map((f) => path.resolve(f));
  const out = new Set<string>();
  for (const raw of credentialPaths) {
    const p = requireAbsolute('a credential path', raw);
    if (own.some((f) => isWithin(f, p))) continue;
    const target = rulePath(p, homeAbs);
    for (const tool of FILE_RULE_TOOLS) {
      out.add(`${tool}(${target})`);
      out.add(`${tool}(${target}/**)`);
    }
  }
  return [...out];
}

/** The fence's environment: claude's temp folder (TMPDIR and the sandbox's
 *  temp grant follow it) and the package caches, all in the worker's temp
 *  folder, so no cache in home is shared between workers. Pure. */
export function workerFenceEnv(workerTempDir: string): Record<string, string> {
  const tmp = requireAbsolute('the worker temp dir', workerTempDir);
  return {
    CLAUDE_CODE_TMPDIR: tmp,
    npm_config_cache: path.join(tmp, 'npm-cache'),
    PIP_CACHE_DIR: path.join(tmp, 'pip-cache'),
    CARGO_HOME: path.join(tmp, 'cargo-home'),
  };
}

/**
 * The worker's fence settings. On a capable platform: the sandbox, the
 * environment, the permission denies and the hook. Elsewhere: the permission
 * denies and the hook only, marked `weaker`. Throws when an input cannot be
 * turned into a rule (a relative path, a malformed name): the caller then
 * does not start the worker. Pure.
 */
export function buildWorkerFence(input: WorkerFenceInput): WorkerFence {
  const worktree = requireAbsolute('the worktree', input.worktree);
  const tmp = requireAbsolute('the worker temp dir', input.workerTempDir);
  const git = requireAbsolute('the git common dir', input.gitCommonDir);
  if (typeof input.hookCommand !== 'string' || input.hookCommand.trim() === '') throw new Error('worker fence: no hook command');
  const credentials = input.credentialPaths.map((p) => requireAbsolute('a credential path', p));
  const deny = [...workerFencePermissionDenies(credentials, [worktree, tmp, git], input.home), ...WORKER_FENCE_REFUSED_WMUX_TOOLS];
  const hooks = {
    PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: input.hookCommand, timeout: WORKER_GATE_TIMEOUT_S }] }],
  };
  // The temp folder is the hook's second root: claude's temp files go there
  // with or without the sandbox.
  const env = workerFenceEnv(tmp);
  if (!input.platformCapable) {
    return { settings: { env, permissions: { deny }, disableAllHooks: false, hooks }, weaker: true };
  }
  const tests = input.repoTestWritePaths.map((p) => requireAbsolute('a test write path', p));
  const sandbox = {
    enabled: true,
    failIfUnavailable: true,
    // Bypass presets have no other judge for a command; auto mode keeps its
    // own, as bot commands do (botExecSandbox.ts).
    autoAllowBashIfSandboxed: input.permissionMode === 'bypassPermissions',
    allowUnsandboxedCommands: false,
    enableWeakerNestedSandbox: false,
    // `gh` reaches GitHub only with it (measured on macOS).
    enableWeakerNetworkIsolation: true,
    filesystem: {
      // What a commit on the worker's own branch writes in the git common
      // dir (narrowed by the denies below, which win over it).
      allowWrite: [...new Set([worktree, tmp, ...workerFenceGitWrites(input), ...tests])],
      denyWrite: [
        ...workerFenceWorktreeDenies(worktree, input.isLinkedWorktree),
        ...workerFenceGitDenies(input).filter((p) => !input.keepGitDeny || input.keepGitDeny(p)),
        ...(input.extraDenyWrite ?? []).map((p) => requireAbsolute('a denied write path', p)),
      ],
      denyRead: credentials,
      // Re-opened should a denied folder hold them (wmux keeps worktrees in
      // its home folder).
      allowRead: [...new Set([worktree, tmp, git])],
    },
    network: {
      allowedDomains: [...WORKER_FENCE_ALLOWED_DOMAINS],
      strictAllowlist: false,
      // Test runners listen on local ports and sockets in their temp folder.
      allowLocalBinding: true,
      allowUnixSockets: [...new Set([tmp, ...tests])],
    },
  };
  return {
    settings: { env, permissions: { deny }, sandbox, disableAllHooks: false, hooks },
    weaker: false,
  };
}

// ── The launch: one settings file on one plain claude line ──────────────────

export type WorkerFenceRefusal = 'not-claude' | 'wrapper' | 'settings-flag' | 'add-dir' | 'unspliceable' | 'conflict';

export type WorkerFenceLaunch =
  | { ok: true; line: string; settings: Record<string, unknown> }
  | { ok: false; refusal: WorkerFenceRefusal; reason: string };

/** Programs that run another program: a line starting with one starts claude
 *  (if at all) where the fence's flag cannot be put (shared/paneFence.ts). */
export { WRAPPER_STEMS };

// What a fenced worker's other settings may not set, because each would
// loosen the fence. The launch that attaches the fence refuses or overrides
// them in the worker folder's project settings; mergeWorkerFenceSettings
// refuses them in the launch's own extras.

// The keys and rules themselves live in shared/botWorkerGuard.ts (the
// daemon's phone launch checks a worktree with them too).
export { WORKER_FENCE_FILE_ALLOW_RULE, WORKER_FENCE_REFUSED_PERMISSION_KEYS, WORKER_FENCE_REFUSED_SETTINGS_KEYS, WORKER_FENCE_REFUSED_WMUX_TOOLS };

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge `src` into `dst`: objects key by key, arrays as a union (`dst`'s
 *  items first), equal values kept. Returns the first key two values disagree
 *  on, else null. */
function mergeInto(dst: Record<string, unknown>, src: Record<string, unknown>, at: string): string | null {
  for (const [k, v] of Object.entries(src)) {
    const key = at ? `${at}.${k}` : k;
    if (UNSAFE_KEYS.has(k)) return key;
    if (!Object.prototype.hasOwnProperty.call(dst, k)) {
      dst[k] = structuredClone(v);
      continue;
    }
    const d = dst[k];
    if (Array.isArray(d) && Array.isArray(v)) {
      const seen = new Set(d.map((x) => JSON.stringify(x)));
      for (const item of v) {
        const s = JSON.stringify(item);
        if (!seen.has(s)) {
          seen.add(s);
          d.push(structuredClone(item));
        }
      }
      continue;
    }
    if (isPlainObject(d) && isPlainObject(v)) {
      const clash = mergeInto(d, v, key);
      if (clash) return clash;
      continue;
    }
    if (JSON.stringify(d) !== JSON.stringify(v)) return key;
  }
  return null;
}

/**
 * The fence merged with what the launch also needs (a WSL pane's hooks,
 * wslClaudeHooks; the bot worker's deny rules; wmux's status hooks). The
 * fence's own hook stays the first PreToolUse group. An extra may add, never
 * change: a `sandbox` of its own, a value that differs from the fence's
 * (`disableAllHooks: true`, another CLAUDE_CODE_TMPDIR), or what claude
 * also grants the sandbox's writes from (`permissions.additionalDirectories`,
 * an allow rule for a file tool) is a conflict. Pure.
 */
export function mergeWorkerFenceSettings(fence: Record<string, unknown>, extras: readonly Record<string, unknown>[]): { ok: true; settings: Record<string, unknown> } | { ok: false; key: string } {
  const out = structuredClone(fence);
  for (const extra of extras) {
    if (Object.prototype.hasOwnProperty.call(extra, 'sandbox')) return { ok: false, key: 'sandbox' };
    const perms = isPlainObject(extra.permissions) ? extra.permissions : {};
    const widening = WORKER_FENCE_REFUSED_PERMISSION_KEYS.find((k) => Object.prototype.hasOwnProperty.call(perms, k));
    if (widening) return { ok: false, key: `permissions.${widening}` };
    if (Array.isArray(perms.allow) && perms.allow.some((r) => typeof r !== 'string' || WORKER_FENCE_FILE_ALLOW_RULE.test(r))) return { ok: false, key: 'permissions.allow' };
    const clash = mergeInto(out, extra, '');
    if (clash) return { ok: false, key: clash };
  }
  return { ok: true, settings: out };
}

function refuse(refusal: WorkerFenceRefusal, reason: string): WorkerFenceLaunch {
  return { ok: false, refusal, reason };
}

/**
 * A fenced launch: the line with `--settings="<settingsPath>"` after its
 * claude launcher, and the settings that file must hold. Refused, with the
 * reason, when the fence cannot be attached to the line: it does not start
 * claude itself, it starts it through a wrapper (`env …`, `sh -c …`, a
 * variable assignment), it already carries a `--settings` (of two, the last
 * one wins), it opens another folder (`--add-dir`), it is not one plain command spliceSettingsFlag can carry, or an
 * extra conflicts with the fence. Pure.
 */
export function workerFenceLaunch(input: {
  line: string;
  settingsPath: string;
  fence: Record<string, unknown>;
  extras?: readonly Record<string, unknown>[];
}): WorkerFenceLaunch {
  const { command } = splitModelEnvMarker(input.line);
  const tokens = tokenize(command);
  const first = tokens[0]?.value ?? '';
  const stem = launcherStem(first);
  if (!isClaudeLauncher(first)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || WRAPPER_STEMS.has(stem) || namesClaude(command)) {
      return refuse('wrapper', 'the line starts claude through another program, where the fence cannot be attached');
    }
    return refuse('not-claude', 'the line does not start claude');
  }
  const spliced = spliceSettingsFlag(input.line, input.settingsPath);
  if (tokens.slice(1).some((t) => /^--settings(=|$)/.test(t.value)) && spliced !== input.line) {
    return refuse('settings-flag', 'the line already carries its own --settings, which would replace the fence');
  }
  if (tokens.slice(1).some((t) => /^--add-dir(=|$)/.test(t.value))) {
    return refuse('add-dir', 'the line opens another folder with --add-dir, which widens the fence');
  }
  if (spliced === null) return refuse('unspliceable', 'the line is not one plain claude command the fence can be attached to');
  const merged = mergeWorkerFenceSettings(input.fence, input.extras ?? []);
  if (!merged.ok) return refuse('conflict', `the launch's other settings change the fence's ${merged.key}`);
  return { ok: true, line: spliced, settings: merged.settings };
}

// ── The hook ─────────────────────────────────────────────────────────────────

/** The built-in tools whose target the hook checks. */
export const WORKER_FENCE_WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** Built-in tools that pass whatever path they name: reads (not fenced) and
 *  the shells (the sandbox decides what their commands reach). */
export const WORKER_FENCE_PASS_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'Bash', 'PowerShell'];

/** Built-in tools that change files from claude's own process with no path
 *  the hook can check: they create or remove a git worktree. A subagent
 *  asked to run in a worktree of its own (`isolation: "worktree"`) is
 *  refused for the same reason. */
export const WORKER_FENCE_REFUSED_TOOLS: readonly string[] = ['EnterWorktree', 'ExitWorktree'];

/** The tools that start a subagent. */
export const WORKER_FENCE_AGENT_TOOLS: readonly string[] = ['Agent', 'Task'];

/** The tool-input fields that name a file. */
export const WORKER_FENCE_PATH_FIELDS: readonly string[] = ['file_path', 'notebook_path', 'path'];

/** How long the hook waits for its input before it refuses; well under the
 *  hook's timeout (WORKER_GATE_TIMEOUT_S), past which claude runs the call. */
export const WORKER_FENCE_INPUT_TIMEOUT_MS = 10_000;

/**
 * The hook script: plain JavaScript, the same for every worker (its roots
 * come on its command line), so main writes it once, content-named. It reads
 * the call as JSON on stdin and exits 0 to let it run or 2 to refuse it; any
 * other exit would let the call run, so every error, malformed input, missing
 * root or late input exits 2.
 *
 * For each call:
 *   - a wmux tool in WORKER_FENCE_REFUSED_WMUX_TOOLS is refused; any other
 *     MCP tool, or a built-in in WORKER_FENCE_PASS_TOOLS, passes;
 *   - a built-in in WORKER_FENCE_REFUSED_TOOLS is refused, and so is a
 *     subagent (WORKER_FENCE_AGENT_TOOLS) asked for an isolation of its own;
 *   - a write tool (WORKER_FENCE_WRITE_TOOLS) passes only when every path it
 *     names passes the check below;
 *   - any other tool passes when it names no path, and is refused when it
 *     does (a file tool the fence does not know).
 * A path passes when it is absolute with no `.`/`..` part, its real location
 * (that of its nearest existing parent, for a new file) is inside one of the
 * roots, it is not this script, it is not a file with more than one hard
 * link, and, inside the worktree (the first root), no part of it is `.git`
 * and it is not one of the WORKER_FENCE_CONFIG_FILES (compared without case:
 * macOS and Windows folders ignore it). Pure.
 */
export function workerFenceHookScript(): string {
  const data = {
    write: WORKER_FENCE_WRITE_TOOLS,
    pass: WORKER_FENCE_PASS_TOOLS,
    refused: WORKER_FENCE_REFUSED_TOOLS,
    refusedMcp: WORKER_FENCE_REFUSED_WMUX_TOOLS,
    agents: WORKER_FENCE_AGENT_TOOLS,
    fields: WORKER_FENCE_PATH_FIELDS,
    configFiles: WORKER_FENCE_CONFIG_FILES.map((f) => f.toLowerCase()),
    timeoutMs: WORKER_FENCE_INPUT_TIMEOUT_MS,
    maxInput: 64 * 1024 * 1024,
  };
  return `'use strict';
// wmux: the worker fence's hook (generated). Argv: the roots, the worktree first.
const P = ${JSON.stringify(data)};
function refuse(msg) {
  try { process.stderr.write('wmux fence: ' + msg + '\\n'); } catch (e) { /* still refused */ }
  process.exit(2);
}
process.on('uncaughtException', (e) => refuse('hook error (' + (e && e.message) + '); call refused'));
process.on('unhandledRejection', (e) => refuse('hook error (' + (e && e.message) + '); call refused'));
const timer = setTimeout(() => refuse('the call did not arrive in time; call refused'), P.timeoutMs);
try {
  const fs = require('fs');
  const path = require('path');
  const self = fs.realpathSync.native(__filename);
  const args = process.argv.slice(2);
  if (args.length === 0) refuse('no fence roots; call refused');
  const roots = args.map((r) => {
    if (!path.isAbsolute(r)) refuse('fence root ' + r + ' is not absolute; call refused');
    const real = fs.realpathSync.native(r);
    if (!fs.statSync(real).isDirectory()) refuse('fence root ' + r + ' is not a folder; call refused');
    return real;
  });
  const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  // The real location of the nearest entry that exists (lstat sees a dangling
  // link too, whose realpath then throws), with the missing parts after it.
  const resolveReal = (abs) => {
    let p = abs;
    const rest = [];
    for (;;) {
      try { fs.lstatSync(p); break; } catch (e) {
        if (!e || e.code !== 'ENOENT') throw e;
        const parent = path.dirname(p);
        if (parent === p) throw new Error('no existing parent');
        rest.unshift(path.basename(p));
        p = parent;
      }
    }
    return { real: path.join(fs.realpathSync.native(p), ...rest), existing: rest.length === 0 };
  };
  const check = (tool, target) => {
    if (typeof target !== 'string' || target.length === 0 || target.includes('\\0')) refuse(tool + ' names no usable path; call refused');
    if (!path.isAbsolute(target)) refuse(tool + ' to ' + target + ' is not an absolute path; call refused');
    if (target.split(/[\\\\/]+/).some((s) => s === '.' || s === '..')) refuse(tool + ' to ' + target + ' has a . or .. part; name the path itself');
    const { real, existing } = resolveReal(target);
    if (real === self) refuse(tool + ' to the fence hook itself; call refused');
    if (existing) {
      const st = fs.statSync(real);
      if (!st.isDirectory() && st.nlink > 1) refuse(tool + ' to ' + real + ' is a hard-linked file; call refused');
    }
    const root = roots.find((r) => within(real, r));
    if (!root) refuse(tool + ' to ' + real + ' is outside the worktree; write inside it instead');
    if (within(real, roots[0])) {
      const parts = path.relative(roots[0], real).split(path.sep).filter(Boolean).map((s) => s.toLowerCase());
      if (parts.includes('.git') || P.configFiles.includes(parts.join('/'))) {
        refuse(tool + ' to ' + real + ' changes git or Claude configuration in the worktree; call refused');
      }
    }
  };
  const decide = (ev) => {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) refuse('the call is not an object; call refused');
    const tool = ev.tool_name;
    if (typeof tool !== 'string' || tool.length === 0) refuse('the call names no tool; call refused');
    if (P.refusedMcp.includes(tool)) refuse(tool + ' is not available inside the worker fence');
    if (tool.startsWith('mcp__') || P.pass.includes(tool)) process.exit(0);
    if (P.refused.includes(tool)) refuse(tool + ' is not available inside the worker fence');
    const input = ev.tool_input;
    if (P.agents.includes(tool) && input && typeof input === 'object' && input.isolation !== undefined && input.isolation !== null) {
      refuse(tool + ' with isolation ' + JSON.stringify(input.isolation) + ' is not available inside the worker fence; start it without isolation');
    }
    const named = input && typeof input === 'object' ? P.fields.filter((f) => input[f] !== undefined) : [];
    if (!P.write.includes(tool)) {
      if (named.length === 0) process.exit(0);
      refuse(tool + ' is a file tool the worker fence does not know; call refused');
    }
    if (named.length === 0) refuse(tool + ' names no path; call refused');
    for (const f of named) check(tool, input[f]);
    process.exit(0);
  };
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', (e) => refuse('the call could not be read (' + e.message + '); call refused'));
  process.stdin.on('data', (d) => {
    raw += d;
    if (raw.length > P.maxInput) refuse('the call is too large; call refused');
  });
  process.stdin.on('end', () => {
    clearTimeout(timer);
    let ev;
    try { ev = JSON.parse(raw); } catch (e) { refuse('the call is not JSON; call refused'); }
    decide(ev);
  });
} catch (e) {
  refuse('hook error (' + (e && e.message) + '); call refused');
}
`;
}

/** The hook's command: this process's runtime by its absolute path, as
 *  node, the script, then the roots (the worktree first, then the worker's
 *  temp folder), each in double quotes. Null when there is no root or a path
 *  is not absolute or holds what a POSIX shell reads inside double quotes
 *  (`"`, `$`, a backtick, a backslash) or a line break.
 *
 *  On Windows claude runs a hook in Git Bash, so the line keeps its POSIX
 *  form and each drive path is written with forward slashes (`C:/…`), which
 *  bash leaves alone and Windows reads as the same path. Without Git Bash,
 *  claude counts only exit 0 or 2 from such a hook and blocks on anything
 *  else, so a line that shell cannot run refuses the call. A UNC path, a
 *  path that is not a drive path, or one holding `%` or `!` (which cmd
 *  reads) gives null. Pure. */
export function workerFenceHookCommand(runtime: string, script: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): string | null {
  if (roots.length === 0) return null;
  const paths = [runtime, script, ...roots];
  let quoted: string[];
  if (platform === 'win32') {
    const drive = (p: string) => /^[A-Za-z]:[\\/][^"$`%!\0\r\n]*$/.test(p) && !/[\\/]{2}/.test(p.slice(2));
    if (!paths.every(drive)) return null;
    quoted = paths.map((p) => `"${p.replace(/\\/g, '/')}"`);
  } else {
    const plain = (p: string) => /^\/[^"$`\\\0\r\n]*$/.test(p);
    if (!paths.every(plain)) return null;
    quoted = paths.map((p) => `"${p}"`);
  }
  return `ELECTRON_RUN_AS_NODE=1 ${quoted.join(' ')} || exit 2`;
}
