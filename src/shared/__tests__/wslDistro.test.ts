import { describe, it, expect } from 'vitest';
import {
  isWslShellPath,
  isValidWslDistroName,
  wslDistroArgs,
  isWslDistroSpawnArgs,
  parseWslDistros,
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
  it('accepts real distro names and refuses shell metacharacters', () => {
    expect(isValidWslDistroName('Ubuntu')).toBe(true);
    expect(isValidWslDistroName('Ubuntu-24.04')).toBe(true);
    expect(isValidWslDistroName('openSUSE-Leap-15.6')).toBe(true);
    expect(isValidWslDistroName('docker-desktop')).toBe(true);
    expect(isValidWslDistroName('-flag')).toBe(false);
    expect(isValidWslDistroName('has space')).toBe(false);
    expect(isValidWslDistroName('a"b')).toBe(false);
    expect(isValidWslDistroName(42)).toBe(false);
  });
});

describe('parseWslDistros', () => {
  it('parses UTF-8 --list --quiet output, docker distros last', () => {
    expect(parseWslDistros('docker-desktop\nUbuntu-24.04\ndocker-desktop-data\n'))
      .toEqual(['Ubuntu-24.04', 'docker-desktop', 'docker-desktop-data']);
  });
  it('decodes UTF-16LE output (interleaved NULs) and strips the BOM + \\r', () => {
    const utf16 = 'U\x00b\x00u\x00n\x00t\x00u\x00\r\x00\n\x00d\x00o\x00c\x00k\x00e\x00r\x00-\x00d\x00e\x00s\x00k\x00t\x00o\x00p\x00';
    expect(parseWslDistros('\uFEFF' + utf16)).toEqual(['Ubuntu', 'docker-desktop']);
  });
  it('drops blank lines, duplicates, and names outside the charset', () => {
    expect(parseWslDistros('\n\nUbuntu\nUbuntu\n<Default>\nsome weird/name\n'))
      .toEqual(['Ubuntu']);
  });
});
