import { describe, it, expect } from 'vitest';
import {
  compareSemVer,
  normalizeVersion,
  isAllowedDownloadUrl,
  digestsEqual,
  sha256Hex,
  validateManifest,
} from '../verifyUpdate';

// NN2-T4 — the fail-closed verification core. The pre-fix updater launched an
// UNVERIFIED binary from a URL taken verbatim from the update server. These
// tests lock in the security decisions: only https github.com downloads, exact
// SHA-256 match, manifest must match the offered version, reject on any doubt.

const VALID_SHA = 'a'.repeat(64);
const validManifest = (over: Record<string, unknown> = {}) => ({
  version: '2.14.1',
  setupExe: 'fmux-2.14.1.Setup.exe',
  sha256: VALID_SHA,
  url: 'https://github.com/skflowne/fmux/releases/download/v2.14.1/fmux-2.14.1.Setup.exe',
  ...over,
});

describe('normalizeVersion', () => {
  it('strips a leading v (any case) and trims', () => {
    expect(normalizeVersion('v2.14.0')).toBe('2.14.0');
    expect(normalizeVersion('2.14.0')).toBe('2.14.0');
    expect(normalizeVersion('  V1.0 ')).toBe('1.0');
  });
});

describe('compareSemVer', () => {
  it('orders major, minor, and patch releases', () => {
    expect(compareSemVer('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemVer('1.10.0', '1.9.99')).toBeGreaterThan(0);
    expect(compareSemVer('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareSemVer('v1.0.0', '1.0.0')).toBe(0);
    expect(compareSemVer('1.0.0', '1.0.1')).toBeLessThan(0);
  });

  it('follows SemVer prerelease precedence and ignores build metadata', () => {
    expect(compareSemVer('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareSemVer('1.0.0-rc.2', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareSemVer('1.0.0-beta.11', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareSemVer('1.0.0+build.2', '1.0.0+build.1')).toBe(0);
  });

  it('fails closed for invalid versions', () => {
    expect(compareSemVer('latest', '1.0.0')).toBeNull();
    expect(compareSemVer('1.1', '1.0.0')).toBeNull();
    expect(compareSemVer('1.1.0', 'dev')).toBeNull();
    expect(compareSemVer('1.1.0-rc.01', '1.1.0-rc.1')).toBeNull();
  });
});

describe('isAllowedDownloadUrl', () => {
  it('accepts https github.com and *.github.com', () => {
    expect(isAllowedDownloadUrl('https://github.com/o/r/releases/download/v1/x.exe')).toBe(true);
    expect(isAllowedDownloadUrl('https://api.github.com/x')).toBe(true);
  });
  it('rejects non-https, non-github hosts, and garbage', () => {
    expect(isAllowedDownloadUrl('http://github.com/x')).toBe(false);
    expect(isAllowedDownloadUrl('https://evil.com/x.exe')).toBe(false);
    expect(isAllowedDownloadUrl('https://github.com.evil.com/x')).toBe(false);
    expect(isAllowedDownloadUrl('ftp://github.com/x')).toBe(false);
    expect(isAllowedDownloadUrl('not a url')).toBe(false);
  });
});

describe('digestsEqual', () => {
  it('matches case-insensitively', () => {
    expect(digestsEqual('ABCDEF', 'abcdef')).toBe(true);
    expect(digestsEqual('a'.repeat(64), 'A'.repeat(64))).toBe(true);
  });
  it('rejects differing content, differing length, and empty', () => {
    expect(digestsEqual('abcdef', 'abcde0')).toBe(false);
    expect(digestsEqual('abc', 'abcdef')).toBe(false);
    expect(digestsEqual('', '')).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('matches known vectors', () => {
    expect(sha256Hex(Buffer.from(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('validateManifest', () => {
  it('accepts a well-formed manifest whose version matches the offered update (v-prefix tolerant)', () => {
    const r = validateManifest(validManifest(), 'v2.14.1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.url).toContain('github.com');
  });

  it('rejects a version mismatch (stale/wrong manifest)', () => {
    const r = validateManifest(validManifest(), '2.99.0');
    expect(r.ok).toBe(false);
  });

  it('rejects a sha256 that is not a 64-char hex digest', () => {
    expect(validateManifest(validManifest({ sha256: 'deadbeef' }), '2.14.1').ok).toBe(false);
    expect(validateManifest(validManifest({ sha256: 'z'.repeat(64) }), '2.14.1').ok).toBe(false);
  });

  it('rejects a non-github / non-https download url', () => {
    expect(validateManifest(validManifest({ url: 'https://evil.com/x.exe' }), '2.14.1').ok).toBe(false);
    expect(validateManifest(validManifest({ url: 'http://github.com/x.exe' }), '2.14.1').ok).toBe(false);
  });

  it('rejects missing fields and non-objects', () => {
    expect(validateManifest({ version: '2.14.1' }, '2.14.1').ok).toBe(false);
    expect(validateManifest(null, '2.14.1').ok).toBe(false);
    expect(validateManifest('nope', '2.14.1').ok).toBe(false);
  });

  // The Windows manifest names the artifact `setupExe`, the darwin one `file`;
  // both normalize to `fileName` so downloadAndVerify is platform-agnostic.
  it('normalizes the Windows setupExe field to fileName', () => {
    const r = validateManifest(validManifest(), '2.14.1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.fileName).toBe('fmux-2.14.1.Setup.exe');
  });

  it('accepts a darwin manifest that names the artifact with `file`', () => {
    const { setupExe: _setupExe, ...rest } = validManifest();
    const r = validateManifest(
      { ...rest, file: 'wmux-darwin-arm64-2.14.1.zip' },
      '2.14.1',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.fileName).toBe('wmux-darwin-arm64-2.14.1.zip');
  });

  it('rejects a manifest that names no artifact at all', () => {
    const { setupExe: _setupExe, ...rest } = validManifest();
    expect(validateManifest(rest, '2.14.1').ok).toBe(false);
  });

  it('still applies every other check to a darwin (`file`) manifest', () => {
    const { setupExe: _setupExe, ...rest } = validManifest();
    const darwin = (over: Record<string, unknown> = {}) =>
      ({ ...rest, file: 'wmux-darwin-arm64-2.14.1.zip', ...over });
    expect(validateManifest(darwin({ url: 'https://evil.com/x.zip' }), '2.14.1').ok).toBe(false);
    expect(validateManifest(darwin({ sha256: 'deadbeef' }), '2.14.1').ok).toBe(false);
    expect(validateManifest(darwin(), '2.99.0').ok).toBe(false);
  });
});
