import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCompanyRpc } from '../rpcHandlers';
import type { Company } from '../../types';

const ptyWrite = vi.fn();

function createStore() {
  const company: Company = {
    id: 'company-1',
    name: 'Acme',
    ceoWorkspaceId: 'ceo-ws',
    createdAt: 1,
    departments: [
      {
        id: 'dept-1',
        name: 'Engineering',
        leadId: 'alice-id',
        members: [
          {
            id: 'alice-id',
            name: 'Alice',
            preset: 'frontend-developer',
            workspaceId: 'alice-ws',
            ptyId: 'alice-pty',
            status: 'idle',
          },
          {
            id: 'bob-id',
            name: 'Bob',
            preset: 'backend-architect',
            workspaceId: 'bob-ws',
            ptyId: 'bob-pty',
            status: 'idle',
          },
        ],
      },
    ],
  };

  return {
    company,
    workspaces: [],
    addFeedEntry: vi.fn(),
    addToInbox: vi.fn(),
    enqueueMessage: vi.fn(),
  };
}

describe('company A2A RPC sender authorization', () => {
  beforeEach(() => {
    ptyWrite.mockReset();
    vi.stubGlobal('window', { electronAPI: { pty: { write: ptyWrite } } });
  });

  it('rejects send and broadcast calls from workspaces outside the company', async () => {
    const store = createStore();

    await expect(handleCompanyRpc('company.a2a.send', {
      workspaceId: 'outsider-ws',
      from: 'CEO',
      to: 'Bob',
      message: 'spoofed',
    }, store as any)).resolves.toMatchObject({ error: 'no company sender for workspace outsider-ws' });

    await expect(handleCompanyRpc('company.a2a.broadcast', {
      workspaceId: 'outsider-ws',
      from: 'CEO',
      message: 'spoofed',
    }, store as any)).resolves.toMatchObject({ error: 'no company sender for workspace outsider-ws' });

    expect(store.addFeedEntry).not.toHaveBeenCalled();
    expect(store.addToInbox).not.toHaveBeenCalled();
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('derives the sender from workspaceId and ignores caller-controlled from values', async () => {
    const store = createStore();

    await expect(handleCompanyRpc('company.a2a.send', {
      workspaceId: 'alice-ws',
      from: 'CEO',
      to: 'Bob',
      message: 'hello',
      priority: 'high',
    }, store as any)).resolves.toMatchObject({ ok: true, delivered: 1, queued: 0, targetCount: 1 });

    expect(store.addFeedEntry).toHaveBeenCalledWith({ from: 'Alice', to: 'Bob', message: 'hello', tag: 'message' });
    expect(store.addToInbox).toHaveBeenCalledWith('bob-id', { from: 'Alice', to: 'Bob', message: 'hello', priority: 'high' });
    expect(ptyWrite.mock.calls[0][1]).toContain('Alice');
    expect(ptyWrite.mock.calls[0][1]).not.toContain('CEO');
  });

  it('allows the CEO workspace and derives sender as CEO', async () => {
    const store = createStore();

    await expect(handleCompanyRpc('company.a2a.broadcast', {
      workspaceId: 'ceo-ws',
      from: 'Mallory',
      message: 'all hands',
    }, store as any)).resolves.toMatchObject({ ok: true, sent: 2 });

    expect(store.addFeedEntry).toHaveBeenCalledWith({ from: 'CEO', to: 'All', message: 'all hands', tag: 'broadcast' });
    expect(store.addToInbox).toHaveBeenCalledWith('alice-id', { from: 'CEO', to: 'All', message: 'all hands', priority: 'normal' });
    expect(store.addToInbox).toHaveBeenCalledWith('bob-id', { from: 'CEO', to: 'All', message: 'all hands', priority: 'normal' });
    expect(ptyWrite.mock.calls.every(([, data]) => String(data).includes('CEO'))).toBe(true);
    expect(ptyWrite.mock.calls.every(([, data]) => !String(data).includes('Mallory'))).toBe(true);
  });
});
