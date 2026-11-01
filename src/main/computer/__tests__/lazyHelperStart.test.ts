// @wmux-lane unit
// "win32" here is only a helper hello's OS, chosen as the opposite of this
// machine's, so the result is the same on every platform.
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
  hello: { value: null as unknown },
  sent: [] as Array<{ method: string; params: Record<string, unknown> }>,
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
    get hello() { return h.hello.value; }
    async defersForeground() {
      h.starts.count += 1;
      if (h.startError.value) throw h.startError.value;
      return true;
    }
    async request(method: string, params: Record<string, unknown>) {
      h.starts.count += 1;
      h.requests.count += 1;
      if (h.startError.value) throw h.startError.value;
      h.sent.push({ method, params });
      return { method: 'synthetic', verification: 'unverified' };
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
  h.hello.value = null;
  h.sent.length = 0;
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

describe("a running helper's hello", () => {
  it('picks the actions that need real input up front by the helper OS, not this machine', async () => {
    // The opposite of this machine, so only the hello can decide.
    const helperOs = process.platform === 'darwin' ? 'win32' : 'darwin';
    h.startError.value = null;
    h.hello.value = {
      type: 'hello',
      protocolVersion: 2,
      os: helperOs,
      helperVersion: 'test',
      capabilities: {
        actions: [],
        modes: ['ax'],
        permissions: { accessibility: true, screenRecording: true },
        input: { backgroundPointer: true, focusWithoutRaise: true, keyAuth: true, deferForeground: true },
      },
    };
    // A fresh module: the service above was disposed, which ends that module's.
    vi.resetModules();
    const mod = await import('../index');
    const service = mod.createComputerService({ requestConsent: async () => 'approved' });
    (service as unknown as { recordSnapshot(id: string, record: object): void }).recordSnapshot('s1', {
      agentKey: AGENT.key,
      app,
      window,
      expiresAt: Date.now() + 60_000,
    });
    await service.control(AGENT, { action: 'hotkey', snapshotId: 's1', keys: ['ctrl', 'a'] });
    // A chord needs real input up front on Windows only; on macOS the helper decides.
    expect(h.sent.at(-1)?.params.foreground).toBe(helperOs === 'win32' ? 'allow' : 'refuse');
    service.dispose();
  });
});
