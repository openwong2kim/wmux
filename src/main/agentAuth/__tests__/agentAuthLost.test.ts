import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock('../../notification/dispatchNotification', () => ({ dispatchNotification: vi.fn() }));

import { EventEmitter } from 'node:events';
import { AuthLostBoard, answerLoginState, loginProbeEnv, registerAgentAuthHandlers } from '../agentAuthLost';
import type { DaemonClient } from '../../DaemonClient';
import { authLostKey, parseAgentAuthLost, type AgentAuthLost } from '../../../shared/agentAuthLost';

const lost = (over: Partial<AgentAuthLost> = {}): AgentAuthLost => ({ agent: 'claude', configDir: null, origin: 'turn', at: 1, ...over });

describe('AuthLostBoard', () => {
  it('opens one entry per agent and account however many panes report it', () => {
    const board = new AuthLostBoard();
    expect(board.report('pty-1', lost())).toBe(true);
    expect(board.report('pty-2', lost({ origin: 'start' }))).toBe(false);
    expect(board.report('pty-3', lost({ configDir: '/acc/work' }))).toBe(true);
    expect(board.report('pty-4', lost({ agent: 'codex' }))).toBe(true);
    expect(board.list().find((e) => e.key === authLostKey('claude', null))?.ptyIds).toEqual(['pty-1', 'pty-2']);
  });

  it('drops an entry when its account works again, even one no pane holds any more', () => {
    const board = new AuthLostBoard();
    // A scheduled run's refusal (no pane) and a pane that has since closed.
    board.report('', lost({ origin: 'schedule', configDir: '/acc/work' }));
    board.report('pty-1', lost());
    expect(board.forgetPane('pty-1')).toBe(true);
    expect(board.list().map((e) => e.ptyIds)).toEqual([[], []]);
    expect(board.accountWorks('codex', null)).toBe(false);
    expect(board.accountWorks('claude', null)).toBe(true);
    expect(board.accountWorks('claude', '/acc/work')).toBe(true);
    expect(board.list()).toEqual([]);
    // Signed out again later: a new entry, so a new notice.
    expect(board.report('pty-2', lost())).toBe(true);
  });
});

describe('answerLoginState', () => {
  it('clears the entry once the agent says signed in, and never probes a key the daemon did not report', async () => {
    const board = new AuthLostBoard();
    board.report('', lost({ origin: 'schedule', configDir: '/acc/work' }));
    const key = authLostKey('claude', '/acc/work');
    const probe = vi.fn(async () => false as boolean | null);
    expect(await answerLoginState(board, key, probe)).toEqual({ known: true, signedIn: false, cleared: false });
    expect(board.list()).toHaveLength(1);
    probe.mockResolvedValueOnce(true);
    expect(await answerLoginState(board, key, probe)).toEqual({ known: true, signedIn: true, cleared: true });
    expect(board.list()).toEqual([]);
    expect(await answerLoginState(board, 'claude:/etc', probe)).toEqual({ known: false });
    expect(await answerLoginState(board, 42, probe)).toEqual({ known: false });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('answerLoginState for a WSL account home', () => {
  it('does not ask the Windows status, so the wait ends on the pane\'s own report or times out', async () => {
    const board = new AuthLostBoard();
    const lost: AgentAuthLost = { agent: 'claude', configDir: 'wsl:Ubuntu:C:\\acc\\work', origin: 'turn', at: 1 };
    board.report('pty-1', lost);
    const key = authLostKey('claude', lost.configDir);
    const probe = vi.fn(async () => true);
    expect(await answerLoginState(board, key, probe)).toEqual({ known: true, signedIn: null, cleared: false });
    expect(probe).not.toHaveBeenCalled();
    board.accountWorks('claude', lost.configDir);
    expect(await answerLoginState(board, key, probe)).toEqual({ known: false });
  });
});

describe('answerLoginState generations', () => {
  it('keeps a loss reported while the status check ran, even when that check said signed in', async () => {
    const board = new AuthLostBoard();
    board.report('pty-1', lost());
    const key = authLostKey('claude', null);
    const answer = await answerLoginState(board, key, async () => {
      board.report('pty-2', lost());
      return true;
    });
    expect(answer).toEqual({ known: true, signedIn: true, cleared: false });
    expect(board.list()).toHaveLength(1);
  });
});

describe('loginProbeEnv', () => {
  it("names the entry's account on a copy, and takes an inherited one out for the default account", () => {
    const base = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/inherited' };
    expect(loginProbeEnv({ agent: 'claude', configDir: '/acc/work' }, base)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/acc/work' });
    expect(loginProbeEnv({ agent: 'claude', configDir: null }, base)).toEqual({ PATH: '/bin' });
    expect(loginProbeEnv({ agent: 'codex', configDir: '/acc/cx' }, base)).toEqual({ ...base, CODEX_HOME: '/acc/cx' });
    expect(base).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/inherited' });
  });
});

describe('parseAgentAuthLost', () => {
  it('keeps a well-formed report and refuses anything else', () => {
    expect(parseAgentAuthLost({ agent: 'codex', configDir: '/acc/x', origin: 'start', providerCode: 'unauthorized', at: 5 }))
      .toEqual({ agent: 'codex', configDir: '/acc/x', origin: 'start', providerCode: 'unauthorized', at: 5 });
    expect(parseAgentAuthLost({ agent: 'grok', configDir: null, origin: 'turn', at: 1 })).toBeNull();
    expect(parseAgentAuthLost({ agent: 'claude', configDir: '', origin: 'turn', at: 1 })).toBeNull();
    expect(parseAgentAuthLost({ agent: 'claude', configDir: null, origin: 'other', at: 1 })).toBeNull();
    expect(parseAgentAuthLost({ agent: 'claude', configDir: null, origin: 'turn', providerCode: 'a b', at: 1 })).not.toHaveProperty('providerCode');
  });
});

describe('registerAgentAuthHandlers across a daemon reconnect', () => {
  it('keeps a loss seen before the reconnect and hands it to the renderer again', () => {
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as import('electron').BrowserWindow;
    const first = new EventEmitter();
    const cleanup = registerAgentAuthHandlers(first as unknown as DaemonClient, () => win);
    first.emit('agent:authLost', { sessionId: 'pty-1', lost: lost() });
    cleanup();
    send.mockClear();
    // registerAllHandlers runs again with the reconnected client.
    const second = new EventEmitter();
    const cleanupAgain = registerAgentAuthHandlers(second as unknown as DaemonClient, () => win);
    expect(send).toHaveBeenCalledWith('agentAuth:lostChanged', [expect.objectContaining({ key: authLostKey('claude', null), ptyIds: ['pty-1'] })]);
    // The account works again on the new connection: the same entry goes.
    second.emit('agent:authLost', { sessionId: '', works: { agent: 'claude', configDir: null } });
    expect(send).toHaveBeenLastCalledWith('agentAuth:lostChanged', []);
    cleanupAgain();
  });
});
