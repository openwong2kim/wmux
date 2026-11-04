import { describe, expect, it } from 'vitest';
import { normalizeHostPath, resolveTerminalFileLink } from '../terminalFileLink';

const linux = { hostPlatform: 'linux' as const, shellKind: 'native' as const };
const winNative = { hostPlatform: 'win32' as const, shellKind: 'native' as const };
const winWsl = { hostPlatform: 'win32' as const, shellKind: 'wsl' as const, distro: 'Ubuntu' };

describe('resolveTerminalFileLink', () => {
  it('passes a POSIX path through on a POSIX host', () => {
    expect(resolveTerminalFileLink({ ...linux, raw: '/tmp/x.md' })).toEqual({ hostPath: '/tmp/x.md' });
  });

  it('splits :line and :line:col', () => {
    expect(resolveTerminalFileLink({ ...linux, raw: '/a/b.ts:42' })).toEqual({ hostPath: '/a/b.ts', line: 42 });
    expect(resolveTerminalFileLink({ ...linux, raw: '/a/b.ts:42:7' })).toEqual({ hostPath: '/a/b.ts', line: 42, col: 7 });
  });

  it('passes a drive path through on Windows and normalises it', () => {
    expect(resolveTerminalFileLink({ ...winNative, raw: 'c:/Users/me/x.md' })).toEqual({ hostPath: 'C:\\Users\\me\\x.md' });
    expect(resolveTerminalFileLink({ ...winNative, raw: 'C:\\Temp\\x.md:3' })).toEqual({ hostPath: 'C:\\Temp\\x.md', line: 3 });
  });

  it('refuses drive and UNC paths on a POSIX host', () => {
    expect(resolveTerminalFileLink({ ...linux, raw: 'C:\\x.md' })).toBeNull();
    expect(resolveTerminalFileLink({ ...linux, raw: '\\\\srv\\share\\x' })).toBeNull();
  });

  it('keeps a UNC path on Windows, spelling wsl.localhost as wsl$', () => {
    expect(resolveTerminalFileLink({ ...winNative, raw: '\\\\wsl.localhost\\Ubuntu\\tmp\\x.md' }))
      .toEqual({ hostPath: '\\\\wsl$\\Ubuntu\\tmp\\x.md' });
    expect(resolveTerminalFileLink({ ...winNative, raw: '\\\\srv\\share\\x.txt' })).toEqual({ hostPath: '\\\\srv\\share\\x.txt' });
  });

  it('maps a WSL pane POSIX path to a \\\\wsl$ share', () => {
    expect(resolveTerminalFileLink({ ...winWsl, raw: '/tmp/x.md' })).toEqual({ hostPath: '\\\\wsl$\\Ubuntu\\tmp\\x.md' });
  });

  it('maps /mnt/c in a WSL pane to the drive', () => {
    expect(resolveTerminalFileLink({ ...winWsl, raw: '/mnt/c/Users/me/x.md:9' })).toEqual({ hostPath: 'C:\\Users\\me\\x.md', line: 9 });
  });

  it('is null for a WSL path with an unknown distro, and for POSIX paths in a native Windows pane', () => {
    expect(resolveTerminalFileLink({ hostPlatform: 'win32', shellKind: 'wsl', raw: '/tmp/x.md' })).toBeNull();
    expect(resolveTerminalFileLink({ ...winNative, raw: '/tmp/x.md' })).toBeNull();
  });

  it('refuses a WSL path Windows would read differently', () => {
    expect(resolveTerminalFileLink({ ...winWsl, raw: '/home/me/a\\b' })).toBeNull();
  });

  describe('file:// URLs', () => {
    it('reads a POSIX file URL and decodes it', () => {
      expect(resolveTerminalFileLink({ ...linux, raw: 'file:///tmp/a%20b.md' })).toEqual({ hostPath: '/tmp/a b.md' });
    });
    it('reads a drive file URL on Windows', () => {
      expect(resolveTerminalFileLink({ ...winNative, raw: 'file:///C:/Users/me/x.md' })).toEqual({ hostPath: 'C:\\Users\\me\\x.md' });
    });
    it('refuses a non-local host (UNC would leak NTLM credentials)', () => {
      expect(resolveTerminalFileLink({ ...winNative, raw: 'file://srv/share/x.md' })).toBeNull();
      expect(resolveTerminalFileLink({ ...winWsl, raw: 'file://srv/share/x.md' })).toBeNull();
      expect(resolveTerminalFileLink({ ...linux, raw: 'file://srv/share/x.md' })).toBeNull();
      expect(resolveTerminalFileLink({ ...winNative, raw: 'file://wsl.localhost/Ubuntu/tmp/x.md' })).toBeNull();
    });
    it('accepts an empty or localhost host', () => {
      expect(resolveTerminalFileLink({ ...winNative, raw: 'file://localhost/C:/x.md' })).toEqual({ hostPath: 'C:\\x.md' });
      expect(resolveTerminalFileLink({ ...linux, raw: 'file://LOCALHOST/tmp/x.md' })).toEqual({ hostPath: '/tmp/x.md' });
    });
    it('does not turn an empty-host //server/share path into UNC on a native Windows pane', () => {
      expect(resolveTerminalFileLink({ ...winNative, raw: 'file:////srv/share/x.md' })).toBeNull();
    });
    it('translates a file URL in a WSL pane and honours #L', () => {
      expect(resolveTerminalFileLink({ ...winWsl, raw: 'file:///tmp/x.md#L12' })).toEqual({ hostPath: '\\\\wsl$\\Ubuntu\\tmp\\x.md', line: 12 });
    });
    it('rejects a malformed URL', () => {
      expect(resolveTerminalFileLink({ ...linux, raw: 'file:///%zz' })).toBeNull();
    });
  });

  describe('relative paths', () => {
    it('joins onto a POSIX cwd', () => {
      expect(resolveTerminalFileLink({ ...linux, raw: './src/a.ts:5', cwd: '/home/me/repo' })).toEqual({ hostPath: '/home/me/repo/src/a.ts', line: 5 });
      expect(resolveTerminalFileLink({ ...linux, raw: '../b.md', cwd: '/home/me/repo' })).toEqual({ hostPath: '/home/me/b.md' });
    });
    it('is null without a cwd or when .. climbs out of the root', () => {
      expect(resolveTerminalFileLink({ ...linux, raw: 'a/b.ts' })).toBeNull();
      expect(resolveTerminalFileLink({ ...linux, raw: '../../../x', cwd: '/a' })).toBeNull();
    });
    it('joins onto a Windows drive cwd', () => {
      expect(resolveTerminalFileLink({ ...winNative, raw: 'docs\\x.md', cwd: 'C:\\proj' })).toEqual({ hostPath: 'C:\\proj\\docs\\x.md' });
    });
    it('joins onto a WSL cwd and translates', () => {
      expect(resolveTerminalFileLink({ ...winWsl, raw: './x.md', cwd: '/home/me' })).toEqual({ hostPath: '\\\\wsl$\\Ubuntu\\home\\me\\x.md' });
    });
    it('ignores a Windows cwd for a WSL pane', () => {
      expect(resolveTerminalFileLink({ ...winWsl, raw: './x.md', cwd: 'C:\\proj' })).toBeNull();
    });
    it('does not guess for ~', () => {
      expect(resolveTerminalFileLink({ ...linux, raw: '~/x.md', cwd: '/a' })).toBeNull();
    });
  });

  it('rejects empty and control-character input', () => {
    expect(resolveTerminalFileLink({ ...linux, raw: '  ' })).toBeNull();
    expect(resolveTerminalFileLink({ ...linux, raw: '/tmp/a\0b' })).toBeNull();
  });
});

describe('normalizeHostPath', () => {
  it('makes spellings of one Windows file identical', () => {
    expect(normalizeHostPath('c:/Users/me//x.md')).toBe('C:\\Users\\me\\x.md');
    expect(normalizeHostPath('//wsl.localhost/Ubuntu/tmp/x')).toBe('\\\\wsl$\\Ubuntu\\tmp\\x');
  });
  it('leaves POSIX paths alone', () => {
    expect(normalizeHostPath('/tmp/x.md')).toBe('/tmp/x.md');
  });
});
