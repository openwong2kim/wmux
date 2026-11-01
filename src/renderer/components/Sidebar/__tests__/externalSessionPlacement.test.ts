// External sessions, placement B (2026-11-01): which workspace's roster a
// session joins, the "Outside wmux" rest, and when there is an attach command.
import { describe, expect, it } from 'vitest';
import {
  externalAttachCommand,
  externalWhereShort,
  matchExternalWorkspace,
  placeExternalSessions,
  workspaceFolder,
} from '../externalSessionPlacement';
import type { ExternalSession } from '../../../../shared/externalSessions';
import type { Workspace } from '../../../../shared/types';
import { selectExternalPlacement } from '../../../stores/selectors/externalSessions';
import { formatShadowWorkspaceId } from '../../../../shared/pcRail';

function session(id: string, cwd: string, patch: Partial<ExternalSession> = {}): ExternalSession {
  return {
    id,
    agent: 'claude',
    agentSessionId: id,
    cwd,
    where: { kind: 'unknown' },
    state: 'idle',
    lastSignalAt: 1_000,
    startedAt: 0,
    ...patch,
  };
}

describe('matchExternalWorkspace', () => {
  const workspaces = [
    { id: 'api', folder: '/code/api-server' },
    { id: 'wmux', folder: '/code/wmux' },
    { id: 'pkg', folder: '/code/wmux/packages/web' },
    { id: 'none' },
  ];

  it('matches the workspace folder itself', () => {
    expect(matchExternalWorkspace('/code/api-server', workspaces)).toBe('api');
  });

  it('matches a folder nested under the workspace folder', () => {
    expect(matchExternalWorkspace('/code/api-server/tests/auth', workspaces)).toBe('api');
  });

  it('never matches a workspace whose folder is under the session folder', () => {
    expect(matchExternalWorkspace('/code', workspaces)).toBeUndefined();
  });

  it('does not match a sibling that only shares a name prefix', () => {
    expect(matchExternalWorkspace('/code/api-server-v2', workspaces)).toBeUndefined();
  });

  it('takes the deepest workspace folder when several hold the session', () => {
    expect(matchExternalWorkspace('/code/wmux/packages/web/src', workspaces)).toBe('pkg');
    expect(matchExternalWorkspace('/code/wmux/src', workspaces)).toBe('wmux');
  });

  it('takes the first workspace in list order on a tie', () => {
    const twins = [{ id: 'a', folder: '/code/wmux/' }, { id: 'b', folder: '/code/wmux' }];
    expect(matchExternalWorkspace('/code/wmux/src', twins)).toBe('a');
  });

  it('compares Windows paths by separator-insensitive, drive-insensitive rules', () => {
    expect(matchExternalWorkspace('c:\\Code\\api\\src', [{ id: 'w', folder: 'C:/Code/api' }])).toBe('w');
  });

  it('has no match for an empty cwd', () => {
    expect(matchExternalWorkspace('', workspaces)).toBeUndefined();
  });
});

describe('workspaceFolder', () => {
  it('prefers the folder the workspace was opened on over its live cwd', () => {
    expect(workspaceFolder({ profile: { startupCwd: '/code/wmux' }, metadata: { cwd: '/code/wmux/src' } })).toBe('/code/wmux');
  });

  it('falls back to the live cwd', () => {
    expect(workspaceFolder({ metadata: { cwd: '/code/wmux' } })).toBe('/code/wmux');
    expect(workspaceFolder({})).toBeUndefined();
  });
});

describe('placeExternalSessions', () => {
  it('groups sessions by workspace and leaves the unmatched outside, most urgent first', () => {
    const placed = placeExternalSessions(
      [
        session('idle-api', '/code/api', { state: 'idle', lastSignalAt: 5 }),
        session('needs-api', '/code/api/src', { state: 'needs-you', lastSignalAt: 1 }),
        session('billing', '/code/billing', { state: 'running', lastSignalAt: 3 }),
        session('crash', '/tmp/crash', { state: 'ended', lastSignalAt: 9 }),
        session('billing-new', '/code/billing', { state: 'running', lastSignalAt: 7 }),
      ],
      [{ id: 'api', folder: '/code/api' }, { id: 'web', folder: '/code/web' }],
    );
    expect(placed.byWorkspace.api.map((s) => s.id)).toEqual(['needs-api', 'idle-api']);
    expect(placed.byWorkspace.web).toBeUndefined();
    expect(placed.outside.map((s) => s.id)).toEqual(['billing-new', 'billing', 'crash']);
  });
});

describe('externalWhereShort terminal names', () => {
  it('shows a terminal app by its own name, and an unknown one as sent', () => {
    expect(externalWhereShort({ kind: 'terminal', label: 'Apple_Terminal' })).toBe('Terminal');
    expect(externalWhereShort({ kind: 'terminal', label: 'iTerm.app' })).toBe('iTerm2');
    expect(externalWhereShort({ kind: 'terminal', label: 'kitty' })).toBe('kitty');
  });
});

describe('externalAttachCommand', () => {
  it('attaches to a known tmux session', () => {
    expect(externalAttachCommand({ kind: 'tmux', session: 'api', window: '2' })).toBe('tmux attach -t api');
  });

  it('reattaches to a known screen session', () => {
    expect(externalAttachCommand({ kind: 'screen', session: '4021.build' })).toBe('screen -r 4021.build');
  });

  it('quotes a session name the shell would split', () => {
    expect(externalAttachCommand({ kind: 'tmux', session: "my work's" })).toBe(`tmux attach -t 'my work'\\''s'`);
  });

  it('goes through wsl.exe for a session inside a WSL distro', () => {
    expect(externalAttachCommand({ kind: 'tmux', session: 'api', wslDistro: 'Ubuntu-24.04' }))
      .toBe('wsl.exe -d Ubuntu-24.04 --exec tmux attach -t api');
    expect(externalAttachCommand({ kind: 'tmux', session: 'my work', wslDistro: 'Ubuntu' }))
      .toBe('wsl.exe -d Ubuntu --exec tmux attach -t "my work"');
    expect(externalAttachCommand({ kind: 'screen', session: 'build', wslDistro: 'Dev Box' }))
      .toBe('wsl.exe -d "Dev Box" --exec screen -r build');
  });

  it('offers no WSL command the Windows shell would expand or a bad distro name', () => {
    expect(externalAttachCommand({ kind: 'tmux', session: '$HOME', wslDistro: 'Ubuntu' })).toBeUndefined();
    expect(externalAttachCommand({ kind: 'tmux', session: 'a%PATH%', wslDistro: 'Ubuntu' })).toBeUndefined();
    expect(externalAttachCommand({ kind: 'tmux', session: 'api', wslDistro: 'Ubuntu & calc' })).toBeUndefined();
  });

  it('has none without a session name', () => {
    expect(externalAttachCommand({ kind: 'tmux' })).toBeUndefined();
    expect(externalAttachCommand({ kind: 'screen', session: '  ' })).toBeUndefined();
  });

  it('has none for zellij, ssh, a terminal app or an unknown place', () => {
    expect(externalAttachCommand({ kind: 'zellij', session: 'dev' })).toBeUndefined();
    expect(externalAttachCommand({ kind: 'ssh', label: '10.0.0.4' })).toBeUndefined();
    expect(externalAttachCommand({ kind: 'terminal', label: 'Terminal.app' })).toBeUndefined();
    expect(externalAttachCommand({ kind: 'unknown' })).toBeUndefined();
  });
});

describe('externalWhereShort', () => {
  it('names the multiplexer session and window', () => {
    expect(externalWhereShort({ kind: 'tmux', session: 'api', window: '2' })).toBe('tmux api:2');
    expect(externalWhereShort({ kind: 'screen', session: 'build' })).toBe('screen build');
  });

  it('names the terminal app, the ssh client or the WSL distro', () => {
    expect(externalWhereShort({ kind: 'terminal', label: 'Terminal.app' })).toBe('Terminal.app');
    expect(externalWhereShort({ kind: 'ssh', label: '10.0.0.4' })).toBe('ssh 10.0.0.4');
    expect(externalWhereShort({ kind: 'unknown', wslDistro: 'Ubuntu' })).toBe('WSL Ubuntu');
    expect(externalWhereShort({ kind: 'unknown' })).toBeUndefined();
  });
});

describe('selectExternalPlacement', () => {
  const ws = (id: string, startupCwd?: string, cwd?: string) =>
    ({ id, ...(startupCwd ? { profile: { startupCwd } } : {}), ...(cwd ? { metadata: { cwd } } : {}) }) as unknown as Workspace;
  const state = (patch: Record<string, unknown>) => ({
    externalSessions: [session('s', '/code/api/src', { state: 'needs-you' })],
    workspaces: [ws('api', '/code/api')],
    fanoutOrigin: {},
    readOnly: false,
    ...patch,
  }) as unknown as Parameters<typeof selectExternalPlacement>[0];

  it('places by the workspace folder', () => {
    expect(selectExternalPlacement(state({})).byWorkspace.api?.map((s) => s.id)).toEqual(['s']);
  });

  it('never matches another computer’s shadow workspace', () => {
    const shadow = formatShadowWorkspaceId('host-1', 'api') ?? '';
    expect(shadow).not.toBe('');
    const placed = selectExternalPlacement(state({ workspaces: [ws(shadow, '/code/api')] }));
    expect(placed.byWorkspace[shadow]).toBeUndefined();
    expect(placed.outside.map((s) => s.id)).toEqual(['s']);
  });

  it('places nothing in a read-only view (another computer’s list, the web mirror)', () => {
    const placed = selectExternalPlacement(state({ readOnly: true }));
    expect(placed.byWorkspace).toEqual({});
    expect(placed.outside).toEqual([]);
  });
});
