import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { DaemonSessionManager } from '../DaemonSessionManager';

// Runtime-marked: createSession spawns a real PTY, so this rides the serialized
// runtime suite (vitest.runtime.config.ts) alongside the other ConPTY tests.
const SHELL = process.platform === 'win32' ? 'powershell.exe' : 'bash';

describe('DaemonSessionManager — workspace profile env (runtime)', () => {
  const mgr = new DaemonSessionManager();

  afterEach(() => {
    mgr.disposeAll();
  });

  it('applies profileEnv after the safe-env filter and persists it in meta.env', () => {
    const session = mgr.createSession({
      id: 'profile-runtime-1',
      cmd: SHELL,
      cwd: os.homedir(),
      // Identity baked into the inherited env (as the main process does).
      env: { WMUX_WORKSPACE_ID: 'ws-real', PATH: process.env.PATH ?? '' },
      profileEnv: {
        CLAUDE_CONFIG_DIR: 'C:/accounts/a',
        // A *_KEY would be stripped by buildSafeChildEnv if it were inherited;
        // as an intentional overlay it MUST survive (applied post-filter).
        GEMINI_API_KEY: 'intentional',
        // Reserved → must be ignored so identity stays authoritative.
        WMUX_WORKSPACE_ID: 'spoof',
      },
    });

    expect(session.env.CLAUDE_CONFIG_DIR).toBe('C:/accounts/a');
    expect(session.env.GEMINI_API_KEY).toBe('intentional');
    expect(session.env.WMUX_WORKSPACE_ID).toBe('ws-real');
  });

  it('leaves the environment untouched when no profileEnv is supplied', () => {
    const session = mgr.createSession({
      id: 'profile-runtime-2',
      cmd: SHELL,
      cwd: os.homedir(),
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(session.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});
