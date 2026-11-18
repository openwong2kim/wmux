import { describe, it, expect, vi } from 'vitest';
import { revealablePath, revealInHost } from '../revealPath';

const api = (session: Record<string, unknown> | undefined) => ({
  list: async () => (session ? [{ id: 'p1', ...session }] : []),
}) as never;
const wsl = (distro?: string) =>
  api({ shell: 'wsl.exe', args: distro ? ['-d', distro] : [], wslTarget: distro ? { distribution: distro } : undefined });

describe('revealablePath', () => {
  it('off Windows, a Linux path is the host\'s own: no session lookup', async () => {
    const list = vi.fn(async () => []);
    expect(await revealablePath('/home/me/repo', 'p1', { list } as never, 'darwin')).toEqual({ path: '/home/me/repo' });
    expect(list).not.toHaveBeenCalled();
  });

  it('translates a Linux cwd of a WSL pane to its \\\\wsl$ share', async () => {
    expect(await revealablePath('/home/me/repo', 'p1', wsl('Ubuntu'))).toEqual({ path: '\\\\wsl$\\Ubuntu\\home\\me\\repo' });
  });
  it('maps /mnt/c to the drive', async () => {
    expect(await revealablePath('/mnt/c/x', 'p1', wsl('Ubuntu'))).toEqual({ path: 'C:\\x' });
  });
  it('errors on an untranslatable name', async () => {
    expect(await revealablePath('/home/a:b', 'p1', wsl('Ubuntu'))).toHaveProperty('error');
  });
  it('errors for a distro-local path of a WSL pane with no distro', async () => {
    expect(await revealablePath('/home/me', 'p1', wsl())).toHaveProperty('error');
  });
  it('still maps /mnt/c for a WSL pane with no distro', async () => {
    expect(await revealablePath('/mnt/c/x', 'p1', wsl())).toEqual({ path: 'C:\\x' });
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

describe('revealInHost', () => {
  it('reports a resolved {ok:false} openPath result', async () => {
    const onError = vi.fn();
    await revealInHost('C:\\x', undefined, wsl(), async () => ({ ok: false, error: 'NOT_FOUND' }), onError);
    expect(onError).toHaveBeenCalledWith('NOT_FOUND');
  });
  it('stays quiet on {ok:true}', async () => {
    const onError = vi.fn();
    await revealInHost('C:\\x', undefined, wsl(), async () => ({ ok: true }), onError);
    expect(onError).not.toHaveBeenCalled();
  });
  it('reports the error text and does not open when the path cannot be translated', async () => {
    const open = vi.fn();
    const onError = vi.fn();
    await revealInHost('/home/a:b', 'p1', wsl('Ubuntu'), open, onError);
    expect(open).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('/home/a:b'));
  });
  it('opens the translated path', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true });
    await revealInHost('/home/me', 'p1', wsl('Ubuntu'), open, vi.fn());
    expect(open).toHaveBeenCalledWith('\\\\wsl$\\Ubuntu\\home\\me');
  });
  it('reports a rejected open', async () => {
    const onError = vi.fn();
    await revealInHost('C:\\x', 'p1', wsl('Ubuntu'), () => Promise.reject(new Error('boom')), onError);
    expect(onError).toHaveBeenCalledWith('boom');
  });
});
