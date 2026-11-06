// Every harness that launches the app by itself and drives it over CDP sets
// the test harness opt-in, WMUX_TEST_CDP_PORT=1, in the env it spawns the app
// with (src/main/browser-session/cdpTestOptIn.ts).
//
// What makes a file a launcher (scripts/ and e2e/; rig/ only spawns daemons):
//   - it reads the app's CDP port from the app log: a pattern for the
//     "CDP requested|listening|enabled on port N" line that captures the
//     number, so a comment or message naming the line is not a read; or
//   - it calls Playwright's `_electron.launch(` / `electron.launch(`, which
//     waits for the app's debugging port itself and never reads that line.
// Scripts that attach to an instance someone else launched get the port
// elsewhere (an argument, a range scan) and are not launchers.
//
// What makes a launcher compliant:
//   - a code line assigns the var into an env: `WMUX_TEST_CDP_PORT: '1'`,
//     `env.WMUX_TEST_CDP_PORT = '1'`, or `WMUX_TEST_CDP_PORT=1` in .sh/.ps1.
//     A bare mention (a delete, a message) does not count; or
//   - it builds its spawn env with control-wmux-lib's scrubEnv()/launchEnv()
//     (imports one and calls it), which set the var (checked below).
// A code line is any line that does not start with a comment token: `//`,
// `/*` or `*` in JavaScript, `#` in .sh/.ps1.
//
// KNOWN_LAUNCHERS names today's launchers: each must still be matched and be
// compliant, so a launcher whose pattern drifts out of the match fails by name.
//
// Blind spots: a launcher that neither reads that log line nor uses
// Playwright's launch (a fixed port, or one that reads the CDP claim file) is
// not caught; nor is an assignment that only exists in a trailing comment.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubEnv } from '../lib/control-wmux-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_DIRS = ['scripts', 'e2e'];
const SHELL_EXTENSIONS = new Set(['.sh', '.ps1']);
const EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.mts', ...SHELL_EXTENSIONS]);

const KNOWN_LAUNCHERS = [
  'e2e/lib.mjs',
  'scripts/a2a-eventbus-dogfood.mjs',
  'scripts/a2a-silent-default-dogfood.mjs',
  'scripts/a2a-state-query-dogfood.mjs',
  'scripts/coldstart-first-keystroke-dynamic.mjs',
  'scripts/lib/control-wmux-lib.mjs',
  'scripts/perf-bench.mjs',
  'scripts/phase3-retention-probe.mjs',
  'scripts/readme-clips/launch.sh',
  'scripts/s-c2-fleet-deepening-dogfood.mjs',
  'scripts/twenty-pane-stability.mjs',
];

// "on port" followed by a capture group: `(\d+)` in a regex, `\(` in sed.
const READS_CDP_LOG_LINE = /CDP \(?(?:\?:)?(?:requested|listening|enabled)\b[^\n]*?on port \\?\(/;
const PLAYWRIGHT_LAUNCH = /\b_?electron\.launch\s*\(/;
const ASSIGNS_OPT_IN = /WMUX_TEST_CDP_PORT['"]?\s*[:=]\s*['"]1['"]/;
const SHELL_ASSIGNS_OPT_IN = /WMUX_TEST_CDP_PORT=1\b/;
const IMPORTS_ENV_BUILDER = /import\s*\{[^}]*\b(?:scrubEnv|launchEnv)\b[^}]*\}\s*from\s*['"][^'"]*control-wmux-lib\.mjs['"]/;
const CALLS_ENV_BUILDER = /\b(?:scrubEnv|launchEnv)\s*\(/;

const isShell = (rel) => SHELL_EXTENSIONS.has(path.extname(rel));
const commentLine = (rel) => (isShell(rel) ? /^\s*#/ : /^\s*(?:\/\/|\/\*|\*)/);

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** A file's code: every line that does not start with a comment token. */
function codeOf(rel, text) {
  const comment = commentLine(rel);
  return text
    .split(/\r?\n/)
    .filter((line) => !comment.test(line))
    .join('\n');
}

function isLauncher(rel, text = readFile(rel)) {
  const code = codeOf(rel, text);
  return READS_CDP_LOG_LINE.test(code) || PLAYWRIGHT_LAUNCH.test(code);
}

function isCompliant(rel, text = readFile(rel)) {
  const code = codeOf(rel, text);
  if (ASSIGNS_OPT_IN.test(code)) return true;
  if (isShell(rel) && SHELL_ASSIGNS_OPT_IN.test(code)) return true;
  return IMPORTS_ENV_BUILDER.test(code) && CALLS_ENV_BUILDER.test(code);
}

const remedy = (rel) =>
  `add WMUX_TEST_CDP_PORT: '1' to the env ${rel} spawns the app with, or build that env with scrubEnv()/launchEnv() from scripts/lib/control-wmux-lib.mjs.`;

describe('the test harness opt-in', () => {
  it('control-wmux builds its spawn env with scrubEnv/launchEnv, and scrubEnv sets it', () => {
    expect(scrubEnv({ WMUX_TEST_CDP_PORT: '0' }, '-verify-a').WMUX_TEST_CDP_PORT).toBe('1');
    expect(isCompliant('scripts/control-wmux.mjs')).toBe(true);
  });

  it('every known launcher is still matched and sets it', () => {
    const problems = [];
    for (const rel of KNOWN_LAUNCHERS) {
      if (!fs.existsSync(path.join(ROOT, rel))) {
        problems.push(`${rel} is listed in KNOWN_LAUNCHERS but does not exist (renamed or deleted?): update the list.`);
        continue;
      }
      const text = readFile(rel);
      if (!isLauncher(rel, text)) {
        problems.push(`${rel} no longer matches the launcher patterns: if it still launches the app, fix the patterns; otherwise drop it from KNOWN_LAUNCHERS.`);
      } else if (!isCompliant(rel, text)) {
        problems.push(`${rel} launches the app but does not set WMUX_TEST_CDP_PORT: ${remedy(rel)}`);
      }
    }
    expect(problems.join('\n')).toBe('');
  });

  it('every other launcher under scripts/ and e2e/ sets it', () => {
    const offenders = [];
    for (const dir of SCAN_DIRS) {
      for (const file of filesUnder(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        const text = readFile(rel);
        if (isLauncher(rel, text) && !isCompliant(rel, text)) {
          offenders.push(`${rel} launches the app and drives it over CDP but does not set WMUX_TEST_CDP_PORT: ${remedy(rel)}`);
        }
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('a mention is not an assignment, and a comment is not code', () => {
    const js = 'x.mjs';
    expect(isCompliant(js, 'delete env.WMUX_TEST_CDP_PORT;')).toBe(false);
    expect(isCompliant(js, "throw new Error('set WMUX_TEST_CDP_PORT=1');")).toBe(false);
    expect(isCompliant(js, "if (env.WMUX_TEST_CDP_PORT === '1') {}")).toBe(false);
    expect(isCompliant(js, "const env = { WMUX_TEST_CDP_PORT: '1' };")).toBe(true);
    expect(isCompliant(js, "env.WMUX_TEST_CDP_PORT = '1';")).toBe(true);
    expect(isCompliant('x.sh', 'env WMUX_TEST_CDP_PORT=1 "$APP"')).toBe(true);
    // Importing something else from the lib is no exemption.
    expect(isCompliant(js, "import { claimOwnedBy } from './lib/control-wmux-lib.mjs';\nclaimOwnedBy();")).toBe(false);
    // `#` starts a comment only in shell; in JavaScript it is a private field.
    expect(isLauncher(js, "#port = /CDP requested on port (\\d+)/;")).toBe(true);
    expect(isLauncher('x.sh', "# sed 's/.*CDP listening on port \\([0-9]*\\).*/\\1/'")).toBe(false);
    // A comment or a message naming the log line is not a read of it.
    expect(isLauncher(js, 'throw new Error(\'waiting for "CDP requested on port N"\');')).toBe(false);
  });
});
