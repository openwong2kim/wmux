import { describe, it, expect } from 'vitest';
import { quotePathsForPrompt, buildSubmitWrites } from '../inject';

describe('quotePathsForPrompt', () => {
  it('single-quotes paths with spaces on POSIX and joins with a single space', () => {
    expect(quotePathsForPrompt(['/a/b.png', '/c d/e.ts'], 'darwin')).toBe("/a/b.png '/c d/e.ts'");
  });
  it('returns empty string for no paths', () => {
    expect(quotePathsForPrompt([], 'darwin')).toBe('');
  });
  it('single-quotes shell metacharacters on POSIX', () => {
    for (const name of ['$(echo X)', '`id`', 'a;b', 'a&b', 'a|b', '*', '!x', 'a"b']) {
      expect(quotePathsForPrompt([`/r/${name}`], 'linux')).toBe(`'/r/${name}'`);
    }
  });
  it("escapes an embedded single quote as '\\'' on POSIX", () => {
    expect(quotePathsForPrompt(["/r/it's"], 'darwin')).toBe("'/r/it'\\''s'");
  });
  it('leaves out paths with control characters and keeps the rest', () => {
    for (const c of ['\n', '\r', '\t', '\x1b', '\x00', '\x7f', '\x85', '\x9b']) {
      expect(quotePathsForPrompt([`/r/a${c}b`], 'darwin')).toBe('');
      expect(quotePathsForPrompt(['C:\\ok', `C:\\a${c}b`, 'C:\\ok2'], 'win32', 'pwsh.exe')).toBe('C:\\ok C:\\ok2');
    }
  });
  it('writes a backslash outside the quotes so fish reads it like bash and zsh', () => {
    expect(quotePathsForPrompt(["/r/a \\'b"], 'darwin')).toBe("'/r/a '\\\\''\\''b'");
  });
  it('on Windows keeps a safe path bare and double-quotes the rest for any shell', () => {
    for (const shell of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\cmd.exe', undefined]) {
      expect(quotePathsForPrompt(['C:\\a\\b.txt'], 'win32', shell)).toBe('C:\\a\\b.txt');
      expect(quotePathsForPrompt(['C:\\a b\\c.txt'], 'win32', shell)).toBe('"C:\\a b\\c.txt"');
      expect(quotePathsForPrompt(['C:\\a & b,c;(d).txt'], 'win32', shell)).toBe('"C:\\a & b,c;(d).txt"');
      expect(quotePathsForPrompt(['C:\\a&b.txt'], 'win32', shell)).toBe('"C:\\a&b.txt"');
    }
  });
  it('uses PowerShell single quotes for $ and backticks in a PowerShell pane', () => {
    for (const shell of ['powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']) {
      expect(quotePathsForPrompt(['C:\\a $(x) `y`.txt'], 'win32', shell)).toBe("'C:\\a $(x) `y`.txt'");
      expect(quotePathsForPrompt(["C:\\it's $x\u2019.txt"], 'win32', shell)).toBe("'C:\\it''s $x\u2019\u2019.txt'");
      expect(quotePathsForPrompt(['C:\\a\u201Cb\u201D.txt'], 'win32', shell)).toBe("'C:\\a\u201Cb\u201D.txt'");
    }
  });
  it('keeps double quotes for cmd.exe, which cannot read single quotes', () => {
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    expect(quotePathsForPrompt(['C:\\a $x & b.txt'], 'win32', cmd)).toBe('"C:\\a $x & b.txt"');
    expect(quotePathsForPrompt(['C:\\50% off.txt'], 'win32', cmd)).toBe('"C:\\50% off.txt"');
  });
  it('leaves out a path cmd.exe cannot read literally', () => {
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    expect(quotePathsForPrompt(['C:\\a%PATH%b.txt', 'C:\\ok.txt'], 'win32', cmd)).toBe('C:\\ok.txt');
    expect(quotePathsForPrompt(['\\\\wsl.localhost\\u\\a"b'], 'win32', cmd)).toBe('');
  });
  it('leaves out a path that needs shell-specific quoting when the shell is unknown', () => {
    expect(quotePathsForPrompt(['C:\\a $x & b.txt', 'C:\\c d.txt'], 'win32', undefined)).toBe('"C:\\c d.txt"');
    expect(quotePathsForPrompt(['C:\\a`b.txt'], 'win32', 'nu.exe')).toBe('');
  });
  it('uses POSIX quoting for a Git Bash or WSL pane on Windows', () => {
    expect(quotePathsForPrompt(["C:\\it's"], 'win32', 'C:\\Program Files\\Git\\bin\\bash.exe')).toBe("'C:'\\\\'it'\\''s'");
    expect(quotePathsForPrompt(['C:\\a b'], 'win32', 'C:\\Windows\\System32\\wsl.exe')).toBe("'C:'\\\\'a b'");
  });
});

describe('buildSubmitWrites', () => {
  it('returns the text then a lone CR when submit=true', () => {
    expect(buildSubmitWrites('hello', true)).toEqual(['hello', '\r']);
  });
  it('returns just the text when submit=false', () => {
    expect(buildSubmitWrites('hello', false)).toEqual(['hello']);
  });
});
