/**
 * Audit every production dependency against the license policy.
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
 * This module holds the audit itself so the test suite can import it. The CLI
 * wrapper — scripts/check-licenses.mjs — carries the `#!` line; a module with a
 * shebang cannot be imported under vitest.
 *
 * Zero external deps by design — pulling in a license scanner would mean
 * vetting that scanner's own dependency tree with the tool it replaces.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProdClosure } from './prod-dependency-closure.mjs';
import { classifyLicense, findCopyleftMarker } from './license-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const ALLOWLIST_PATH = join(ROOT, 'license-allowlist.json');

/** Stands in for "the manifest declares no license at all" on BOTH sides of the
 *  allowlist key. Coalescing to '' instead made that key end in a bare '|',
 *  which no allowlist entry could ever equal — loadAllowlist rejects an empty
 *  declaredLicense — so the one case the header names as reviewable (an empty
 *  declaration) had no way to be reviewed. */
const NO_DECLARED_LICENSE = '(none)';

/** The key an allowlist entry is matched on: name + version + declared license.
 *  A version bump ships a new artifact and a changed declaration means the
 *  terms moved; either way the exception lapses until someone re-reads. */
export function allowlistKey(name, version, declaredLicense) {
  const declared = typeof declaredLicense === 'string' && declaredLicense.trim() ? declaredLicense : NO_DECLARED_LICENSE;
  return `${name}@${version}|${declared}`;
}

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
    byKey.set(allowlistKey(entry.name, entry.version, entry.declaredLicense), entry);
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
    const key = allowlistKey(pkg.name, pkg.version, pkg.declaredLicense);
    const verdict = classifyLicense(pkg.declaredLicense);

    // The text check runs even for a declared-permissive package — that is the
    // whole point of reading the artifact instead of the metadata.
    //
    // Known limit, stated rather than implied: it cannot run for a package
    // absent from disk (an os/cpu-constrained variant on a runner that is not
    // its target). Such a package is judged on its declaration ALONE, so a
    // platform variant whose manifest misstates its shipped terms passes here.
    // Only the undetermined ones are forced to an allowlist entry; one that
    // declares MIT is taken at its word. Closing that would mean fetching every
    // platform variant's tarball, which is a different piece of work.
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

    // Only an UNDETERMINED verdict is waivable. The failure guidance says
    // "copyleft or source-available -> remove the dependency, do not waive it",
    // but the lookup used to run for a denied verdict too, so an entry naming
    // EUPL-1.2 / OSL-3.0 / CPAL-1.0 would have passed the production gate. The
    // allowlist records a human READING an ambiguous declaration; it is not a
    // channel for overriding the policy.
    if (verdict.status === 'undetermined') {
      const waiver = allowlist.get(key);
      if (waiver) {
        usedAllowlistKeys.add(key);
        waived.push({ package: `${pkg.name}@${pkg.version}`, reason: waiver.reason });
        continue;
      }
    }

    violations.push({
      package: `${pkg.name}@${pkg.version}`,
      declared: pkg.declaredLicense,
      kind: verdict.status === 'denied' ? 'denied-license' : 'undetermined-license',
      detail:
        verdict.status === 'denied'
          ? `${verdict.detail} — this cannot be waived in license-allowlist.json; remove the dependency`
          : verdict.detail,
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
