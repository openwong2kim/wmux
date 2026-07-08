import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewCdpManager } from '../WebviewCdpManager';

const mockDebugger = { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) };
const mockWebContents = {
  debugger: mockDebugger,
  isDestroyed: vi.fn(() => false),
  on: vi.fn(),
  getURL: vi.fn(() => 'https://example.com'),
  getTitle: vi.fn(() => 'Example Page'),
  loadURL: vi.fn(),
  setBackgroundThrottling: vi.fn(),
};

vi.mock('electron', () => ({
  webContents: {
    fromId: vi.fn(() => mockWebContents),
  },
}));

const mockTargets = [
  {
    id: 'target-abc',
    type: 'page',
    url: 'https://example.com',
    webSocketDebuggerUrl: 'ws://127.0.0.1:18800/devtools/page/target-abc',
  },
];
global.fetch = vi.fn(() =>
  Promise.resolve({ json: () => Promise.resolve(mockTargets) } as Response),
);

describe('WebviewCdpManager', () => {
  let manager: WebviewCdpManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new WebviewCdpManager(18800);
  });

  it('register attaches debugger and stores session', async () => {
    await manager.register('surface-1', 42);
    expect(mockDebugger.attach).toHaveBeenCalledWith('1.3');
    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:18800/json');
    const target = manager.getTarget('surface-1');
    expect(target).not.toBeNull();
    expect(target?.targetId).toBe('target-abc');
    expect(target?.wsUrl).toContain('ws://');
  });

  it('register enables focus emulation and disables background throttling (#353)', async () => {
    await manager.register('surface-1', 42);
    // Background surfaces (display:none guest) must behave focused for input/a11y.
    expect(mockDebugger.sendCommand).toHaveBeenCalledWith('Emulation.setFocusEmulationEnabled', {
      enabled: true,
    });
    // And keep running full-speed so background screenshots / evaluate don't stall.
    expect(mockWebContents.setBackgroundThrottling).toHaveBeenCalledWith(false);
  });

  it('unregister detaches debugger and removes session', async () => {
    await manager.register('surface-1', 42);
    manager.unregister('surface-1');
    expect(mockDebugger.detach).toHaveBeenCalled();
    expect(manager.getTarget('surface-1')).toBeNull();
  });

  it('getTarget without surfaceId returns first available', async () => {
    await manager.register('surface-1', 42);
    const target = manager.getTarget();
    expect(target).not.toBeNull();
  });

  it('listTargets returns all sessions', async () => {
    await manager.register('s1', 42);
    const list = manager.listTargets();
    expect(list).toHaveLength(1);
    expect(list[0].surfaceId).toBe('s1');
  });

  it('waitForTarget resolves when target is already registered', async () => {
    await manager.register('surface-1', 42);
    const target = await manager.waitForTarget('surface-1', 1000);
    expect(target.targetId).toBe('target-abc');
  });

  it('waitForTarget resolves when target registers later', async () => {
    const promise = manager.waitForTarget('surface-2', 3000);
    setTimeout(() => manager.register('surface-2', 99), 50);
    const target = await promise;
    expect(target).not.toBeNull();
  });

  it('waitForTarget rejects on timeout', async () => {
    await expect(manager.waitForTarget('nonexistent', 100)).rejects.toThrow('timeout');
  });
});
