// The model-discovery IPC handler keeps ONE ModelCatalog across
// registerAllHandlers re-runs (boot + every daemon reconnect), so the in-memory
// failure TTL and the in-flight dedup survive a reconnect.

import { describe, it, expect, vi } from 'vitest';

const captured = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

import { IPC } from '../../../../shared/constants';
import { registerAgentModelsHandlers, sharedModelCatalog } from '../agentModels.handler';

describe('agentModels handler', () => {
  it('reuses the same catalog when handlers are registered again', async () => {
    const catalog = sharedModelCatalog();
    expect(sharedModelCatalog()).toBe(catalog);
    const list = vi
      .spyOn(catalog, 'list')
      .mockResolvedValue({ agent: 'codex', status: 'unavailable', models: [], fetchedAt: 0 });

    registerAgentModelsHandlers();
    const first = captured.get(IPC.AGENT_MODELS_LIST);
    registerAgentModelsHandlers(); // a daemon reconnect
    const second = captured.get(IPC.AGENT_MODELS_LIST);
    expect(second).not.toBe(first);

    await second?.({}, { agent: ' Codex ', refresh: true });
    expect(list).toHaveBeenCalledWith('codex', { refresh: true });
    list.mockRestore();
  });
});
