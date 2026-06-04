import { describe, expect, it } from 'vitest';
import { withDefaultShell, withWorkspaceProfile } from '../ptyCreateOptions';

describe('withDefaultShell', () => {
  it('uses the stored detected shell path when no shell is specified', () => {
    expect(withDefaultShell({ workspaceId: 'ws-1' }, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toEqual({
      workspaceId: 'ws-1',
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    });
  });

  it('keeps an explicitly requested shell', () => {
    expect(withDefaultShell({ shell: 'cmd.exe' }, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toEqual({
      shell: 'cmd.exe',
    });
  });

  it('does not pass legacy setting aliases as executable shell values', () => {
    expect(withDefaultShell({ workspaceId: 'ws-1' }, 'powershell')).toEqual({
      workspaceId: 'ws-1',
    });
  });
});

describe('withWorkspaceProfile', () => {
  it('returns the original options unchanged when there is no profile', () => {
    const opts = { workspaceId: 'ws-1' };
    expect(withWorkspaceProfile(opts, undefined)).toBe(opts);
  });

  it('overlays profile env and startup command', () => {
    expect(
      withWorkspaceProfile(
        { workspaceId: 'ws-1' },
        { env: { CLAUDE_CONFIG_DIR: 'C:/a' }, defaultPaneCommand: 'claude' },
      ),
    ).toEqual({
      workspaceId: 'ws-1',
      env: { CLAUDE_CONFIG_DIR: 'C:/a' },
      initialCommand: 'claude',
    });
  });

  it('lets a caller-supplied pane env override the workspace env', () => {
    const result = withWorkspaceProfile(
      { workspaceId: 'ws-1', env: { FOO: 'pane' } },
      { env: { FOO: 'workspace', BAR: 'workspace' } },
    );
    expect(result.env).toEqual({ FOO: 'pane', BAR: 'workspace' });
  });

  it('does not overwrite an explicit initialCommand', () => {
    const result = withWorkspaceProfile(
      { workspaceId: 'ws-1', initialCommand: 'explicit' },
      { defaultPaneCommand: 'profile' },
    );
    expect(result.initialCommand).toBe('explicit');
  });

  it('leaves env/initialCommand absent for an empty profile', () => {
    expect(withWorkspaceProfile({ workspaceId: 'ws-1' }, {})).toEqual({ workspaceId: 'ws-1' });
  });
});
