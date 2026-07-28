/**
 * License policy for everything wmux ships.
 *
 * We distribute signed, notarized Electron binaries. A GPL/AGPL dependency
 * reaching that bundle creates a source-disclosure obligation that is, in
 * practice, not reversible once released. So this policy is deny-by-default:
 * a license is acceptable only if it is on ALLOWED, and *everything else
 * fails* — including "I could not tell".
 *
 * That last part is the point. A deny-list alone does not hold. `gh api
 * repos/{owner}/{repo}/license` returns `"other"` / SPDX `NOASSERTION` for
 * projects whose LICENSE file is, on inspection, the GNU General Public
 * License. Anything that treats an undetermined verdict as "no hits, pass"
 * lets exactly that case through green. Undetermined must route to a human
 * reading the actual LICENSE text, and the only way to record that reading is
 * an explicit entry in license-allowlist.json.
 */

// Permissive licenses that impose no source-disclosure obligation on a
// distributed binary. Attribution-only terms are satisfied by
// THIRD_PARTY_NOTICES, which ships with the app.
//
// MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0 and Unlicense are all
// present in the current production closure. 0BSD, MIT-0, CC0-1.0 and
// Python-2.0 are not, but are equally permissive and common enough in the
// transitive npm graph that omitting them would produce a spurious hard
// failure on a routine dependency bump.
export const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
]);

// Families that are outright disqualifying for a shipped binary. Matched by
// prefix so version variants (GPL-3.0-or-later, AGPL-3.0-only, BUSL-1.1, …)
// are covered without enumerating them. This list does not decide the pass/
// fail outcome — anything off ALLOWED already fails — it exists so the report
// can say "this is copyleft, do not allowlist it" instead of "unrecognized".
export const DENIED_PREFIXES = [
  'AGPL',
  'BSL',
  'BUSL',
  'CPAL',
  'EUPL',
  'Elastic',
  'GPL',
  'LGPL',
  'OSL',
  'SSPL',
];

// Values that mean "the tooling could not determine a license". Treated as
// failures, never as passes.
const UNDETERMINED_LITERALS = new Set([
  '',
  'NOASSERTION',
  'OTHER',
  'UNKNOWN',
  'UNLICENSED',
  'NONE',
  'NULL',
  'UNDEFINED',
]);

function normalizeId(id) {
  // SPDX `+` suffix (Apache-2.0+) means "or later"; the base id decides.
  return id.trim().replace(/\+$/, '');
}

function isDenied(id) {
  const upper = normalizeId(id).toUpperCase();
  return DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()));
}

/**
 * Evaluate a single SPDX expression.
 *
 * Handles the two operators that actually appear on npm: OR (dual-licensed —
 * satisfiable if any operand is acceptable, since we may elect that operand)
 * and AND (all operands must be acceptable). `WITH` exception clauses are
 * deliberately NOT interpreted: judging whether a linking exception cures a
 * copyleft obligation is a human decision, so those route to review.
 *
 * @returns {{status: 'allowed'|'denied'|'undetermined', detail: string}}
 */
export function classifyLicense(declared) {
  if (declared === null || declared === undefined || typeof declared !== 'string') {
    return { status: 'undetermined', detail: 'no license field in the package manifest or lockfile' };
  }

  const raw = declared.trim();
  if (UNDETERMINED_LITERALS.has(raw.toUpperCase())) {
    return { status: 'undetermined', detail: `license reported as "${raw || '(empty)'}"` };
  }

  // "SEE LICENSE IN <file>" is npm's escape hatch for non-SPDX terms. It is a
  // pointer, not a verdict — a human has to open the file.
  if (/^SEE LICENSE IN /i.test(raw)) {
    return { status: 'undetermined', detail: `non-SPDX declaration "${raw}" — terms live in a file, not the manifest` };
  }

  if (/\bWITH\b/i.test(raw)) {
    return { status: 'undetermined', detail: `SPDX exception clause "${raw}" is not auto-evaluated` };
  }

  const operands = raw
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (operands.length === 0) {
    return { status: 'undetermined', detail: `unparseable license expression "${raw}"` };
  }

  const isOr = /\sOR\s/i.test(raw);
  const allowedOperands = operands.filter((id) => ALLOWED.has(normalizeId(id)));
  const deniedOperands = operands.filter((id) => isDenied(id));

  if (isOr) {
    // Dual-licensed: we may elect the permissive operand.
    if (allowedOperands.length > 0) return { status: 'allowed', detail: `elected "${allowedOperands[0]}" from "${raw}"` };
  } else if (allowedOperands.length === operands.length) {
    return { status: 'allowed', detail: raw };
  }

  if (deniedOperands.length > 0) {
    return { status: 'denied', detail: `copyleft / source-available license "${raw}"` };
  }
  return { status: 'undetermined', detail: `license "${raw}" is not on the allow list` };
}

// Phrases that appear verbatim in the canonical texts of licenses we cannot
// ship. Scanned against the LICENSE file a package actually distributes,
// independent of what its manifest claims, because the manifest is exactly
// what lies in the failure mode this policy exists to catch.
const COPYLEFT_TEXT_MARKERS = [
  'GNU GENERAL PUBLIC LICENSE',
  'GNU AFFERO GENERAL PUBLIC LICENSE',
  'GNU LESSER GENERAL PUBLIC LICENSE',
  'GNU LIBRARY GENERAL PUBLIC LICENSE',
  'SERVER SIDE PUBLIC LICENSE',
  'BUSINESS SOURCE LICENSE',
  'ELASTIC LICENSE',
  'EUROPEAN UNION PUBLIC LICENCE',
  'COMMON DEVELOPMENT AND DISTRIBUTION LICENSE',
];

/**
 * Look for a copyleft license body inside text that a package ships as its
 * LICENSE, regardless of the SPDX id it declares.
 *
 * @returns {string|null} the marker that matched, or null
 */
export function findCopyleftMarker(licenseText) {
  if (!licenseText) return null;
  const upper = licenseText.toUpperCase();
  for (const marker of COPYLEFT_TEXT_MARKERS) {
    if (upper.includes(marker)) return marker;
  }
  return null;
}
