// The native hook bridge in release.yml.
//
// wmux-native is spawned on every hook event, so an unsigned Windows exe must
// never reach users: it is signed before `make` packages the stage, or the
// stage is dropped and the installers keep `node <bridge>`. macOS signs it
// with the app inside `make`; Linux ships it as built. This pins the steps by
// name and their order, as computerHelperRelease.test.mjs does for the helper.
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

function job(name, next) {
  return RELEASE.slice(RELEASE.indexOf(`\n  ${name}:\n`), next ? RELEASE.indexOf(`\n  ${next}:\n`) : undefined);
}

/** Step names of a job, in order. */
const stepsOf = (text) => [...text.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1].trim());

/** The text of one step, up to the next. */
function step(text, name) {
  const start = text.indexOf(`- name: ${name}\n`);
  expect(start, `step "${name}"`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\n      - ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

const BUILD = 'Build the native hook bridge';
const WINDOWS = job('build', 'winget');

describe('release.yml native hook bridge', () => {
  it('builds it before make in every packaging job', () => {
    for (const [name, text] of [['build', WINDOWS], ['macos', job('macos', 'linux')], ['linux', null]]) {
      const steps = stepsOf(text ?? job(name));
      expect(steps.indexOf(BUILD), name).toBeGreaterThanOrEqual(0);
      expect(steps.indexOf(BUILD), name).toBeLessThan(steps.indexOf('Build & Make'));
      expect(step(text ?? job(name), BUILD)).toContain('node scripts/build-native-hooks.mjs');
    }
  });

  it('on Windows: builds, signs, replaces, or drops the stage; then makes and checks', () => {
    const steps = stepsOf(WINDOWS);
    const order = [
      BUILD,
      'Upload unsigned native hook bridge for signing',
      'Sign native hook bridge via SignPath',
      'Replace the unsigned native hook bridge with the signed one',
      'Drop the unsigned native hook bridge',
      'Build & Make',
      'Check the packaged native hook bridge',
    ].map((name) => {
      const i = steps.indexOf(name);
      expect(i, `step "${name}" is missing from release.yml's build job`).toBeGreaterThanOrEqual(0);
      return i;
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('signs with its own artifact configuration, gated like the helper', () => {
    expect(WINDOWS).toContain(
      "NATIVE_SIGNING_ENABLED: ${{ secrets.SIGNPATH_API_TOKEN != '' && vars.SIGNPATH_NATIVE_ARTIFACT_CONFIGURATION_SLUG != '' }}",
    );
    for (const name of ['Upload unsigned native hook bridge for signing', 'Sign native hook bridge via SignPath',
      'Replace the unsigned native hook bridge with the signed one']) {
      expect(step(WINDOWS, name), name).toContain("if: env.NATIVE_SIGNING_ENABLED == 'true'");
    }
    const sign = step(WINDOWS, 'Sign native hook bridge via SignPath');
    expect(sign).toContain('artifact-configuration-slug: ${{ vars.SIGNPATH_NATIVE_ARTIFACT_CONFIGURATION_SLUG }}');
    expect(sign).not.toContain('SIGNPATH_HELPER_');
    // The release mark needs a Valid signature from the expected certificate.
    const replace = step(WINDOWS, 'Replace the unsigned native hook bridge with the signed one');
    expect(replace).toContain('Get-AuthenticodeSignature');
    expect(replace).toContain('$env:EXPECTED_THUMBPRINT');
  });

  it('ships no unsigned exe: without signing the stage is dropped, and the package is checked', () => {
    const drop = step(WINDOWS, 'Drop the unsigned native hook bridge');
    expect(drop).toContain("if: env.NATIVE_SIGNING_ENABLED != 'true'");
    expect(drop).toMatch(/Remove-Item .*dist\/native-hooks/);
    const check = step(WINDOWS, 'Check the packaged native hook bridge');
    // Unsigned run: any packaged wmux-native.exe fails the release.
    expect(check).toMatch(/if \(\$env:NATIVE_SIGNING_ENABLED -ne 'true'\) \{\n\s*if \(\$exes\.Count -ne 0\) \{ Write-Error [^\n]*; exit 1 \}/);
    // Signed run: every packaged copy carries a signature.
    expect(check).toMatch(/Get-AuthenticodeSignature \$e\.FullName\n\s*if \(-not \$sig\.SignerCertificate\) \{ Write-Error [^\n]*; exit 1 \}/);
  });

  it('touches the stage nowhere after make on Windows', () => {
    const after = WINDOWS.slice(WINDOWS.indexOf('- name: Build & Make'));
    const writes =
      /\b(Copy-Item|Move-Item|Rename-Item|Remove-Item|New-Item|Set-Content|Add-Content|Out-File|Clear-Content|signtool|cp|mv|rm)\b|>\s*\S|\[IO\.File\]::(Write|Copy|Move|Delete)/i;
    const offending = after.split('\n').filter((line) => /native-hooks|wmux-native/i.test(line) && writes.test(line));
    expect(offending).toEqual([]);
    expect(after).not.toMatch(/SIGNPATH_NATIVE_|wmux-native-unsigned/);
  });
});
