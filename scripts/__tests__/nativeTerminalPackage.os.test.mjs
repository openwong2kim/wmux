import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { verifyIntegrity } = createRequire(import.meta.url)('../verify-native-terminal-package.cjs');
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
