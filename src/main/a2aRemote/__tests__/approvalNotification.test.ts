// The desktop notification for another PC's allow or deny typed into a pane here.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../notification/dispatchNotification', () => ({ dispatchNotification: vi.fn() }));

import { dispatchNotification } from '../../notification/dispatchNotification';
import { registerRemoteApprovalNotifications, remoteApprovalNotification, REMOTE_APPROVAL_DONE_EVENT } from '../approvalNotification';
import { REMOTE_APPROVAL_DONE_EVENT as DAEMON_EVENT } from '../../../daemon/a2aRemote/approvalNotice';
import type { DaemonClient } from '../../DaemonClient';

describe('remoteApprovalNotification', () => {
  it('shows the daemon\'s line as the title; nothing else from the event reaches it', () => {
    const shown = remoteApprovalNotification({ taskId: 't', ptyId: 'pty-1', decision: 'allow', text: 'Mac allowed Bash in Backend', command: 'rm -rf / # COMMAND-TEXT' });
    expect(shown).toEqual({
      ptyId: 'pty-1',
      payload: { type: 'info', title: 'Mac allowed Bash in Backend', body: 'A paired PC answered a permission prompt in a task it sent here.', category: 'approval' },
    });
    expect(JSON.stringify(shown)).not.toContain('COMMAND-TEXT');
  });

  it('anything not shaped as the daemon makes it shows nothing', () => {
    for (const bad of [null, [], { text: '', decision: 'allow' }, { text: 'x', decision: 'maybe' }, { text: 'x'.repeat(301), decision: 'deny' }]) {
      expect(remoteApprovalNotification(bad)).toBeNull();
    }
    expect(remoteApprovalNotification({ text: 'x', decision: 'deny', ptyId: '../evil' })?.ptyId).toBeNull();
  });

  it('listens for the daemon\'s event name, and raises one notification per event', () => {
    expect(REMOTE_APPROVAL_DONE_EVENT).toBe(DAEMON_EVENT);
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
