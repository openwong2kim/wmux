import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewCdpManager } from '../WebviewCdpManager';

const mockWebContents = {
  debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
  isDestroyed: vi.fn(() => false),
  on: vi.fn(),
  getURL: vi.fn(() => 'https://example.com'),
  getTitle: vi.fn(() => 'Example Page'),
  setBackgroundThrottling: vi.fn(),
};

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => mockWebContents) },
}));

describe('WebviewCdpManager — visibility for the phone browser stream', () => {
  let manager: WebviewCdpManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new WebviewCdpManager(0);
  });

  it('a getter (visible until a report says otherwise) and observers told each change once', async () => {
    expect(manager.isVisible('s1')).toBe(true);
    const seen: Array<[string, boolean]> = [];
    const off = manager.onVisibility((surfaceId, visible) => { seen.push([surfaceId, visible]); });
    manager.onVisibility(() => { throw new Error('observer failed'); });
    await manager.register('s1', 42, 'ws-1');
    manager.setVisibility('s1', false);
    manager.setVisibility('s1', false);
    expect(manager.isVisible('s1')).toBe(false);
    manager.setVisibility('s1', true);
    off();
    manager.setVisibility('s1', false);
    expect(seen).toEqual([['s1', false], ['s1', true]]);
    // A throwing observer does not stop the throttle bookkeeping.
    manager.setLightweightMode(true);
    expect(mockWebContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });
});
