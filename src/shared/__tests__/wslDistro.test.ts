import { describe, it, expect, vi } from 'vitest';
import {
  isWslShellPath,
  isValidWslDistroName,
  wslDistroArgs,
  isWslDistroSpawnArgs,
  parseWslDistros,
  decodeWslOutput,
} from '../wslDistro';

// #1103 — the distro choice travels as EXACTLY ['-d', '<name>'] and every
// trust boundary (renderer store → main IPC → daemon RPC → spawn) validates
// that shape before it reaches a process.

describe('isWslShellPath', () => {
  it('recognizes wsl.exe across casing and separators', () => {
    expect(isWslShellPath('C:\\Windows\\System32\\wsl.exe')).toBe(true);
    expect(isWslShellPath('C:\\WINDOWS\\system32\\WSL.EXE')).toBe(true);
    expect(isWslShellPath('/usr/bin/wsl')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isWslShellPath('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(false);
    expect(isWslShellPath('wslhelper.exe')).toBe(false);
    expect(isWslShellPath(undefined)).toBe(false);
    expect(isWslShellPath('')).toBe(false);
  });
});

describe('wslDistroArgs', () => {
  it('builds the flag only for a wsl shell with a valid distro', () => {
    expect(wslDistroArgs('C:\\Windows\\System32\\wsl.exe', 'Ubuntu-24.04'))
      .toEqual(['-d', 'Ubuntu-24.04']);
  });
  it('undefined for no choice, empty choice, non-wsl shell, or a hostile name', () => {
    expect(wslDistroArgs('C:\\Windows\\System32\\wsl.exe', undefined)).toBeUndefined();
    expect(wslDistroArgs('C:\\Windows\\System32\\wsl.exe', '')).toBeUndefined();
    expect(wslDistroArgs('C:\\Program Files\\pwsh.exe', 'Ubuntu')).toBeUndefined();
    expect(wslDistroArgs('C:\\Windows\\System32\\wsl.exe', '--exec cmd')).toBeUndefined();
    expect(wslDistroArgs('C:\\Windows\\System32\\wsl.exe', 'a;b')).toBeUndefined();
  });
});

describe('isWslDistroSpawnArgs (daemon RPC boundary)', () => {
  it('accepts exactly the validated selection for a wsl cmd', () => {
    expect(isWslDistroSpawnArgs('wsl.exe', ['-d', 'Ubuntu'])).toBe(true);
  });
  it('refuses extra flags, reordering, wrong arity, non-wsl cmd', () => {
    expect(isWslDistroSpawnArgs('wsl.exe', ['-d', 'Ubuntu', '--exec', 'cmd'])).toBe(false);
    expect(isWslDistroSpawnArgs('wsl.exe', ['Ubuntu', '-d'])).toBe(false);
    expect(isWslDistroSpawnArgs('wsl.exe', ['--exec', 'cmd.exe'])).toBe(false);
    expect(isWslDistroSpawnArgs('pwsh.exe', ['-d', 'Ubuntu'])).toBe(false);
    expect(isWslDistroSpawnArgs('wsl.exe', 'not-an-array')).toBe(false);
    expect(isWslDistroSpawnArgs('wsl.exe', undefined)).toBe(false);
  });
});

describe('isValidWslDistroName', () => {
  it('accepts real distro names — incl. Unicode and interior spaces — and refuses metacharacters', () => {
    expect(isValidWslDistroName('Ubuntu')).toBe(true);
    expect(isValidWslDistroName('Ubuntu-24.04')).toBe(true);
    expect(isValidWslDistroName('openSUSE-Leap-15.6')).toBe(true);
    expect(isValidWslDistroName('docker-desktop')).toBe(true);
    expect(isValidWslDistroName('우분투')).toBe(true);
    expect(isValidWslDistroName('My Distro')).toBe(true);
    expect(isValidWslDistroName('-flag')).toBe(false);
    expect(isValidWslDistroName(' leading')).toBe(false);
    expect(isValidWslDistroName('a"b')).toBe(false);
    expect(isValidWslDistroName('a;b')).toBe(false);
    expect(isValidWslDistroName('a/b')).toBe(false);
    expect(isValidWslDistroName('a\\b')).toBe(false);
    expect(isValidWslDistroName('')).toBe(false);
    expect(isValidWslDistroName(42)).toBe(false);
  });
});

describe('parseWslDistros', () => {
  it('parses UTF-8 --list --quiet output, docker distros last', () => {
    expect(parseWslDistros('docker-desktop\nUbuntu-24.04\ndocker-desktop-data\n'))
      .toEqual(['Ubuntu-24.04', 'docker-desktop', 'docker-desktop-data']);
  });
  it('decodes real UTF-16LE buffers (BOM-sniffed), incl. non-ASCII names', () => {
    const body = 'Ubuntu\r\n우분투\ndocker-desktop';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
    expect(parseWslDistros(utf16)).toEqual(['Ubuntu', '우분투', 'docker-desktop']);
  });
  it('decodes BOM-less UTF-16LE buffers (inbox wsl.exe ignoring WSL_UTF8)', () => {
    const utf16 = Buffer.from('Ubuntu-24.04\r\n우분투\r\ndocker-desktop\r\n', 'utf16le');
    expect(parseWslDistros(utf16)).toEqual(['Ubuntu-24.04', '우분투', 'docker-desktop']);
  });
  it('decodes a BOM-marked UTF-8 buffer and still accepts plain strings', () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Ubuntu\n', 'utf8')]);
    expect(parseWslDistros(utf8)).toEqual(['Ubuntu']);
    expect(parseWslDistros('Ubuntu\n')).toEqual(['Ubuntu']);
  });
  it('#1395 orders Latin before Hangul whatever the process locale says', async () => {
    // A bare localeCompare followed the machine locale: on ko-KR, Hangul sorted
    // first and the two UTF-16 tests above failed on a clean main. The order
    // is pinned to one collation so every box lists the same distros the same way.
    expect(parseWslDistros('우분투\ndocker-desktop\nUbuntu\nalpine\n'))
      .toEqual(['alpine', 'Ubuntu', '우분투', 'docker-desktop']);
    // The assertion above passes on an English worker under the OLD code too,
    // so pin the mechanism as well: the module asks for the 'en' collation
    // instead of whatever the process locale is (review, #1404).
    vi.resetModules();
    const collator = vi.spyOn(Intl, 'Collator');
    try {
      await import('../wslDistro');
      expect(collator).toHaveBeenCalledWith('en');
    } finally {
      collator.mockRestore();
    }
  });

  it('drops blank lines, duplicates, and names outside the charset', () => {
    expect(parseWslDistros('\n\nUbuntu\nUbuntu\n<Default>\nsome weird/name\n'))
      .toEqual(['Ubuntu']);
  });
});

// #1390 — wsl.exe writes UTF-16LE. Every reader of its output goes through
// decodeWslOutput, so a spawn failure reaches recoveryError as readable text
// instead of the interleaved-NUL form the issue reported.
describe('decodeWslOutput', () => {
  const NUL = String.fromCharCode(0);
  const BOM = String.fromCharCode(0xfeff);
  // What wsl.exe prints on a box with no distro installed, localized.
  const korean = '지정된 이름의 배포가 없습니다.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND';

  it('decodes UTF-16LE with a BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(korean, 'utf16le')]);
    expect(decodeWslOutput(bytes)).toBe(korean);
  });

  it('decodes BOM-less UTF-16LE, the form that mangled recoveryError', () => {
    const bytes = Buffer.from(korean, 'utf16le');
    // The old path: utf8 over UTF-16LE bytes keeps ASCII with a NUL after
    // every character and destroys the Korean outright.
    expect(bytes.toString('utf8')).toContain(NUL);
    expect(decodeWslOutput(bytes)).toBe(korean);
    expect(decodeWslOutput(bytes)).not.toContain(NUL);
  });

  it('decodes the ASCII shape from the issue without interleaved NULs', () => {
    expect(decodeWslOutput(Buffer.from('Linux', 'utf16le'))).toBe('Linux');
  });

  it('leaves genuine UTF-8 untouched, with or without a BOM', () => {
    const message = 'wsl: 배포를 시작할 수 없습니다';
    expect(decodeWslOutput(Buffer.from(message, 'utf8'))).toBe(message);
    expect(decodeWslOutput(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(message, 'utf8')])))
      .toBe(message);
  });

  it('answers empty for empty input and strips a BOM from a string', () => {
    expect(decodeWslOutput(Buffer.alloc(0))).toBe('');
    expect(decodeWslOutput('')).toBe('');
    expect(decodeWslOutput(`${BOM}Ubuntu`)).toBe('Ubuntu');
    expect(decodeWslOutput('plain text')).toBe('plain text');
  });
});
