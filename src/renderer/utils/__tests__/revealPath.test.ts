import { describe, it, expect } from 'vitest';
import { revealablePath } from '../revealPath';

const api = (session: Record<string, unknown> | undefined) => ({
  list: async () => (session ? [{ id: 'p1', ...session }] : []),
}) as never;
const wsl = (distro?: string) =>
  api({ shell: 'wsl.exe', args: distro ? ['-d', distro] : [], wslTarget: distro ? { distribution: distro } : undefined });

describe('revealablePath', () => {
  it('translates a Linux cwd of a WSL pane to its \\\\wsl$ share', async () => {
    expect(await revealablePath('/home/me/repo', 'p1', wsl('Ubuntu'))).toEqual({ path: '\\\\wsl$\\Ubuntu\\home\\me\\repo' });
  });
  it('maps /mnt/c to the drive', async () => {
    expect(await revealablePath('/mnt/c/x', 'p1', wsl('Ubuntu'))).toEqual({ path: 'C:\\x' });
  });
  it('errors on an untranslatable name', async () => {
    expect(await revealablePath('/home/a:b', 'p1', wsl('Ubuntu'))).toHaveProperty('error');
  });
  it('errors for a WSL pane with no distro', async () => {
    expect(await revealablePath('/home/me', 'p1', wsl())).toHaveProperty('error');
  });
  it('leaves Windows paths and shares unchanged', async () => {
    expect(await revealablePath('C:\\x', 'p1', wsl('Ubuntu'))).toEqual({ path: 'C:\\x' });
    expect(await revealablePath('//wsl.localhost/Ubuntu/home/me', 'p1', wsl('Ubuntu'))).toEqual({ path: '//wsl.localhost/Ubuntu/home/me' });
  });
  it('leaves a non-WSL pane, a missing pane and no ptyId unchanged', async () => {
    expect(await revealablePath('/home/x', 'p1', api({ shell: 'bash' }))).toEqual({ path: '/home/x' });
    expect(await revealablePath('/home/x', 'p1', api(undefined))).toEqual({ path: '/home/x' });
    expect(await revealablePath('/home/x', undefined, wsl('Ubuntu'))).toEqual({ path: '/home/x' });
  });
});
