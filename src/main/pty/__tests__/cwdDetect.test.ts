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
});

describe('detectPromptCwd', () => {
  it('returns null when there is no prompt', () => {
    expect(detectPromptCwd('just some command output\n')).toBeNull();
  });

  it('reads the PowerShell cwd from a single prompt', () => {
    expect(detectPromptCwd('PS C:\\Users\\me>')).toBe('C:\\Users\\me');
  });

  it('reads the LAST prompt, not the first — the core stuck-at-home fix', () => {
    // The echoed command line carries the OLD prompt before the new one.
    const buf = 'PS C:\\Users\\me> cd D:\\proj\r\nPS D:\\proj>';
    expect(detectPromptCwd(buf)).toBe('D:\\proj');
  });

  it('handles several prompts and returns the final cwd', () => {
    const buf = 'PS C:\\a> cd b\r\nPS C:\\a\\b> cd c\r\nPS C:\\a\\b\\c>';
    expect(detectPromptCwd(buf)).toBe('C:\\a\\b\\c');
  });

  it('reads a bash-style prompt cwd', () => {
    expect(detectPromptCwd('me@host:/home/me/work$')).toBe('/home/me/work');
  });

  it('prefers the last prompt across mixed content', () => {
    const buf = 'PS C:\\start> npm run build\r\n...output...\r\nPS C:\\start\\dist>';
    expect(detectPromptCwd(buf)).toBe('C:\\start\\dist');
  });
});
