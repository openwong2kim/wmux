import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({
  sendToRenderer: vi.fn(),
  startGuiFanOut: vi.fn(),
  home: '',
}));

vi.mock('electron', () => ({ globalShortcut: {}, ipcMain: {}, BrowserWindow: class {}, screen: {} }));
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: h.sendToRenderer }));
vi.mock('../../ipc/handlers/fanout.handler', () => ({ startGuiFanOut: h.startGuiFanOut }));
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, homedir: () => h.home };
});

import { launchQuick } from '../index';
import type { FanOutService } from '../../worktask/FanOutService';

const ws = { id: 'ws-1', name: 'Repo', cwd: '/repo' };
const deps = { getMainWindow: () => null, fanOutService: {} as FanOutService };

describe('launchQuick', () => {
  beforeEach(() => {
    h.home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ql-home-'));
    h.sendToRenderer.mockReset();
    h.startGuiFanOut.mockReset();
    h.sendToRenderer.mockImplementation(async (_w: unknown, method: string) =>
      method === 'quickLaunch.context' ? { workspaces: [ws] } : { workspaceId: 'ws-new' },
    );
    h.startGuiFanOut.mockResolvedValue({ ok: true, tasks: [] });
  });

  it('starts a worktree task on the chosen agent', async () => {
    const result = await launchQuick(
      { prompt: 'fix it', workspaceId: 'ws-1', agent: { kind: 'agent', agent: 'codex' }, checkout: 'worktree' },
      deps,
    );
    expect(result).toEqual({ ok: true });
    const req = h.startGuiFanOut.mock.calls[0][1];
    expect(req).toMatchObject({ repoPath: '/repo', verifiedWorkspaceId: 'ws-1', worktree: true, agents: [{ agent: 'codex' }] });
    expect(req.roles).toBeUndefined();
  });

  it('starts a worktree task on a role', async () => {
    await launchQuick({ prompt: 'review', workspaceId: 'ws-1', agent: { kind: 'role', role: 'Reviewer' }, checkout: 'worktree' }, deps);
    expect(h.startGuiFanOut.mock.calls[0][1]).toMatchObject({ roles: ['Reviewer'] });
  });

  it('starts the current checkout on the chosen agent, nested but not stamped as a task', async () => {
    await launchQuick({ prompt: 'fix it', workspaceId: 'ws-1', agent: { kind: 'agent', agent: 'codex' }, checkout: 'current' }, deps);
    const [, method, params] = h.sendToRenderer.mock.calls[1];
    expect(method).toBe('fanout.spawnWorkspace');
    // The renderer swaps the base launcher for the chosen CLI (applyRoleAgent).
    expect(params).toMatchObject({ cwd: '/repo', agentChoice: { agent: 'codex' }, nestUnder: 'ws-1' });
    expect(params.fanoutTaskOf).toBeUndefined();
    expect(params.workerPermissionMode).toBeUndefined();
    // The prompt is read from a file, never typed into the shell.
    const file = /cat '([^']+)'/.exec(params.initialCommand)?.[1];
    expect(file && fs.readFileSync(file, 'utf8')).toBe('fix it');
  });

  it('refuses a workspace without a folder', async () => {
    h.sendToRenderer.mockResolvedValueOnce({ workspaces: [{ ...ws, cwd: '' }] });
    const result = await launchQuick({ prompt: 'x', workspaceId: 'ws-1', agent: { kind: 'default' }, checkout: 'current' }, deps);
    expect(result.ok).toBe(false);
  });
});
