import { describe, expect, it } from 'vitest';
import { resolveSpawnEnv } from '../resolveSpawnEnv';

describe('resolveSpawnEnv', () => {
  it('strips inherited secrets from the baseline', () => {
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'sk-x', WMUX_AUTH_TOKEN: 't' },
      undefined,
      {},
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.WMUX_AUTH_TOKEN).toBeUndefined();
  });

  it('applies any profile key verbatim (spawn mechanism — policy is one layer up)', () => {
    // resolveSpawnEnv applies whatever the profile contains; it does NOT re-run
    // the denylist on profile keys. WHICH keys a profile may contain is decided
    // by the editor policy (workspaceProfile: secret-named keys dropped on
    // save), tested separately. Here we only assert the mechanism: a key that
    // reaches this layer survives even if its name matches the baseline denylist.
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin' },
      { GEMINI_API_KEY: 'x', CLAUDE_CONFIG_DIR: 'C:/a' },
      {},
    );
    expect(env.GEMINI_API_KEY).toBe('x');
    expect(env.CLAUDE_CONFIG_DIR).toBe('C:/a');
  });

  it('forces identity last so a profile cannot spoof it', () => {
    const env = resolveSpawnEnv(
      { PATH: '/usr/bin' },
      { WMUX_WORKSPACE_ID: 'spoof', WMUX_SOCKET_PATH: 'spoof' },
      { WMUX_WORKSPACE_ID: 'real-ws', WMUX_SURFACE_ID: 'real-surface' },
    );
    expect(env.WMUX_WORKSPACE_ID).toBe('real-ws');
    expect(env.WMUX_SURFACE_ID).toBe('real-surface');
    // applyProfileEnv already skips reserved keys, so the spoof never even
    // reaches the identity step — but identity-last is the belt to that braces.
    expect(env.WMUX_SOCKET_PATH).toBeUndefined();
  });

  it('lets identity carry a socket path (local-mode shape) without profile spoofing', () => {
    const env = resolveSpawnEnv({}, undefined, {
      WMUX_SOCKET_PATH: '\\\\.\\pipe\\wmux',
      WMUX_WORKSPACE_ID: 'ws-1',
    });
    expect(env.WMUX_SOCKET_PATH).toBe('\\\\.\\pipe\\wmux');
    expect(env.WMUX_WORKSPACE_ID).toBe('ws-1');
  });

  it('drops STALE inherited WMUX_* identity the caller does not force (nested-wmux launch)', () => {
    // Simulates `npm start` from inside a wmux pane: the child main process
    // inherits the parent pane's identity in its own env. The new child must
    // NOT carry that stale identity forward — only what we force survives.
    const env = resolveSpawnEnv(
      {
        PATH: '/usr/bin',
        WMUX_WORKSPACE_ID: 'parent-ws',
        WMUX_SURFACE_ID: 'parent-surface',
        WMUX_SOCKET_PATH: '\\\\.\\pipe\\parent',
      },
      undefined,
      // Daemon-mode shape: only workspace id is forced (no socket path, no surface id).
      { WMUX_WORKSPACE_ID: 'child-ws' },
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.WMUX_WORKSPACE_ID).toBe('child-ws');     // forced wins
    expect(env.WMUX_SURFACE_ID).toBeUndefined();        // stale parent value dropped
    expect(env.WMUX_SOCKET_PATH).toBeUndefined();       // stale parent socket dropped
  });

  it('strips the reserved namespace case-insensitively', () => {
    const env = resolveSpawnEnv({ wmux_socket_path: 'stale', PATH: '/p' }, undefined, {});
    expect(env.wmux_socket_path).toBeUndefined();
    expect(env.PATH).toBe('/p');
  });
});
