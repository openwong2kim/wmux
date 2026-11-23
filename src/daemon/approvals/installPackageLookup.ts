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
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeCrateName,
  normalizePythonName,
  parseInstallCommand,
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
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** All reads for one command together. */
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
/** How many parent directories are tried while looking for the repo root. */
const MAX_LEVELS = 12;

const JS_MANIFEST = 'package.json';
const JS_LOCKS = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'];
const PY_MANIFESTS = ['pyproject.toml', 'Pipfile', 'setup.cfg'];
const PY_LOCKS = ['uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock'];
const CARGO_MANIFEST = 'Cargo.toml';
const CARGO_LOCK = 'Cargo.lock';

/** Thrown inside the lookup when a file cannot be read whole: the ecosystem then says nothing. */
class Unreadable extends Error {}

class Reader {
  private total = 0;
  /** The file's text, null when absent. Throws Unreadable when present but not readable within the caps. */
  read(file: string): string | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES || this.total + st.size > MAX_TOTAL_BYTES) throw new Unreadable(file);
    this.total += st.size;
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      throw new Unreadable(file);
    }
  }
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The directories to look in, nearest first: `cwd` and its parents up to and
 * including the first one holding `.git`. Without a repo root in reach, only
 * `cwd` itself: never a walk up into the home directory.
 */
export function projectDirs(cwd: string): string[] {
  if (!path.isAbsolute(cwd)) return [];
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  for (let level = 0; level < MAX_LEVELS; level++) {
    dirs.push(dir);
    if (exists(path.join(dir, '.git'))) return dirs;
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
  for (const m of text.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm)) add(m[1]);
  return out;
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
  for (const m of text.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9_-]*)\s*=/gm)) add(m[1]);
  for (const m of text.matchAll(/^\s*\[[^\]]*dependencies\.([A-Za-z0-9_-]+)\]/gm)) add(m[1]);
  for (const m of text.matchAll(/\b(?:name|package)\s*=\s*"([A-Za-z0-9_-]+)"/g)) add(m[1]);
  return out;
}

function requirementFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => /^requirements[\w.-]*\.(txt|in)$/i.test(f)).sort().slice(0, 16);
  } catch {
    return [];
  }
}

/** The ones of `refs` (one ecosystem) not found anywhere; null = say nothing. */
function lookupJs(refs: InstallPackageRef[], dirs: string[], reader: Reader): NewPackageNote[] | null {
  let manifest = false;
  const known = new Set<string>();
  const pending = new Set(refs.map((r) => r.name));
  for (const dir of dirs) {
    for (const name of pending) {
      // Installed already, maybe transitively, or a local bin `npx` will run.
      if (exists(path.join(dir, 'node_modules', name, 'package.json'))
        || (!name.startsWith('@') && exists(path.join(dir, 'node_modules', '.bin', name)))) known.add(name);
    }
    const pkg = reader.read(path.join(dir, JS_MANIFEST));
    if (pkg !== null) {
      manifest = true;
      for (const n of packageJsonNames(pkg)) if (pending.has(n)) known.add(n);
    }
    for (const lock of JS_LOCKS) {
      if ([...pending].every((n) => known.has(n))) break;
      const text = reader.read(path.join(dir, lock));
      if (text === null) continue;
      for (const n of pending) if (!known.has(n) && jsLockNames(text, n)) known.add(n);
    }
  }
  if (!manifest) return null;
  return refs.filter((r) => !known.has(r.name)).map((r) => ({ ecosystem: 'npm', name: r.name, checked: JS_MANIFEST, via: r.via }));
}

function lookupPython(refs: InstallPackageRef[], dirs: string[], reader: Reader): NewPackageNote[] | null {
  let checked: string | null = null;
  const known = new Set<string>();
  for (const dir of dirs) {
    for (const f of PY_MANIFESTS) {
      const text = reader.read(path.join(dir, f));
      if (text === null) continue;
      checked ??= f;
      for (const n of pythonNamesIn(text)) known.add(n);
    }
    for (const f of requirementFiles(dir)) {
      const text = reader.read(path.join(dir, f));
      if (text === null) continue;
      checked ??= f;
      for (const n of requirementsNames(text)) known.add(n);
    }
    for (const f of PY_LOCKS) {
      const text = reader.read(path.join(dir, f));
      if (text !== null) for (const n of pythonNamesIn(text)) known.add(n);
    }
  }
  if (checked === null) return null;
  const file = checked;
  return refs
    .filter((r) => !known.has(normalizePythonName(r.name)))
    .map((r) => ({ ecosystem: 'pypi', name: r.name, checked: file, via: r.via }));
}

function lookupCargo(refs: InstallPackageRef[], dirs: string[], reader: Reader): NewPackageNote[] | null {
  let manifest = false;
  const known = new Set<string>();
  for (const dir of dirs) {
    const text = reader.read(path.join(dir, CARGO_MANIFEST));
    if (text !== null) {
      manifest = true;
      for (const n of cargoNamesIn(text)) known.add(n);
    }
    const lock = reader.read(path.join(dir, CARGO_LOCK));
    if (lock !== null) for (const n of cargoNamesIn(lock)) known.add(n);
  }
  if (!manifest) return null;
  return refs
    .filter((r) => !known.has(normalizeCrateName(r.name)))
    .map((r) => ({ ecosystem: 'crates', name: r.name, checked: CARGO_MANIFEST, via: r.via }));
}

const LOOKUPS: Record<PackageEcosystem, (refs: InstallPackageRef[], dirs: string[], reader: Reader) => NewPackageNote[] | null> = {
  npm: lookupJs,
  pypi: lookupPython,
  crates: lookupCargo,
};

/** The packages of `refs` the project at `cwd` does not have. Never throws. */
export function findNewPackages(refs: readonly InstallPackageRef[], cwd: string): NewPackageNote[] {
  if (refs.length === 0) return [];
  let dirs: string[];
  try {
    dirs = projectDirs(cwd);
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
      const found = LOOKUPS[eco](mine, dirs, reader);
      if (found) out.push(...found);
    } catch {
      // Unreadable (or past the caps): this ecosystem says nothing.
    }
  }
  return out.slice(0, MAX_NEW_PACKAGE_NOTES);
}

/**
 * The new-package line for a shell command run in `cwd`: undefined when the
 * command installs nothing, everything it names is already in the project, or
 * `enabled` (the setting, read only once the command names a package) says no.
 * The disk is touched only after the command is seen to name a package.
 */
export function newPackagesForCommand(command: string, cwd: string, enabled: () => boolean = () => true): NewPackageNote[] | undefined {
  const refs = parseInstallCommand(command);
  if (refs.length === 0 || !enabled()) return undefined;
  const found = findNewPackages(refs, cwd);
  return found.length > 0 ? found : undefined;
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
