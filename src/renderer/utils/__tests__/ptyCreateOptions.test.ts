import { describe, expect, it } from 'vitest';
import { resolveRespawnCwd, resolveStartupCwd, withDefaultShell, withWorkspaceProfile, withRoleBinding } from '../ptyCreateOptions';

describe('withRoleBinding (D2)', () => {
  it('enforces the bound model on a bound pane\'s initialCommand', () => {
    const out = withRoleBinding({ workspaceId: 'ws', initialCommand: 'claude' }, { model: 'haiku' });
    expect(out.initialCommand).toBe('claude --model haiku');
  });

  it('is a no-op when there is no binding', () => {
    const options = { workspaceId: 'ws', initialCommand: 'claude' };
    expect(withRoleBinding(options, undefined)).toBe(options);
  });

  it('is a no-op when there is no initialCommand (exec/supervised branch)', () => {
    const options = { workspaceId: 'ws', exec: 'claude' };
    expect(withRoleBinding(options, { model: 'haiku' })).toBe(options);
  });

  it('does not override an explicit --model already in the seed command', () => {
    const options = { workspaceId: 'ws', initialCommand: 'claude --model opus' };
    expect(withRoleBinding(options, { model: 'haiku' })).toBe(options);
  });
});

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

// Issues #173/#174/#175: priority chain for a new terminal's starting directory.
describe('resolveStartupCwd', () => {
  it('prefers the split seed when the toggle is on', () => {
    expect(resolveStartupCwd({
      splitSeed: 'D:\\proj',
      splitInheritsCwd: true,
      profile: { startupCwd: 'C:\\ws' },
      startupDirectory: 'C:\\global',
    })).toBe('D:\\proj');
  });

  it('ignores the split seed when the toggle is off (#174)', () => {
    expect(resolveStartupCwd({
      splitSeed: 'D:\\proj',
      splitInheritsCwd: false,
      profile: { startupCwd: 'C:\\ws' },
      startupDirectory: 'C:\\global',
    })).toBe('C:\\ws');
  });

  it('falls back profile → global → undefined', () => {
    expect(resolveStartupCwd({
      splitInheritsCwd: true,
      profile: { startupCwd: 'C:\\ws' },
      startupDirectory: 'C:\\global',
    })).toBe('C:\\ws');
    expect(resolveStartupCwd({
      splitInheritsCwd: true,
      startupDirectory: 'C:\\global',
    })).toBe('C:\\global');
    expect(resolveStartupCwd({ splitInheritsCwd: true })).toBeUndefined();
  });

  it('ignores an empty-string split seed and falls to profile.startupCwd (#515 healthy path)', () => {
    // A split from a parent whose tracked cwd is empty must not seed '' — it
    // falls through to the profile default, not home.
    expect(resolveStartupCwd({
      splitSeed: '',
      splitInheritsCwd: true,
      profile: { startupCwd: 'C:\\ws' },
      startupDirectory: 'C:\\global',
    })).toBe('C:\\ws');
  });

  it('treats an empty/whitespace global setting as unset', () => {
    expect(resolveStartupCwd({ splitInheritsCwd: true, startupDirectory: '   ' })).toBeUndefined();
    expect(resolveStartupCwd({ splitInheritsCwd: true, startupDirectory: '' })).toBeUndefined();
  });

  it('skips a profile whose startupCwd is unset', () => {
    expect(resolveStartupCwd({
      splitInheritsCwd: true,
      profile: { env: { FOO: 'bar' } },
      startupDirectory: 'C:\\global',
    })).toBe('C:\\global');
  });
});

// Issue #515: a self-create (dead-session respawn / blank-slate recovery) is a
// NEW shell, so the workspace default OUTRANKS the surface's tracked cwd — the
// inverse of resolveStartupCwd's split-seed-first semantics.
describe('resolveRespawnCwd', () => {
  it('prefers profile.startupCwd over a non-empty (contaminated) surface cwd', () => {
    // This is the core #515 heal: the surface tracks home, the profile is
    // configured — the respawn must land in the profile dir, not home.
    expect(resolveRespawnCwd({
      surfaceCwd: 'C:\\Users\\rizz',
      profile: { startupCwd: 'D:\\proj' },
      startupDirectory: 'C:\\global',
    })).toBe('D:\\proj');
  });

  it('honors a non-empty surface cwd when there is no profile.startupCwd', () => {
    expect(resolveRespawnCwd({
      surfaceCwd: 'D:\\live',
      profile: { env: { FOO: 'bar' } },
      startupDirectory: 'C:\\global',
    })).toBe('D:\\live');
  });

  it('falls back surface → global → undefined', () => {
    expect(resolveRespawnCwd({ surfaceCwd: '', startupDirectory: 'C:\\global' })).toBe('C:\\global');
    expect(resolveRespawnCwd({ startupDirectory: 'C:\\global' })).toBe('C:\\global');
    expect(resolveRespawnCwd({})).toBeUndefined();
  });

  it('treats an empty/whitespace surface cwd and global as unset', () => {
    expect(resolveRespawnCwd({ surfaceCwd: '   ', startupDirectory: '  ' })).toBeUndefined();
    expect(resolveRespawnCwd({ surfaceCwd: '' })).toBeUndefined();
  });
});
