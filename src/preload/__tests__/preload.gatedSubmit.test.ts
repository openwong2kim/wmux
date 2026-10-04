// @vitest-environment jsdom
//
// The renderer's gated submit crosses the preload bridge with only the
// options it lists, so a new option that is not forwarded here silently never
// reaches main. The Git page's hand-off depends on three of them.
import { describe, expect, it, vi } from 'vitest';

const exposed: Record<string, unknown> = {};
const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true }));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api; } },
  ipcRenderer: { invoke, on: vi.fn(), once: vi.fn(), off: vi.fn(), removeListener: vi.fn(), removeAllListeners: vi.fn(), send: vi.fn(), sendSync: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
  webFrame: { setZoomFactor: vi.fn(), getZoomFactor: vi.fn(() => 1) },
}));

describe('preload gatedSubmit', () => {
  it('forwards the hand-off options: the typing hold, the agent to expect and the deadline', async () => {
    await import('../preload');
    const api = exposed.electronAPI as { rpc: { gatedSubmit: (...a: unknown[]) => Promise<unknown> } };
    await api.rpc.gatedSubmit('pty-1', 'ref', 'Claude Code', {
      newTask: true, taskId: 't1', waitQuiet: true, expectAgent: 'Claude Code', deadlineAt: 123,
    });
    expect(invoke).toHaveBeenLastCalledWith('pty:gated-submit', 'pty-1', 'ref', 'Claude Code', expect.objectContaining({
      newTask: true, taskId: 't1', waitQuiet: true, expectAgent: 'Claude Code', deadlineAt: 123,
    }));
    // Without the hold, nothing about it is sent.
    await api.rpc.gatedSubmit('pty-1', 'x', null, { newTask: true });
    expect(invoke.mock.calls.at(-1)?.[4]).toEqual({ newTask: true });
  });
});
