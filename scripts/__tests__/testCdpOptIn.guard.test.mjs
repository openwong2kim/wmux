// Every script that launches the app and drives it over CDP sets the test
// harness opt-in, WMUX_TEST_CDP_PORT=1 (src/main/browser-session/cdpTestOptIn.ts).
//
// The rule keys on how a script learns the app's CDP port, not on how it
// spawns the app: spawn idioms differ per script, but every launcher waits for
// the app's own log line ("CDP requested|listening|enabled on port N").
// Scripts that attach to an instance someone else launched get the port
// elsewhere (an argument, a range scan) and are not matched.
//
// A matched script passes when a code line of it sets WMUX_TEST_CDP_PORT, or
// when it imports scripts/lib/control-wmux-lib.mjs, whose scrubEnv() sets it
// (checked below).
//
// Blind spot: a launcher that never reads that log line (one with a fixed
// port, or one that reads the CDP claim file instead) is not caught.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubEnv } from '../lib/control-wmux-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.sh', '.ps1']);
const OPT_IN = 'WMUX_TEST_CDP_PORT';

// The app's log line as a script's code spells it: a literal, a regex with
// `(?:requested|listening|enabled)`, or a sed pattern.
const READS_CDP_LOG_LINE = /CDP \(?(?:\?:)?(?:requested|listening|enabled)\b[^\n]*? on port/;
const IMPORTS_CONTROL_WMUX = /from\s+['"][^'"]*control-wmux-lib\.mjs['"]/;
// Comment lines (`//`, ` *`, `#`) neither match nor count as setting the var.
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*|#)/;

function scriptFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...scriptFiles(full));
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function codeOf(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n');
}

describe('the test harness opt-in', () => {
  it('control-wmux sets it on every instance it launches', () => {
    expect(scrubEnv({ WMUX_TEST_CDP_PORT: '0' }, '-verify-a').WMUX_TEST_CDP_PORT).toBe('1');
  });

  it('every script that reads the app CDP port from its log sets it', () => {
    const matched = [];
    const offenders = [];
    for (const file of scriptFiles(SCRIPTS)) {
      const code = codeOf(file);
      if (!READS_CDP_LOG_LINE.test(code)) continue;
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      matched.push(rel);
      if (code.includes(OPT_IN) || IMPORTS_CONTROL_WMUX.test(code)) continue;
      offenders.push(
        `${rel} launches the app and reads its CDP port, but does not set ${OPT_IN}: ` +
          `add ${OPT_IN}: '1' to the env it spawns the app with, or launch through scripts/control-wmux.mjs.`,
      );
    }
    expect(offenders.join('\n')).toBe('');
    // A floor, so a pattern that stopped matching cannot pass with nothing checked.
    expect(matched.length, matched.join('\n')).toBeGreaterThanOrEqual(9);
  });
});
