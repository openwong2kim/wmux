#!/usr/bin/env node
/**
 * CLI for the production-dependency license gate.
 *
 * The audit itself lives in scripts/lib/license-audit.mjs so the test suite can
 * import it — this file carries the `#!` line, and a module with a shebang
 * cannot be imported under vitest.
 *
 * Usage:
 *   node scripts/check-licenses.mjs            # exit 1 on any violation
 *   node scripts/check-licenses.mjs --json     # machine-readable findings
 */
import { checkLicenses } from './lib/license-audit.mjs';

function main() {
  const args = process.argv.slice(2);
  const { packages, violations, waived, staleWaivers } = checkLicenses();

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ checked: packages.length, violations, waived, staleWaivers }, null, 2)}\n`);
    process.exit(violations.length ? 1 : 0);
  }

  console.log(`[licenses] checked ${packages.length} production packages from package-lock.json.`);
  // First sentence only — the full reason lives in license-allowlist.json and
  // nine multi-line waivers would bury the actual verdict in CI output.
  for (const w of waived) console.log(`[licenses] waived  ${w.package} — ${w.reason.split('. ')[0]}.`);
  if (staleWaivers.length) {
    console.log(
      `[licenses] note: ${staleWaivers.length} license-allowlist.json entr${staleWaivers.length === 1 ? 'y no longer applies' : 'ies no longer apply'} ` +
        'to any installed package and can be deleted:',
    );
    for (const key of staleWaivers) console.log(`             - ${key.split('|')[0]}`);
  }

  if (violations.length === 0) {
    console.log('[licenses] OK — every production dependency is permissively licensed or explicitly waived.');
    return;
  }

  console.error(`\n[licenses] FAILED — ${violations.length} package(s) violate the license policy:\n`);
  for (const v of violations) {
    console.error(`  ${v.package}  [${v.kind}]`);
    console.error(`    ${v.detail}`);
  }
  console.error(
    [
      '',
      'wmux distributes signed, notarized binaries. A GPL/AGPL dependency in that',
      'bundle creates a source-disclosure obligation that cannot be undone after a',
      'release, so this check is deny-by-default and an undetermined verdict fails.',
      '',
      'An undetermined result does NOT mean "probably fine". Automated license',
      'detection returns "other" / NOASSERTION for projects whose LICENSE file, when',
      'a person opens it, is the GNU General Public License — we have hit exactly',
      'that case. Only reading the text tells you.',
      '',
      'To resolve: open the package\'s actual LICENSE file and read it.',
      '  - Copyleft or source-available  -> remove the dependency. Do not waive it.',
      '  - Permissive but oddly declared -> add an entry to license-allowlist.json',
      '    with the exact name, version, declaredLicense, and a reason recording',
      '    what you read and where. The entry is version-pinned on purpose: the',
      '    next version is a new artifact and needs a fresh reading.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

main();
