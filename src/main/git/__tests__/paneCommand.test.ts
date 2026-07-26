import { describe, expect, it } from 'vitest';
import { preparePaneCommand } from '../paneCommand';
import { prepareGitCommand } from '../git';

describe('preparePaneCommand', () => {
  it('preserves structured argv when routing a WSL command', () => {
    expect(preparePaneCommand(
      {
        sessionId: 'pty-1',
        location: { domain: 'wsl', cwd: '/home/me/repo with spaces', shell: 'wsl.exe', distro: 'Ubuntu' },
        activeContext: { sessionId: 'pty-1', active: true, distro: 'Ubuntu' },
      },
      'git',
      ['status', '--', 'a file.txt', '$(not-shell)'],
    )).toEqual({
      ok: true,
      file: 'wsl.exe',
      args: [
        '-d', 'Ubuntu',
        '--cd', '/home/me/repo with spaces',
        '--exec', 'git',
        'status', '--', 'a file.txt', '$(not-shell)',
      ],
    });
  });

  it('routes the shared git helper through the same structured preparation', () => {
    expect(prepareGitCommand(
      ['diff', '--', 'a file.txt'],
      {
        sessionId: 'pty-1',
        location: { domain: 'wsl', cwd: '/repo', shell: 'wsl.exe', distro: 'Ubuntu' },
        activeContext: { sessionId: 'pty-1', active: true, distro: 'Ubuntu' },
      },
    )).toMatchObject({
      ok: true,
      file: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', '/repo', '--exec', 'git', 'diff', '--', 'a file.txt'],
    });
  });

  it('rejects missing or stale active WSL session context', () => {
    const location = { domain: 'wsl' as const, cwd: '/repo', shell: 'wsl.exe', distro: 'Ubuntu' };
    expect(preparePaneCommand({ sessionId: 'pty-1', location }, 'git', ['status'])).toEqual({
      ok: false,
      error: 'ACTIVE_CONTEXT_REQUIRED',
    });
    expect(preparePaneCommand(
      {
        sessionId: 'pty-1',
        location,
        activeContext: { sessionId: 'pty-old', active: true, distro: 'Ubuntu' },
      },
      'git',
      ['status'],
    )).toEqual({ ok: false, error: 'ACTIVE_CONTEXT_REQUIRED' });
  });
});
