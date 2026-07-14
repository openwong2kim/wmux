import { describe, it, expect } from 'vitest';
// The plugin is plain .js (OpenCode loads it directly); it exports the pure
// envelope builder alongside the plugin so this test can validate the shape
// without a live opencode process.
import { buildOpencodeStopEnvelope } from '../plugins/wmux.js';
import { isAgentSignal } from '../../shared/signal-types';

describe('buildOpencodeStopEnvelope', () => {
  const baseEnv = {
    WMUX_PTY_ID: 'pty-123',
    WMUX_WORKSPACE_ID: 'ws-abc',
    WMUX_SURFACE_ID: 'surf-9',
  } as NodeJS.ProcessEnv;

  it('builds a canonical agent.stop / opencode envelope from the pane env', () => {
    const env = buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/proj', now: 42 });
    expect(env).toMatchObject({
      kind: 'agent.stop',
      agent: 'opencode',
      ptyId: 'pty-123',
      workspaceId: 'ws-abc',
      surfaceId: 'surf-9',
      cwd: '/proj',
      payload: {},
      ts: 42,
    });
  });

  it('produces an envelope the wmux daemon accepts (isAgentSignal)', () => {
    const env = buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/proj', sessionId: 's1', now: 1 });
    expect(isAgentSignal(env)).toBe(true);
  });

  it('carries agentSessionId only when a session id is given', () => {
    expect(buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/p', now: 1 }).agentSessionId).toBeUndefined();
    expect(
      buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/p', sessionId: 'sess-7', now: 1 }).agentSessionId,
    ).toBe('sess-7');
  });

  it('omits routing fields absent from the env (never sends empty strings)', () => {
    const env = buildOpencodeStopEnvelope({ env: {} as NodeJS.ProcessEnv, cwd: '/p', now: 1 });
    expect(env.ptyId).toBeUndefined();
    expect(env.workspaceId).toBeUndefined();
    expect(env.surfaceId).toBeUndefined();
    // Still a valid envelope — cwd + ts + payload carry it (cwd-fallback routing).
    expect(isAgentSignal(env)).toBe(true);
  });

  it('falls back to process.cwd() when no cwd is supplied', () => {
    const env = buildOpencodeStopEnvelope({ env: baseEnv, now: 1 });
    expect(env.cwd).toBe(process.cwd());
    expect(env.cwd.length).toBeGreaterThan(0);
  });
});
