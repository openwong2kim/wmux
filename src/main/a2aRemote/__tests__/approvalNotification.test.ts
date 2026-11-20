// The desktop notification for another PC's allow or deny typed into a pane here.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../notification/dispatchNotification', () => ({ dispatchNotification: vi.fn() }));

import { dispatchNotification } from '../../notification/dispatchNotification';
import { registerRemoteApprovalNotifications, remoteApprovalNotification } from '../approvalNotification';
import { REMOTE_APPROVAL_DONE_EVENT } from '../../../shared/a2aRemote';
import { describeNotification } from '../../../renderer/components/Notification/NotificationPanel';
import type { Notification } from '../../../shared/types';
import type { DaemonClient } from '../../DaemonClient';

describe('remoteApprovalNotification', () => {
  it('shows the daemon\'s line as the title; nothing else from the event reaches it', () => {
    const shown = remoteApprovalNotification({ taskId: 't', ptyId: 'pty-1', decision: 'allow', text: 'Mac allowed Bash in Backend', command: 'rm -rf / # COMMAND-TEXT' });
    expect(shown).toEqual({
      ptyId: 'pty-1',
      payload: { type: 'info', title: 'Mac allowed Bash in Backend', body: 'A paired PC answered a permission prompt in a task it sent here.', category: 'system' },
    });
    expect(JSON.stringify(shown)).not.toContain('COMMAND-TEXT');
  });

  it('anything not shaped as the daemon makes it shows nothing', () => {
    for (const bad of [null, [], { text: '', decision: 'allow' }, { text: 'x', decision: 'maybe' }, { text: 'x'.repeat(301), decision: 'deny' }]) {
      expect(remoteApprovalNotification(bad)).toBeNull();
    }
    expect(remoteApprovalNotification({ text: 'x', decision: 'deny', ptyId: '../evil' })?.ptyId).toBeNull();
  });

  it('is a record, not a decision waiting: the panel shows the line as written, not a needs-you row', () => {
    const shown = remoteApprovalNotification({ ptyId: 'pty-1', decision: 'deny', text: 'Mac denied Bash in Backend' })!;
    expect(shown.payload.category).not.toBe('approval');
    const row: Notification = { id: 'n1', ptyId: 'pty-1', workspaceId: 'ws', type: shown.payload.type, title: shown.payload.title, body: shown.payload.body, category: shown.payload.category, timestamp: 1, read: false };
    const state = { workspaces: [], surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'awaiting_input' as const } }, surfaceAgentStatus: {}, surfacePendingQuestion: { 'pty-1': 'Allow?' } };
    expect(describeNotification(row, state as never, (k) => k, true).title).toBe('Mac denied Bash in Backend');
  });

  it('listens for the daemon\'s event name, and raises one notification per event', () => {
    let listener: ((e: { type?: unknown; data?: unknown }) => void) | undefined;
    const client = { on: vi.fn((_n: string, fn: typeof listener) => { listener = fn; }), off: vi.fn() } as unknown as DaemonClient;
    const off = registerRemoteApprovalNotifications(client, () => null);
    listener!({ type: 'other', data: { text: 'x', decision: 'deny' } });
    listener!({ type: REMOTE_APPROVAL_DONE_EVENT, data: { text: 'Mac denied Read in Backend', decision: 'deny' } });
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    off();
    expect(client.off).toHaveBeenCalled();
  });
});
