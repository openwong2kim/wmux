import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import type { AppInfo, WindowInfo } from '../../../shared/computer/protocol';

// The helper wrapper in src/main/computer/index.ts, as an input action meets
// it: a helper that cannot start (no hello in time) is waited for once, and
// the action fails with that start error. Electron, the switch file and the
// helper process are the mocked boundaries; the real wrapper and
// ComputerService run.

const h = vi.hoisted(() => ({
  starts: { count: 0 },
  requests: { count: 0 },
  startError: { value: null as Error | null },
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:/wmux', getAppMetrics: () => [] },
  globalShortcut: { register: () => true, unregister: () => undefined },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
}));
vi.mock('../../../shared/computer/config', () => ({
  readComputerUseEnabled: () => true,
  readComputerUseAskPerApp: () => false,
  readComputerUseOverlay: () => true,
}));
// Each start attempt (by defersForeground or by a request) counts as one
// hello timeout's worth of waiting.
vi.mock('../HelperProcess', () => ({
  HelperProcess: class {
    async defersForeground() {
      h.starts.count += 1;
      throw h.startError.value;
    }
    async request() {
      h.starts.count += 1;
      h.requests.count += 1;
      throw h.startError.value;
    }
    supports() { return undefined; }
    abort() { /* nothing in flight */ }
    dispose() { /* nothing to stop */ }
  },
}));
vi.mock('../helperPath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../helperPath')>()),
  resolveHelperPathFor: () => 'C:/wmux/fake-helper.exe',
}));
vi.mock('../selfElevation', () => ({ isSelfElevated: () => false }));
vi.mock('../settings', () => ({
  helperStatus: () => 'ready',
  writeComputerUseSettings: () => undefined,
}));

const app: AppInfo = { id: 'c:\\fake\\app.exe', name: 'Fake', pid: 10, path: 'C:\\fake\\app.exe' };
const window: WindowInfo = { id: 'w-10', appId: app.id, pid: 10, title: 'Fake window', bounds: { x: 0, y: 0, width: 800, height: 600 } };
const AGENT = { key: 'agent-a', label: 'agent A' };

beforeEach(() => {
  h.starts.count = 0;
  h.requests.count = 0;
  h.startError.value = new ComputerError('helper_unavailable', 'the computer-use helper did not say hello within 10000 ms');
});

describe('a helper that cannot start', () => {
  it('costs an input action one start, and the action fails with that start error, not_delivered', async () => {
    const mod = await import('../index');
    const service = mod.createComputerService({ requestConsent: async () => 'approved' });
    // A snapshot as getAppState would have recorded it (before the helper died).
    (service as unknown as { recordSnapshot(id: string, record: object): void }).recordSnapshot('s1', {
      agentKey: AGENT.key,
      app,
      window,
      expiresAt: Date.now() + 60_000,
    });
    const err = await service.control(AGENT, { action: 'pressKey', snapshotId: 's1', key: 'a' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComputerError);
    expect((err as ComputerError).code).toBe('helper_unavailable');
    expect((err as ComputerError).message).toContain('did not say hello');
    expect((err as ComputerError).disposition).toBe('not_delivered');
    expect(h.starts.count).toBe(1);
    expect(h.requests.count).toBe(0);
    service.dispose();
  });
});
