// @wmux-lane unit — 'win32' is only a platform string passed to a pure function; nothing reaches the OS.
import { describe, expect, it } from 'vitest';
import { applyWslShareCwd } from '../wslShareSpawn';

const share = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

describe('applyWslShareCwd', () => {
  it('converts a share cwd to a Linux cwd, the distro and the WSL shell', () => {
    const r = applyWslShareCwd({ cwd: share }, 'win32', ['Ubuntu', 'Debian']);
    expect(r).toEqual({ options: { cwd: '/home/me/repo', wslDistro: 'Ubuntu', shell: expect.stringMatching(/wsl\.exe$/i) } });
  });
  it('trusts the distro as written when enumeration answered nothing', () => {
    const r = applyWslShareCwd({ cwd: share }, 'win32', []);
    expect(r).toMatchObject({ options: { cwd: '/home/me/repo', wslDistro: 'Ubuntu' } });
  });
  it('maps the share root to /', () => {
    expect(applyWslShareCwd({ cwd: '\\\\wsl$\\Ubuntu' }, 'win32', [])).toMatchObject({ options: { cwd: '/' } });
  });
  it('keeps the installed spelling of the distro', () => {
    expect(applyWslShareCwd({ cwd: '\\\\wsl$\\ubuntu\\x' }, 'win32', ['Ubuntu'])).toMatchObject({ options: { wslDistro: 'Ubuntu' } });
  });
  it('errors, naming the distro, when it is not installed', () => {
    const r = applyWslShareCwd({ cwd: share }, 'win32', ['Debian']);
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('Ubuntu');
  });
  it('keeps a caller-set WSL shell and replaces a non-WSL one', () => {
    expect(applyWslShareCwd({ cwd: share, shell: 'C:\\x\\wsl.exe' }, 'win32', [])).toMatchObject({ options: { shell: 'C:\\x\\wsl.exe' } });
    const r = applyWslShareCwd({ cwd: share, shell: 'pwsh.exe' }, 'win32', []) as { options: { shell: string } };
    expect(r.options.shell).toMatch(/wsl\.exe$/i);
  });
  it('returns the same options off Windows or for any other cwd', () => {
    const a = { cwd: share };
    expect(applyWslShareCwd(a, 'linux', [])).toEqual({ options: a });
    expect((applyWslShareCwd(a, 'linux', []) as { options: unknown }).options).toBe(a);
    const b = { cwd: 'C:\\repo' };
    expect((applyWslShareCwd(b, 'win32', ['Ubuntu']) as { options: unknown }).options).toBe(b);
    const c = {};
    expect((applyWslShareCwd(c, 'win32', []) as { options: unknown }).options).toBe(c);
  });
});
