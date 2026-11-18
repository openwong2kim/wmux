// The desktop notification for a remote approval carried out on this PC:
// "<PC> allowed|denied <tool> in <pane>". The daemon sends the line already
// made (REMOTE_APPROVAL_DONE_EVENT, daemon/a2aRemote/approvalNotice.ts) and
// never a command; this reads only that line, the decision and the pane to
// jump to.

import type { BrowserWindow } from 'electron';
import type { NotificationPayload } from '../notification/sendNotification';
import { dispatchNotification } from '../notification/dispatchNotification';
import type { DaemonClient } from '../DaemonClient';

/** Mirrors daemon/a2aRemote/approvalNotice.ts (main does not import daemon code). */
export const REMOTE_APPROVAL_DONE_EVENT = 'a2a.remote.approval.done';

const PTY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TEXT_MAX = 300;

/** The notification for one event's data; null when it is not one. */
export function remoteApprovalNotification(data: unknown): { ptyId: string | null; payload: NotificationPayload } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d['text'] !== 'string' || d['text'].length === 0 || d['text'].length > TEXT_MAX) return null;
  if (d['decision'] !== 'allow' && d['decision'] !== 'deny') return null;
  const ptyId = typeof d['ptyId'] === 'string' && PTY_ID_RE.test(d['ptyId']) ? d['ptyId'] : null;
  return {
    ptyId,
    payload: {
      type: 'info',
      title: d['text'],
      body: 'A paired PC answered a permission prompt in a task it sent here.',
      category: 'approval',
    },
  };
}

export function registerRemoteApprovalNotifications(daemonClient: DaemonClient | undefined, getWindow: () => BrowserWindow | null): () => void {
  if (!daemonClient) return () => undefined;
  const onEvent = (event: { type?: unknown; data?: unknown }): void => {
    if (event.type !== REMOTE_APPROVAL_DONE_EVENT) return;
    const shown = remoteApprovalNotification(event.data);
    if (shown) dispatchNotification(getWindow(), shown.ptyId, shown.payload, { ptyId: shown.ptyId });
  };
  daemonClient.on('event', onEvent);
  return () => {
    daemonClient.off('event', onEvent);
  };
}
