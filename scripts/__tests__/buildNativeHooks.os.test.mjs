// The native hook bridge's packaging contract, which spans four files that
// cannot import each other: the build script, the Rust binary, the installer
// (src/shared/hooks) and the CI matrix.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NATIVE_HOOKS_MARKER, NATIVE_HOOKS_TARGETS, nativeHooksBinary, nativeHooksSourceHash, nativeHooksStageProblem,
} from '../build-native-hooks.mjs';
import { NATIVE_TERMINAL_TARGETS } from '../lib/native-terminal-targets.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Line endings normalised: a Windows checkout may have CRLF.
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

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

  // A required check must report on every pull request, so the workflow
  // always runs and its own first job decides whether anything relevant
  // changed; the steps then run or no-op.
  it('always runs, and treats every path the native bridge depends on as relevant', () => {
    const workflow = read('.github', 'workflows', 'native-hooks.yml');
    expect(workflow).not.toMatch(/^\s+paths:/m);
    // Every step runs unless `changes` said no, and one says why when it did.
    const { jobs } = parseYaml(workflow);
    expect(jobs['native-hooks'].needs).toBe('changes');
    for (const step of jobs['native-hooks'].steps) {
      const gate = step.name === 'Nothing the native bridge depends on changed'
        ? "needs.changes.outputs.relevant == 'false'"
        : "needs.changes.outputs.relevant != 'false'";
      expect(step.if, step.name ?? step.uses ?? step.run).toBe(gate);
    }
    const pattern = new RegExp(workflow.match(/RELEVANT: '([^']+)'/)[1]);
    for (const file of [
      'core/wmux-native/src/rpc.rs', 'core/wmux-native/.cargo/config.toml', 'integrations/shared/bin/wmux-hooks-bridge.mjs',
      'src/shared/hooks/compatHookInstall.ts', 'src/shared/lifecycleIntegrations.ts', 'src/cli/commands/setupHooks.ts',
      'src/daemon/DaemonPipeServer.ts', 'src/main/pipe/PipeServer.ts', 'src/main/pipe/handlers/hooks.rpc.ts',
      'src/shared/rpc.ts', 'src/main/mcp/hookBridge.ts', 'src/main/mcp/__tests__/hookBridge.lockstep.test.ts',
      'scripts/build-native-hooks.mjs', 'scripts/__tests__/buildNativeHooks.os.test.mjs',
      'scripts/__tests__/nativeHooksRelease.test.mjs', 'forge.config.ts', 'package.json', 'package-lock.json',
      '.github/workflows/native-hooks.yml', '.github/workflows/release.yml',
      'integrations/claude/bin/wmux-bridge.mjs', 'integrations/claude/__tests__/fixtures/claude-hook/cases/gate-reset.json',
    ]) {
      expect(pattern.test(file), file).toBe(true);
    }
    for (const file of ['src/renderer/App.tsx', 'docs/x.md', 'src/main/pipeline.ts', 'core/wmux-term/src/lib.rs', 'integrations/claude/bin/wmux-bridge.mjs.bak']) {
      expect(pattern.test(file), file).toBe(false);
    }
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
    fs.writeFileSync(crate('claude-hook.ported-from.sha256'), 'pin');
    fs.writeFileSync(crate('Cargo.lock'), 'lock');
    fs.writeFileSync(crate('Cargo.toml'), '[package]');
    fs.mkdirSync(crate('.cargo'), { recursive: true });
    fs.writeFileSync(crate('.cargo', 'config.toml'), '[target]');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('hashes the crate sources, the embedded files, the lockfile and the cargo config', () => {
    const before = nativeHooksSourceHash(root);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    // Build output is not a source.
    fs.writeFileSync(crate('target', 'release', 'wmux-native'), 'binary');
    expect(nativeHooksSourceHash(root)).toBe(before);
    // flavours.json and the Claude hook's pinned bridge hash are compiled in.
    for (const file of [['src', 'nested', 'mod.rs'], ['flavours.json'], ['claude-hook.ported-from.sha256'], ['Cargo.lock'], ['Cargo.toml'], ['.cargo', 'config.toml']]) {
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

  // In a package hook, not at config load: loading the config (to run any
  // forge command, or a test) must not depend on the stage.
  it('is checked by the forge config before packaging', () => {
    const forge = read('forge.config.ts');
    expect(forge).toMatch(
      /prePackage: async \(\) => \{\n\s*if \(!shipsNativeHooks\) return;\n\s*const problem = require\('\.\/scripts\/build-native-hooks\.mjs'\)\.nativeHooksStageProblem\(__dirname, [^\n]+\);\n\s*if \(problem\) throw new Error\(problem\);/,
    );
    expect(forge).not.toMatch(/^if \(shipsNativeHooks\)/m);
  });
});
