import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nativeTerminalTarget } from '../lib/native-terminal-targets.mjs';

const { verifyIntegrity, recordShippedDigest } = createRequire(import.meta.url)('../verify-native-terminal-package.cjs');
let directory;
let manifest;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-package-'));
  const bytes = Buffer.from('fixture native binary');
  manifest = { abi: 1, platform: 'win32', arch: 'x64', binary: 'wmux-term.win32-x64-msvc.node',
    sha256: createHash('sha256').update(bytes).digest('hex') };
  fs.writeFileSync(path.join(directory, manifest.binary), bytes);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, 'index.cjs'), 'module.exports = {};');
  fs.writeFileSync(path.join(directory, 'THIRD_PARTY_NOTICES'), 'fixture notices');
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('copied native terminal resource integrity', () => {
  it('accepts a complete copy for the package target', () => {
    expect(() => verifyIntegrity(directory, 'win32', 'x64')).not.toThrow();
  });
  it.each(['manifest.json', 'index.cjs', 'THIRD_PARTY_NOTICES', 'wmux-term.win32-x64-msvc.node'])(
    'rejects a package missing %s', file => {
      fs.unlinkSync(path.join(directory, file));
      expect(() => verifyIntegrity(directory, 'win32', 'x64')).toThrow();
    },
  );
  it('rejects a stale binary from a different target', () => {
    expect(() => verifyIntegrity(directory, 'linux', 'x64')).toThrow(/platform mismatch/);
    expect(() => verifyIntegrity(directory, 'win32', 'arm64')).toThrow(/architecture mismatch/);
    expect(() => verifyIntegrity(directory, undefined, undefined)).toThrow();
  });
  it('rejects corruption in the copied binary', () => {
    fs.appendFileSync(path.join(directory, manifest.binary), 'corruption');
    expect(() => verifyIntegrity(directory, 'win32', 'x64')).toThrow(/checksum mismatch/);
  });
  it('rejects an incompatible manifest ABI', () => {
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, abi: 2 }));
    expect(() => verifyIntegrity(directory, 'win32', 'x64')).toThrow(/ABI mismatch/);
  });
});

describe('recording the digest of the binary as shipped', () => {
  it('describes a binary that signing rewrote, and changes nothing else', () => {
    // macOS code signing embeds a signature in the Mach-O after the build
    // recorded its digest.
    fs.appendFileSync(path.join(directory, manifest.binary), 'embedded signature');
    expect(() => verifyIntegrity(directory, 'win32', 'x64')).toThrow(/checksum mismatch/);
    const digest = recordShippedDigest(directory);
    const shipped = fs.readFileSync(path.join(directory, manifest.binary));
    expect(digest).toBe(createHash('sha256').update(shipped).digest('hex'));
    const recorded = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    expect(recorded).toEqual({ ...manifest, sha256: digest });
    expect(() => verifyIntegrity(directory, 'win32', 'x64')).not.toThrow();
  });
  it('refuses a manifest that does not name a terminal binary', () => {
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, binary: '../escape.node' }));
    expect(() => recordShippedDigest(directory)).toThrow(/Invalid native binary filename/);
  });
  it('refuses a missing binary', () => {
    fs.unlinkSync(path.join(directory, manifest.binary));
    expect(() => recordShippedDigest(directory)).toThrow();
  });
});

describe('build targets', () => {
  it('names each binary the way napi builds it, Linux arm64 included', () => {
    expect(nativeTerminalTarget('linux', 'arm64')).toEqual({ target: 'aarch64-unknown-linux-gnu', binary: 'wmux-term.linux-arm64-gnu.node' });
    expect(nativeTerminalTarget('linux', 'x64')).toEqual({ target: 'x86_64-unknown-linux-gnu', binary: 'wmux-term.linux-x64-gnu.node' });
    expect(() => nativeTerminalTarget('linux', 'ia32')).toThrow(/Unqualified terminal-core target: linux-ia32/);
  });
});

describe('the package smoke runtime', () => {
  const verifier = fileURLToPath(new URL('../verify-native-terminal-package.cjs', import.meta.url));
  const runSmoke = (...args) => spawnSync(process.execPath, [verifier, directory, ...args], { encoding: 'utf8' });

  it('wants the packaged Electron for a desktop package', () => {
    expect(runSmoke().stderr).toContain('Run this smoke with the packaged Electron executable');
  });

  it('runs on Node for a package whose daemon runs on Node (wmux-server)', () => {
    const { status, stderr } = runSmoke('--node');
    expect(status).not.toBe(0);
    expect(stderr).not.toContain('Run this smoke with');
    // Past the runtime check: the fixture has no wmux-native module to load.
    expect(stderr).toMatch(/Cannot find module/);
  });
});

describe('official desktop release packaging', () => {
  const release = fs.readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');
  it.each(['build', 'macos', 'linux'])('builds and includes the Rust module in %s', job => {
    const body = release.split(`\n  ${job}:\n`)[1]?.split(/\n  \w+:\n/)[0];
    expect(body).toBeDefined();
    const buildAt = body.indexOf('run: npm run build:terminal-core');
    const makeAt = body.indexOf('- name: Build & Make');
    expect(buildAt).toBeGreaterThan(body.indexOf('run: npm ci'));
    expect(makeAt).toBeGreaterThan(buildAt);
    const make = body.slice(makeAt).split(/\n      - /)[0];
    expect(make).toContain("WMUX_PACKAGE_TERMINAL_CORE: '1'");
    expect(make).toContain('run: npm run make');
    expect(body).not.toMatch(/WMUX_TERMINAL_CORE:\s*['"]?rust/);
  });
});
