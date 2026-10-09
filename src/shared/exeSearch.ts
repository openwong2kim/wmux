// Windows executable lookup hardening.
//
// On Windows, a bare command name (`git`, `gh`, `tailscale`, ...) passed to
// child_process is resolved by libuv, which looks in the child's working
// directory BEFORE the PATH entries. So `execFile('git', args, { cwd: repo })`
// starts `<repo>\git.exe` when one exists there, instead of the git on PATH.
// libuv (like CreateProcess and cmd.exe) skips that working-directory lookup
// when `NoDefaultCurrentDirectoryInExePath` is present in the SPAWNING
// process's own environment. Putting it only in the child's `env` option has
// no effect on libuv's lookup — it reads the parent's environment block.
//
// Two layers, both here:
//   1. `applyExeSearchGuard()` sets the variable on our own process.env, early
//      in every entry that spawns tools (see exeSearchGuard.ts). It covers
//      every spawn site at once, including ones added later.
//   2. `resolveExecutable()` turns a bare name into an absolute path found on
//      PATH alone, for the runners that centralise git/gh spawning and for
//      every cross-spawn call (cross-spawn resolves names itself, working
//      directory first, and does not honour the variable). It holds even if
//      layer 1 is missing (a module reused from another entry, a test
//      harness), and also ignores relative PATH entries (`.` or `bin`), which
//      libuv would resolve against the child's working directory.
//
// Terminal panes are the exception: `withoutExeSearchGuard()` strips the
// variable from the env a PTY is spawned with when wmux itself added it. A
// user's shell keeps the lookup behaviour it has outside wmux (cmd.exe users
// who type `tool` to run `.\tool.exe` see no change). If the user set the
// variable themselves, it is passed through untouched.

import fs from 'node:fs';
import path from 'node:path';

export const NO_CWD_EXE_SEARCH_ENV = 'NoDefaultCurrentDirectoryInExePath';
/**
 * Set next to the variable when wmux (not the user) introduced it, so a child
 * wmux process (daemon, MCP broker) inherits the knowledge and strips exactly
 * what wmux added — never a value the user set on their own.
 */
export const EXE_SEARCH_GUARD_MARKER_ENV = 'WMUX_EXE_SEARCH_GUARD';

type Env = Record<string, string | undefined>;

/** Keys of `env` equal to `name` ignoring case (Windows env names are case-insensitive). */
function keysNamed(env: Env, name: string): string[] {
  const upper = name.toUpperCase();
  return Object.keys(env).filter((k) => k.toUpperCase() === upper);
}

function hasVar(env: Env, name: string): boolean {
  return keysNamed(env, name).some((k) => env[k] !== undefined);
}

/**
 * Turn off the working-directory step of executable lookup for every child this
 * process spawns. Windows only, idempotent. Records with a marker that wmux
 * added the variable; a value the user already had is left alone and unmarked.
 */
export function applyExeSearchGuard(env: Env = process.env, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return;
  if (hasVar(env, NO_CWD_EXE_SEARCH_ENV)) return;
  env[NO_CWD_EXE_SEARCH_ENV] = '1';
  env[EXE_SEARCH_GUARD_MARKER_ENV] = '1';
}

/**
 * Remove what `applyExeSearchGuard` added from an environment about to be given
 * to a terminal pane. `ownEnv` is this process's environment: only when its
 * marker says wmux added the variable is the variable removed. The marker is
 * always removed. Mutates and returns `env`.
 */
export function withoutExeSearchGuard<T extends Env>(env: T, ownEnv: Env = process.env): T {
  const wmuxAdded = hasVar(ownEnv, EXE_SEARCH_GUARD_MARKER_ENV);
  for (const k of keysNamed(env, EXE_SEARCH_GUARD_MARKER_ENV)) delete env[k];
  if (wmuxAdded) {
    for (const k of keysNamed(env, NO_CWD_EXE_SEARCH_ENV)) delete env[k];
  }
  return env;
}

export interface ResolveExecutableOptions {
  /** Environment whose PATH (and PATHEXT) is searched. Defaults to process.env. */
  env?: Env;
  platform?: NodeJS.Platform;
  /**
   * Which file kinds count, per PATH entry:
   *  - 'exe' (default): `.com` then `.exe`, what execFile/spawn can start
   *    without a shell — libuv's own rule.
   *  - 'pathext': every PATHEXT extension in order (`.cmd`/`.bat` shims too),
   *    for callers that hand the result to cross-spawn, which runs a shim
   *    under cmd.exe. cross-spawn's own lookup (node-which) checks the working
   *    directory first and ignores NoDefaultCurrentDirectoryInExePath, so it
   *    must be given an absolute path.
   */
  extensions?: 'exe' | 'pathext';
  /** Injectable for tests. */
  isFile?: (p: string) => boolean;
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function envValue(env: Env, name: string): string | undefined {
  for (const k of keysNamed(env, name)) {
    const v = env[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

const cache = new Map<string, string>();

/** Test hook: forget cached lookups. */
export function clearResolveExecutableCache(): void {
  cache.clear();
}

/**
 * Absolute path of `name` found on PATH, never in the working directory.
 *
 * Windows only; elsewhere `name` is returned unchanged (POSIX exec never
 * searches the working directory, and resolving against process.env on macOS
 * would bypass the PATH fallbacks getExecEnv() adds for GUI launches).
 *
 * Mirrors libuv's own search minus the working-directory step: PATH entries in
 * order, each trying the name as given when it has an extension, then the
 * extensions `opts.extensions` selects. Relative PATH entries are skipped. A
 * name that already contains a directory (or a drive) is returned unchanged.
 * When nothing matches, `name` is returned unchanged, so a missing tool still
 * fails the way it always did (ENOENT) — from execFile/spawn, whose own lookup
 * skips the working directory once layer 1 is in place. Do NOT hand a miss to
 * cross-spawn; use `findExecutable` there and handle null.
 *
 * Results are cached per (name, kind, PATH, PATHEXT); a hit is re-checked on
 * disk so an uninstalled tool is looked up again.
 */
export function resolveExecutable(name: string, opts: ResolveExecutableOptions = {}): string {
  return findExecutable(name, opts) ?? name;
}

/**
 * `resolveExecutable` without the fallback: the absolute path, `name` itself
 * off Windows or when it already names a directory, or null when PATH has no
 * match.
 */
export function findExecutable(name: string, opts: ResolveExecutableOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return name;
  if (!name) return null;
  if (/[\\/:]/.test(name)) return name;
  const isFile = opts.isFile ?? defaultIsFile;
  const env = opts.env ?? process.env;
  const kind = opts.extensions ?? 'exe';
  const pathVar = envValue(env, 'PATH') ?? '';
  const exts = kind === 'pathext'
    ? (envValue(env, 'PATHEXT') || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.trim()).filter(Boolean)
    : ['.com', '.exe'];
  const key = `${name.toLowerCase()}\0${kind}\0${pathVar}\0${exts.join(';')}`;
  const hit = cache.get(key);
  if (hit && isFile(hit)) return hit;

  const hasExt = path.win32.extname(name) !== '';
  const candidates = [...(hasExt ? [name] : []), ...exts.map((e) => `${name}${e}`)];
  for (const raw of pathVar.split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !path.win32.isAbsolute(dir) || !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(dir)) continue;
    for (const file of candidates) {
      const full = path.win32.join(dir, file);
      if (isFile(full)) {
        cache.set(key, full);
        return full;
      }
    }
  }
  cache.delete(key);
  return null;
}

/** The error execFile/spawn would report for a command that is not installed. */
export function notFoundError(name: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${name} ENOENT`), {
    code: 'ENOENT', errno: -4058, syscall: `spawn ${name}`, path: name,
  });
}
