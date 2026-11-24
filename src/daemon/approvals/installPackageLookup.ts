// Which of the packages an install command names the project does not have
// yet: a quiet line on the approval card ("New package: X — not in
// package.json"). Agents invent package names and attackers register them, so
// the one command worth reading closely is the install.
//
// Informational only. It never changes a risk verdict, the buttons, or what a
// one-tap answer does. It reads a fixed list of manifest and lockfile names in
// the pane's directory and its parents up to the repo root (the first
// directory holding `.git`, a file in a worktree), each size-capped, with no
// network and no subprocess. It claims a package is new only when it found
// that ecosystem's manifest to compare against; anything it could not read
// makes it say nothing rather than guess.
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import {
  normalizeCrateName,
  normalizePythonName,
  parseInstallCommand,
  type CommandShell,
  type InstallPackageRef,
  type PackageEcosystem,
} from '../../shared/installCommandParse';

/** One package the project does not have, as the approval record carries it. */
export interface NewPackageNote {
  ecosystem: PackageEcosystem;
  name: string;
  /** The manifest it was compared with (a basename, e.g. `package.json`). */
  checked: string;
  /** `run`: executed from the registry (npx, bunx, dlx), not added to the project. */
  via: 'install' | 'run';
}

/** At most this many entries on one record. */
export const MAX_NEW_PACKAGE_NOTES = 8;
/** One file past this is not read. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** All reads for one command together. */
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Past this the lookup is abandoned and the record carries no line. */
export const NEW_PACKAGE_LOOKUP_TIMEOUT_MS = 1_500;
/** How many parent directories are tried while looking for the repo root. */
const MAX_LEVELS = 12;

const JS_MANIFEST = 'package.json';
const JS_LOCKS = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'];
const PY_MANIFESTS = ['pyproject.toml', 'Pipfile', 'setup.cfg'];
/** Its dependencies are code, not data: a project with one gets no Python line. */
const PY_SETUP_SCRIPT = 'setup.py';
const PY_LOCKS = ['uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock'];
const CARGO_MANIFEST = 'Cargo.toml';
const CARGO_LOCK = 'Cargo.lock';

/** Thrown inside the lookup when a file cannot be read whole: the ecosystem then says nothing. */
class Unreadable extends Error {}

/** A stat failure that only means "not there". Anything else (EACCES, EIO) is not knowing. */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The path's stats, null when absent. Throws Unreadable when it cannot be told. */
async function statOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.stat(p);
  } catch (err) {
    if (isMissing(err)) return null;
    throw new Unreadable(p);
  }
}

class Reader {
  private total = 0;
  /** The file's text, null when absent. Throws Unreadable when present but not readable within the caps. */
  async read(file: string): Promise<string | null> {
    const st = await statOrNull(file);
    if (st === null || !st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES || this.total + st.size > MAX_TOTAL_BYTES) throw new Unreadable(file);
    this.total += st.size;
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      throw new Unreadable(file);
    }
  }
}

async function exists(p: string): Promise<boolean> {
  return (await statOrNull(p)) !== null;
}

/**
 * The directories to look in, nearest first: `cwd` and its parents up to and
 * including the first one holding `.git`. Without a repo root in reach, only
 * `cwd` itself: never a walk up into the home directory.
 */
export async function projectDirs(cwd: string): Promise<string[]> {
  if (!path.isAbsolute(cwd)) return [];
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  for (let level = 0; level < MAX_LEVELS; level++) {
    dirs.push(dir);
    // An unreadable `.git` is no repo root: keep walking, as for a missing one.
    if (await exists(path.join(dir, '.git')).catch(() => false)) return dirs;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [path.resolve(cwd)];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a JS lockfile names `name` as a package. Delimiter-bounded on both
 * sides so `expres` is not found inside `express`, nor `react` inside
 * `@types/react`.
 */
export function jsLockNames(text: string, name: string): boolean {
  const re = new RegExp(`(?:(?:^|[\\s"',])/?|node_modules/)${escapeRegExp(name)}(?=[@"':\\s]|$)`, 'mi');
  return re.test(text);
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function packageJsonNames(text: string): Set<string> {
  const out = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Unreadable('package.json');
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const o = parsed as Record<string, unknown>;
  if (typeof o['name'] === 'string') out.add(o['name']);
  for (const f of DEP_FIELDS) {
    const deps = o[f];
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) for (const k of Object.keys(deps)) out.add(k);
  }
  return out;
}

/**
 * Names a Python manifest or lockfile mentions, PEP 503-normalized: the start
 * of every quoted string, every TOML key, every `name = "…"` value. Loose on
 * purpose: a stray match only keeps the card quiet.
 */
export function pythonNamesIn(text: string): Set<string> {
  const out = new Set<string>();
  const add = (n: string): void => { out.add(normalizePythonName(n.replace(/[._-]+$/, ''))); };
  for (const m of text.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) add(m[1]);
  // `[ \t]`, never `\s`: with the m flag `\s*` runs across newlines, and a
  // file of blank lines took seconds.
  for (const m of text.matchAll(/^[ \t]*([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*=/gm)) add(m[1]);
  // setup.cfg's `install_requires =` lists one unquoted requirement per
  // indented line.
  for (const m of text.matchAll(/^[ \t]+([A-Za-z0-9][A-Za-z0-9._-]*)/gm)) add(m[1]);
  return out;
}

/**
 * Whether a Python manifest declares dependencies at all. One that does not
 * (a pyproject.toml holding only tool settings) is no list to compare with.
 */
export function pythonDeclaresDeps(file: string, text: string): boolean {
  if (file === 'setup.cfg') return /^[ \t]*install_requires[ \t]*=/m.test(text);
  if (file === 'Pipfile') return /^\[(dev-)?packages\][ \t]*$/m.test(text);
  return /^[ \t]*(dependencies|optional-dependencies)[ \t]*=/m.test(text)
    || /^\[(project\.optional-dependencies|dependency-groups|tool\.poetry(\.group\.[^\]\n]+)?\.(dev-)?dependencies|tool\.pdm\.dev-dependencies)\][ \t]*$/m.test(text);
}

/** Names a requirements file lists, PEP 503-normalized. */
export function requirementsNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (m) out.add(normalizePythonName(m[1].replace(/[._-]+$/, '')));
  }
  return out;
}

/** Names a Cargo manifest or lockfile mentions, normalized (`-`/`_`, case). */
export function cargoNamesIn(text: string): Set<string> {
  const out = new Set<string>();
  const add = (n: string): void => { out.add(normalizeCrateName(n)); };
  // `[ \t]` and `[^\]\n]`, never `\s` or `[^\]]`: either runs across lines.
  for (const m of text.matchAll(/^[ \t]*([A-Za-z0-9][A-Za-z0-9_-]*)[ \t]*=/gm)) add(m[1]);
  for (const m of text.matchAll(/^[ \t]*\[[^\]\n]*dependencies\.([A-Za-z0-9_-]+)\]/gm)) add(m[1]);
  for (const m of text.matchAll(/\b(?:name|package)[ \t]*=[ \t]*"([A-Za-z0-9_-]+)"/g)) add(m[1]);
  return out;
}

async function requirementFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw new Unreadable(dir);
  }
  return names.filter((f) => /^requirements[\w.-]*\.(txt|in)$/i.test(f)).sort().slice(0, 16);
}

/** The ones of `refs` (one ecosystem) not found anywhere; null = say nothing. */
async function lookupJs(refs: InstallPackageRef[], dirs: string[], reader: Reader): Promise<NewPackageNote[] | null> {
  let manifest = false;
  const known = new Set<string>();
  // A local bin only answers for a run: `npx tsc` runs typescript's `tsc`,
  // while `npm i tsc` installs the registry's `tsc`, another package.
  const localBin = new Set<string>();
  const runs = new Set(refs.filter((r) => r.via === 'run').map((r) => r.name));
  const pending = new Set(refs.map((r) => r.name));
  for (const dir of dirs) {
    for (const name of pending) {
      // Installed already, maybe transitively.
      if (await exists(path.join(dir, 'node_modules', name, 'package.json'))) known.add(name);
      else if (runs.has(name) && !name.startsWith('@') && await exists(path.join(dir, 'node_modules', '.bin', name))) localBin.add(name);
    }
    const pkg = await reader.read(path.join(dir, JS_MANIFEST));
    if (pkg !== null) {
      manifest = true;
      for (const n of packageJsonNames(pkg)) if (pending.has(n)) known.add(n);
    }
    for (const lock of JS_LOCKS) {
      if ([...pending].every((n) => known.has(n))) break;
      const text = await reader.read(path.join(dir, lock));
      if (text === null) continue;
      for (const n of pending) if (!known.has(n) && jsLockNames(text, n)) known.add(n);
    }
  }
  if (!manifest) return null;
  return refs
    .filter((r) => !known.has(r.name) && !(r.via === 'run' && localBin.has(r.name)))
    .map((r) => ({ ecosystem: 'npm', name: r.name, checked: JS_MANIFEST, via: r.via }));
}

async function lookupPython(refs: InstallPackageRef[], dirs: string[], reader: Reader): Promise<NewPackageNote[] | null> {
  let checked: string | null = null;
  const known = new Set<string>();
  for (const dir of dirs) {
    // setup.py lists its dependencies in code this does not run.
    if (await exists(path.join(dir, PY_SETUP_SCRIPT))) return null;
    for (const f of PY_MANIFESTS) {
      const text = await reader.read(path.join(dir, f));
      if (text === null) continue;
      if (pythonDeclaresDeps(f, text)) checked ??= f;
      for (const n of pythonNamesIn(text)) known.add(n);
    }
    for (const f of await requirementFiles(dir)) {
      const text = await reader.read(path.join(dir, f));
      if (text === null) continue;
      checked ??= f;
      for (const n of requirementsNames(text)) known.add(n);
    }
    for (const f of PY_LOCKS) {
      const text = await reader.read(path.join(dir, f));
      if (text !== null) for (const n of pythonNamesIn(text)) known.add(n);
    }
  }
  if (checked === null) return null;
  const file = checked;
  return refs
    .filter((r) => !known.has(normalizePythonName(r.name)))
    .map((r) => ({ ecosystem: 'pypi', name: r.name, checked: file, via: r.via }));
}

async function lookupCargo(refs: InstallPackageRef[], dirs: string[], reader: Reader): Promise<NewPackageNote[] | null> {
  let manifest = false;
  const known = new Set<string>();
  for (const dir of dirs) {
    const text = await reader.read(path.join(dir, CARGO_MANIFEST));
    if (text !== null) {
      manifest = true;
      for (const n of cargoNamesIn(text)) known.add(n);
    }
    const lock = await reader.read(path.join(dir, CARGO_LOCK));
    if (lock !== null) for (const n of cargoNamesIn(lock)) known.add(n);
  }
  if (!manifest) return null;
  return refs
    .filter((r) => !known.has(normalizeCrateName(r.name)))
    .map((r) => ({ ecosystem: 'crates', name: r.name, checked: CARGO_MANIFEST, via: r.via }));
}

const LOOKUPS: Record<PackageEcosystem, (refs: InstallPackageRef[], dirs: string[], reader: Reader) => Promise<NewPackageNote[] | null>> = {
  npm: lookupJs,
  pypi: lookupPython,
  crates: lookupCargo,
};

/** The packages of `refs` the project at `cwd` does not have. Never rejects. */
export async function findNewPackages(refs: readonly InstallPackageRef[], cwd: string): Promise<NewPackageNote[]> {
  if (refs.length === 0) return [];
  let dirs: string[];
  try {
    dirs = await projectDirs(cwd);
  } catch {
    return [];
  }
  if (dirs.length === 0) return [];
  const reader = new Reader();
  const out: NewPackageNote[] = [];
  for (const eco of ['npm', 'pypi', 'crates'] as const) {
    const mine = refs.filter((r) => r.ecosystem === eco);
    if (mine.length === 0) continue;
    try {
      const found = await LOOKUPS[eco](mine, dirs, reader);
      if (found) out.push(...found);
    } catch {
      // Unreadable (or past the caps): this ecosystem says nothing.
    }
  }
  return out.slice(0, MAX_NEW_PACKAGE_NOTES);
}

/**
 * The new-package line for a shell command run in `cwd`: undefined when the
 * command installs nothing, everything it names is already in the project,
 * `enabled` (the setting, read only once the command names a package) says
 * no, or the reads outlast `timeoutMs`. The disk is touched only after the
 * command is seen to name a package, and only through fs.promises: the
 * caller's thread never waits on a file. Never rejects.
 */
export async function newPackagesForCommand(
  command: string,
  cwd: string,
  enabled: () => boolean = () => true,
  opts: { shell?: CommandShell; timeoutMs?: number } = {},
): Promise<NewPackageNote[] | undefined> {
  const refs = parseInstallCommand(command, opts.shell);
  if (refs.length === 0 || !enabled()) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<NewPackageNote[]>((resolve) => {
    timer = setTimeout(() => resolve([]), opts.timeoutMs ?? NEW_PACKAGE_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const found = await Promise.race([findNewPackages(refs, cwd).catch(() => []), timeout]);
    return found.length > 0 ? found : undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Re-validate a stored list (approvals.json is plain JSON on disk). */
export function sanitizeNewPackages(raw: unknown): NewPackageNote[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: NewPackageNote[] = [];
  for (const e of raw.slice(0, MAX_NEW_PACKAGE_NOTES)) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const eco = o['ecosystem'];
    if (eco !== 'npm' && eco !== 'pypi' && eco !== 'crates') continue;
    const name = o['name'];
    const checked = o['checked'];
    if (typeof name !== 'string' || !/^[@A-Za-z0-9][@A-Za-z0-9._~/-]{0,213}$/.test(name)) continue;
    if (typeof checked !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(checked)) continue;
    out.push({ ecosystem: eco, name, checked, via: o['via'] === 'run' ? 'run' : 'install' });
  }
  return out.length > 0 ? out : undefined;
}
