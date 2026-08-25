// X8 — tests for the supervision EventBus tees fired from
// DaemonNotificationRouter:
//   - session:restarted    → pane.restarted   { ptyId, restartCount, exitCode }
//   - supervision:changed  → pane.supervision { ptyId, status, reason }
//
// Same workspace-resolution-or-drop contract as the existing agent.lifecycle /
// notification.received tees: an event whose workspace can't be resolved is
// dropped so it never routes to the wrong events.poll subscriber. Mirrors the
// mocking approach of DaemonNotificationRouter.lifecycle.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DaemonClient } from '../../DaemonClient';
import { eventBus } from '../../events/EventBus';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

vi.mock('../../pipe/handlers/notify.rpc', () => ({
  toastManager: { show: vi.fn() },
}));

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: vi.fn(),
  // #935 direction 3: PTYBridge/DaemonNotificationRouter import these from
  // the real module; this suite does not exercise the deferral logic, so
  // no-op stubs are enough to keep the import from throwing.
  getLastBroadcastAgentStatus: () => undefined,
  clearLastBroadcastAgentStatus: () => { /* no-op stub */ },
}));

vi.mock('../sendNotification', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../idleSuppression', () => ({
  clearPty: vi.fn(),
}));

vi.mock('../../pipe/handlers/_bridge', () => ({
  sendToRenderer: vi.fn(),
}));

import { sendToRenderer } from '../../pipe/handlers/_bridge';
import { DaemonNotificationRouter } from '../DaemonNotificationRouter';

const sendToRendererMock = vi.mocked(sendToRenderer);

const FIXTURE_WORKSPACE_LIST = [
  { id: 'ws-1', name: 'Workspace 1', activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-b'] },
];

interface CapturedListeners {
  restarted?: (payload: {
    sessionId: string;
    restartCount: number;
    consecutiveFailures: number;
    exitCode: number | null;
  }) => void;
  supervision?: (payload: {
    sessionId: string;
    status: 'armed' | 'stopped';
    reason: 'guard-trip' | 'rearm' | 'manual-stop';
    restartCount: number;
    consecutiveFailures: number;
  }) => void;
}

function makeRouter() {
  const captured: CapturedListeners = {};
  const fakeDaemon = {
    on: vi.fn((event: string, cb: (payload: never) => void) => {
      if (event === 'session:restarted') captured.restarted = cb as CapturedListeners['restarted'];
      if (event === 'supervision:changed') captured.supervision = cb as CapturedListeners['supervision'];
    }),
    off: vi.fn(),
  } as unknown as DaemonClient;
  const router = new DaemonNotificationRouter(fakeDaemon, () => null);
  router.start();
  return { router, captured };
}

function pollRestarted() {
  return eventBus.poll(0, { types: ['pane.restarted'] }).events;
}

function pollSupervision() {
  return eventBus.poll(0, { types: ['pane.supervision'] }).events;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  sendToRendererMock.mockReset();
  sendToRendererMock.mockResolvedValue(FIXTURE_WORKSPACE_LIST);
  eventBus.reset();
});

afterEach(() => {
  eventBus.reset();
});

describe('DaemonNotificationRouter — pane.restarted tee', () => {
  it('emits pane.restarted with the resolved workspaceId, restartCount, and exitCode', async () => {
    const { router, captured } = makeRouter();
    try {
      captured.restarted!({ sessionId: 'pty-a', restartCount: 3, consecutiveFailures: 1, exitCode: 1 });
      await flushMicrotasks();

      const events = pollRestarted();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'pane.restarted',
        workspaceId: 'ws-1',
        ptyId: 'pty-a',
        restartCount: 3,
        exitCode: 1,
      });
    } finally {
      router.stop();
    }
  });

  it('carries exitCode null (external kill / signal exit)', async () => {
    const { router, captured } = makeRouter();
    try {
      captured.restarted!({ sessionId: 'pty-a', restartCount: 1, consecutiveFailures: 0, exitCode: null });
      await flushMicrotasks();

      expect(pollRestarted()[0]).toMatchObject({ exitCode: null, restartCount: 1 });
    } finally {
      router.stop();
    }
  });

  it('drops the event when the workspace cannot be resolved', async () => {
    const { router, captured } = makeRouter();
    try {
      // Unknown ptyId → findWorkspaceIdForPty returns null → drop.
      captured.restarted!({ sessionId: 'pty-unknown', restartCount: 1, consecutiveFailures: 0, exitCode: 0 });
      await flushMicrotasks();

      expect(pollRestarted()).toHaveLength(0);
    } finally {
      router.stop();
    }
  });
});

describe('DaemonNotificationRouter — pane.supervision tee', () => {
  it('emits pane.supervision on a guard trip (stopped)', async () => {
    const { router, captured } = makeRouter();
    try {
      captured.supervision!({
        sessionId: 'pty-a',
        status: 'stopped',
        reason: 'guard-trip',
        restartCount: 5,
        consecutiveFailures: 5,
      });
      await flushMicrotasks();

      const events = pollSupervision();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'pane.supervision',
        workspaceId: 'ws-1',
        ptyId: 'pty-a',
        status: 'stopped',
        reason: 'guard-trip',
      });
    } finally {
      router.stop();
    }
  });

  it('emits pane.supervision on a manual rearm (armed)', async () => {
    const { router, captured } = makeRouter();
    try {
      captured.supervision!({
        sessionId: 'pty-a',
        status: 'armed',
        reason: 'rearm',
        restartCount: 0,
        consecutiveFailures: 0,
      });
      await flushMicrotasks();

      expect(pollSupervision()[0]).toMatchObject({ status: 'armed', reason: 'rearm' });
    } finally {
      router.stop();
    }
  });

  it('drops the event when the workspace cannot be resolved', async () => {
    const { router, captured } = makeRouter();
    try {
      captured.supervision!({
        sessionId: 'pty-unknown',
        status: 'stopped',
        reason: 'manual-stop',
        restartCount: 0,
        consecutiveFailures: 0,
      });
      await flushMicrotasks();

      expect(pollSupervision()).toHaveLength(0);
    } finally {
      router.stop();
    }
  });
});
