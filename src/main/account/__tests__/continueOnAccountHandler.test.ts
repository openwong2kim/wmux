import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { continuePane, signsInWithToken, type ContinuePaneDeps } from '../continueOnAccount.handler';
import type { Account } from '../accountStore';

const SID = '0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const TOKEN = 'sk-ant-oat01-secret-value-never-leaves-main';

const plain: Account = { id: 'acc-plain', name: 'Plain', vendor: 'claude', configDir: '/acc/plain', createdAt: 1 };
const token: Account = { id: 'acc-token', name: 'Token', vendor: 'claude', configDir: '/acc/token', createdAt: 1 };

function deps(over: Partial<ContinuePaneDeps> = {}): ContinuePaneDeps & { rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(async (params: { copyOnly?: true }) => (params.copyOnly
    ? { ok: true, sessionId: SID, transcriptPath: `/acc/token/projects/-work/${SID}.jsonl`, cwd: '/work', permissionMode: 'bypassPermissions' }
    : { ok: true, sessionId: SID, transcriptPath: `/acc/plain/projects/-work/${SID}.jsonl` }));
  return {
    account: (id) => [plain, token].find((a) => a.id === id),
    vaultEntries: (id) => (id === token.id ? [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', inject: true, usable: true }] : []),
    dirOk: () => true,
    connected: () => true,
    rpc,
    ...over,
  } as ContinuePaneDeps & { rpc: ReturnType<typeof vi.fn> };
}

describe('continue on an account', () => {
  it('a token account takes the conversation in a new pane: the daemon only copies', async () => {
    const d = deps();
    const res = await continuePane(d, { ptyId: 'daemon-1', accountId: token.id });
    expect(d.rpc).toHaveBeenCalledWith({ sessionId: 'daemon-1', configDir: '/acc/token', copyOnly: true });
    expect(res).toEqual({
      ok: true,
      newPane: { accountId: token.id, command: `claude --resume ${SID} --dangerously-skip-permissions`, cwd: '/work' },
    });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it('an account without a token keeps the same-pane switch', async () => {
    const d = deps();
    expect(await continuePane(d, { ptyId: 'daemon-1', accountId: plain.id })).toEqual({ ok: true });
    expect(d.rpc).toHaveBeenCalledWith({ sessionId: 'daemon-1', configDir: '/acc/plain' });
  });

  it('a token that is not injected or cannot be decrypted is no token sign-in', () => {
    expect(signsInWithToken([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', inject: true, usable: true }])).toBe(true);
    expect(signsInWithToken([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', inject: false, usable: true }])).toBe(false);
    expect(signsInWithToken([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', inject: true, usable: false }])).toBe(false);
    expect(signsInWithToken([{ name: 'GITHUB_TOKEN', inject: true, usable: true }])).toBe(false);
  });

  it('passes a refusal through, and a copy reply without a conversation opens no pane', async () => {
    const refused = deps({ rpc: vi.fn(async () => ({ ok: false, code: 'turn_open' })) });
    expect(await continuePane(refused, { ptyId: 'daemon-1', accountId: token.id })).toEqual({ ok: false, code: 'turn_open' });
    const odd = deps({ rpc: vi.fn(async () => ({ ok: true, sessionId: 'not-a-session', cwd: '/work' })) });
    expect(await continuePane(odd, { ptyId: 'daemon-1', accountId: token.id })).toEqual({ ok: false, code: 'unknown_session' });
    expect(await continuePane(deps(), { ptyId: 'daemon-1', accountId: 'nobody' })).toEqual({ ok: false, code: 'invalid_account' });
    expect(await continuePane(deps({ connected: () => false }), { ptyId: 'daemon-1', accountId: token.id })).toEqual({ ok: false, code: 'unavailable' });
  });
});
