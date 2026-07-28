// Gate for the license policy that protects the binaries we sign and notarize.
//
// The integration test asserts the real dependency tree is clean. The unit
// tests pin the behaviour that actually matters: an undetermined verdict must
// FAIL, not pass. `gh api repos/{owner}/{repo}/license` returns "other" /
// NOASSERTION for projects whose LICENSE file is the GNU GPL — we hit exactly
// that case. A checker with only a deny-list waves those through green, so
// these cases exist to stop anyone "fixing" a noisy build by relaxing them.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLicenses } from '../lib/license-audit.mjs';
import { ALLOWED, classifyLicense, findCopyleftMarker } from '../lib/license-policy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('production dependency licenses', () => {
  it('has no policy violations across the whole production closure', () => {
    const { packages, violations } = checkLicenses();
    expect(packages.length).toBeGreaterThan(100);
    expect(
      violations.map((v) => `${v.package} [${v.kind}] ${v.detail}`),
      'a production dependency violates the license policy — see scripts/check-licenses.mjs output',
    ).toEqual([]);
  });

  it('checks the same package set that THIRD_PARTY_NOTICES documents', () => {
    // If these ever diverge, we would be publishing attribution for one set of
    // packages while vetting a different one.
    const { packages } = checkLicenses();
    const notices = readFileSync(path.join(REPO_ROOT, 'THIRD_PARTY_NOTICES'), 'utf8');
    expect(notices).toContain(`Total packages: ${packages.length}`);
    for (const pkg of packages) {
      expect(notices, `${pkg.name}@${pkg.version} is vetted but missing from THIRD_PARTY_NOTICES`).toContain(
        `${pkg.name}@${pkg.version}`,
      );
    }
  });
});

describe('license classification', () => {
  it('accepts the permissive licenses we actually depend on', () => {
    for (const id of ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'Unlicense']) {
      expect(classifyLicense(id), id).toMatchObject({ status: 'allowed' });
    }
  });

  it.each([
    ['NOASSERTION', 'the SPDX value GitHub returns for an unrecognized LICENSE'],
    ['other', 'the value the GitHub license API returns for the same case'],
    ['OTHER', 'case-insensitive'],
    ['', 'empty string'],
    ['UNKNOWN', 'explicit unknown'],
    ['UNLICENSED', 'npm private-package marker, not the Unlicense'],
    [null, 'no license field at all'],
    [undefined, 'missing key'],
    ['SEE LICENSE IN LICENSE.md', 'a pointer to a file, not a verdict'],
    ['GPL-2.0-only WITH Classpath-exception-2.0', 'exception clauses need a human'],
    ['Frobnicate-1.0', 'an id nobody has vetted'],
  ])('fails %s (%s) instead of passing it', (declared) => {
    // This is the whole point of the check. Undetermined is not "no hits found".
    expect(classifyLicense(declared).status).toBe('undetermined');
  });

  it.each(['GPL-3.0-or-later', 'AGPL-3.0', 'LGPL-2.1', 'SSPL-1.0', 'BUSL-1.1', 'Elastic-2.0'])(
    'rejects the copyleft/source-available license %s',
    (declared) => {
      expect(classifyLicense(declared).status).toBe('denied');
    },
  );

  it('elects the permissive half of a dual license but rejects an all-copyleft one', () => {
    expect(classifyLicense('(MIT OR GPL-2.0)').status).toBe('allowed');
    expect(classifyLicense('(GPL-2.0 OR AGPL-3.0)').status).toBe('denied');
  });

  it('requires every operand of an AND expression to be acceptable', () => {
    expect(classifyLicense('MIT AND Apache-2.0').status).toBe('allowed');
    expect(classifyLicense('MIT AND GPL-3.0').status).toBe('denied');
  });

  it('never lists a copyleft license as allowed', () => {
    for (const id of ALLOWED) {
      expect(id).not.toMatch(/GPL|SSPL|BUSL|Elastic/i);
    }
  });
});

describe('shipped LICENSE text', () => {
  it('catches a copyleft body regardless of what the manifest declares', () => {
    // The failure mode this exists for: metadata says one thing, the file the
    // package actually ships says GNU GPL.
    const gplText = 'GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991\n\nCopyright (C) 1989, 1991 FSF';
    expect(findCopyleftMarker(gplText)).toBe('GNU GENERAL PUBLIC LICENSE');
    expect(findCopyleftMarker('GNU Affero General Public License')).toBe('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(findCopyleftMarker('Server Side Public License')).toBe('SERVER SIDE PUBLIC LICENSE');
  });

  it('does not fire on permissive license text', () => {
    expect(findCopyleftMarker('MIT License\n\nPermission is hereby granted, free of charge')).toBeNull();
    expect(findCopyleftMarker(null)).toBeNull();
  });
});

describe('license-allowlist.json', () => {
  it('gives every exception a written reason and a pinned version', () => {
    const allowlist = JSON.parse(readFileSync(path.join(REPO_ROOT, 'license-allowlist.json'), 'utf8'));
    for (const entry of allowlist.packages) {
      expect(entry.name).toBeTruthy();
      expect(entry.version, `${entry.name} must pin an exact version`).toMatch(/^\d+\.\d+\.\d+/);
      expect(entry.declaredLicense).toBeTruthy();
      // A reason short enough to be a shrug is not a reason.
      expect(entry.reason?.length, `${entry.name} needs a substantive reason`).toBeGreaterThan(40);
    }
  });

  it('never waives a copyleft license', () => {
    const allowlist = JSON.parse(readFileSync(path.join(REPO_ROOT, 'license-allowlist.json'), 'utf8'));
    for (const entry of allowlist.packages) {
      expect(entry.declaredLicense, `${entry.name} waives a copyleft license`).not.toMatch(
        /\b(A?GPL|LGPL|SSPL|BUSL|Elastic)\b/i,
      );
    }
  });
});
