// The native hook bridge's packaging contract, which spans four files that
// cannot import each other: the build script, the Rust binary, the installer
// (src/shared/hooks) and the CI matrix.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NATIVE_HOOKS_MARKER, NATIVE_HOOKS_TARGETS, nativeHooksBinary, nativeHooksSourceHash, nativeHooksStageProblem,
} from '../build-native-hooks.mjs';
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

// A stage built from other sources than the checkout's must not be packaged:
// it would ship a bridge that no parity test ran against.
describe('native hooks stage freshness', () => {
  let root;
  const crate = (...p) => path.join(root, 'core', 'wmux-native', ...p);
  const stage = () => path.join(root, 'dist', 'native-hooks');
  const writeStage = (manifest) => {
    fs.mkdirSync(stage(), { recursive: true });
    fs.writeFileSync(path.join(stage(), 'manifest.json'), JSON.stringify(manifest));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-hooks-stage-'));
    fs.mkdirSync(crate('src', 'nested'), { recursive: true });
    fs.mkdirSync(crate('target', 'release'), { recursive: true });
    fs.writeFileSync(crate('src', 'main.rs'), 'fn main() {}');
    fs.writeFileSync(crate('src', 'nested', 'mod.rs'), '');
    fs.writeFileSync(crate('flavours.json'), '{}');
    fs.writeFileSync(crate('Cargo.lock'), 'lock');
    fs.writeFileSync(crate('Cargo.toml'), '[package]');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('hashes the crate sources, the flavour table and the lockfile', () => {
    const before = nativeHooksSourceHash(root);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    // Build output is not a source.
    fs.writeFileSync(crate('target', 'release', 'wmux-native'), 'binary');
    expect(nativeHooksSourceHash(root)).toBe(before);
    for (const file of [['src', 'nested', 'mod.rs'], ['flavours.json'], ['Cargo.lock'], ['Cargo.toml']]) {
      const original = fs.readFileSync(crate(...file));
      fs.writeFileSync(crate(...file), 'changed');
      expect(nativeHooksSourceHash(root), file.join('/')).not.toBe(before);
      fs.writeFileSync(crate(...file), original);
    }
    // A new source file counts too.
    fs.writeFileSync(crate('src', 'extra.rs'), '');
    expect(nativeHooksSourceHash(root)).not.toBe(before);
  });

  it('accepts a stage built from these sources and refuses any other', () => {
    writeStage({ sourceHash: nativeHooksSourceHash(root) });
    expect(nativeHooksStageProblem(root, stage())).toBeNull();
    fs.writeFileSync(crate('src', 'main.rs'), 'fn main() { /* edited after the build */ }');
    expect(nativeHooksStageProblem(root, stage())).toMatch(/build-native-hooks/);
    writeStage({ platform: 'darwin' });
    expect(nativeHooksStageProblem(root, stage())).toMatch(/build-native-hooks/);
  });

  it('is checked by the forge config before packaging', () => {
    expect(read('forge.config.ts')).toMatch(
      /const problem = require\('\.\/scripts\/build-native-hooks\.mjs'\)\.nativeHooksStageProblem\(__dirname, [^\n]+\);\n\s*if \(problem\) throw new Error\(problem\);/,
    );
  });
});
