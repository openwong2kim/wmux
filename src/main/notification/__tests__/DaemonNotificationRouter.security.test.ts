// A daemon security notice (source 'security', e.g. a phone started an agent
// with approvals off) must reach the host user even when every renderer
// notification gate would hide a terminal notification.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DaemonClient } from '../../DaemonClient';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../ToastManager', () => ({ toastManager: { showDirect: vi.fn() } }));
vi.mock('../dispatchNotification', () => ({ dispatchNotification: vi.fn() }));
vi.mock('../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: vi.fn(),
  getLastBroadcastAgentStatus: () => undefined,
  clearLastBroadcastAgentStatus: () => { /* no-op stub */ },
}));
vi.mock('../sendNotification', () => ({ sendNotification: vi.fn() }));
vi.mock('../idleSuppression', () => ({ clearPty: vi.fn() }));
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: vi.fn(async () => []) }));

import { toastManager } from '../ToastManager';
import { dispatchNotification } from '../dispatchNotification';
import { DaemonNotificationRouter } from '../DaemonNotificationRouter';

type NotificationListener = (payload: { sessionId: string; event: unknown }) => void;

function start(): NotificationListener {
  let listener: NotificationListener | undefined;
  const fakeDaemon = {
    on: vi.fn((event: string, cb: NotificationListener) => { if (event === 'session:notification') listener = cb; }),
    off: vi.fn(),
  } as unknown as DaemonClient;
  new DaemonNotificationRouter(fakeDaemon, () => null).start();
  if (!listener) throw new Error('session:notification listener not registered');
  return listener;
}

describe('DaemonNotificationRouter security notice', () => {
  beforeEach(() => { vi.mocked(toastManager.showDirect).mockClear(); vi.mocked(dispatchNotification).mockClear(); });

  it('shows the notice directly, bypassing the renderer policy and the toast toggle', () => {
    start()({ sessionId: 'pty-a', event: { source: 'security', title: 'Phone launch', body: 'Codex started with approvals and sandbox off', ts: 1 } });
    expect(toastManager.showDirect).toHaveBeenCalledWith('Phone launch', 'Codex started with approvals and sandbox off',
      { ptyId: 'pty-a' }, { ignoreToastSetting: true });
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it('keeps terminal notifications on the policy path and drops unknown sources', () => {
    const emit = start();
    emit({ sessionId: 'pty-a', event: { source: 'osc9', title: null, body: 'done', ts: 1 } });
    emit({ sessionId: 'pty-a', event: { source: 'other', title: null, body: 'ignored', ts: 1 } });
    emit({ sessionId: 'pty-a', event: { source: 'security', title: null, body: '', ts: 1 } });
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(toastManager.showDirect).not.toHaveBeenCalled();
  });
});
