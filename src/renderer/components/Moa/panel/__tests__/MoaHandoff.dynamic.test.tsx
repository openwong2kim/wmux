// @vitest-environment jsdom
//
// Moa's hand-off card (a "Waiting on you" row), the task card's hand-off
// details, and the auto hand-off receipts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoaWaitingOnYou } from '../MoaWaitingOnYou';
import { MoaTaskCards } from '../MoaTaskCards';
import { MoaHandoffReceipts } from '../MoaHandoffReceipts';
import type { MoaPendingDecision } from '../../../../../shared/moa';
import type { MoaHandoffCardInfo, MoaHandoffResolveResult } from '../../../../../shared/moaHandoff';
import type { WorkLink } from '../../../../../shared/workLink';

let container: HTMLDivElement;
let root: Root;
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

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

const info = (over: Partial<MoaHandoffCardInfo> = {}): MoaHandoffCardInfo => ({
  body: 'Fix the <b>flaky</b> test\nthen report back',
  title: 'Flaky test',
  agentName: 'Claude',
  targetPaneId: 'p1',
  targetPtyId: 'pty1',
  foldsNewlines: false,
  willQueue: false,
  ...over,
});

const handoffDecision = (id: string, over: Partial<MoaHandoffCardInfo> = {}): MoaPendingDecision => ({
  workspaceId: 'ws-t',
  workspaceName: 'Target',
  decision: { id, question: 'Hand off?', options: ['Hand off', 'Edit', 'Cancel'], context: '', raisedAt: 1 },
  handoff: info(over),
});

const render = async (decisions: MoaPendingDecision[], handoffResolve: (r: never) => Promise<MoaHandoffResolveResult>) => {
  await act(async () => root.render(createElement(MoaWaitingOnYou, {
    decisions, onResolve: vi.fn(), handoffResolve: handoffResolve as never, t,
  })));
};

const q = <E extends Element = HTMLButtonElement>(sel: string) => container.querySelector(sel) as E;

describe('MoaHandoffCard', () => {
  it('renders the target and the body as plain text, not markup', async () => {
    await render([handoffDecision('h1')], vi.fn());
    expect(q('[data-moa-handoff]')).not.toBeNull();
    expect(q('[data-moa-decision-option]')).toBeNull();
    expect(q('[data-moa-handoff-target]').textContent).toBe('moa.handoff.target(Claude,Target)');
    const body = q<HTMLElement>('[data-moa-handoff-body]');
    expect(body.textContent).toBe('Fix the <b>flaky</b> test\nthen report back');
    expect(body.querySelector('b')).toBeNull();
    expect(q('[data-moa-handoff-folds]')).toBeNull();
    expect(q('[data-moa-handoff-queue]')).toBeNull();
  });

  it('shows the one-line and queue warnings when main says so', async () => {
    await render([handoffDecision('h2', { foldsNewlines: true, willQueue: true })], vi.fn());
    expect(q('[data-moa-handoff-folds]').textContent).toBe('moa.handoff.foldsNewlines');
    expect(q('[data-moa-handoff-queue]').textContent).toBe('moa.handoff.willQueue(Claude)');
  });

  it('says why the hand-off waits for a click', async () => {
    await render([handoffDecision('h3', { askReason: 'hourly-cap' })], vi.fn());
    expect(q('[data-moa-handoff-reason="hourly-cap"]').textContent).toBe('moa.handoff.reason.hourly-cap');
  });

  it('Hand off sends no body (main delivers its own) and the row leaves', async () => {
    const resolve = vi.fn(async () => ({ ok: true, delivered: true }) as MoaHandoffResolveResult);
    await render([handoffDecision('h3')], resolve);
    await act(async () => { q('[data-moa-handoff-go]').click(); });
    expect(resolve).toHaveBeenCalledWith({ workspaceId: 'ws-t', id: 'h3', action: 'handoff' });
    expect('body' in (resolve.mock.calls[0] as unknown as [object])[0]).toBe(false);
    expect(q('[data-moa-handoff]')).toBeNull();
  });

  it('Edit sends the edited body; an empty edit is refused before any call', async () => {
    const resolve = vi.fn(async () => ({ ok: true, delivered: true }) as MoaHandoffResolveResult);
    await render([handoffDecision('h4')], resolve);
    await act(async () => { q('[data-moa-handoff-edit-open]').click(); });
    const area = q<HTMLTextAreaElement>('[data-moa-handoff-edit]');
    expect(area.value).toBe(info().body);
    const type = async (v: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, v);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await type('   ');
    await act(async () => { q('[data-moa-handoff-save]').click(); });
    expect(resolve).not.toHaveBeenCalled();
    expect(q('[data-moa-handoff-error]').textContent).toBe('moa.handoff.refusal.body_empty');
    await type('Only fix the test');
    await act(async () => { q('[data-moa-handoff-save]').click(); });
    expect(resolve).toHaveBeenCalledWith({ workspaceId: 'ws-t', id: 'h4', action: 'handoff', body: 'Only fix the test' });
  });

  it('Cancel sends cancel', async () => {
    const resolve = vi.fn(async () => ({ ok: true, delivered: false }) as MoaHandoffResolveResult);
    await render([handoffDecision('h5')], resolve);
    await act(async () => { q('[data-moa-handoff-cancel]').click(); });
    expect(resolve).toHaveBeenCalledWith({ workspaceId: 'ws-t', id: 'h5', action: 'cancel' });
    expect(q('[data-moa-handoff]')).toBeNull();
  });

  it('answered elsewhere (not_pending) leaves quietly; another failure stays with its message', async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'not_pending' })
      .mockResolvedValueOnce({ ok: false, code: 'error', message: 'Pane is gone' });
    await render([handoffDecision('h6'), handoffDecision('h7')], resolve);
    await act(async () => { q('[data-moa-decision="h6"] [data-moa-handoff-go]').click(); });
    expect(q('[data-moa-decision="h6"]')).toBeNull();
    expect(q('[role="alert"]')).toBeNull();
    await act(async () => { q('[data-moa-decision="h7"] [data-moa-handoff-go]').click(); });
    expect(q('[data-moa-decision="h7"]')).not.toBeNull();
    expect(q('[data-moa-handoff-error]').textContent).toBe('Pane is gone');
  });

  it('a hand-off that was not delivered shows main\'s note briefly, then leaves', async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn(async () => ({ ok: true, delivered: false, note: 'The pane closed.' }) as MoaHandoffResolveResult);
      await render([handoffDecision('h8')], resolve);
      await act(async () => { q('[data-moa-handoff-go]').click(); });
      expect(q('[data-moa-handoff-note]').textContent).toBe('The pane closed.');
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(q('[data-moa-handoff]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

const link = (id: string, over: Partial<WorkLink> = {}): WorkLink => ({
  id, origin: 'moa', owner: { workspaceId: 'ws-a', paneId: 'pane-a' }, state: 'running', decisionIds: [], createdAt: 1, updatedAt: 1, ...over,
});

describe('MoaTaskCards — hand-off details', () => {
  it('shows the worker\'s last question as text, the auto tag, Open pane and the A2A task id', async () => {
    const onOpenPane = vi.fn();
    await act(async () => root.render(createElement(MoaTaskCards, {
      links: [link('l1', { origin: 'moa-auto', a2aTaskId: 'task-123', lastQuestion: { text: 'Which <i>branch</i>?', at: 2 } })],
      pendingDecisions: [],
      workspaceName: () => 'Alpha',
      onOpenPane,
      t,
    })));
    expect(q('[data-moa-task-auto]').textContent).toBe('moa.panel.autoTag');
    await act(async () => { q('[data-moa-task-toggle]').click(); });
    const lastQ = q<HTMLElement>('[data-moa-task-last-question]');
    expect(lastQ.textContent).toBe('moa.panel.lastQuestion(Which <i>branch</i>?)');
    expect(lastQ.querySelector('i')).toBeNull();
    expect(q('[data-moa-task-a2a-id]').textContent).toContain('task-123');
    await act(async () => { q('[data-moa-task-open-pane]').click(); });
    expect(onOpenPane).toHaveBeenCalledWith('ws-a', 'pane-a');
  });

  it('plain (non-Moa) work gets none of it', async () => {
    await act(async () => root.render(createElement(MoaTaskCards, {
      links: [link('l2', { origin: 'manual', a2aTaskId: 'task-9', lastQuestion: { text: 'x', at: 2 } })],
      pendingDecisions: [], workspaceName: () => 'Alpha', onOpenPane: vi.fn(), t,
    })));
    await act(async () => { q('[data-moa-task-toggle]').click(); });
    expect(q('[data-moa-task-auto]')).toBeNull();
    expect(q('[data-moa-task-last-question]')).toBeNull();
    expect(q('[data-moa-task-open-pane]')).toBeNull();
    expect(q('[data-moa-task-a2a-id]')).toBeNull();
  });
});

describe('MoaHandoffReceipts', () => {
  const receipt = { id: 'r1', taskId: 'task-1', title: 'Fix CI', targetWorkspaceId: 'ws-t', targetWorkspaceName: 'Target', targetPaneId: 'p1', at: 5 };

  it('lists a receipt; Stop calls the api and says Stopped; Dismiss hides it', async () => {
    const api = {
      handoffReceipts: vi.fn(async () => ({ receipts: [receipt] })),
      handoffStop: vi.fn(async () => ({ ok: true })),
      onChanged: vi.fn(() => () => undefined),
    };
    const onOpenPane = vi.fn();
    await act(async () => root.render(createElement(MoaHandoffReceipts, { api, workspaceName: () => undefined, onOpenPane, t })));
    expect(q('[data-moa-handoff-receipt="r1"]').textContent).toContain('moa.receipts.line(Fix CI,Target)');
    await act(async () => { q('[data-moa-handoff-receipt-stop]').click(); });
    expect(api.handoffStop).toHaveBeenCalledWith({ id: 'r1' });
    expect(q('[data-moa-handoff-receipt-stopped]').textContent).toBe('moa.receipts.stopped');
    await act(async () => { q('[data-moa-handoff-receipt-open]').click(); });
    expect(onOpenPane).toHaveBeenCalledWith('ws-t', 'p1');
    await act(async () => { q('[data-moa-handoff-receipt-dismiss]').click(); });
    expect(q('[data-moa-handoff-receipts]')).toBeNull();
  });

  it('draws nothing with no receipts', async () => {
    const api = { handoffReceipts: vi.fn(async () => ({ receipts: [] })), handoffStop: vi.fn() };
    await act(async () => root.render(createElement(MoaHandoffReceipts, { api, workspaceName: () => undefined, t })));
    expect(q('[data-moa-handoff-receipts]')).toBeNull();
  });
});
