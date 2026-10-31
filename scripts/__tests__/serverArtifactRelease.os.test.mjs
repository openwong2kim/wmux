// wmux-server artifact (scripts/build-server-artifact.mjs + release.yml).
//
// The desktop app verifies the server tarball it installs over SSH against the
// sha256 in its baked resources/server-manifest.json, so the manifest must be
// written from the artifacts before any app is packaged, and must refuse
// fragments that do not describe one consistent release.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { maxGlibcRequirement, mergeFragments, serverArtifactName, stageNativeCore } from '../build-server-artifact.mjs';
import { serverArtifactName as contractName } from '../../src/shared/sshPcContract';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const RELEASE = read('.github', 'workflows', 'release.yml');
const SERVER_WORKFLOW = read('.github', 'workflows', 'server-artifact.yml');

function fragment(arch, over = {}) {
  return {
    version: '4.3.1',
    arch,
    node: '24.21.0',
    glibcMin: '2.28',
    name: serverArtifactName('4.3.1', arch),
    sha256: (arch === 'x64' ? 'a' : 'b').repeat(64),
    size: 1000,
    ...over,
  };
}

describe('server manifest merge', () => {
  it('builds the ServerArtifactManifest with the highest glibc floor', () => {
    const m = mergeFragments([fragment('x64', { glibcMin: '2.34' }), fragment('arm64', { glibcMin: '2.31' })], { version: '4.3.1' });
    expect(m).toEqual({
      version: '4.3.1',
      node: '24.21.0',
      glibcMin: '2.34',
      artifacts: {
        x64: { name: 'wmux-server-4.3.1-linux-x64.tar.gz', sha256: 'a'.repeat(64), size: 1000 },
        arm64: { name: 'wmux-server-4.3.1-linux-arm64.tar.gz', sha256: 'b'.repeat(64), size: 1000 },
      },
    });
  });

  it('refuses a missing arch, a version that is not the app version, and mixed releases', () => {
    expect(() => mergeFragments([fragment('x64')], { version: '4.3.1' })).toThrow(/arm64/);
    expect(() => mergeFragments([fragment('x64'), fragment('arm64')], { version: '4.3.2' })).toThrow(/package\.json/);
    expect(() => mergeFragments([fragment('x64'), fragment('arm64', { node: '24.20.0' })])).toThrow(/Node/);
    expect(() => mergeFragments([fragment('x64'), fragment('arm64', { sha256: 'nope' })])).toThrow(/sha256/);
  });

  it('names artifacts the way the contract fetches them', () => {
    expect(serverArtifactName('4.0.0-beta.1', 'arm64')).toBe(contractName('4.0.0-beta.1', 'arm64'));
  });

  it('reads the highest GLIBC version an ELF asks for', () => {
    const elf = Buffer.from('\0libc.so.6\0GLIBC_2.17\0GLIBC_2.34\0GLIBC_2.4\0GLIBC_PRIVATE\0');
    expect(maxGlibcRequirement(elf)).toBe('2.34');
    expect(maxGlibcRequirement(Buffer.from('static'))).toBeNull();
  });
});

describe('staging the native terminal core', () => {
  let src;
  let dest;
  beforeEach(() => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-server-native-'));
    src = path.join(parent, 'wmux-native');
    dest = path.join(parent, 'resources', 'wmux-native');
    fs.mkdirSync(src);
    const binary = 'wmux-term.linux-arm64-gnu.node';
    const bytes = Buffer.from('fixture native binary');
    fs.writeFileSync(path.join(src, binary), bytes);
    fs.writeFileSync(path.join(src, 'index.cjs'), 'module.exports = {};');
    fs.writeFileSync(path.join(src, 'THIRD_PARTY_NOTICES'), 'fixture notices');
    fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({
      abi: 1, platform: 'linux', arch: 'arm64', binary, sha256: createHash('sha256').update(bytes).digest('hex'),
    }));
  });
  afterEach(() => fs.rmSync(path.dirname(src), { recursive: true, force: true }));

  it('copies the built core where the daemon looks for it, and checks the copy', () => {
    // Another target's build left in the stage (a desktop build in the same checkout).
    fs.writeFileSync(path.join(src, 'wmux-term.darwin-arm64.node'), 'stale');
    stageNativeCore(src, dest, 'arm64');
    expect(fs.readdirSync(dest).sort()).toEqual(['THIRD_PARTY_NOTICES', 'index.cjs', 'manifest.json', 'wmux-term.linux-arm64-gnu.node']);
  });

  it('refuses a core built for another arch, and a missing one', () => {
    expect(() => stageNativeCore(src, dest, 'x64')).toThrow(/architecture mismatch/);
    fs.rmSync(path.join(src, 'manifest.json'));
    expect(() => stageNativeCore(src, path.join(dest, 'again'), 'arm64')).toThrow(/build:terminal-core/);
  });
});

describe('release.yml server artifacts', () => {
  function job(name, text = RELEASE) {
    const start = text.indexOf(`\n  ${name}:\n`);
    expect(start, `job "${name}" is missing`).toBeGreaterThanOrEqual(0);
    const next = text.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
    return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
  }
  const step = (text, name) => text.indexOf(`- name: ${name}\n`);

  it('builds each arch natively on its own runner, in the workflow pull requests run too', () => {
    expect(job('server')).toMatch(/\n {4}uses: \.\/\.github\/workflows\/server-artifact\.yml\n/);
    expect(SERVER_WORKFLOW).toMatch(/\non:\n {2}workflow_call:\n {2}pull_request:\n/);
    for (const file of ['build-server-artifact.mjs', 'build-server-artifact-container.sh', 'prove-server-artifact.mjs', 'prove-server-artifact.sh', 'build-native-terminal.mjs', 'verify-native-terminal-package.cjs']) {
      expect(SERVER_WORKFLOW).toContain(`- 'scripts/${file}'\n`);
    }
    const server = job('server', SERVER_WORKFLOW);
    expect(server).toMatch(/arch: x64\n\s+runner: ubuntu-22\.04\n/);
    expect(server).toMatch(/arch: arm64\n\s+runner: ubuntu-22\.04-arm\n/);
    expect(server).toContain('bash scripts/build-server-artifact-container.sh "$ARCH" out/server');
  });

  it('proves every arch on the rust engine after the build, and uploads only for a release run', () => {
    const server = job('server', SERVER_WORKFLOW);
    const build = step(server, 'Build the server artifact');
    const prove = step(server, 'Prove the artifact on the rust engine');
    const upload = step(server, 'Upload the server artifact');
    expect(build).toBeGreaterThan(0);
    expect(prove).toBeGreaterThan(build);
    expect(upload).toBeGreaterThan(prove);
    expect(server.slice(prove, upload)).toContain('run: bash scripts/prove-server-artifact.sh "$ARCH" out/server\n');
    expect(server.slice(upload)).toContain("if: github.event_name != 'pull_request'\n");

    const wrapper = read('scripts', 'prove-server-artifact.sh');
    expect(wrapper).toMatch(/\nIMAGE=debian:11-slim@sha256:[0-9a-f]{64}\n/);
    const proof = read('scripts', 'prove-server-artifact.mjs');
    expect(proof).toContain("JSON.stringify({ engine: 'rust' })");
    expect(proof).toContain("terminalCore.effective !== 'rust'");
    expect(proof).not.toContain('WMUX_TERMINAL_CORE:');
  });

  it('builds against glibc 2.28 in a digest-pinned image and refuses anything newer', () => {
    const wrapper = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build-server-artifact-container.sh'), 'utf8').replace(/\r\n/g, '\n');
    expect(wrapper).toContain('MAX_GLIBC=2.28\n');
    expect(wrapper).toContain('--max-glibc "$MAX_GLIBC"');
    for (const arch of ['x86_64', 'aarch64']) {
      expect(wrapper).toMatch(new RegExp(`IMAGE=quay\\.io/pypa/manylinux_2_28_${arch}@sha256:[0-9a-f]{64}\\n`));
    }
  });

  // #2398: node-pty 1.2 ships Linux prebuilds, which npm ci uses instead of
  // compiling; stageNodePty needs the build against this image's glibc.
  it('rebuilds node-pty from source in the image after npm ci', () => {
    const wrapper = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build-server-artifact-container.sh'), 'utf8').replace(/\r\n/g, '\n');
    const ci = wrapper.indexOf('npm ci --no-audit --no-fund');
    const rebuild = wrapper.indexOf('npm_config_build_from_source=true npm rebuild node-pty');
    expect(ci).toBeGreaterThan(0);
    expect(rebuild).toBeGreaterThan(ci);
    expect(rebuild).toBeLessThan(wrapper.indexOf('node scripts/build-server-artifact.mjs build'));
  });

  it('installs Rust in the image from a pinned, checked rustup-init and builds the terminal core there', () => {
    const wrapper = read('scripts', 'build-server-artifact-container.sh');
    expect(wrapper).toMatch(/\nRUSTUP_VERSION=\d+\.\d+\.\d+\n/);
    expect(wrapper.match(/\n {4}RUSTUP_SHA256=[0-9a-f]{64}\n/g)).toHaveLength(2);
    const check = wrapper.indexOf('echo "$RUSTUP_SHA256  /tmp/rustup-init" | sha256sum -c -');
    const install = wrapper.indexOf('/tmp/rustup-init -y');
    const ci = wrapper.indexOf('npm ci --no-audit --no-fund');
    const core = wrapper.indexOf('npm run build:terminal-core');
    expect(check).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(check);
    expect(core).toBeGreaterThan(Math.max(install, ci));
    expect(core).toBeLessThan(wrapper.indexOf('node scripts/build-server-artifact.mjs build'));
  });

  it('writes the manifest before every app is packaged, and checks it shipped', () => {
    expect(job('build')).toMatch(/\n {4}needs: server\n/);
    for (const name of ['macos', 'linux']) expect(job(name)).toMatch(/\n {4}needs: \[server, build\]\n/);
    for (const name of ['build', 'macos', 'linux']) {
      const text = job(name);
      const write = text.indexOf('- name: Write the server manifest');
      const make = text.indexOf('- name: Build & Make');
      const check = text.indexOf('- name: Check the packaged server manifest');
      expect(write, `${name} writes no manifest`).toBeGreaterThan(0);
      expect(write, `${name} writes the manifest after make`).toBeLessThan(make);
      expect(check, `${name} never checks the packaged manifest`).toBeGreaterThan(make);
    }
  });

  it('publishes the tarballs through the one release-creating step', () => {
    const files = RELEASE.slice(RELEASE.indexOf('- name: Create GitHub Release'));
    expect(files).toContain('out/server/wmux-server-*.tar.gz\n');
    expect(files).toContain('out/server/wmux-server-*.tar.gz.sha256\n');
    expect(files).toContain('dist/server-manifest.json\n');
  });
});
