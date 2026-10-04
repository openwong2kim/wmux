// Prerelease tags (release.yml).
//
// A tag like v4.0.0-beta.1 must ship as a GitHub prerelease that existing
// users never auto-update to: never "latest" (the in-app updater reads its
// manifests through releases/latest), and never pushed to Chocolatey or WinGet.
// The workflow only runs for real on a tag, so this pins the gates by text.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE = fs
  .readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  )
  .replace(/\r\n/g, '\n');

/** The text of one step, from its `- name:` or `- uses:` line to the next step or job. */
function step(name) {
  const start = RELEASE.indexOf(`- name: ${name}\n`);
  expect(start, `step "${name}" is missing from release.yml`).toBeGreaterThanOrEqual(0);
  const rest = RELEASE.slice(start + 1);
  const end = rest.search(/\n {6}- |\n {2}\S/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The header of one job: everything before its `steps:` line. */
function jobHeader(job) {
  const start = RELEASE.indexOf(`\n  ${job}:\n`);
  expect(start, `job "${job}" is missing from release.yml`).toBeGreaterThanOrEqual(0);
  return RELEASE.slice(start, RELEASE.indexOf('\n    steps:\n', start));
}

const NOT_PRE = "steps.pkg.outputs.is_prerelease != 'true'";

describe('release.yml prerelease tags', () => {
  it('derives is_prerelease from the tag and the package.json version, and exports it', () => {
    const pkg = step('Get version from package.json');
    expect(pkg).toContain('is_prerelease=');
    expect(pkg).toMatch(/REF_NAME\.Contains\('-'\)/);
    expect(pkg).toMatch(/\$v\.Contains\('-'\)/);
    expect(jobHeader('build')).toContain('is_prerelease: ${{ steps.pkg.outputs.is_prerelease }}');
  });

  it('marks the GitHub release as a prerelease and never latest', () => {
    const release = step('Create GitHub Release');
    expect(release).toContain("prerelease: ${{ steps.pkg.outputs.is_prerelease == 'true' }}");
    expect(release).toContain(`make_latest: \${{ ${NOT_PRE} }}`);
  });

  it('keeps a prerelease off Chocolatey and WinGet', () => {
    for (const name of ['Build Chocolatey package', 'Push to Chocolatey']) {
      const gate = step(name).match(/^ {8}if: (.+)$/m);
      expect(gate?.[1], `"${name}" has no prerelease gate`).toContain(NOT_PRE);
    }
    expect(jobHeader('winget')).toContain("if: needs.build.outputs.is_prerelease != 'true'");
  });

  it('has exactly one release-creating step, so no other path can publish as latest', () => {
    expect(RELEASE.match(/uses: softprops\/action-gh-release@/g)).toHaveLength(1);
    expect(RELEASE).not.toMatch(/gh release create/);
  });
});
