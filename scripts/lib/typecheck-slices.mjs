// Type-check slices: the root project split into programs small enough to fit
// a CI runner's default V8 heap.
//
// One `tsc -p tsconfig.json` program holds ~3,600 files (half of them tests)
// and peaks near 2.4 GB of heap. On macos-14 (7 GB RAM) that sits on the
// default heap limit, so the check died with "JavaScript heap out of memory"
// on and off from 2026-09-27, and six parallel local gates pushed a 16 GB Mac
// into swap. Each slice below is its own program; together they must list
// exactly the files the root tsconfig does, which coverageGaps() enforces so a
// new directory can never fall out of type checking unnoticed.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROOT_CONFIG = path.join(ROOT, 'tsconfig.json');
export const SLICE_DIR = path.join(ROOT, 'scripts', 'typecheck');

/** Slice configs in run order: the app source first, then the test areas. */
export const SLICES = ['src', 'tests-renderer', 'tests-main', 'tests-daemon', 'tests-rest'];

/**
 * Build programs checked as they are, after the slices. These are not slices:
 * each sets its own compiler options, and the option that matters is the
 * target. The MCP bundle builds for ES2020 and the CLI and daemon for ES2022,
 * while tsconfig.json targets ESNext — so a shared file that calls a newer
 * library API (`Object.hasOwn`, `Array.prototype.at`, `replaceAll`) passes
 * every slice and only fails when its own build runs. #1677 shipped exactly
 * that into the MCP bundle and found out from `npm run start`.
 *
 * They pick their own files, so the coverage and scope checks (which compare
 * slices against tsconfig.json) do not apply to them.
 */
export const PROGRAMS = {
  mcp: 'tsconfig.mcp.json',
  cli: 'tsconfig.cli.json',
  daemon: 'tsconfig.daemon.json',
};

export function sliceConfig(name, dir = SLICE_DIR) {
  return path.join(dir, `${name}.json`);
}

/** The tsconfig to run for a slice or program name. */
export function checkConfig(name, dir = SLICE_DIR, root = ROOT) {
  return Object.prototype.hasOwnProperty.call(PROGRAMS, name)
    ? path.join(root, PROGRAMS[name])
    : sliceConfig(name, dir);
}

/** Every name `node scripts/typecheck.mjs` runs by default, in order. */
export const CHECKS = [...SLICES, ...Object.keys(PROGRAMS)];

/** The root files a tsconfig selects (include/exclude expanded), without building a program. */
export function rootFiles(configPath) {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath), undefined, configPath);
  const fatal = parsed.errors.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) throw new Error(fatal.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  return parsed.fileNames.map((f) => path.resolve(f));
}

/**
 * Files the root config checks that no slice does (`missing`), and files a
 * slice checks that the root config does not (`extra`). Both must be empty.
 */
export function coverageGaps(rootConfig, sliceConfigs) {
  const root = new Set(rootFiles(rootConfig));
  const union = new Set(sliceConfigs.flatMap((c) => rootFiles(c)));
  return {
    missing: [...root].filter((f) => !union.has(f)).sort(),
    extra: [...union].filter((f) => !root.has(f)).sort(),
  };
}

/** A slice may only choose files; any compiler option has to come from tsconfig.json. */
export function sliceConfigProblems(names, dir = SLICE_DIR) {
  const problems = [];
  for (const n of names) {
    const cfg = JSON.parse(fs.readFileSync(sliceConfig(n, dir), 'utf8'));
    const keys = Object.keys(cfg).filter((k) => !['extends', 'include', 'exclude'].includes(k));
    if (keys.length > 0) problems.push(`${n}.json sets ${keys.join(', ')} — slices may only set extends/include/exclude`);
    if (cfg.extends !== '../../tsconfig.json') problems.push(`${n}.json must extend ../../tsconfig.json`);
  }
  return problems;
}

/**
 * Files outside .d.ts that declare globals or augment modules. A slice sees such
 * a declaration only if it holds the file, so each one is listed here on
 * purpose, together with the slices that include it (see scripts/typecheck/).
 */
export const AUGMENTING_FILES = new Set(['src/renderer/components/Browser/BrowserPanel.tsx']);

const AUGMENTS = /\bdeclare\s+(?:global\b|module\s+['"])/;

/**
 * Whole-program behaviour the split would silently lose: an unlisted global or
 * module augmentation outside a .d.ts, and script-scope (non-module) files
 * outside the src slice, whose globals would no longer meet in one program.
 */
const STATIC_MODULE_SYNTAX = new RegExp(
  String.raw`^[ \t]*(?:import[ \t]+(?:type[ \t]+)?[\w*{$'"]` +
    String.raw`|export[ \t]+(?:\*|\{|=|default\b|type\b|interface\b|class\b|const\b|let\b|var\b|function\b|async\b|enum\b|declare\b|abstract\b|namespace\b))`,
  'm',
);

function stripCommentsAndTemplates(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``');
}

export function scopeProblems(rootConfig, srcSliceConfig, root = ROOT) {
  const src = new Set(rootFiles(srcSliceConfig));
  const problems = [];
  for (const file of rootFiles(rootConfig)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (file.endsWith('.d.ts')) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (AUGMENTS.test(text) && !AUGMENTING_FILES.has(rel)) {
      problems.push(`${rel} declares a global or module augmentation — move it to a .d.ts or list it in AUGMENTING_FILES and the slices that need it`);
    }
    // A static import/export declaration already makes the file a module, so
    // only the rare file without one pays for a full parse (slow on CI runners).
    // The fast path must never call a script a module: dynamic `import(…)`,
    // `import.meta`, an `export:` object key, and text inside block comments or
    // template literals do not count.
    if (!src.has(file) && !STATIC_MODULE_SYNTAX.test(stripCommentsAndTemplates(text))) {
      const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      if (!ts.isExternalModule(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind))) {
        problems.push(`${rel} is a script (no import/export); outside the src slice its globals are not checked against the rest`);
      }
    }
  }
  return problems;
}

/**
 * Program files (from `tsc --listFiles`) whose path casing differs from disk.
 * One program used to hold every source file as a root, so a test importing
 * `./foo` for `Foo.ts` on a case-insensitive disk (validate runs on Windows)
 * failed with TS1149. A test slice only reaches src through imports, so the
 * wrong casing is the only spelling it sees and tsc stays quiet; Linux then
 * fails to resolve the import. This restores the check.
 */
export function casingMismatches(files, root = ROOT) {
  const realRoot = fs.realpathSync.native(root);
  const out = [];
  for (const f of files) {
    const abs = path.resolve(f);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || rel.split(path.sep).includes('node_modules')) continue;
    let real;
    try {
      real = path.relative(realRoot, fs.realpathSync.native(abs));
    } catch {
      continue; // not on disk under this spelling: a case-sensitive disk, where tsc already reports TS2307
    }
    // Only a pure casing difference; a symlink resolving elsewhere is not one.
    if (real !== rel && real.toLowerCase() === rel.toLowerCase()) out.push({ listed: rel, onDisk: real });
  }
  return out;
}

export function assertSlicesExist(names, dir = SLICE_DIR) {
  for (const n of names) {
    if (!fs.existsSync(checkConfig(n, dir))) throw new Error(`unknown type-check slice "${n}" (have: ${CHECKS.join(', ')})`);
  }
}

/**
 * The checks a command line asks for: the named ones, or every check when none
 * is named, minus any listed in `--skip a,b`.
 *
 * Only build programs can be skipped. The one reason to skip a check is that
 * something else compiles the same tsconfig anyway (CI's build steps run
 * `tsc -p` on mcp and daemon); nothing else compiles a slice. So a slice or an
 * unknown name in --skip throws rather than silently checking less.
 */
export function selectChecks(argv) {
  const named = [];
  const skip = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip') {
      if (i + 1 >= argv.length) throw new Error('--skip needs a comma-separated list of build programs');
      skip.push(...argv[++i].split(','));
    } else if (argv[i].startsWith('-')) {
      throw new Error(`unknown option "${argv[i]}"`);
    } else {
      named.push(argv[i]);
    }
  }
  for (const n of skip) {
    if (!Object.prototype.hasOwnProperty.call(PROGRAMS, n)) {
      throw new Error(`--skip takes build programs only (${Object.keys(PROGRAMS).join(', ')}), not "${n}"`);
    }
  }
  return (named.length > 0 ? named : CHECKS).filter((n) => !skip.includes(n));
}
