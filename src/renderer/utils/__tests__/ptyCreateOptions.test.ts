import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRespawnCwd, resolveStartupCwd, withDefaultShell, withWorkspaceProfile, withRoleBinding } from '../ptyCreateOptions';

describe('withRoleBinding (D2)', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  beforeEach(() => logSpy.mockClear());

  it('enforces the bound model on a bound pane\'s initialCommand', () => {
    const out = withRoleBinding(
      { workspaceId: 'ws', initialCommand: 'claude' },
      { agent: 'claude', model: 'haiku' },
    );
    expect(out.initialCommand).toBe('claude --model haiku');
  });

  it('is a no-op when there is no binding', () => {
    const options = { workspaceId: 'ws', initialCommand: 'claude' };
    expect(withRoleBinding(options, undefined)).toBe(options);
  });

  // P2-C — a wmux.json leaf can declare a role next to `restart`, which makes
  // the funnel pick the exec branch. Skipping exec would have made that exact
  // combination a silent no-op.
  it("enforces the bound model on a supervised leaf's exec unit", () => {
    const out = withRoleBinding(
      { workspaceId: 'ws', exec: 'claude /loop' },
      { agent: 'claude', model: 'haiku' },
    );
    expect(out.exec).toBe('claude --model haiku /loop');
  });

  it('leaves a non-agent exec unit untouched', () => {
    const options = { workspaceId: 'ws', exec: 'npm run dev' };
    expect(withRoleBinding(options, { agent: 'claude', model: 'haiku' })).toBe(options);
  });

  it('is a no-op when there is no command of either shape', () => {
    const options = { workspaceId: 'ws' };
    expect(withRoleBinding(options, { agent: 'claude', model: 'haiku' })).toBe(options);
  });

  it('does not override an explicit --model already in the seed command', () => {
    const options = { workspaceId: 'ws', initialCommand: 'claude --model opus' };
    expect(withRoleBinding(options, { agent: 'claude', model: 'haiku' })).toBe(options);
  });

  // P1-1 — a seeded project command is usually NOT an agent launch.
  it('leaves a non-agent seed command untouched even with args bound', () => {
    const options = { workspaceId: 'ws', initialCommand: 'npm run dev' };
    expect(withRoleBinding(options, { args: '--dangerously-skip-permissions' })).toBe(options);
  });

  // P2-7 — this path alters what runs with no response to carry a note.
  it('logs an audit line with the role and before/after when it rewrites', () => {
    withRoleBinding(
      { workspaceId: 'ws', initialCommand: 'claude' },
      { agent: 'claude', model: 'haiku' },
      'Builder',
    );
    expect(logSpy).toHaveBeenCalledWith(
      '[wmux:role-binding] seed command rewritten',
      expect.objectContaining({
        role: 'Builder',
        field: 'initialCommand',
        before: 'claude',
        after: 'claude --model haiku',
      }),
    );
  });

  it('names the exec field in the audit line so the two paths are distinguishable', () => {
    withRoleBinding({ workspaceId: 'ws', exec: 'claude' }, { agent: 'claude', model: 'haiku' }, 'Tester');
    expect(logSpy).toHaveBeenCalledWith(
      '[wmux:role-binding] seed command rewritten',
      expect.objectContaining({ role: 'Tester', field: 'exec' }),
    );
  });

  it('logs nothing when the seed command is unchanged', () => {
    withRoleBinding({ workspaceId: 'ws', initialCommand: 'npm run dev' }, { args: '--foo' }, 'Builder');
    expect(logSpy).not.toHaveBeenCalled();
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
