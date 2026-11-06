// The native hook bridge in release.yml.
//
// wmux-native is spawned on every hook event, so an unsigned Windows exe must
// never reach users: it is built only when it can be signed, signed before
// `make` packages the stage, and the packaged copy is checked against the
// signed one. Without signing there is no stage and the installers keep
// `node <bridge>`. macOS signs it with the app inside `make` and checks the
// signature after; Linux ships it as built and checks it runs. This pins the
// steps by name and their order, as computerHelperRelease.test.mjs does for
// the helper.
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
const CHECK = 'Check the packaged native hook bridge';
const WINDOWS = job('build', 'winget');
const MACOS = job('macos', 'linux');
const LINUX = job('linux');

describe('release.yml native hook bridge', () => {
  it('builds it before make and checks the package after, in every packaging job', () => {
    for (const [name, text] of [['build', WINDOWS], ['macos', MACOS], ['linux', LINUX]]) {
      const steps = stepsOf(text);
      expect(steps.indexOf(BUILD), name).toBeGreaterThanOrEqual(0);
      expect(steps.indexOf(BUILD), name).toBeLessThan(steps.indexOf('Build & Make'));
      expect(steps.indexOf(CHECK), name).toBeGreaterThan(steps.indexOf('Build & Make'));
      expect(step(text, BUILD)).toContain('node scripts/build-native-hooks.mjs');
    }
  });

  it('on macOS: the packaged copy runs, and a signed build carries a valid hardened signature', () => {
    const check = step(MACOS, CHECK);
    expect(check).toContain("-path '*/Contents/Resources/native-hooks/wmux-native'");
    expect(check).toMatch(/--version \| grep -q 'wmux-managed: native-hooks'/);
    expect(check).toMatch(/if \[ -n "\$APPLE_CERT_P12_BASE64" \]; then\n\s*codesign --verify --strict/);
    expect(check).toContain('TeamIdentifier=$APPLE_TEAM_ID');
    expect(check).toMatch(/flags=.*runtime/);
  });

  it('on Linux: the packaged copy is there and runs', () => {
    const check = step(LINUX, CHECK);
    expect(check).toContain("-path '*/resources/native-hooks/wmux-native'");
    expect(check).toMatch(/--version \| grep -q 'wmux-managed: native-hooks'/);
  });

  it('on Windows: builds, signs, replaces, or drops the stage; then makes and checks', () => {
    const steps = stepsOf(WINDOWS);
    const order = [
      BUILD,
      'Upload unsigned native hook bridge for signing',
      'Sign native hook bridge via SignPath',
      'Replace the unsigned native hook bridge with the signed one',
      'Build & Make',
      CHECK,
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
    // Nothing is built that cannot be signed.
    for (const name of [BUILD, 'Upload unsigned native hook bridge for signing', 'Sign native hook bridge via SignPath',
      'Replace the unsigned native hook bridge with the signed one']) {
      expect(step(WINDOWS, name), name).toContain("if: env.NATIVE_SIGNING_ENABLED == 'true'");
    }
    const sign = step(WINDOWS, 'Sign native hook bridge via SignPath');
    expect(sign).toContain('artifact-configuration-slug: ${{ vars.SIGNPATH_NATIVE_ARTIFACT_CONFIGURATION_SLUG }}');
    expect(sign).not.toContain('SIGNPATH_HELPER_');
    // Whatever the policy, only a Valid signature from the release
    // certificate is shipped, and its bytes are pinned for the package check.
    const replace = step(WINDOWS, 'Replace the unsigned native hook bridge with the signed one');
    expect(replace).toMatch(/if \(\$sig\.Status -ne 'Valid'\) \{ Write-Error [^\n]*; exit 1 \}/);
    expect(replace).toMatch(/\$sig\.SignerCertificate\.Thumbprint -ne \$env:EXPECTED_THUMBPRINT\.ToUpper\(\)\) \{\n\s*Write-Error [^\n]*; exit 1/);
    expect(replace).not.toContain("SIGNING_POLICY_SLUG -eq 'release-signing'");
    expect(replace).toMatch(/"WMUX_WIN_NATIVE_SHA256=\$hash" \| Out-File -Append -Encoding utf8 \$env:GITHUB_ENV/);
  });

  it('ships no unsigned exe, and every packaged copy is the signed one', () => {
    const check = step(WINDOWS, CHECK);
    // Unsigned run: any packaged wmux-native.exe fails the release.
    expect(check).toMatch(/if \(\$env:NATIVE_SIGNING_ENABLED -ne 'true'\) \{\n\s*if \(\$exes\.Count -ne 0\) \{ Write-Error [^\n]*; exit 1 \}/);
    // Signed run: every packaged copy is byte-identical to the signed one,
    // Valid, and signed by the release certificate.
    expect(check).toMatch(/if \(\$hash -ne \$env:WMUX_WIN_NATIVE_SHA256\) \{ Write-Error [^\n]*; exit 1 \}/);
    expect(check).toMatch(/if \(\$sig\.Status -ne 'Valid'\) \{ Write-Error [^\n]*; exit 1 \}/);
    expect(check).toMatch(/if \(\$sig\.SignerCertificate\.Thumbprint -ne \$env:EXPECTED_THUMBPRINT\.ToUpper\(\)\) \{ Write-Error [^\n]*; exit 1 \}/);
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
