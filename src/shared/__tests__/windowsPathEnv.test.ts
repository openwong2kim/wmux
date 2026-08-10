import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  expandPercentRefs,
  composeRegistryPath,
  mergeFreshPathWithBase,
  withFreshWindowsPath,
  resetFreshPathCacheForTests,
  parseRegExportValue,
  readRegistryEnvPath,
} from '../windowsPathEnv';

beforeEach(() => resetFreshPathCacheForTests());

/** Build a `.reg` export body around one root section. */
function regFile(section: string, extra = ''): string {
  return [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Environment]',
    section,
    extra,
    '',
  ].join('\r\n');
}

/** UTF-16LE bytes of `s` (NUL-terminated) as a `.reg` hex(2) token list. */
function hexBytes(s: string): string {
  const buf = Buffer.from(`${s}\0`, 'ucs2');
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(',');
}

/**
 * #849 — the registry read used to pipe reg.exe text and decode it as UTF-8,
 * but reg.exe encodes a pipe in the console code page: `D:\软件\Python312` came
 * back as `D:\?<FFFD><FFFD>\Python312`, a path that exists nowhere, so command
 * resolution fell through to a later PATH entry. Reading a UTF-16LE `.reg`
 * export instead keeps every byte. These cases pin the parser's contract:
 * decode exactly what it can prove, return null for everything else.
 */
describe('parseRegExportValue', () => {
  it('round-trips non-ASCII through hex(2), which is what a user PATH is', () => {
    const value = 'D:\\软件\\Python312;D:\\héllo;%SystemRoot%\\System32';
    expect(parseRegExportValue(regFile(`"Path"=hex(2):${hexBytes(value)}`), 'Path')).toBe(value);
  });

  it('joins backslash-continued hex lines', () => {
    const value = 'C:\\a;C:\\b';
    const tokens = hexBytes(value).split(',');
    const split = `"Path"=hex(2):${tokens.slice(0, 4).join(',')},\\\r\n  ${tokens.slice(4).join(',')}`;
    expect(parseRegExportValue(regFile(split), 'Path')).toBe(value);
  });

  it('decodes REG_SZ escaping, which is not JSON escaping', () => {
    // A literal backslash-n in a path must stay two characters.
    expect(parseRegExportValue(regFile('"Path"="C:\\\\new;C:\\\\b"'), 'Path')).toBe('C:\\new;C:\\b');
    expect(parseRegExportValue(regFile('"Path"="C:\\\\a \\"q\\" b"'), 'Path')).toBe('C:\\a "q" b');
    expect(parseRegExportValue(regFile('"Path"="\\\\\\\\server\\\\share"'), 'Path')).toBe('\\\\server\\share');
  });

  it('matches the value name case-insensitively', () => {
    expect(parseRegExportValue(regFile('"PATH"="C:\\\\a"'), 'Path')).toBe('C:\\a');
  });

  it('ignores a subkey section — only the root key owns our value', () => {
    const withSub = regFile(
      '"TEMP"="C:\\\\t"',
      '\r\n[HKEY_CURRENT_USER\\Environment\\Sub]\r\n"Path"="C:\\\\decoy"',
    );
    expect(parseRegExportValue(withSub, 'Path')).toBeNull();
  });

  it('returns null rather than a partial PATH on anything malformed', () => {
    const bad = [
      `"Path"=hex(2):${hexBytes('C:\\a')},41`,        // odd byte count
      '"Path"=hex(2):44,00,zz,00',                     // non-hex token
      '"Path"=hex(2):44,00,\\',                        // continuation off the end
      `"Path"=hex(7):${hexBytes('C:\\a')}`,            // REG_MULTI_SZ, not a PATH
      '"Path"=dword:00000001',                         // wrong shape entirely
      '"Path"="unterminated',                          // no closing quote
    ];
    for (const section of bad) {
      expect(parseRegExportValue(regFile(section), 'Path')).toBeNull();
    }
    expect(parseRegExportValue('', 'Path')).toBeNull();
    expect(parseRegExportValue(regFile('"TEMP"="C:\\\\t"'), 'Path')).toBeNull();
  });
});

/**
 * The regression that matters: every other test here injects
 * `deps.readRegistryPath`, so the real reader — the function that held the
 * encoding bug — was never executed by the suite. This one spawns the real
 * reg.exe against a scratch key under HKCU\Software. It never touches
 * HKCU\Environment.
 */
describe.runIf(process.platform === 'win32')('readRegistryEnvPath (live reg.exe)', () => {
  const KEY = `HKCU\\Software\\wmux-test-849-${process.pid}`;
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const drop = () => {
    try {
      execFileSync(reg, ['delete', KEY, '/f'], { stdio: 'ignore' });
    } catch {
      /* not present */
    }
  };

  it('round-trips a non-ASCII REG_EXPAND_SZ value byte for byte', () => {
    const value = 'D:\\软件\\Python312;D:\\héllo;%SystemRoot%\\System32';
    drop();
    execFileSync(reg, ['add', KEY, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], {
      stdio: 'ignore',
    });
    try {
      expect(readRegistryEnvPath(KEY)).toBe(value);
    } finally {
      drop();
    }
  });

  it('leaves no temp file behind', () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('wmux-regpath-'));
    drop();
    execFileSync(reg, ['add', KEY, '/v', 'Path', '/t', 'REG_SZ', '/d', 'C:\\a', '/f'], {
      stdio: 'ignore',
    });
    try {
      readRegistryEnvPath(KEY);
      const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('wmux-regpath-'));
      expect(after.length).toBe(before.length);
    } finally {
      drop();
    }
  });

  it('fails open (null) for a key that does not exist', () => {
    expect(readRegistryEnvPath(`${KEY}-absent-xyz`)).toBeNull();
  });
});

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
