// ─── Hermes install — the version of the install `hermes` runs, read from files ─
//
// Hermes's `--version` runs its update check (hermes_cli/main.py cmd_version →
// _print_version_info(check_updates=True) → banner.py check_for_updates),
// which runs `git fetch` in the install the command resolves to and writes
// `.update_check` in HERMES_HOME. Hermes has no switch that turns that check
// off for `--version`, so wmux never runs it: the version is read from the
// install's `hermes_cli/__init__.py` (`__version__ = "X.Y.Z"`), the module
// Hermes itself reports.
//
// The install is found from the executable `hermes` resolves to:
// - for a small shell launcher, the program each of its `exec` commands runs
//   (the installer's `exec "<install>/venv/bin/hermes" "$@"`, or a forwarder
//   to `<checkout>/.hermes/bin/hermes`), before the launcher itself;
// - followed through symlinks to `<venv>/bin/hermes` (`<venv>\Scripts\…` on
//   Windows): `<venv>/../hermes_cli/__init__.py` (a source checkout installed
//   into its own venv, as the installer does), else the venv's
//   `site-packages/hermes_cli/__init__.py` (a pip, pipx or uv install);
// - the Windows installer's published command `<HERMES_HOME>\bin\hermes.exe`
//   (a native launcher, not text): the install beside it,
//   `<HERMES_HOME>\hermes-agent` (scripts/install.ps1 $HermesHome, $InstallDir,
//   Publish-UserCommand).
// Nothing is run and nothing is written.

import fs from 'node:fs';
import path from 'node:path';

/** At most this much of a launcher or version module is read. */
const LAUNCHER_MAX_BYTES = 8 * 1024;
const VERSION_MAX_BYTES = 256 * 1024;

/** `X.Y.Z` (or `X.Y.Z-<pre>`) from an install's `hermes_cli/__init__.py`
 *  text (`__version__ = "0.22.5"`), or null. Pure. */
export function parseInstallVersion(text: string): string | null {
  const m = /^__version__\s*=\s*["'](\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:-([0-9A-Za-z.]{1,40}))?["']\s*$/m.exec(text);
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}${m[4] ? `-${m[4]}` : ''}` : null;
}

export interface HermesInstallDeps {
  realpath?: (p: string) => string;
  /** A file's text when it is a regular file of at most `max` bytes, else null. */
  readText?: (file: string, max: number) => string | null;
  readdir?: (dir: string) => string[];
}

function readText(file: string, max: number): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The first word of a POSIX shell command line, as sh reads it (single and
 *  double quotes, backslash escapes), or null. Pure. */
export function shFirstWord(line: string): string | null {
  let i = 0;
  while (i < line.length && /[ \t]/.test(line[i])) i++;
  let word = '';
  let any = false;
  while (i < line.length && !/[ \t\r\n;&|]/.test(line[i])) {
    const c = line[i];
    any = true;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      word += line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) i++;
        word += line[i];
        i++;
      }
      if (i >= line.length) return null;
      i++;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[i + 1];
      i += 2;
    } else {
      word += c;
      i++;
    }
  }
  return any && word ? word : null;
}

/** The programs a small shell launcher runs: the first word of each
 *  top-level `exec` command (`exec "<install>/venv/bin/hermes" "$@"`, at the
 *  start of a line, as Hermes's launchers write it). A path the text only
 *  mentions (a comment, an echo, an indented branch) is not one. Pure. */
export function launcherExecTargets(text: string): string[] {
  if (!text.startsWith('#!')) return [];
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^exec[ \t]/.test(line)) continue;
    const w = shFirstWord(line.slice(4));
    if (w && path.isAbsolute(w)) out.push(w);
  }
  return out;
}

/** The version modules that may belong to the install `exe` runs, most
 *  likely first: what a launcher execs before the launcher's own place.
 *  Reads only small files and directory names. */
export function hermesVersionFiles(exe: string, deps: HermesInstallDeps = {}): string[] {
  const real = deps.realpath ?? ((p: string) => fs.realpathSync(p));
  const read = deps.readText ?? readText;
  const readdir = deps.readdir ?? ((d: string) => fs.readdirSync(d));
  // A forwarder may exec another launcher (~/.local/bin/hermes →
  // <checkout>/.hermes/bin/hermes): followed a few levels.
  const targets: string[] = [];
  const visit = (t: string, depth: number): void => {
    if (targets.includes(t)) return;
    const text = depth < 3 ? read(t, LAUNCHER_MAX_BYTES) : null;
    for (const next of text === null ? [] : launcherExecTargets(text)) visit(next, depth + 1);
    targets.push(t);
  };
  visit(exe, 0);
  const out: string[] = [];
  const sitePackages = (venv: string): void => {
    for (const lib of ['lib', 'Lib']) {
      const libDir = path.join(venv, lib);
      let names: string[] = [];
      try {
        names = readdir(libDir);
      } catch {
        continue;
      }
      if (names.includes('site-packages')) out.push(path.join(libDir, 'site-packages', 'hermes_cli', '__init__.py'));
      for (const py of names.filter((n) => /^python3(\.\d+)?$/.test(n))) out.push(path.join(libDir, py, 'site-packages', 'hermes_cli', '__init__.py'));
    }
  };
  for (const t of targets) {
    let r = t;
    try {
      r = real(t);
    } catch {
      continue;
    }
    const bin = path.dirname(r);
    if (!/^(bin|scripts)$/i.test(path.basename(bin))) continue;
    // `<venv>/bin/hermes`: the checkout beside the venv, then the venv's
    // packages. Also `<checkout>/.hermes/bin/hermes`, the checkout's own
    // launcher (hermes_cli/_launchers.py), whose parent's parent is the checkout.
    const venv = path.dirname(bin);
    out.push(path.join(path.dirname(venv), 'hermes_cli', '__init__.py'));
    sitePackages(venv);
    // The installer's published command, `<HERMES_HOME>/bin/hermes(.exe)`, a
    // launcher beside the install `<HERMES_HOME>/hermes-agent`
    // (scripts/install.ps1 $HermesHome / $InstallDir and Publish-UserCommand).
    out.push(path.join(venv, 'hermes-agent', 'hermes_cli', '__init__.py'));
    sitePackages(path.join(venv, 'hermes-agent', 'venv'));
  }
  return [...new Set(out)];
}

/** The version of the install `exe` runs, read from its files, or null when
 *  no version module is found or none parses. Never runs anything. */
export function hermesInstallVersion(exe: string, deps: HermesInstallDeps = {}): string | null {
  const read = deps.readText ?? readText;
  for (const file of hermesVersionFiles(exe, deps)) {
    const text = read(file, VERSION_MAX_BYTES);
    const v = text === null ? null : parseInstallVersion(text);
    if (v) return v;
  }
  return null;
}
