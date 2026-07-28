#!/usr/bin/env node
/**
 * Gate every production dependency against the license policy.
 *
 * Checks the same package-lock.json closure that THIRD_PARTY_NOTICES documents
 * (scripts/lib/prod-dependency-closure.mjs), so the file we publish and the set
 * we vet can never describe different things.
 *
 * Three independent ways a package fails:
 *
 *   1. Declared license is copyleft / source-available (GPL, AGPL, SSPL, …).
 *   2. Declared license is undetermined — NOASSERTION, "other", UNKNOWN, empty,
 *      or a non-SPDX "SEE LICENSE IN <file>". This is a FAILURE, not a pass.
 *   3. The LICENSE text the package actually ships contains a copyleft license
 *      body, whatever its manifest declares. Metadata is self-reported; the
 *      text is the artifact.
 *
 * Exceptions live in license-allowlist.json, one entry per package with a
 * written reason. Nothing is hardcoded here.
 *
 * Usage:
 *   node scripts/check-licenses.mjs            # exit 1 on any violation
 *   node scripts/check-licenses.mjs --json     # machine-readable findings
 *
 * Zero external deps by design — pulling in a license scanner would mean
 * vetting that scanner's own dependency tree with the tool it replaces.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProdClosure } from './lib/prod-dependency-closure.mjs';
import { classifyLicense, findCopyleftMarker } from './lib/license-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ALLOWLIST_PATH = join(ROOT, 'license-allowlist.json');

/** Read every LICENSE-ish file a package ships, concatenated. */
function readLicenseTexts(pkgDir) {
  let files;
  try {
    files = readdirSync(pkgDir);
  } catch {
    return null;
  }
  const parts = [];
  for (const file of files.sort()) {
    const lower = file.toLowerCase();
    const isLicenseFile =
      lower === 'unlicense' ||
      lower.startsWith('license') ||
      lower.startsWith('licence') ||
      lower.startsWith('copying');
    if (!isLicenseFile) continue;
    try {
      parts.push(readFileSync(join(pkgDir, file), 'utf8'));
    } catch {
      // unreadable — the declared-license checks still apply
    }
  }
  return parts.length ? parts.join('\n') : null;
}

function loadAllowlist() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`could not read ${relative(ROOT, ALLOWLIST_PATH)}: ${err.message}`);
  }
  const entries = parsed.packages || [];
  const byKey = new Map();
  for (const entry of entries) {
    for (const field of ['name', 'version', 'declaredLicense', 'reason']) {
      if (!entry[field] || typeof entry[field] !== 'string' || !entry[field].trim()) {
        throw new Error(
          `${relative(ROOT, ALLOWLIST_PATH)}: entry ${JSON.stringify(entry.name ?? '(unnamed)')} is missing a non-empty "${field}".`,
        );
      }
    }
    // Keyed on name + version + declared license: a version bump ships a new
    // artifact, and a changed declaration means the terms moved. Either way
    // the exception no longer applies until someone re-reads the LICENSE.
    byKey.set(`${entry.name}@${entry.version}|${entry.declaredLicense}`, entry);
  }
  return byKey;
}

export function checkLicenses() {
  const allowlist = loadAllowlist();
  const { packages, unresolved } = readProdClosure({ root: ROOT, alwaysInclude: ['electron'] });

  const violations = [];
  const waived = [];
  const usedAllowlistKeys = new Set();

  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}|${pkg.declaredLicense ?? ''}`;
    const verdict = classifyLicense(pkg.declaredLicense);

    // The text check runs even for a declared-permissive package — that is the
    // whole point of reading the artifact instead of the metadata. It cannot
    // run for platform-constrained packages, which are absent from disk on
    // every platform but their own; those must be covered by an allowlist
    // entry recording a human reading instead.
    const shippedText = pkg.dir ? readLicenseTexts(pkg.dir) : null;
    const textMarker = findCopyleftMarker(shippedText);

    if (textMarker) {
      violations.push({
        package: `${pkg.name}@${pkg.version}`,
        declared: pkg.declaredLicense,
        kind: 'copyleft-text',
        detail:
          `declares "${pkg.declaredLicense}" but the LICENSE file it ships contains "${textMarker}". ` +
          'The shipped text governs, not the manifest.',
      });
      continue;
    }

    if (verdict.status === 'allowed') continue;

    const waiver = allowlist.get(key);
    if (waiver) {
      usedAllowlistKeys.add(key);
      waived.push({ package: `${pkg.name}@${pkg.version}`, reason: waiver.reason });
      continue;
    }

    violations.push({
      package: `${pkg.name}@${pkg.version}`,
      declared: pkg.declaredLicense,
      kind: verdict.status === 'denied' ? 'denied-license' : 'undetermined-license',
      detail: verdict.detail,
    });
  }

  for (const edge of unresolved) {
    violations.push({
      package: edge,
      declared: null,
      kind: 'unresolved-dependency',
      detail: 'dependency edge does not resolve in package-lock.json, so its license cannot be determined',
    });
  }

  const staleWaivers = [...allowlist.keys()].filter((key) => !usedAllowlistKeys.has(key));
  return { packages, violations, waived, staleWaivers };
}

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

// Only run when invoked as a script — the test suite imports checkLicenses().
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
