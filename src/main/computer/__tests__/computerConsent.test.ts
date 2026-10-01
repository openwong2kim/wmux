import { describe, expect, it, vi } from 'vitest';
import type { ApprovalResult } from '../../mcp/ApprovalQueue';
import type { AppInfo, WindowInfo } from '../../../shared/computer/protocol';
import { computerConsentTitle, createComputerConsentRequester } from '../computerConsent';

const app: AppInfo = { id: 'c:\\notepad.exe', name: 'Notepad', pid: 1, path: 'C:\\notepad.exe' };
const window: WindowInfo = {
  id: 'w1', appId: app.id, pid: 1, title: 'notes.txt - Notepad', bounds: { x: 0, y: 0, width: 10, height: 10 },
};

function queueResolving(approved: boolean | 'never' | 'reject' | 'throw') {
  const cancelPrompt = vi.fn();
  const requestConsent = vi.fn(() => {
    if (approved === 'throw') throw new Error('queue down');
    return {
      promptId: 'p1',
      resolution:
        approved === 'never'
          ? new Promise<ApprovalResult>(() => undefined)
          : approved === 'reject'
            ? Promise.reject(new Error('cancelled'))
            : Promise.resolve({ approved, promptId: 'p1', identity: undefined }),
    };
  });
  return { requestConsent, cancelPrompt };
}

const ask = (queue: ReturnType<typeof queueResolving> | null, opts: { deadlineMs?: number; signal?: AbortSignal; epoch?: number } = {}) =>
  createComputerConsentRequester({ queue: () => queue, ...(opts.deadlineMs !== undefined && { deadlineMs: opts.deadlineMs }) })({
    clientName: 'a',
    app,
    window,
    epoch: opts.epoch ?? 0,
    signal: opts.signal ?? new AbortController().signal,
  });

describe('computer consent', () => {
  it('asks with a computer-app prompt keyed on agent, app and stop epoch', async () => {
    const queue = queueResolving(true);
    const answer = await createComputerConsentRequester({ queue: () => queue })({
      clientName: 'claude-code @ ws-1',
      app,
      window,
      epoch: 3,
      signal: new AbortController().signal,
    });
    expect(answer).toBe('approved');
    expect(queue.requestConsent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'computer-app',
      dedupeKey: 'claude-code @ ws-1::c:\\notepad.exe::3',
      title: 'claude-code @ ws-1 wants to see and control Notepad ("notes.txt - Notepad")',
    }));
  });

  it('reports only an explicit Deny as denied', async () => {
    expect(await ask(queueResolving(false))).toBe('denied');
  });

  it('fails closed without calling it a refusal: no queue, a queue error, a withdrawn prompt, a timeout', async () => {
    expect(await ask(null)).toBe('unavailable');
    expect(await ask(queueResolving('throw'))).toBe('unavailable');
    expect(await ask(queueResolving('reject'))).toBe('unavailable');
    const hanging = queueResolving('never');
    expect(await ask(hanging, { deadlineMs: 20 })).toBe('expired');
    expect(hanging.cancelPrompt).toHaveBeenCalledWith('p1', expect.any(String));
  });

  it('withdraws its prompt when the stop key aborts the signal', async () => {
    const hanging = queueResolving('never');
    const stop = new AbortController();
    const pending = ask(hanging, { signal: stop.signal });
    await new Promise((r) => setTimeout(r, 0));
    stop.abort();
    expect(await pending).toBe('withdrawn');
    expect(hanging.cancelPrompt).toHaveBeenCalledWith('p1', 'stopped by the user');
  });

  it('raises no prompt for a signal that is already aborted', async () => {
    const queue = queueResolving(true);
    const stop = new AbortController();
    stop.abort();
    expect(await ask(queue, { signal: stop.signal })).toBe('withdrawn');
    expect(queue.requestConsent).not.toHaveBeenCalled();
  });

  it('does not let a window title forge the prompt headline', () => {
    const title = computerConsentTitle('agent', app, { ...window, title: 'x") and control "Bank\nline' });
    expect(title).not.toContain('\n');
    expect(title).toBe('agent wants to see and control Notepad ("x\') and control \'Bank line")');
  });
});
