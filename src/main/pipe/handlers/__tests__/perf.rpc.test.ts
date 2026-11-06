import { describe, expect, it, vi } from 'vitest';

const { getAppMetrics } = vi.hoisted(() => ({ getAppMetrics: vi.fn(() => [
  { pid: 123, type: 'Browser', memory: { workingSetSize: 1024 } },
]) }));
vi.mock('electron', () => ({ app: { getAppMetrics } }));
const { pipe } = vi.hoisted(() => ({ pipe: { frames: 0, bytes: 0, parseMsTotal: 0, parseMsMax: 0, largestFrameBytes: 0, dropped: {}, refused: 0 } }));
vi.mock('../../../browser-session/CdpPipeMux', () => ({ cdpPipeCounters: () => ({ ...pipe }) }));
import { registerPerfRpc } from '../perf.rpc';
import { RpcRouter } from '../../RpcRouter';

describe('perf.status memory diagnostics', () => {
  it('samples Electron memory only on explicit request', async () => {
    const router = new RpcRouter();
    registerPerfRpc(router);
    getAppMetrics.mockClear();
    const normal = await router.dispatch({ id: 'normal', method: 'perf.status', params: {} });
    expect(normal.ok).toBe(true);
    expect(getAppMetrics).not.toHaveBeenCalled();
    const diagnostic = await router.dispatch({ id: 'memory', method: 'perf.status', params: { includeMemory: true } });
    expect(diagnostic).toMatchObject({ ok: true, result: { memory: {
      mainPid: process.pid, processes: [{ pid: 123, type: 'Browser', workingSetBytes: 1024 * 1024 }],
    } } });
    expect(getAppMetrics).toHaveBeenCalledTimes(1);
  });

  it('adds the Chrome debugging pipe counters once a pipe has said something', async () => {
    const router = new RpcRouter();
    registerPerfRpc(router);
    const idle = await router.dispatch({ id: 'idle', method: 'perf.status', params: { includeMemory: true } });
    expect((idle as { result: { memory: object } }).result.memory).not.toHaveProperty('cdpPipe');
    Object.assign(pipe, { frames: 3, bytes: 300, dropped: { 'root-event': 1 } });
    const used = await router.dispatch({ id: 'used', method: 'perf.status', params: { includeMemory: true } });
    expect(used).toMatchObject({ ok: true, result: { memory: { cdpPipe: { frames: 3, bytes: 300, dropped: { 'root-event': 1 }, refused: 0 } } } });
  });
});
