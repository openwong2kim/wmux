// The tests scripts/verify.sh adds to `vitest --changed`: those that read a
// changed source file as text. Such a test checks a source by its words (a
// regex over useTerminal.ts, a slice of daemon/index.ts) and imports nothing it
// checks, so `--changed`, which follows imports, never picks it. Changes
// passed verify.sh and then failed one of them in CI: twice on #3330 (a slice
// of useTerminal.ts), once on #3336 (the koffi packaging pins).
//
// A test counts when a path built from its string literals names the changed
// file, extension included. A TypeScript import specifier has none; an ESM
// import of a .mjs file does, and such a test then runs twice, which only
// costs time. A literal is resolved from the test's directory or from the
// repository root, alone or joined to the literals before it
// (`path.join(__dirname, '..', '..', 'daemon', 'index.ts')`), and from up to
// four directories above the test (a base directory kept in a variable).
// How it reads the file does not matter
// (`readFileSync`, a helper such as test-utils/sourceText.ts, a spawned
// script). Picking a test too many only costs its run.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const posix = path.posix;

/** A source file a test may read as text; `.json` too, for the tests that
 *  pin a dependency or a script in package.json. */
const SOURCE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js|json)$/;
const TEST_FILE = /\.test\.(ts|tsx|mts|cts|mjs|cjs|js)$/;
// Single, double and template literals on one line; no escapes needed for paths.
// A template's `${...}` parts (`${__dirname}/../x.ts`) are dropped: what is
// left is resolved from the test's directory and above, like any literal.
const STRING_LITERAL = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\\n]*)`/g;
/** Literals joined before the one that ends with the file's name. */
const MAX_JOINED = 6;
/** Directories above the test a base path may start from. */
const MAX_ANCESTORS = 4;

export const isTestFile = (file) => TEST_FILE.test(file);

/**
 * The trees vitest.config.ts (`include`, both lanes) and
 * vitest.runtime.config.ts (`include`) run. A test outside them (e2e/, rig/,
 * core/harness/) has its own runner: named to `vitest run`, it matches no
 * file and fails the gate. Keep in step with those two `include` lists.
 */
const LANE_TEST_FILE = [
  /^src\/(?:.+\/)?__tests__\/(?:.+\/)?[^/]+\.test\.tsx?$/,
  /^scripts\/__tests__\/(?:.+\/)?[^/]+\.test\.mjs$/,
  /^integrations\/(?:.+\/)?__tests__\/(?:.+\/)?[^/]+\.test\.tsx?$/,
  /^relay\/__tests__\/(?:.+\/)?[^/]+\.test\.ts$/,
];
const RUNTIME_TEST = /\.runtime\.test\./;

/** A test file one of verify.sh's two vitest configs runs. */
export function inAVitestLane(file) {
  if (!LANE_TEST_FILE.some((re) => re.test(file))) return false;
  // relay/ has no runtime lane: its runtime suite would run nowhere.
  return !(RUNTIME_TEST.test(file) && file.startsWith('relay/'));
}
export const isSourceFile = (file) => SOURCE_FILE.test(file) && !TEST_FILE.test(file);

function literalsOf(text) {
  const out = [];
  for (const m of text.matchAll(STRING_LITERAL)) {
    const literal = m[1] ?? m[2] ?? m[3].replace(/\$\{[^}]*\}\/?/g, '');
    out.push(literal.replace(/\\/g, '/'));
  }
  return out;
}

/** Repository-relative paths the literals ending at `index` can name. */
function candidates(testDir, literals, index) {
  const out = new Set();
  for (let from = index; from >= Math.max(0, index - MAX_JOINED + 1); from--) {
    const parts = literals.slice(from, index + 1);
    if (parts.some((p) => p === '')) break;
    for (let up = 0; up <= MAX_ANCESTORS; up++) {
      out.add(posix.normalize(posix.join(testDir, ...Array(up).fill('..'), ...parts)));
    }
    out.add(posix.normalize(posix.join(...parts)));
  }
  return out;
}

/**
 * The tests among `tests` that read one of `changed` as text.
 * `read(file)` returns a test's source, or null when it cannot be read.
 * All paths are repository-relative with `/`.
 */
export function sourceReaders({ changed, tests, read }) {
  const targets = changed.filter(isSourceFile);
  if (targets.length === 0) return [];
  const byName = new Map();
  for (const file of targets) {
    const name = posix.basename(file);
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(file);
  }
  const picked = [];
  for (const test of tests) {
    const text = read(test);
    if (text === null) continue;
    const literals = literalsOf(text);
    const testDir = posix.dirname(test);
    const hit = literals.some((literal, i) => {
      const files = byName.get(posix.basename(literal));
      if (!files) return false;
      for (const c of candidates(testDir, literals, i)) if (files.has(c)) return true;
      return false;
    });
    if (hit) picked.push(test);
  }
  return picked.sort();
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

const lines0 = (out) => out.split('\0').filter((s) => s !== '');

/** The change since `base`, as verify.sh counts it: committed, staged,
 *  unstaged and untracked files. */
export function changedFiles(root, base) {
  return [...new Set([
    ...lines0(git(root, ['diff', '-z', '--name-only', base, 'HEAD'])),
    ...lines0(git(root, ['diff', '-z', '--name-only', 'HEAD'])),
    ...lines0(git(root, ['ls-files', '-z', '--others', '--exclude-standard'])),
  ])].sort();
}

/** Every test file in the tree, tracked or not, that verify.sh's vitest configs run. */
export function testFiles(root) {
  return lines0(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).filter(inAVitestLane);
}

export function readOrNull(root) {
  return (file) => {
    try {
      return fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      return null;
    }
  };
}
