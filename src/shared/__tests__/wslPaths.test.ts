import { describe, expect, it } from 'vitest';
import { wslShareToLinux } from '../wslPaths';

describe('wslShareToLinux', () => {
  it('maps a wsl.localhost share to distro + Linux path', () => {
    expect(wslShareToLinux('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')).toEqual({ distro: 'Ubuntu', linuxPath: '/home/me/repo' });
  });
  it('accepts wsl$ and drops a trailing separator', () => {
    expect(wslShareToLinux('\\\\wsl$\\Ubuntu\\home\\me\\')).toEqual({ distro: 'Ubuntu', linuxPath: '/home/me' });
  });
  it('maps the share root to /, case-insensitive host', () => {
    expect(wslShareToLinux('\\\\WSL.LOCALHOST\\Ubuntu')).toEqual({ distro: 'Ubuntu', linuxPath: '/' });
  });
  it('accepts forward-slash spelling', () => {
    expect(wslShareToLinux('//wsl.localhost/Ubuntu/x')).toEqual({ distro: 'Ubuntu', linuxPath: '/x' });
  });
  it('collapses . and .. segments and repeated slashes, never above /', () => {
    expect(wslShareToLinux('\\\\wsl$\\Ubuntu\\home\\..\\..\\etc')?.linuxPath).toBe('/etc');
    expect(wslShareToLinux('\\\\wsl$\\Ubuntu\\..\\..\\..')?.linuxPath).toBe('/');
    expect(wslShareToLinux('\\\\wsl$\\Ubuntu\\a\\.\\\\b')?.linuxPath).toBe('/a/b');
  });
  it('returns null for anything that is not a WSL share', () => {
    expect(wslShareToLinux('\\\\server\\share\\x')).toBeNull();
    expect(wslShareToLinux('C:\\x')).toBeNull();
    expect(wslShareToLinux('/home/me')).toBeNull();
    expect(wslShareToLinux('\\\\wsl$\\..\\x')).toBeNull();
    expect(wslShareToLinux('\\\\wsl$\\.\\x')).toBeNull();
  });
});
