import { describe, expect, it, vi } from 'vitest';
import { workspaceAccountEnv } from '../workspaceAccountEnv';

describe('workspace spawn account resolution', () => {
  const inherited = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/wrong', CODEX_HOME: '/wrong-too', WMUX_WORKSPACE_ID: 'ws-1' };
  it('replaces inherited accounts and ignores unapproved desktop environment keys', async () => {
    const request = vi.fn(async () => ({ CLAUDE_CONFIG_DIR: '/right', PATH: '/bad', ANTHROPIC_API_KEY: 'secret' }));
    const next = await workspaceAccountEnv(inherited, 'ws-1', { available: true, request });
    expect(next).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/right', WMUX_WORKSPACE_ID: 'ws-1' });
    expect(inherited.CODEX_HOME).toBe('/wrong-too');
    expect(request).toHaveBeenCalledWith('accounts.env', { workspaceId: 'ws-1' });
  });
  it('clears inherited overrides for an explicitly unbound workspace', async () => {
    const next = await workspaceAccountEnv(inherited, 'ws-1', { available: true, request: async () => ({}) });
    expect(next.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(next.CODEX_HOME).toBeUndefined();
  });
  it('does not spawn using a guessed account when the desktop is unavailable', async () => {
    await expect(workspaceAccountEnv(inherited, 'ws-1', null)).rejects.toThrow('Open the desktop');
    await expect(workspaceAccountEnv(inherited, 'ws-1', { available: true, request: async () => { throw new Error('disconnected'); } })).rejects.toThrow('disconnected');
  });
  it.each([null, [], { CODEX_HOME: '' }, { CLAUDE_CONFIG_DIR: '/bad\0path' }, { CODEX_HOME: 12 }])('rejects malformed resolution %j', async result => {
    await expect(workspaceAccountEnv(inherited, 'ws-1', { available: true, request: async () => result })).rejects.toThrow('resolution failed');
  });
});
