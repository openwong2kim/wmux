import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { continuePane, type ContinuePaneDeps } from '../continueOnAccount.handler';
import { holdsClaudeSignIn } from '../accountVault';
import type { Account } from '../accountStore';

const SID = '0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const TOKEN = 'sk-ant-oat01-secret-value-never-leaves-main';

const plain: Account = { id: 'acc-plain', name: 'Plain', vendor: 'claude', configDir: '/acc/plain', createdAt: 1 };
const token: Account = { id: 'acc-token', name: 'Token', vendor: 'claude', configDir: '/acc/token', createdAt: 1 };

type Rpc = ReturnType<typeof vi.fn<ContinuePaneDeps['rpc']>>;

function deps(over: Partial<ContinuePaneDeps> = {}): ContinuePaneDeps & { rpc: Rpc } {
  const rpc: Rpc = vi.fn<ContinuePaneDeps['rpc']>(async (method, params) => (method === 'session.copyToAccountV1'
    ? { ok: true, sessionId: SID, transcriptPath: `${params.configDir}/projects/-work/${SID}.jsonl`, cwd: '/work', permissionMode: 'bypassPermissions' }
    : { ok: true, sessionId: SID, transcriptPath: `${params.configDir}/projects/-work/${SID}.jsonl` }));
  return {
    account: (id) => [plain, token].find((a) => a.id === id),
    vaultEntries: (id) => (id === token.id ? [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', inject: true, usable: true }] : []),
    sourceSignedIn: () => false,
    dirOk: () => true,
    connected: () => true,
    rpc,
    ...over,
  } as ContinuePaneDeps & { rpc: Rpc };
}

describe('continue on an account', () => {
  it('a token account takes the conversation in a new pane: the daemon only copies', async () => {
    const d = deps();
    const res = await continuePane(d, { ptyId: 'daemon-1', accountId: token.id });
    expect(d.rpc).toHaveBeenCalledWith('session.copyToAccountV1', { sessionId: 'daemon-1', configDir: '/acc/token' });
    expect(res).toEqual({
      ok: true,
      newPane: { accountId: token.id, command: `claude --resume ${SID} --dangerously-skip-permissions`, cwd: '/work' },
    });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it('an account without a token keeps the same-pane switch', async () => {
    const d = deps();
    expect(await continuePane(d, { ptyId: 'daemon-1', accountId: plain.id })).toEqual({ ok: true });
    expect(d.rpc).toHaveBeenCalledWith('session.continueOnAccount', { sessionId: 'daemon-1', configDir: '/acc/plain' });
  });

  it('a pane that spawned with a vault sign-in moves to a new pane even for a plain account', async () => {
    const sourceSignedIn = vi.fn(() => true);
    const d = deps({ sourceSignedIn });
    const res = await continuePane(d, { ptyId: 'daemon-1', accountId: plain.id, workspaceId: 'ws-1' });
    expect(sourceSignedIn).toHaveBeenCalledWith('daemon-1', 'ws-1');
    expect(d.rpc).toHaveBeenCalledWith('session.copyToAccountV1', { sessionId: 'daemon-1', configDir: '/acc/plain' });
    expect(res).toMatchObject({ ok: true, newPane: { accountId: plain.id, cwd: '/work' } });
  });

  it('a daemon without the copy method refuses: unavailable, and no same-pane move is asked for', async () => {
    const rpc: Rpc = vi.fn<ContinuePaneDeps['rpc']>(async () => { throw new Error('Unknown method: session.copyToAccountV1'); });
    const d = deps({ rpc });
    expect(await continuePane(d, { ptyId: 'daemon-1', accountId: token.id })).toEqual({ ok: false, code: 'unavailable' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('session.copyToAccountV1');
  });

  it('a vault that cannot be read is unavailable, with nothing asked of the daemon', async () => {
    const broken = deps({ vaultEntries: () => { throw new Error('vault unreadable'); } });
    expect(await continuePane(broken, { ptyId: 'daemon-1', accountId: plain.id })).toEqual({ ok: false, code: 'unavailable' });
    const brokenSource = deps({ sourceSignedIn: () => { throw new Error('vault unreadable'); } });
    expect(await continuePane(brokenSource, { ptyId: 'daemon-1', accountId: plain.id })).toEqual({ ok: false, code: 'unavailable' });
    expect([...broken.rpc.mock.calls, ...brokenSource.rpc.mock.calls]).toEqual([]);
  });

  it('only an injected, decryptable Claude sign-in variable counts', () => {
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      expect(holdsClaudeSignIn([{ name, inject: true, usable: true }])).toBe(true);
    }
    expect(holdsClaudeSignIn([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', inject: false, usable: true }])).toBe(false);
    expect(holdsClaudeSignIn([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', inject: true, usable: false }])).toBe(false);
    expect(holdsClaudeSignIn([{ name: 'OPENAI_API_KEY', inject: true, usable: true }])).toBe(false);
    expect(holdsClaudeSignIn([{ name: 'GITHUB_TOKEN', inject: true, usable: true }])).toBe(false);
  });

  it('passes a refusal through, and a copy reply without a conversation opens no pane', async () => {
    const refused = deps({ rpc: vi.fn<ContinuePaneDeps['rpc']>(async () => ({ ok: false, code: 'turn_open' })) });
    expect(await continuePane(refused, { ptyId: 'daemon-1', accountId: token.id })).toEqual({ ok: false, code: 'turn_open' });
    const odd = deps({ rpc: vi.fn<ContinuePaneDeps['rpc']>(async () => ({ ok: true, sessionId: 'not-a-session', cwd: '/work' })) });
    expect(await continuePane(odd, { ptyId: 'daemon-1', accountId: token.id })).toEqual({ ok: false, code: 'unknown_session' });
    const noCwd = deps({ rpc: vi.fn<ContinuePaneDeps['rpc']>(async () => ({ ok: true, sessionId: SID })) });
    expect(await continuePane(noCwd, { ptyId: 'daemon-1', accountId: token.id })).toEqual({ ok: false, code: 'unknown_session' });
    expect(await continuePane(deps(), { ptyId: 'daemon-1', accountId: 'nobody' })).toEqual({ ok: false, code: 'invalid_account' });
    expect(await continuePane(deps({ connected: () => false }), { ptyId: 'daemon-1', accountId: token.id })).toEqual({ ok: false, code: 'unavailable' });
  });
});
