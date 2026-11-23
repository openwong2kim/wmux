// Which registry packages a shell command asks to install (or run straight
// from the registry, like `npx foo`). Pure: no I/O, so the daemon can call it
// on every gated command and only touch the disk when it returns names.
//
// It reads the command the way a careful human would skim it, not the way a
// shell would run it: segments split on `&&`, `||`, `;`, `|`, `&` and
// newlines, words split on whitespace with quotes honoured. Anything it cannot
// read with confidence (a `$VAR`, a backtick, a path, a URL, a git spec, a
// local tarball, `-r requirements.txt`) is skipped, never guessed at. The
// result is informational only: it feeds a quiet line on an approval card and
// never a risk verdict.

export type PackageEcosystem = 'npm' | 'pypi' | 'crates';

export interface InstallPackageRef {
  ecosystem: PackageEcosystem;
  /** The registry name as written (version and extras stripped). */
  name: string;
  /** `run`: executed from the registry (npx, bunx, pnpm dlx), not added to the project. */
  via: 'install' | 'run';
}

/** Past this, a command is not parsed at all. */
const MAX_COMMAND_CHARS = 20_000;
/** At most this many names come back from one command. */
export const MAX_INSTALL_PACKAGES = 16;

type Segment = string[];

/**
 * Split a command into segments of words. A word holding any character a
 * shell would expand (`$`, a backtick, `(`, `)`, a glob) comes back as null so
 * no caller can mistake it for a literal name. Redirection targets are dropped.
 */
function segmentsOf(command: string): Array<Array<string | null>> {
  const segments: Array<Array<string | null>> = [];
  let words: Array<string | null> = [];
  let word = '';
  let inWord = false;
  let opaque = false;
  let skipNext = false;
  const endWord = (): void => {
    if (inWord) {
      if (skipNext) skipNext = false;
      else words.push(opaque ? null : word);
    }
    word = '';
    inWord = false;
    opaque = false;
  };
  const endSegment = (): void => {
    endWord();
    skipNext = false;
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      inWord = true;
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j];
        if (d === '\\' && j + 1 < command.length) {
          word += command[++j];
        } else {
          if (d === '$' || d === '`') opaque = true;
          word += d;
        }
      }
      i = j;
    } else if (c === '\\') {
      inWord = true;
      if (i + 1 < command.length && command[i + 1] !== '\n') word += command[++i];
      else i++;
    } else if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r') {
      // `2>&1` keeps its `&` in a redirection, which already ended the word.
      endSegment();
    } else if (c === '>' || c === '<') {
      // `2>`: the digits are a file descriptor, not an argument.
      if (inWord && !opaque && /^\d+$/.test(word)) { word = ''; inWord = false; }
      endWord();
      // `>>`, `>&1`: the next word is a file or a descriptor, not an argument.
      if (command[i + 1] === '>' || command[i + 1] === '&') i++;
      skipNext = true;
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else {
      if (c === '$' || c === '`' || c === '(' || c === ')' || c === '*' || c === '?' || c === '{' || c === '}') opaque = true;
      inWord = true;
      word += c;
    }
  }
  endSegment();
  return segments;
}

/** Prefixes that run the rest of the segment as its own command. */
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'time', 'nohup', 'exec', 'nice', 'builtin']);
/** sudo options that take a value. */
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '--user', '--group']);

function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** Strip env assignments and wrappers; null when a word is unreadable. */
function unwrap(words: Array<string | null>): Segment | null {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w === null) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    const p = programName(w);
    if (WRAPPERS.has(p)) {
      i++;
      while (i < words.length) {
        const f = words[i];
        if (f === null || !f.startsWith('-')) break;
        i += p === 'sudo' && SUDO_VALUE_FLAGS.has(f) ? 2 : 1;
      }
      continue;
    }
    break;
  }
  const rest = words.slice(i);
  if (rest.length === 0 || rest[0] === null) return null;
  // An unreadable word becomes a NUL, which no name reader accepts.
  return rest.map((w) => (w === null ? '\u0000' : w));
}

// ─── Flag tables ────────────────────────────────────────────────────────────

const NPM_VALUE_FLAGS = new Set([
  '-w', '--workspace', '--registry', '--prefix', '--tag', '--cache', '--userconfig', '--globalconfig',
  '--omit', '--include', '--install-strategy', '-C', '--dir', '--filter', '-F', '--cwd', '--network-timeout',
  '--modules-folder', '--save-prefix', '--loglevel', '--otp', '--scope', '--reporter', '--config',
  '--lockfile-dir', '--virtual-store-dir', '--store-dir', '--mutex', '--network-concurrency', '--cache-folder',
  '--global-folder', '--link-folder', '--use-yarnrc', '--backend', '--trust', '--allow',
]);
const NPM_GLOBAL_FLAGS = new Set(['-g', '--global', '--location=global']);
const NPX_VALUE_FLAGS = new Set(['--registry', '--cache', '--userconfig', '-w', '--workspace', '--prefix', '--loglevel', '--node-options', '--shell', '--call', '-c']);
const NPM_INSTALL_SUBS = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add']);

const PIP_VALUE_FLAGS = new Set([
  '-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url',
  '-f', '--find-links', '-t', '--target', '--prefix', '--root', '--platform', '--python-version',
  '--implementation', '--abi', '--src', '--upgrade-strategy', '--progress-bar', '--cache-dir', '--log',
  '--proxy', '--retries', '--timeout', '--trusted-host', '--cert', '--client-cert', '--exists-action',
  '--report', '-C', '--config-settings', '--global-option', '--no-binary', '--only-binary', '--python',
  '-p', '--index', '--default-index', '--index-strategy', '--keyring-provider', '--resolution', '--prerelease',
  '--exclude-newer', '--link-mode', '--reinstall-package', '--refresh-package', '--no-build-package',
  '--no-binary-package', '--only-binary-package', '--config-file', '--directory', '--project', '--group',
  '--overrides', '--build-constraints', '--torch-backend', '--extra', '--color',
]);
const UV_ADD_VALUE_FLAGS = new Set([
  ...PIP_VALUE_FLAGS, '--optional', '--package', '--tag', '--branch', '--rev', '--script', '--bounds', '--marker', '-m',
  '--requirements', '--constraints',
]);
const CARGO_VALUE_FLAGS = new Set([
  '-p', '--package', '-F', '--features', '--rename', '--registry', '--target', '--manifest-path',
  '--lockfile-path', '--color', '-Z', '--config', '--branch', '--tag', '--rev', '--git', '--path', '--base',
]);

// ─── Name parsing ───────────────────────────────────────────────────────────

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

/** The registry name a JS spec installs, or null for anything that is not a plain registry spec. */
export function npmSpecName(spec: string): string | null {
  let s = spec.trim();
  if (!s || s.includes('\u0000')) return null;
  // `alias@npm:real@1.2`: what lands from the registry is `real`.
  const alias = /^((?:@[^/@]+\/)?[^/@]+)@npm:(.+)$/.exec(s);
  if (alias) s = alias[2];
  if (/^[.~/\\]/.test(s) || s.includes('://') || /^(git\+|git:|github:|gitlab:|bitbucket:|gist:|file:|link:|workspace:|portal:|patch:|http)/i.test(s)) return null;
  if (/\.(tgz|tar|tar\.gz|zip)$/i.test(s)) return null;
  let name: string;
  if (s.startsWith('@')) {
    const at = s.indexOf('@', 1);
    name = at === -1 ? s : s.slice(0, at);
  } else {
    const at = s.indexOf('@');
    name = at === -1 ? s : s.slice(0, at);
  }
  // `user/repo` GitHub shorthand, or a scoped name with a path after it.
  if (!name.startsWith('@') && name.includes('/')) return null;
  if (name.length > 214 || !NPM_NAME.test(name)) return null;
  return name;
}

const PY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** The project name a pip requirement installs, or null for a path, URL or direct reference. */
export function pythonSpecName(spec: string): string | null {
  const s = spec.trim();
  if (!s || s.includes('\u0000')) return null;
  if (/^[.~/\\]/.test(s) || s.includes('://') || /^(git\+|file:|hg\+|svn\+|bzr\+)/i.test(s)) return null;
  if (/\.(whl|tar\.gz|tgz|zip|tar\.bz2)$/i.test(s)) return null;
  // `name @ url` is a direct reference: not the registry.
  if (/\s@\s|@\s*\w+:/.test(s) || /^[^@]+@/.test(s)) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s);
  if (!m) return null;
  const name = m[1].replace(/[._-]+$/, '');
  const rest = s.slice(m[1].length);
  // What may follow a name: extras, a version specifier, a marker.
  if (rest && !/^\s*(\[|==|>=|<=|~=|!=|===|<|>|;|,|$)/.test(rest)) return null;
  if (name.includes('/') || name.length > 128 || !PY_NAME.test(name)) return null;
  return name;
}

const CRATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function crateSpecName(spec: string): string | null {
  const s = spec.trim();
  if (!s || s.includes('\u0000')) return null;
  const at = s.indexOf('@');
  const name = at === -1 ? s : s.slice(0, at);
  if (name.length > 64 || !CRATE_NAME.test(name)) return null;
  return name;
}

/** PEP 503: case and runs of `-`, `_`, `.` do not tell two projects apart. */
export function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** crates.io treats `-` and `_` (and case) as the same name. */
export function normalizeCrateName(name: string): string {
  return name.toLowerCase().replace(/_/g, '-');
}

// ─── Per-tool readers ───────────────────────────────────────────────────────

/** Positional words after `start` (value-taking flags and their values skipped), and every flag seen. */
function positionals(args: Segment, start: number, valueFlags: ReadonlySet<string>): { names: string[]; flags: Set<string> } {
  const names: string[] = [];
  const flags = new Set<string>();
  let afterDashes = false;
  for (let i = start; i < args.length; i++) {
    const a = args[i];
    if (!afterDashes && a === '--') { afterDashes = true; continue; }
    if (!afterDashes && a.startsWith('-') && a.length > 1) {
      const eq = a.indexOf('=');
      const flag = eq === -1 ? a : a.slice(0, eq);
      flags.add(a);
      flags.add(flag);
      if (eq === -1 && valueFlags.has(flag)) i++;
      continue;
    }
    names.push(a);
  }
  return { names, flags };
}

function isGlobal(flags: Set<string>): boolean {
  for (const f of flags) if (NPM_GLOBAL_FLAGS.has(f)) return true;
  return false;
}

function jsInstall(args: Segment, start: number, out: InstallPackageRef[]): void {
  const { names, flags } = positionals(args, start, NPM_VALUE_FLAGS);
  // A global install lands outside the project: there is nothing to compare it with.
  if (isGlobal(flags)) return;
  for (const n of names) {
    const name = npmSpecName(n);
    if (name) out.push({ ecosystem: 'npm', name, via: 'install' });
  }
}

/** npx / bunx / pnpm dlx / yarn dlx: the package is the first positional, or every `-p` value. */
function jsRun(args: Segment, start: number, out: InstallPackageRef[]): void {
  const packages: string[] = [];
  let first: string | undefined;
  for (let i = start; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { first = args[i + 1]; break; }
    if (a === '-p' || a === '--package') { if (args[i + 1] !== undefined) packages.push(args[++i]); continue; }
    if (a.startsWith('--package=')) { packages.push(a.slice('--package='.length)); continue; }
    if (a.startsWith('-')) {
      if (NPX_VALUE_FLAGS.has(a)) {
        // `npx -c '<cmd>'` runs a command string, not a package.
        if (a === '-c' || a === '--call') return;
        i++;
      }
      continue;
    }
    first = a;
    break;
  }
  const specs = packages.length > 0 ? packages : first !== undefined ? [first] : [];
  for (const s of specs) {
    const name = npmSpecName(s);
    if (name) out.push({ ecosystem: 'npm', name, via: 'run' });
  }
}

function pipInstall(args: Segment, start: number, valueFlags: ReadonlySet<string>, out: InstallPackageRef[]): void {
  const { names } = positionals(args, start, valueFlags);
  for (const n of names) {
    const name = pythonSpecName(n);
    if (name) out.push({ ecosystem: 'pypi', name, via: 'install' });
  }
}

/** Index of a JS package manager's subcommand: options before it (`pnpm --filter web add`) are skipped. */
function jsSubIndex(args: Segment): number {
  let i = 1;
  while (i < args.length && args[i].startsWith('-')) {
    i += !args[i].includes('=') && NPM_VALUE_FLAGS.has(args[i]) ? 2 : 1;
  }
  return i;
}

function readSegment(args: Segment, out: InstallPackageRef[]): void {
  const p = programName(args[0]);
  const sub = args[1];
  if (p === 'npm' || p === 'pnpm' || p === 'yarn' || p === 'bun') {
    const at = jsSubIndex(args);
    const verb = args[at];
    if (verb === undefined) return;
    // A global flag before the subcommand (`npm -g i x`) makes the install global too.
    const leadingGlobal = args.slice(1, at).some((a) => NPM_GLOBAL_FLAGS.has(a));
    const install = p === 'npm' ? NPM_INSTALL_SUBS.has(verb)
      : p === 'pnpm' ? verb === 'add' || verb === 'install' || verb === 'i'
        : p === 'yarn' ? verb === 'add'
          : verb === 'add' || verb === 'a' || verb === 'install' || verb === 'i';
    const run = p === 'npm' ? verb === 'exec' || verb === 'x'
      : p === 'bun' ? verb === 'x'
        : verb === 'dlx';
    if (install && !leadingGlobal) jsInstall(args, at + 1, out);
    else if (run) jsRun(args, at + 1, out);
    return;
  }
  if (p === 'npx' || p === 'bunx' || p === 'pnpx') {
    jsRun(args, 1, out);
    return;
  }
  if (/^pip(3(\.\d+)?)?$/.test(p)) {
    if (sub === 'install') pipInstall(args, 2, PIP_VALUE_FLAGS, out);
    return;
  }
  if (/^python(3(\.\d+)?)?$/.test(p) || p === 'py') {
    // `python -m pip install …`
    const m = args.indexOf('-m');
    if (m !== -1 && args[m + 1] === 'pip' && args[m + 2] === 'install') pipInstall(args, m + 3, PIP_VALUE_FLAGS, out);
    return;
  }
  if (p === 'uv') {
    if (sub === 'add') {
      const { flags } = positionals(args, 2, UV_ADD_VALUE_FLAGS);
      if (flags.has('--git') || flags.has('--path') || flags.has('--editable')) return;
      pipInstall(args, 2, UV_ADD_VALUE_FLAGS, out);
    } else if (sub === 'pip' && args[2] === 'install') {
      pipInstall(args, 3, PIP_VALUE_FLAGS, out);
    }
    return;
  }
  if (p === 'cargo') {
    if (sub !== 'add') return;
    const { names, flags } = positionals(args, 2, CARGO_VALUE_FLAGS);
    // From a git repo or a path: not crates.io.
    if (flags.has('--git') || flags.has('--path')) return;
    for (const n of names) {
      const name = crateSpecName(n);
      if (name) out.push({ ecosystem: 'crates', name, via: 'install' });
    }
  }
}

/**
 * The registry packages `command` installs or runs, deduplicated, at most
 * MAX_INSTALL_PACKAGES. Empty for anything that is not one of the recognised
 * install commands, and for a bare `npm install` (no names).
 */
export function parseInstallCommand(command: string): InstallPackageRef[] {
  if (typeof command !== 'string' || !command || command.length > MAX_COMMAND_CHARS) return [];
  const out: InstallPackageRef[] = [];
  for (const raw of segmentsOf(command)) {
    const seg = unwrap(raw);
    if (!seg) continue;
    readSegment(seg, out);
  }
  const seen = new Set<string>();
  const unique: InstallPackageRef[] = [];
  for (const r of out) {
    const key = `${r.ecosystem}:${r.ecosystem === 'pypi' ? normalizePythonName(r.name) : r.ecosystem === 'crates' ? normalizeCrateName(r.name) : r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
    if (unique.length >= MAX_INSTALL_PACKAGES) break;
  }
  return unique;
}
