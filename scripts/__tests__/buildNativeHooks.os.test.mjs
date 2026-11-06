// The native hook bridge's packaging contract, which spans four files that
// cannot import each other: the build script, the Rust binary, the installer
// (src/shared/hooks) and the CI matrix.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NATIVE_HOOKS_MARKER, NATIVE_HOOKS_TARGETS, nativeHooksBinary } from '../build-native-hooks.mjs';
import { NATIVE_TERMINAL_TARGETS } from '../lib/native-terminal-targets.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

describe('build-native-hooks', () => {
  // The installer recognises its copy of the binary by this text in its bytes.
  it('uses the marker the binary carries and the installer looks for', () => {
    expect(read('core', 'wmux-native', 'src', 'main.rs')).toContain(`pub const MARKER: &str = "${NATIVE_HOOKS_MARKER}";`);
    expect(read('src', 'shared', 'hooks', 'hookFlavours.ts')).toContain(`export const NATIVE_HOOKS_MARKER = '${NATIVE_HOOKS_MARKER}';`);
  });

  // Same architectures; Linux swaps glibc for a static musl build, so the
  // binary runs on any distribution the app does.
  it('builds for every platform the terminal core ships on', () => {
    for (const key of Object.keys(NATIVE_TERMINAL_TARGETS)) {
      expect(NATIVE_HOOKS_TARGETS[key], key).toBe(NATIVE_TERMINAL_TARGETS[key].target.replace(/-linux-gnu$/, '-linux-musl'));
    }
  });

  it('names the binary as the installer and the parity suite do', () => {
    expect(nativeHooksBinary('win32')).toBe('wmux-native.exe');
    expect(nativeHooksBinary('darwin')).toBe('wmux-native');
    expect(nativeHooksBinary('linux')).toBe('wmux-native');
    expect(read('src', 'shared', 'hooks', 'hookFlavours.ts')).toContain("platform === 'win32' ? 'wmux-native.exe' : 'wmux-native'");
  });

  it('is built and tested in CI on mac arm64, win x64, linux x64 and linux arm64', () => {
    const workflow = read('.github', 'workflows', 'native-hooks.yml');
    for (const os of ['macos-15', 'windows-2022', 'ubuntu-22.04', 'ubuntu-22.04-arm']) {
      expect(workflow).toContain(`os: ${os},`);
    }
    expect(workflow).toContain("WMUX_REQUIRE_NATIVE_HOOKS: '1'");
    expect(workflow).toContain('node scripts/build-native-hooks.mjs');
  });
});
