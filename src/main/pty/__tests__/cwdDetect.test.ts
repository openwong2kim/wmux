import { describe, it, expect } from 'vitest';
import { parseOsc7Cwd, detectPromptCwd } from '../cwdDetect';

describe('parseOsc7Cwd', () => {
  it('converts a Windows OSC 7 URI to a native backslash path', () => {
    // This is the regression: the old code left "/C:/Users/me".
    expect(parseOsc7Cwd('file://DESKTOP/C:/Users/me')).toBe('C:\\Users\\me');
  });

  it('handles a Windows path with no host segment', () => {
    expect(parseOsc7Cwd('file:///C:/Windows/System32')).toBe('C:\\Windows\\System32');
  });

  it('leaves a POSIX path untouched (cross-platform safe)', () => {
    expect(parseOsc7Cwd('file://host/home/me/project')).toBe('/home/me/project');
  });

  it('percent-decodes spaces and unicode in the path', () => {
    expect(parseOsc7Cwd('file://host/C:/Users/me/My%20Docs')).toBe('C:\\Users\\me\\My Docs');
  });

  it('keeps the raw payload when percent-decoding fails', () => {
    // A lone % is invalid percent-encoding — must not throw.
    expect(parseOsc7Cwd('file://host/C:/bad%path')).toBe('C:\\bad%path');
  });

  it('does not mangle a drive-relative-looking POSIX dir', () => {
    expect(parseOsc7Cwd('file://host/srv/data')).toBe('/srv/data');
  });

  it('reconstructs a Windows UNC path emitted by the hook', () => {
    // The pwsh hook turns `\\server\share\proj` into `//server/share/proj` and
    // appends it after the host separator → "file://HOST///server/share/proj".
    expect(parseOsc7Cwd('file://DESKTOP///server/share/proj')).toBe('\\\\server\\share\\proj');
  });

  it('percent-decodes a UNC path with spaces', () => {
    expect(parseOsc7Cwd('file://HOST///nas/Team%20Share/x')).toBe('\\\\nas\\Team Share\\x');
  });

  // Issue #540 round-trip pins: the exact payload shapes the v8 pwsh/bash
  // integration hooks emit must parse back to spawnable native paths, because
  // these values feed the split-inheritance seed (validateCwd + fs.existsSync).
  // Both hooks percent-encode (per-segment on pwsh, byte-wise on bash), so the
  // drive colon arrives as %3A and spaces as %20.
  it('parses the v8 pwsh hook shape (segment-encoded, uppercase drive)', () => {
    // pwsh emits file://$env:COMPUTERNAME/ + EscapeDataString per '\'-segment.
    expect(parseOsc7Cwd('file://DESKTOP-AB12/D%3A/wmux/src')).toBe('D:\\wmux\\src');
    expect(parseOsc7Cwd('file://DESKTOP-AB12/D%3A/Users/me/My%20Docs')).toBe('D:\\Users\\me\\My Docs');
  });

  it('parses the raw-colon shape too (zsh hook and pre-encode daemons still emit it)', () => {
    expect(parseOsc7Cwd('file://DESKTOP-AB12/D:/wmux/src')).toBe('D:\\wmux\\src');
  });

  it('parses the v8 Git Bash hook shape (lowercase drive from /c/... rewrite, byte-encoded)', () => {
    // Git Bash rewrites /c/Users/me → /c:/Users/me, then byte-encodes: %3A.
    expect(parseOsc7Cwd('file://DESKTOP-AB12/c%3A/Users/me/proj')).toBe('c:\\Users\\me\\proj');
  });

  it('parses the v8 Git Bash drive-root shape (/c → /c:/, trailing slash kept)', () => {
    expect(parseOsc7Cwd('file://HOST/c%3A/')).toBe('c:\\');
  });

  // #541 review: a directory whose REAL name contains a literal percent
  // sequence ("build%20cache") must round-trip — the hook emits %2520 (the
  // '%' byte itself encoded), and one decode yields the literal %20 back.
  it('round-trips a directory name containing a literal %20 (%2520 payload)', () => {
    expect(parseOsc7Cwd('file://HOST/D%3A/build%2520cache')).toBe('D:\\build%20cache');
    expect(parseOsc7Cwd('file://HOST/home/me/build%2520cache')).toBe('/home/me/build%20cache');
  });

  // #541 review: ESC/BEL bytes in a hostile directory name arrive %-encoded
  // (%1B/%07) — decode turns them back into control characters inside the
  // STRING VALUE only. They must stay inside the parsed path (state), never
  // terminate the OSC sequence (the encoder upstream is the injection
  // barrier; this pins the decoder half of the contract).
  it('decodes %-encoded control bytes into the string value without truncation', () => {
    expect(parseOsc7Cwd('file://HOST/tmp/evil%1B%5D0%3Bpwned%07dir'))
      .toBe('/tmp/evil\x1b]0;pwned\x07dir');
  });
});

describe('detectPromptCwd', () => {
  it('returns null when there is no prompt', () => {
    expect(detectPromptCwd('just some command output\n')).toBeNull();
  });

  it('reads the PowerShell cwd from a single prompt', () => {
    expect(detectPromptCwd('PS C:\\Users\\me>', 'win32')).toBe('C:\\Users\\me');
  });

  it('reads the LAST prompt, not the first — the core stuck-at-home fix', () => {
    // The echoed command line carries the OLD prompt before the new one.
    const buf = 'PS C:\\Users\\me> cd D:\\proj\r\nPS D:\\proj>';
    expect(detectPromptCwd(buf, 'win32')).toBe('D:\\proj');
  });

  it('handles several prompts and returns the final cwd', () => {
    const buf = 'PS C:\\a> cd b\r\nPS C:\\a\\b> cd c\r\nPS C:\\a\\b\\c>';
    expect(detectPromptCwd(buf, 'win32')).toBe('C:\\a\\b\\c');
  });

  it('reads a bash-style prompt cwd', () => {
    expect(detectPromptCwd('me@host:/home/me/work$')).toBe('/home/me/work');
  });

  it('prefers the last prompt across mixed content', () => {
    const buf = 'PS C:\\start> npm run build\r\n...output...\r\nPS C:\\start\\dist>';
    expect(detectPromptCwd(buf, 'win32')).toBe('C:\\start\\dist');
  });

  // 오탐 방어(2026-07-20): 화면에 표시된 Windows 프롬프트 텍스트가 POSIX
  // 페인의 cwd를 덮지 않는다 — "C:\…" 사고 회귀 테스트.
  it('rejects a Windows-shaped prompt cwd on a POSIX platform', () => {
    expect(detectPromptCwd('PS C:\\Users\\me>', 'darwin')).toBeNull();
    expect(detectPromptCwd('PS C:\\\u2026>', 'darwin')).toBeNull();
  });

  it('still reads POSIX bash prompts on darwin', () => {
    expect(detectPromptCwd('me@host:/home/me/work$', 'darwin')).toBe('/home/me/work');
  });
});
