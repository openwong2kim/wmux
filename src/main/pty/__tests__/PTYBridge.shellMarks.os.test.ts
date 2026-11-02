import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #2771 — local mode: a WSL shell carries wmux's integration, so a mark the
// running program writes gets a lowercase kind before the renderer sees it.
// Any other shell's marks pass through as they are.

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

const realPlatform = process.platform;
const mark = (kind: string) => `\x1b]133;${kind}\x07`;

function makeBridge(shell: string, platform: NodeJS.Platform) {
  let dataCb: ((data: string) => void) | null = null;
  const proc = { onData: (cb: (d: string) => void) => { dataCb = cb; }, onExit: () => { /* not observed */ } };
  const instance: PTYInstance = { id: 'p1', process: proc as unknown as PTYInstance['process'], shell };
  const manager = { get: vi.fn(() => instance), remove: vi.fn(), onDispose: vi.fn() } as unknown as PTYManager;
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    new PTYBridge(manager, () => win as never).setupDataForwarding('p1');
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  }
  const sent = () => win.webContents.send.mock.calls.filter((c) => c[0] === IPC.PTY_DATA).map((c) => c[2]).join('');
  // Output reaches the renderer on the bridge's micro-batch flush.
  const feed = (d: string) => { dataCb?.(d); vi.advanceTimersByTime(50); };
  return { feed, sent };
}

describe('PTYBridge shell marks (#2771)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const program = mark('A') + 'kimi> ' + mark('B') + mark('C') + 'reply' + mark('D');
  const back = mark('D;0') + mark('A') + '$ ' + mark('B');

  it('a WSL shell: the running program\'s marks are lowercased, the shell\'s D;<n> and prompt are not', () => {
    const { feed, sent } = makeBridge('C:\\Windows\\System32\\wsl.exe', 'win32');
    feed(mark('C'));
    feed(program);
    feed(back);
    expect(sent()).toBe(mark('C') + mark('a') + 'kimi> ' + mark('b') + mark('c') + 'reply' + mark('d') + back);
  });

  it('any other shell passes every mark through as it is', () => {
    const { feed, sent } = makeBridge('bash', 'win32');
    feed(mark('C'));
    feed(program);
    feed(back);
    expect(sent()).toBe(mark('C') + program + back);
  });
});
