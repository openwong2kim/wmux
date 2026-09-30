import { describe, expect, it, vi } from 'vitest';
import { workspaceAccountEnv } from '../workspaceAccountEnv';
import { PaneAccountRefusalError, paneAccountFailure } from '../paneAccount';

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
    await expect(workspaceAccountEnv(inherited, 'ws-1', null)).rejects.toThrow('desktop-unavailable');
    await expect(workspaceAccountEnv(inherited, 'ws-1', { available: true, request: async () => { throw new Error('disconnected'); } })).rejects.toThrow('disconnected');
  });
  it.each([null, [], { CODEX_HOME: '' }, { CLAUDE_CONFIG_DIR: '/bad\0path' }, { CODEX_HOME: 12 }])('rejects malformed resolution %j', async result => {
    await expect(workspaceAccountEnv(inherited, 'ws-1', { available: true, request: async () => result })).rejects.toThrow('desktop-request-failed');
  });
  it('asks a desktop that announced the account command in the typed form, and can leave one vendor out', async () => {
    const request = vi.fn(async () => ({ ok: true, env: { CLAUDE_CONFIG_DIR: '/ignored-omitted', CODEX_HOME: '/ws/codex' } }));
    const desktop = { available: true, supports: () => true, request };
    const next = await workspaceAccountEnv(inherited, 'ws-1', desktop, 'claude');
    expect(request).toHaveBeenCalledWith('accounts.env', { workspaceId: 'ws-1', typed: true, omitVendor: 'claude' });
    expect(next).toEqual({ PATH: '/bin', CODEX_HOME: '/ws/codex', WMUX_WORKSPACE_ID: 'ws-1' });
  });
  it('turns a missing bound directory into a typed refusal, and never leaves a vendor out on an old desktop', async () => {
    const missing = { available: true, supports: () => true, request: async () => ({ ok: false, error: 'workspace-account-missing' }) };
    const error = await workspaceAccountEnv(inherited, 'ws-1', missing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaneAccountRefusalError);
    expect(paneAccountFailure(error)).toEqual({ status: 409, body: { error: 'workspace-account-missing', effect: 'none' } });
    const old = { available: true, request: vi.fn(async () => ({})) };
    expect(paneAccountFailure(await workspaceAccountEnv(inherited, 'ws-1', old, 'codex').catch((e: unknown) => e)))
      .toEqual({ status: 503, body: { error: 'desktop-unavailable', effect: 'none' } });
    expect(old.request).not.toHaveBeenCalled();
  });
});
