/**
 * Test lanes: which test files must run on Windows in a PR's CI
 * ("integration": they touch the operating system, or they know about
 * Windows) and which are pure, OS-agnostic unit tests ("unit").
 *
 * Why: CI ran ~2,000 test files on a 4-core Windows runner with one worker
 * process per core. The files that spawn real processes (git, PowerShell,
 * node), open sockets or pipes, or lean on real temp-dir I/O were every flake
 * of a week, all of the "the runner was slow" kind: they wait on the OS, and
 * the OS is shared with 1,000 other files. vitest.config.ts runs the two lanes
 * as two projects; the integration project gets fewer workers and longer
 * timeouts (see the comment there). CI runs it as its own Windows job and runs
 * the unit lane on Linux, where process and file-system calls are several
 * times cheaper; a nightly job still runs everything on Windows. The two real
 * Windows-only failures of the week before the lanes (a `.gitconfig` git
 * refused on Windows, a WSL path) were both in files rule 2 catches, and over
 * the 21 PR commits that had run on both OSes, none had failed on Windows
 * alone — so the unit lane's Linux result is trusted for pure logic, and
 * anything that so much as names Windows stays on Windows (rule 5).
 *
 * The rule below decides each file's lane from its source. Its result is
 * checked in as vitest.lanes.json (integration files only; every other
 * included file is unit), which vitest.config.ts reads: classifying costs
 * ~0.5 s of CPU, too much to pay on every `vitest run`. A guard test
 * (scripts/__tests__/testLanes.test.mjs) recomputes it and fails when the
 * file is stale, naming the file, the reason and the fix.
 *
 * THE RULE. A test file is `integration` when any of these holds, else `unit`:
 *
 *   1. Pragma. A line comment `// @wmux-lane integration` or
 *      `// @wmux-lane unit` decides outright, overriding 2-5. Use it when the
 *      rule guesses wrong, and say why on the next line.
 *   2. The file imports an OS module itself: `child_process`, `net`, `http`,
 *      `https`, `http2`, `dgram` or `tls`, with or without the `node:` prefix,
 *      as `import ... from`, `import()` or `require()`. A type-only import
 *      does not count (TypeScript erases it), and neither does a module the
 *      same file replaces with `vi.mock('<module>')`: such a test asserts on
 *      the mock and never reaches the OS.
 *   3. The file imports a test helper that, by rule 2, imports an OS module:
 *      a file under src/test-utils/ (shortPath.ts runs cmd.exe,
 *      realBrowserHarness.ts serves HTTP) or a non-test file in a __tests__
 *      directory (fakeClaude.ts, a2aServerRig.ts). One level only: helpers
 *      that import helpers are not followed.
 *   4. The file creates a real temp dir (`mkdtemp`) AND imports, one relative
 *      level deep, a source module that by rule 2 imports an OS module the
 *      test does not `vi.mock`, and that module is not `vi.mock`ed itself.
 *      This is the git-worktree/daemon-pipe shape: the test builds a real
 *      directory and the code under test runs git or opens a pipe in it, with
 *      no spawn in the test's own text. Without the `mkdtemp` half the rule
 *      would pull in every test of a pure helper that happens to live in a
 *      module that also spawns.
 *
 *   5. The file mentions `win32` anywhere in its text: a platform check, a
 *      `skipIf`/`runIf`, a comment. A file that knows about Windows must run
 *      on Windows, whatever it imports; 309 of 2,106 files when measured,
 *      26 of them running only on win32. The plain substring is the rule, so
 *      a new spelling cannot slip past it.
 *
 * Out of scope on purpose: fsync-heavy writes on their own. A durable write
 * is slow, not OS-shared state, and the tests that tripped on it were fixed
 * where they stood (nonDurableAtomicWrite.ts). Runtime suites
 * (`*.runtime.test.*`) belong to vitest.runtime.config.ts, not to either lane.
 *
 * This file carries no shebang so tests can import it; the command line is
 * scripts/test-lanes.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `..` twice: this file sits in scripts/lib, the repo root is two levels up.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const LANES = ['unit', 'integration'];

/** The checked-in result: the integration lane, read by vitest.config.ts. */
export const LANES_FILE = path.join(ROOT, 'vitest.lanes.json');

export const OS_MODULES = ['child_process', 'net', 'http', 'https', 'http2', 'dgram', 'tls'];

// The suites vitest.config.ts includes, as one regex over a repo-relative,
// forward-slash path. scripts/__tests__/testLanes.test.mjs pins it to the
// config's `include` globs, so the two cannot drift apart.
//   src/**/__tests__/**/*.test.{ts,tsx}
//   scripts/__tests__/**/*.test.mjs
//   integrations/**/__tests__/**/*.test.{ts,tsx}
//   relay/__tests__/**/*.test.ts
const TEST_FILE =
  /^(?:src\/(?:.+\/)?__tests__\/(?:.+\/)?[^/]+\.test\.tsx?|scripts\/__tests__\/(?:.+\/)?[^/]+\.test\.mjs|integrations\/(?:.+\/)?__tests__\/(?:.+\/)?[^/]+\.test\.tsx?|relay\/__tests__\/(?:.+\/)?[^/]+\.test\.ts)$/;
const RUNTIME_FILE = /\.runtime\.test\.[^/]+$/;
const WALK_ROOTS = ['src', 'scripts/__tests__', 'integrations', 'relay/__tests__'];
// vitest's default exclude (configDefaults.exclude): never descend into these.
const SKIP_DIRS = new Set(['node_modules', '.git']);

const MODULE_NAMES = OS_MODULES.join('|');
// Two steps, for speed: find the quoted module name, then look at what stands
// right before it. One regex that starts with the import keywords tries every
// position of ~22 MB of test source and cost ~300 ms per vitest start.
const OS_LITERAL = new RegExp(`['"](?:node:)?(${MODULE_NAMES})['"]`, 'g');
const IMPORT_BEFORE = /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*$/;
const MOCK_CALL = /\bvi\s*\.\s*(?:do)?[mM]ock\s*\(\s*['"]([^'"]+)['"]/g;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;
const PRAGMA = /^[ \t]*\/\/[ \t]*@wmux-lane[ \t]+(\S+)/m;
const MKDTEMP = /\bmkdtemp(?:Sync)?\b/;
// Rule 5. A substring, not a word: `win32` never appears in this codebase
// except to mean Windows.
const WIN32 = /win32/;
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];

const toPosix = (p) => p.split(path.sep).join('/');
const IN_TESTS_DIR = /(?:^|\/)__tests__\//;
const TEST_SOURCE = /\.test\.[^/]+$/;
// A relative specifier that can reach a helper: src/test-utils, a __tests__
// directory, or a sibling of the test file (which sits in __tests__ itself).
const MAY_NAME_HELPER = /test-utils\/|__tests__|^\.\//;

/** Every non-runtime test file vitest.config.ts includes, repo-relative, sorted. */
export function listTestFiles(root = ROOT) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(child);
      } else if (e.isFile() && TEST_FILE.test(child) && !RUNTIME_FILE.test(child)) {
        out.push(child);
      }
    }
  };
  for (const r of WALK_ROOTS) walk(r);
  return out.sort();
}

/**
 * True when the `from '<module>'` ending at `index` closes a type-only import
 * (`import type ...` or `import { type A, type B }`): TypeScript erases it, so
 * nothing reaches the OS.
 */
function isTypeOnlyImport(source, index) {
  const before = source.slice(Math.max(0, index - 2000), index);
  const stmt = before.slice(before.lastIndexOf('import'));
  if (/^import\s+type\b/.test(stmt)) return true;
  const named = stmt.match(/^import\s*\{([^}]*)\}\s*from\s*$/);
  if (!named) return false;
  const specifiers = named[1].split(',').map((x) => x.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every((x) => /^type\s/.test(x));
}

/** The OS modules a source imports at runtime, minus those named in `exceptMocked`. */
export function osImports(source, exceptMocked = new Set()) {
  const found = new Set();
  for (const m of source.matchAll(OS_LITERAL)) {
    if (exceptMocked.has(m[1]) || found.has(m[1])) continue;
    const lead = source.slice(Math.max(0, m.index - 24), m.index);
    if (!IMPORT_BEFORE.test(lead)) continue;
    if (/\bfrom\s*$/.test(lead) && isTypeOnlyImport(source, m.index)) continue;
    found.add(m[1]);
  }
  return [...found].sort();
}

/** `vi.mock` targets, split into OS modules and relative specifiers. */
function mockedIn(source) {
  const os = new Set();
  const relative = new Set();
  if (!/ock\s*\(/.test(source)) return { os, relative };
  for (const m of source.matchAll(MOCK_CALL)) {
    const spec = m[1];
    const bare = spec.replace(/^node:/, '');
    if (OS_MODULES.includes(bare)) os.add(bare);
    else if (spec.startsWith('.')) relative.add(spec);
  }
  return { os, relative };
}

/** `@wmux-lane <lane>` in a line comment, or null. Throws on an unknown lane. */
export function pragmaOf(source, file = '<source>') {
  const m = source.match(PRAGMA);
  if (!m) return null;
  if (!LANES.includes(m[1])) {
    throw new Error(`${file}: unknown lane "${m[1]}" in @wmux-lane (expected ${LANES.join(' or ')})`);
  }
  return m[1];
}

/** Absolute path of a relative import, or null when it is not a file here. */
function resolveRelative(fromAbs, spec) {
  // TS sources import siblings as `./x.js`; the file on disk is x.ts.
  const bases = [path.resolve(path.dirname(fromAbs), spec)];
  if (/\.[cm]?js$/.test(spec)) bases.push(bases[0].replace(/\.[cm]?js$/, ''));
  for (const base of bases) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = base + suffix;
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not this spelling; try the next.
      }
    }
  }
  return null;
}

/**
 * Classify one test file. `read(abs)` returns a file's source (cached by the
 * caller). Returns { file, lane, reasons }, where reasons say which rule
 * fired, in words a failing guard can print.
 */
export function classifyTestFile(file, { root = ROOT, read = (abs) => fs.readFileSync(abs, 'utf8') } = {}) {
  const abs = path.join(root, file);
  const source = read(abs);

  const pragma = pragmaOf(source, file);
  if (pragma) return { file, lane: pragma, reasons: [`pragma @wmux-lane ${pragma}`] };

  const reasons = [];
  const mocked = mockedIn(source);

  for (const mod of osImports(source, mocked.os)) reasons.push(`imports node:${mod}`);
  if (WIN32.test(source)) reasons.push('mentions win32');

  const usesTempDir = MKDTEMP.test(source);
  const mockedRelative = new Set([...mocked.relative].map((spec) => resolveRelative(abs, spec)).filter(Boolean));
  const seen = new Set();
  for (const m of source.matchAll(RELATIVE_IMPORT)) {
    // Without a temp dir only helpers matter, so skip the stat calls for
    // specifiers that cannot name one.
    if (!usesTempDir && !MAY_NAME_HELPER.test(m[1])) continue;
    const target = resolveRelative(abs, m[1]);
    if (!target || seen.has(target) || mockedRelative.has(target)) continue;
    seen.add(target);
    const rel = toPosix(path.relative(root, target));
    if (TEST_SOURCE.test(rel)) continue;
    const isHelper = rel.startsWith('src/test-utils/') || IN_TESTS_DIR.test(rel);
    if (!isHelper && !usesTempDir) continue;
    const mods = osImports(read(target), mocked.os);
    if (mods.length === 0) continue;
    reasons.push(
      isHelper
        ? `imports the helper ${rel}, which imports ${mods.map((x) => `node:${x}`).join(', ')}`
        : `uses mkdtemp and imports ${rel}, which imports ${mods.map((x) => `node:${x}`).join(', ')}`,
    );
  }

  return { file, lane: reasons.length > 0 ? 'integration' : 'unit', reasons };
}

/**
 * Classify every test file. Returns { unit: string[], integration: string[],
 * byFile: Map<file, {lane, reasons}> }, file lists sorted and repo-relative.
 */
export function classifyAll({ root = ROOT, files = listTestFiles(root) } = {}) {
  const cache = new Map();
  const read = (abs) => {
    let s = cache.get(abs);
    if (s === undefined) {
      s = fs.readFileSync(abs, 'utf8');
      cache.set(abs, s);
    }
    return s;
  };
  const byFile = new Map();
  const lanes = { unit: [], integration: [] };
  for (const file of files) {
    const result = classifyTestFile(file, { root, read });
    byFile.set(file, result);
    lanes[result.lane].push(file);
  }
  return { ...lanes, byFile };
}

const LANES_FILE_NOTE = [
  'Generated by `node scripts/test-lanes.mjs --write`; do not edit by hand.',
  'These test files run in the vitest `integration` project, every other one in `unit`.',
  'The rule is in scripts/lib/test-lanes.mjs. To move one file, put',
  '`// @wmux-lane unit` or `// @wmux-lane integration` in it and regenerate.',
];

/** vitest.lanes.json's text for an integration list. */
export function renderLanesFile(integration) {
  return `${JSON.stringify({ '//': LANES_FILE_NOTE, integration: [...integration].sort() }, null, 2)}\n`;
}

/** { integration, text } from vitest.lanes.json; integration is [] when it is missing. */
export function readLanesFile(file = LANES_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { integration: [], text: null };
  }
  return { integration: JSON.parse(text).integration ?? [], text };
}

/**
 * What differs between the checked-in list and a fresh classification, one
 * line per file, each naming the fix. [] when the file is current.
 */
export function laneDrift(listed, lanes) {
  const problems = [];
  const fix = '`node scripts/test-lanes.mjs --write`';
  if (listed.text === null) return [`${path.relative(ROOT, LANES_FILE)} is missing. Run ${fix}.`];
  const have = new Set(listed.integration);
  for (const file of lanes.integration) {
    if (have.has(file)) continue;
    const { reasons } = lanes.byFile.get(file);
    problems.push(
      `${file} touches the OS (${reasons.join('; ')}) but is not in the integration lane. ` +
        `Run ${fix}. If it never reaches the OS (the import is only a type, or it is mocked another way), ` +
        'add `// @wmux-lane unit` to the file instead, with a line saying why.',
    );
  }
  const wanted = new Set(lanes.integration);
  for (const file of listed.integration) {
    if (wanted.has(file)) continue;
    problems.push(
      lanes.byFile.has(file)
        ? `${file} is in the integration lane, but the rule now puts it in unit. Run ${fix}, ` +
            'or add `// @wmux-lane integration` to the file if it still touches the OS.'
        : `${file} is in the integration lane but is not a test file any more (renamed or deleted?). Run ${fix}.`,
    );
  }
  // A Windows checkout (core.autocrlf) holds the file with CRLF; that is the
  // generated form too.
  if (problems.length === 0 && listed.text.replace(/\r\n/g, '\n') !== renderLanesFile(lanes.integration)) {
    problems.push(`${path.relative(ROOT, LANES_FILE)} lists the right files but not in the generated form. Run ${fix}.`);
  }
  return problems;
}
