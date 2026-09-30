import { describe, expect, it, vi } from 'vitest';
import type { ApprovalResult } from '../../mcp/ApprovalQueue';
import type { AppInfo, WindowInfo } from '../../../shared/computer/protocol';
import { computerConsentTitle, createComputerConsentRequester } from '../computerConsent';

const app: AppInfo = { id: 'c:\\notepad.exe', name: 'Notepad', pid: 1, path: 'C:\\notepad.exe' };
const window: WindowInfo = {
  id: 'w1', appId: app.id, pid: 1, title: 'notes.txt - Notepad', bounds: { x: 0, y: 0, width: 10, height: 10 },
};

function queueResolving(approved: boolean | 'never' | 'reject') {
  const cancelPrompt = vi.fn();
  const requestConsent = vi.fn(() => ({
    promptId: 'p1',
    resolution:
      approved === 'never'
        ? new Promise<ApprovalResult>(() => undefined)
        : approved === 'reject'
          ? Promise.reject(new Error('cancelled'))
          : Promise.resolve({ approved, promptId: 'p1', identity: undefined }),
  }));
  return { requestConsent, cancelPrompt };
}

describe('computer consent', () => {
  it('asks with a computer-app prompt keyed on agent and app', async () => {
    const queue = queueResolving(true);
    const ask = createComputerConsentRequester({ queue: () => queue });
    expect(await ask({ clientName: 'claude-code @ ws-1', app, window })).toBe(true);
    expect(queue.requestConsent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'computer-app',
      dedupeKey: 'claude-code @ ws-1::c:\\notepad.exe',
      title: 'claude-code @ ws-1 wants to see and control Notepad ("notes.txt - Notepad")',
    }));
  });

  it('fails closed: no queue, a denial, a withdrawn prompt, or a timeout', async () => {
    expect(await createComputerConsentRequester({ queue: () => null })({ clientName: 'a', app, window })).toBe(false);
    expect(await createComputerConsentRequester({ queue: () => queueResolving(false) })({ clientName: 'a', app, window })).toBe(false);
    expect(await createComputerConsentRequester({ queue: () => queueResolving('reject') })({ clientName: 'a', app, window })).toBe(false);
    const hanging = queueResolving('never');
    const ask = createComputerConsentRequester({ queue: () => hanging, deadlineMs: 20 });
    expect(await ask({ clientName: 'a', app, window })).toBe(false);
    expect(hanging.cancelPrompt).toHaveBeenCalledWith('p1', expect.any(String));
  });

  it('does not let a window title forge the prompt headline', () => {
    const title = computerConsentTitle('agent', app, { ...window, title: 'x") and control "Bank\nline' });
    expect(title).not.toContain('\n');
    expect(title).toBe('agent wants to see and control Notepad ("x\') and control \'Bank line")');
  });
});
