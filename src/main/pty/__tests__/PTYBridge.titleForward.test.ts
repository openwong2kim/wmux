import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Local-mode window titles (#3004): the tab gets a repeat never, a bare
// spinner frame at most once a second, and any other change at once.

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

vi.mock('../../pipe/handlers/notify.rpc', () => ({
  toastManager: { show: vi.fn() },
}));

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  updateCwd: vi.fn(),
  removeCwd: vi.fn(),
  updateBranch: vi.fn(),
  removeBranch: vi.fn(),
  broadcastMetadataUpdate: vi.fn(),
  getLastBroadcastAgentStatus: () => undefined,
  clearLastBroadcastAgentStatus: () => { /* no-op stub */ },
}));

vi.mock('../../notification/sendNotification', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../../notification/rendererNotificationReadiness', () => ({
  isRendererNotificationListenerReady: () => true,
}));

import { PTYBridge } from '../PTYBridge';
import type { PTYManager, PTYInstance } from '../PTYManager';
import { IPC } from '../../../shared/constants';

function makeBridge() {
  let dataCb: ((data: string) => void) | null = null;
  const proc = { onData: (cb: (d: string) => void) => { dataCb = cb; }, onExit: () => { /* not observed */ } };
  const instance: PTYInstance = { id: 'p1', process: proc as unknown as PTYInstance['process'], shell: 'bash' };
  const manager = { get: vi.fn(() => instance), remove: vi.fn(), onDispose: vi.fn() } as unknown as PTYManager;
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  new PTYBridge(manager, () => win as never).setupDataForwarding('p1');
  const sentTitles = () => win.webContents.send.mock.calls.filter((c) => c[0] === IPC.TERMINAL_TITLE_CHANGED).map((c) => c[2]);
  // Output is parsed on the bridge's micro-batch flush.
  const feed = (d: string) => { dataCb?.(d); vi.advanceTimersByTime(50); };
  return { feed, sentTitles };
}

describe('PTYBridge window titles', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends a repeat once, Codex's spinner about once a second, and its end at once", () => {
    const { feed, sentTitles } = makeBridge();
    feed('\x1b]0;codex | ~/proj\x07');
    feed('\x1b]0;codex | ~/proj\x07');
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇'];
    for (let i = 0; i < 20; i++) {
      feed(`\x1b]0;${frames[i % frames.length]} codex | ~/proj\x07`);
      vi.advanceTimersByTime(50);
    }
    feed('\x1b]0;codex | ~/proj\x07');
    // A frame every 100 ms for 2 s: the spinner appearing, one frame a second later, then its end.
    expect(sentTitles()).toEqual(['codex | ~/proj', '⠋ codex | ~/proj', '⠙ codex | ~/proj', 'codex | ~/proj']);
  });
});
