import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  it('does not spawn using a guessed account when the desktop request fails', async () => {
    await expect(workspaceAccountEnv(inherited, 'ws-1', { available: true, request: async () => { throw new Error('disconnected'); } })).rejects.toThrow('disconnected');
  });
  describe('with no desktop attached (headless host)', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-headless-accounts-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    const writeAccounts = (configDir: string) => fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
      version: 1,
      accounts: [{ id: 'acc-1', name: 'Work', vendor: 'claude', configDir, createdAt: 1 }],
      bindings: { 'ws-1': { claude: 'acc-1' } },
    }));

    it('runs an unconfigured workspace on the default credential', async () => {
      const next = await workspaceAccountEnv(inherited, 'ws-1', null, undefined, dir);
      expect(next).toEqual({ PATH: '/bin', WMUX_WORKSPACE_ID: 'ws-1' });
    });
    it('reads the bound directory from accounts.json', async () => {
      const bound = fs.mkdtempSync(path.join(dir, 'claude-'));
      writeAccounts(bound);
      expect(await workspaceAccountEnv(inherited, 'ws-1', null, undefined, dir))
        .toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: bound, WMUX_WORKSPACE_ID: 'ws-1' });
      // Another workspace has no binding of its own and never borrows this one.
      expect((await workspaceAccountEnv(inherited, 'ws-2', null, undefined, dir)).CLAUDE_CONFIG_DIR).toBeUndefined();
    });
    it('still refuses a configured binding whose directory is gone', async () => {
      writeAccounts(path.join(dir, 'gone'));
      expect(paneAccountFailure(await workspaceAccountEnv(inherited, 'ws-1', null, undefined, dir).catch((e: unknown) => e)))
        .toEqual({ status: 409, body: { error: 'workspace-account-missing', effect: 'none' } });
      // A pane on its own account for that vendor does not depend on the broken binding.
      expect(await workspaceAccountEnv(inherited, 'ws-1', null, 'claude', dir)).toEqual({ PATH: '/bin', WMUX_WORKSPACE_ID: 'ws-1' });
    });
    it.each([
      ['bad JSON', '{not json'],
      ['an unknown schema version', JSON.stringify({ version: 2, accounts: [], bindings: {} })],
      ['a non-object store', '5'],
      ['a binding to an account that is not there', JSON.stringify({ version: 1, accounts: [], bindings: { 'ws-1': { claude: 'acc-x' } } })],
      ['a binding in the wrong vendor slot', JSON.stringify({ version: 1, accounts: [{ id: 'acc-1', name: 'W', vendor: 'codex', configDir: '/x' }], bindings: { 'ws-1': { claude: 'acc-1' } } })],
    ])('refuses rather than guess from %s', async (_label, content) => {
      fs.writeFileSync(path.join(dir, 'accounts.json'), content);
      // An older snapshot must not answer for the primary file.
      fs.writeFileSync(path.join(dir, 'accounts.json.bak'), JSON.stringify({ version: 1, accounts: [], bindings: {} }));
      expect(paneAccountFailure(await workspaceAccountEnv(inherited, 'ws-1', null, undefined, dir).catch((e: unknown) => e)))
        .toEqual({ status: 503, body: { error: 'account-store-unreadable', effect: 'none' } });
    });
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses when the data dir cannot be read', async () => {
      writeAccounts(dir);
      fs.chmodSync(dir, 0o000);
      try {
        expect(paneAccountFailure(await workspaceAccountEnv(inherited, 'ws-1', null, undefined, dir).catch((e: unknown) => e)))
          .toEqual({ status: 503, body: { error: 'account-store-unreadable', effect: 'none' } });
      } finally {
        fs.chmodSync(dir, 0o700);
      }
    });
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
