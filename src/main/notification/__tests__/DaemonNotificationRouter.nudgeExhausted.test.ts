// Channels v2 — tests for the wake worker's HUMAN HANDOFF surface:
//   channel:nudgeExhausted → in-app/OS notification + EventBus tee
//   `channel.nudgeExhausted` (scoped to the affected member's workspace).
//
// The wake worker promises "budget exhausted → hand to humans"; this file
// pins the main-side half of that promise (the daemon-side broadcast is
// covered by channelWakeWorker.test.ts). Mirrors the mocking approach of
// DaemonNotificationRouter.supervision.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DaemonClient } from '../../DaemonClient';
import { eventBus } from '../../events/EventBus';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

vi.mock('../../pipe/handlers/notify.rpc', () => ({
  toastManager: { show: vi.fn() },
}));

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: vi.fn(),
}));

vi.mock('../sendNotification', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../idleSuppression', () => ({
  recentlySuppressed: vi.fn().mockReturnValue(false),
  clearPty: vi.fn(),
}));

vi.mock('../../pipe/handlers/_bridge', () => ({
  sendToRenderer: vi.fn().mockResolvedValue([]),
}));

import { toastManager } from '../../pipe/handlers/notify.rpc';
import { sendNotification } from '../sendNotification';
import { DaemonNotificationRouter } from '../DaemonNotificationRouter';

const toastShowMock = vi.mocked(toastManager.show);
const sendNotificationMock = vi.mocked(sendNotification);

type NudgeListener = (payload: { data: unknown }) => void;

function makeRouter() {
  let captured: NudgeListener | undefined;
  const fakeDaemon = {
    on: vi.fn((event: string, cb: (payload: never) => void) => {
      if (event === 'channel:nudgeExhausted') captured = cb as NudgeListener;
    }),
    off: vi.fn(),
  } as unknown as DaemonClient;
  const router = new DaemonNotificationRouter(fakeDaemon, () => null);
  router.start();
  return { router, fire: (data: unknown) => captured?.({ data }) };
}

const pollExhausted = () => eventBus.poll(0, { types: ['channel.nudgeExhausted'] }).events;

beforeEach(() => {
  toastShowMock.mockReset();
  sendNotificationMock.mockReset();
  eventBus.reset();
});

afterEach(() => {
  eventBus.reset();
});

describe('DaemonNotificationRouter — channel.nudgeExhausted (human handoff)', () => {
  it('surfaces the exhaustion to humans (toast + notification) AND tees it onto the EventBus', () => {
    const { router, fire } = makeRouter();
    try {
      fire({
        type: 'channel.nudgeExhausted',
        channelId: 'ch-1',
        channelName: 'general',
        workspaceId: 'ws-b',
        memberId: 'codex',
        unread: 3,
        mentionUnread: 2,
      });

      // Human surfaces: an in-app/OS toast pointing at the affected workspace.
      expect(toastShowMock).toHaveBeenCalledTimes(1);
      const [title, body, opts] = toastShowMock.mock.calls[0];
      expect(String(title)).toContain('#general');
      expect(String(title)).toContain('codex');
      expect(String(body)).toContain('2 mentions');
      expect(opts).toMatchObject({ workspaceId: 'ws-b' });
      expect(sendNotificationMock).toHaveBeenCalledTimes(1);

      // Orchestrator surface: the EventBus tee, scoped to the member's ws.
      const events = pollExhausted();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'channel.nudgeExhausted',
        channelId: 'ch-1',
        channelName: 'general',
        memberId: 'codex',
        unread: 3,
        mentionUnread: 2,
        workspaceId: 'ws-b',
      });
    } finally {
      router.stop();
    }
  });

  it('drops a malformed payload (no throw, no toast, no bus entry)', () => {
    const { router, fire } = makeRouter();
    try {
      expect(() => fire({ channelId: '', workspaceId: 'ws-b' })).not.toThrow();
      expect(() => fire(null)).not.toThrow();
      expect(() => fire({ channelId: 'ch-1', workspaceId: 'ws-b' })).not.toThrow(); // no memberId
      expect(toastShowMock).not.toHaveBeenCalled();
      expect(pollExhausted()).toHaveLength(0);
    } finally {
      router.stop();
    }
  });

  it('falls back to the channelId when the name is missing', () => {
    const { router, fire } = makeRouter();
    try {
      fire({ channelId: 'ch-9', workspaceId: 'ws-b', memberId: 'codex' });
      const [title] = toastShowMock.mock.calls[0];
      expect(String(title)).toContain('ch-9');
      expect(pollExhausted()[0]).toMatchObject({ channelName: 'ch-9', unread: 0, mentionUnread: 0 });
    } finally {
      router.stop();
    }
  });
});
