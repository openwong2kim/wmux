// @vitest-environment jsdom
//
// A delegated agent's permission prompt is answered in Moa's "Waiting on you":
// Allow once / Don't allow, once, through the operator's press path. A prompt
// the daemon could not bind keeps only the jump to its pane.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoaWaitingOnYou, NEEDS_YOU_TEXT, type DelegatedAnswer } from '../MoaWaitingOnYou';
import type { MoaDelegatedApproval } from '../../../../../shared/moa';
import type { MoaMemoryCardApi } from '../../MoaMemoryCard';

let container: HTMLDivElement;
let root: Root;
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;
const memoryApi: MoaMemoryCardApi = {
  memoryCard: async () => ({ card: null }),
  memoryResolve: async () => ({ ok: true }),
  onChanged: () => () => undefined,
};
const FP = 'f'.repeat(32);
const bound: MoaDelegatedApproval = {
  id: 'ap1', ptyId: 'pty-w', workspaceId: 'ws-w', workspaceName: 'demo-repo', agentName: 'Claude Code',
  toolName: 'Bash', what: 'node test.js', createdAt: 1,
  choices: [{ key: '1', label: 'Yes', decision: 'approve' }, { key: '3', label: 'No', decision: 'deny' }],
  promptFingerprint: FP,
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = async (delegatedApprovals: MoaDelegatedApproval[], delegatedAnswer?: DelegatedAnswer) =>
  act(async () => root.render(createElement(MoaWaitingOnYou, {
    decisions: [], onResolve: vi.fn(), delegatedApprovals, onOpenPty: vi.fn(), memoryApi, t,
    ...(delegatedAnswer ? { delegatedAnswer } : {}),
  })));
const click = async (el: Element | null) => act(async () => { (el as HTMLButtonElement).click(); });

describe('MoaWaitingOnYou — answering a delegated prompt in place', () => {
  it('Allow once presses the plain Yes with the fingerprint, and the row leaves', async () => {
    const answer = vi.fn<DelegatedAnswer>(async () => ({ ok: true }));
    await render([bound], answer);
    await click(container.querySelector('[data-moa-delegated-approval-allow]'));
    expect(answer).toHaveBeenCalledWith({ approvalId: 'ap1', choiceKey: '1', promptFingerprint: FP });
    expect(container.querySelector('[data-moa-delegated-approval="ap1"]')).toBeNull();
    expect(container.querySelector('[data-moa-waiting]')?.className).toBe('hidden');
  });

  it('Don\'t allow presses the No; answered elsewhere a moment ago, the row leaves without an error', async () => {
    const answer = vi.fn<DelegatedAnswer>(async () => ({ ok: false, code: 'not_pending' }));
    await render([bound], answer);
    await click(container.querySelector('[data-moa-delegated-approval-deny]'));
    expect(answer).toHaveBeenCalledWith({ approvalId: 'ap1', choiceKey: '3', promptFingerprint: FP });
    expect(container.querySelector('[data-moa-delegated-approval="ap1"]')).toBeNull();
  });

  it('too soon says try again; a failure says to answer in the pane, and the buttons work again', async () => {
    const answer = vi.fn<DelegatedAnswer>()
      .mockResolvedValueOnce({ ok: false, code: 'answer_too_soon' })
      .mockResolvedValueOnce({ ok: false, code: 'error' });
    await render([bound], answer);
    await click(container.querySelector('[data-moa-delegated-approval-allow]'));
    expect(container.querySelector('[data-moa-delegated-approval-notice]')?.textContent).toBe('moa.panel.approvalTooSoon');
    await click(container.querySelector('[data-moa-delegated-approval-allow]'));
    const notice = container.querySelector('[data-moa-delegated-approval-notice="error"]');
    expect(notice?.textContent).toBe('moa.panel.delegatedAnswerFailed');
    expect(notice?.getAttribute('role')).toBe('alert');
    expect((container.querySelector('[data-moa-delegated-approval-allow]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a prompt the daemon could not bind offers no answer, only the pane', async () => {
    const answer = vi.fn<DelegatedAnswer>();
    const { choices: _c, promptFingerprint: _f, ...unbound } = bound;
    await render([unbound], answer);
    expect(container.querySelector('[data-moa-delegated-approval-allow], [data-moa-delegated-approval-deny]')).toBeNull();
    expect(container.querySelector('[data-moa-delegated-approval-open]')).not.toBeNull();
  });

  it('the yellow eyebrow and count use the readable needs-you text colour', async () => {
    await render([bound], vi.fn<DelegatedAnswer>());
    const eyebrow = container.querySelector('[data-moa-delegated-approval="ap1"] > div');
    expect(eyebrow?.className).toContain(NEEDS_YOU_TEXT);
    expect(container.querySelector('#moa-waiting-title span')?.className).toContain(NEEDS_YOU_TEXT);
    expect(container.innerHTML).not.toContain('text-[var(--accent-yellow)]');
  });
});
