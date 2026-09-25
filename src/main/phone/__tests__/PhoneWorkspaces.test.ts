import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: send }));
import { fitSidebarToBudget, handlePhoneWorkspaces, PHONE_WORKSPACES_REPLY_BUDGET_BYTES } from '../PhoneWorkspaces';
import type { PhoneSidebarSnapshot } from '../../../shared/phoneFleetSidebar';
let directory: string;
const requestId = '01234567-89ab-4cde-8123-456789abcdef';
beforeEach(() => { send.mockReset(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-workspace-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
describe('phone workspace bridge', () => {
  it('validates the folder and forwards only the fixed creation operation', async () => {
    send.mockResolvedValue({ id: `ws-phone-${requestId}`, name: 'Project' });
    const getWindow = () => null;
    await handlePhoneWorkspaces('workspaces.create', { requestId, name: ' Project ', cwd: directory, command: 'rm -rf /', env: { SECRET: 'bad' } }, getWindow);
    expect(send).toHaveBeenCalledWith(getWindow, 'workspace.phoneCreate', { id: `ws-phone-${requestId}`, name: 'Project', cwd: await fs.promises.realpath(directory) });
  });
  it('refuses nonexistent or relative folders before creation', async () => {
    for (const cwd of ['relative', path.join(directory, 'missing')]) {
      await expect(handlePhoneWorkspaces('workspaces.create', { requestId, name: 'Project', cwd }, () => null)).rejects.toThrow();
    }
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves only named creation refusals for phone recovery', async () => {
    for (const error of ['workspace-request-closed', 'workspace-request-history-full']) {
      send.mockResolvedValue({error,secret:'not forwarded'});
      expect(await handlePhoneWorkspaces('workspaces.create', {requestId,name:'Project'}, () => null)).toEqual({error});
    }
  });
  it('does not interpret renderer startup errors as a created workspace', async () => {
    send.mockResolvedValue({ error: 'still starting' });
    await expect(handlePhoneWorkspaces('workspaces.create', { requestId, name: 'Project' }, () => null)).rejects.toThrow('unconfirmed');
  });
  it('limits list responses to workspace identity and active session', async () => {
    send.mockResolvedValue([{ id: 'ws-1', name: 'One', activePtyId: 's1', metadata: { cwd: '/private' }, hidden: 'secret' }]);
    expect(await handlePhoneWorkspaces('workspaces.list', {}, () => null)).toEqual({ workspaces: [{ id: 'ws-1', name: 'One', sessionId: 's1' }] });
  });
  it('forwards the sidebar projection only through the allowlist', async () => {
    const list = [{ id: 'ws-1', name: 'One', activePtyId: 's1' }];
    send.mockImplementation(async (_getWindow: unknown, method: string) => method === 'workspace.list' ? list : {
      activeWorkspaceId: 'ws-1',
      workspaces: [
        { id: 'ws-1', order: 0, pinned: true, color: 'teal', gitSync: { ahead: 1, behind: 2, hasUpstream: true, dirty: 9 }, cwd: '/private', env: { SECRET: 'x' } },
        { id: 'ws-bad', order: 'first', pinned: false },
        { id: 'ws-2', order: 1, pinned: false, color: 'not-a-color', task: { ownerWorkspaceId: 'ws-1', detached: false, createdAt: 1_700_000_000_000, nested: true, state: { needYou: false, toReview: true, finished: true, secret: 'x' }, secret: 'x' } },
      ],
      panes: [{ ptyId: 's1', workspaceId: 'ws-1', surfaceTitle: 'app review', paneName: 'w1-2', transcript: 'secret' }],
      debug: { renderer: 'state' },
    });
    const getWindow = () => null;
    const reply = await handlePhoneWorkspaces('workspaces.list', {}, getWindow);
    expect(send).toHaveBeenCalledWith(getWindow, 'workspace.phoneSidebar', {}, { timeoutMs: 1500 });
    expect(reply).toEqual({
      workspaces: [{ id: 'ws-1', name: 'One', sessionId: 's1' }],
      sidebar: {
        activeWorkspaceId: 'ws-1',
        workspaces: [
          { id: 'ws-1', order: 0, pinned: true, color: 'teal', gitSync: { ahead: 1, behind: 2, hasUpstream: true } },
          { id: 'ws-2', order: 1, pinned: false, task: { ownerWorkspaceId: 'ws-1', detached: false, createdAt: 1_700_000_000_000, nested: true, state: { needYou: false, toReview: true, finished: true } } },
        ],
        panes: [{ ptyId: 's1', workspaceId: 'ws-1', surfaceTitle: 'app review', paneName: 'w1-2' }],
      },
    });
    expect(JSON.stringify(reply)).not.toMatch(/secret|private|SECRET|debug/);
  });
  it('answers the list without the sidebar when the projection fails, and never cuts the list for size', async () => {
    const list = [{ id: 'ws-1', name: 'One', activePtyId: 's1' }];
    send.mockImplementation(async (_getWindow: unknown, method: string) => {
      if (method === 'workspace.list') return list;
      throw new Error('RPC timeout: workspace.phoneSidebar (1500ms)');
    });
    expect(await handlePhoneWorkspaces('workspaces.list', {}, () => null)).toEqual({ workspaces: [{ id: 'ws-1', name: 'One', sessionId: 's1' }] });
    const panes = Array.from({ length: 512 }, (_, i) => ({ ptyId: `pty-${i}-${'p'.repeat(100)}`, workspaceId: 'w'.repeat(120), surfaceTitle: 't'.repeat(100), paneName: 'n'.repeat(64) }));
    send.mockImplementation(async (_getWindow: unknown, method: string) => method === 'workspace.list' ? list : { activeWorkspaceId: null, workspaces: [], panes });
    // Titles alone do not save it; the pane list goes, the list stays whole.
    expect(await handlePhoneWorkspaces('workspaces.list', {}, () => null)).toEqual({
      workspaces: [{ id: 'ws-1', name: 'One', sessionId: 's1' }],
      sidebar: { activeWorkspaceId: null, workspaces: [], panes: [] },
    });
  });
  it('degrades an oversized sidebar in steps: titles, then pane names, then everything', () => {
    const base = { workspaces: [{ id: 'ws-1', name: 'One', sessionId: 's1' }] };
    const sidebar: PhoneSidebarSnapshot = {
      activeWorkspaceId: 'ws-1',
      workspaces: [{ id: 'ws-1', order: 0, pinned: true, gitBranch: 'main' }],
      panes: Array.from({ length: 20 }, (_, i) => ({ ptyId: `pty-${i}`, workspaceId: 'ws-1', surfaceTitle: 't'.repeat(100), paneName: `w1-${i}` })),
    };
    const size = (candidate: PhoneSidebarSnapshot | null) => Buffer.byteLength(JSON.stringify(candidate ? { ...base, sidebar: candidate } : base));
    const full = size(sidebar);
    expect(fitSidebarToBudget(base, sidebar, full)).toBe(sidebar);

    const noTitles = fitSidebarToBudget(base, sidebar, full - 1)!;
    expect(noTitles.panes).toHaveLength(20);
    expect(noTitles.panes.every((p) => !('surfaceTitle' in p) && p.paneName !== undefined)).toBe(true);
    expect(noTitles.workspaces).toEqual(sidebar.workspaces);

    const noPanes = fitSidebarToBudget(base, sidebar, size(noTitles) - 1)!;
    expect(noPanes.panes).toEqual([]);
    expect(noPanes.workspaces).toEqual(sidebar.workspaces);
    expect(noPanes.activeWorkspaceId).toBe('ws-1');

    expect(fitSidebarToBudget(base, sidebar, size(noPanes) - 1)).toBeNull();
  });
  it('keeps the workspace fields when many panes overflow the real budget', async () => {
    const list = [{ id: 'ws-1', name: 'One', activePtyId: 's1' }];
    // Multi-byte titles push it over; without them the pane names fit.
    const panes = Array.from({ length: 512 }, (_, i) => ({ ptyId: `pty-${i}`, workspaceId: 'ws-1', surfaceTitle: '✳'.repeat(100), paneName: `w1-${i}` }));
    send.mockImplementation(async (_getWindow: unknown, method: string) => method === 'workspace.list' ? list : {
      activeWorkspaceId: 'ws-1', workspaces: [{ id: 'ws-1', order: 0, pinned: true }], panes,
    });
    const reply = await handlePhoneWorkspaces('workspaces.list', {}, () => null) as { sidebar?: PhoneSidebarSnapshot };
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(PHONE_WORKSPACES_REPLY_BUDGET_BYTES);
    expect(reply.sidebar?.workspaces).toEqual([{ id: 'ws-1', order: 0, pinned: true }]);
    expect(reply.sidebar?.panes).toHaveLength(512);
    expect(reply.sidebar?.panes.some((p) => 'surfaceTitle' in p)).toBe(false);
  });
  it('keeps the good rows when one is bad, and warns once with reasons only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const list = [{ id: 'ws-1', name: 'One', activePtyId: 's1' }];
      send.mockImplementation(async (_getWindow: unknown, method: string) => method === 'workspace.list' ? list : {
        activeWorkspaceId: 'ws-1',
        workspaces: [
          { id: 'ws-1', order: 0, pinned: false, gitBranch: 'main' },
          { id: 'ws-2', order: 1, pinned: false, task: { ownerWorkspaceId: 'ws-1', detached: 'SECRET-VALUE', nested: true } },
        ],
        panes: [{ ptyId: 's1', workspaceId: 'ws-1', paneName: 'w1-1' }],
      });
      for (let i = 0; i < 3; i++) {
        const reply = await handlePhoneWorkspaces('workspaces.list', {}, () => null) as { sidebar: PhoneSidebarSnapshot };
        expect(reply.sidebar.workspaces).toEqual([{ id: 'ws-1', order: 0, pinned: false, gitBranch: 'main' }, { id: 'ws-2', order: 1, pinned: false }]);
        expect(reply.sidebar.panes).toHaveLength(1);
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toBe('[phone] workspaces.list sidebar: workspace.task×1');
    } finally {
      warn.mockRestore();
    }
  });
  it('does not dispatch arbitrary operations', async () => {
    await expect(handlePhoneWorkspaces('workspace.close', {}, () => null)).rejects.toThrow('Unsupported');
    expect(send).not.toHaveBeenCalled();
  });
});
