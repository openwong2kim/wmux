import { describe, it, expect } from 'vitest';
import { buildWebPaneEnv, stripWmuxNamespace } from '../webPaneEnv';
import { ENV_KEYS } from '../../../shared/constants';

describe('stripWmuxNamespace', () => {
  it('drops the whole reserved namespace and keeps everything else', () => {
    expect(
      stripWmuxNamespace({
        PATH: '/usr/bin',
        WMUX_WORKSPACE_ID: 'ws-inherited',
        WMUX_SOCKET_PATH: '/tmp/wmux.sock',
        HOME: '/home/me',
      }),
    ).toEqual({ PATH: '/usr/bin', HOME: '/home/me' });
  });
});

describe('buildWebPaneEnv', () => {
  const parentEnv = { PATH: '/usr/bin', HOME: '/home/me' } as NodeJS.ProcessEnv;

  it('★ stamps the member id on a pane created WITHOUT a workspace', () => {
    // The regression: this path used to leave env undefined entirely, so
    // `wmux channel join` inside a phone-created pane failed with "no member
    // id" and the other channel commands fell back to the shared literal
    // `agent` — every phone pane colliding on one member.
    const env = buildWebPaneEnv({ id: 'web-abc', parentEnv });
    expect(env[ENV_KEYS.MEMBER_ID]).toBe('web-abc');
    expect(env[ENV_KEYS.WORKSPACE_ID]).toBeUndefined();
    expect(env[ENV_KEYS.WORKSPACE_NAME]).toBeUndefined();
  });

  it('stamps the member id AND the workspace when one is named', () => {
    const env = buildWebPaneEnv({
      id: 'web-def',
      parentEnv,
      workspaceId: 'ws-1',
      workspaceName: 'Workspace 1',
    });
    expect(env[ENV_KEYS.MEMBER_ID]).toBe('web-def');
    expect(env[ENV_KEYS.WORKSPACE_ID]).toBe('ws-1');
    expect(env[ENV_KEYS.WORKSPACE_NAME]).toBe('Workspace 1');
  });

  it('omits the workspace NAME when no live sibling supplied one', () => {
    const env = buildWebPaneEnv({ id: 'web-ghi', parentEnv, workspaceId: 'ws-1' });
    expect(env[ENV_KEYS.WORKSPACE_ID]).toBe('ws-1');
    expect(env[ENV_KEYS.WORKSPACE_NAME]).toBeUndefined();
  });

  it("★ never inherits the daemon's OWN workspace identity", () => {
    // A daemon launched from inside a wmux pane carries that pane's
    // WMUX_WORKSPACE_ID. A phone pane must not silently join it.
    const env = buildWebPaneEnv({
      id: 'web-jkl',
      parentEnv: { ...parentEnv, WMUX_WORKSPACE_ID: 'ws-inherited' } as NodeJS.ProcessEnv,
    });
    expect(env[ENV_KEYS.WORKSPACE_ID]).toBeUndefined();
    expect(env[ENV_KEYS.MEMBER_ID]).toBe('web-jkl');
  });
});
