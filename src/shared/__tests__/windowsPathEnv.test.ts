import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  expandPercentRefs,
  composeRegistryPath,
  mergeFreshPathWithBase,
  withFreshWindowsPath,
  resetFreshPathCacheForTests,
} from '../windowsPathEnv';

beforeEach(() => resetFreshPathCacheForTests());

describe('expandPercentRefs', () => {
  it('expands known vars case-insensitively and leaves unknown literal', () => {
    const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
    expect(expandPercentRefs('%SystemRoot%\\system32', env)).toBe('C:\\Windows\\system32');
    expect(expandPercentRefs('%systemroot%\\a', env)).toBe('C:\\Windows\\a'); // case-insensitive
    expect(expandPercentRefs('%NOPE%\\x', env)).toBe('%NOPE%\\x'); // unknown → literal
  });
});

describe('composeRegistryPath', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  it('returns null only when BOTH reads failed', () => {
    expect(composeRegistryPath(null, null, env)).toBeNull();
  });
  it('composes machine then user, expanding vars', () => {
    expect(composeRegistryPath('%SystemRoot%\\system32;C:\\sys', 'C:\\Users\\me\\bin', env)).toBe(
      'C:\\Windows\\system32;C:\\sys;C:\\Users\\me\\bin',
    );
  });
  it('handles one side missing', () => {
    expect(composeRegistryPath('C:\\sys', null, env)).toBe('C:\\sys');
    expect(composeRegistryPath(null, 'C:\\usr', env)).toBe('C:\\usr');
  });
});

describe('mergeFreshPathWithBase', () => {
  it('leads with fresh entries and appends runtime-only base extras (dedup, ci)', () => {
    const base = { Path: 'C:\\SYS;C:\\wmux\\bin;C:\\usr' };
    // C:\SYS and C:\usr are already in fresh (different case) → only the bin extra is kept.
    expect(mergeFreshPathWithBase('C:\\sys;C:\\usr', base)).toBe('C:\\sys;C:\\usr;C:\\wmux\\bin');
  });
  it('is just the fresh path when base has no PATH', () => {
    expect(mergeFreshPathWithBase('C:\\sys;C:\\usr', {})).toBe('C:\\sys;C:\\usr');
  });
});

describe('withFreshWindowsPath', () => {
  const reader = (sys: string | null, usr: string | null) => (root: string) =>
    root.startsWith('HKLM') ? sys : usr;

  it('is a no-op off win32 (returns the same object)', () => {
    const base = { Path: 'C:\\old' };
    expect(withFreshWindowsPath(base, { platform: 'darwin' })).toBe(base);
  });

  it('is a no-op when disabled by the kill switch', () => {
    const base = { Path: 'C:\\old' };
    expect(withFreshWindowsPath(base, { platform: 'win32', disabled: true })).toBe(base);
  });

  it('refreshes PATH from the registry, leads with fresh, appends base extras, preserves casing', () => {
    const base = { Path: 'C:\\stale;C:\\wmux\\bin', OTHER: 'keep' };
    const out = withFreshWindowsPath(base, {
      platform: 'win32',
      now: () => 1000,
      readRegistryPath: reader('C:\\sys', 'C:\\usr'),
    });
    expect(out).not.toBe(base);
    // Fresh registry entries lead (resolution order); any base entry not in the
    // fresh set is appended — including a now-removed one like C:\stale, which
    // lingers harmlessly at the end rather than risking dropping a live path.
    expect(out.Path).toBe('C:\\sys;C:\\usr;C:\\stale;C:\\wmux\\bin');
    expect(out.OTHER).toBe('keep'); // other vars untouched
    expect(base.Path).toBe('C:\\stale;C:\\wmux\\bin'); // original not mutated
  });

  it('fails open (returns base unchanged) when both registry reads fail', () => {
    const base = { Path: 'C:\\old' };
    const out = withFreshWindowsPath(base, {
      platform: 'win32',
      now: () => 1000,
      readRegistryPath: () => null,
    });
    expect(out).toBe(base);
  });

  it('caches the registry read within the TTL and re-reads after it', () => {
    const read = vi.fn((root: string) => (root.startsWith('HKLM') ? 'C:\\sys' : 'C:\\usr'));
    const base = { Path: 'C:\\x' };
    let t = 10_000;
    const run = () => withFreshWindowsPath(base, { platform: 'win32', now: () => t, readRegistryPath: read });

    run();
    run();
    expect(read).toHaveBeenCalledTimes(2); // one HKLM + one HKCU, cached for the 2nd call

    t += 6_000; // advance past the 5s TTL
    run();
    expect(read).toHaveBeenCalledTimes(4); // re-read
  });
});
