// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TicketDetail } from '../TicketList';
import type { FleetTicket } from '../fleetTickets';
import { t } from '../../../i18n';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial: FleetTicket = {
  id: 'link-1', title: 'Fix login', workspaceId: 'ws-1', a2aTaskId: 'task-1',
  state: 'done', decisionIds: [], origin: 'moa', updatedAt: 100,
};

function reply(summary: string): unknown {
  return { ok: true, result: { task: {
    status: { state: 'completed', evidence: { summary, items: [] } },
  } } };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
const invoke = vi.fn();
const shown = vi.fn();
const noop = () => undefined;

async function render(ticket: FleetTicket): Promise<void> {
  await act(async () => root.render(createElement(TicketDetail, {
    ticket, assignee: 'Claude', decisions: [], onJump: noop, onOpenDecision: noop, onResultShown: shown, t,
  })));
}

beforeEach(() => {
  invoke.mockReset();
  shown.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { rpc: { invoke } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('TicketDetail report identity', () => {
  it('keeps the loaded result when unrelated ticket text changes', async () => {
    invoke.mockResolvedValueOnce(reply('Current report'));
    await render(initial);
    await render({ ...initial, title: 'A clearer task title' });
    expect(container.textContent).toContain('Current report');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('uses a current persisted report without a query', async () => {
    const ticket = { ...initial, result: { summary: 'Persisted current report' } };
    await render(ticket);
    expect(container.textContent).toContain('Persisted current report');
    expect(invoke).not.toHaveBeenCalled();
    expect(shown).toHaveBeenCalledWith(ticket);
  });

  it('does not mark a new report read while displaying the previous revision', async () => {
    const next = deferred();
    invoke.mockResolvedValueOnce(reply('Old report')).mockReturnValueOnce(next.promise);
    await render(initial);
    expect(container.textContent).toContain('Old report');
    shown.mockClear();

    const updated = { ...initial, updatedAt: 200 };
    await render(updated);
    expect(container.querySelector('[data-fleet-ticket-result]')).toBeNull();
    expect(shown).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);

    await act(async () => next.resolve(reply('New report')));
    expect(container.textContent).toContain('New report');
    expect(shown).toHaveBeenCalledWith(updated);
  });

  it('ignores an old request that resolves after the report revision changes', async () => {
    const old = deferred();
    const next = deferred();
    invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await render(initial);
    const updated = { ...initial, updatedAt: 200 };
    await render(updated);

    await act(async () => old.resolve(reply('Late old report')));
    expect(container.querySelector('[data-fleet-ticket-result]')).toBeNull();
    expect(shown).not.toHaveBeenCalled();

    await act(async () => next.resolve(reply('Current report')));
    expect(container.textContent).toContain('Current report');
    expect(shown).toHaveBeenCalledWith(updated);
  });

  it('does not reuse a missing-report response for a later report', async () => {
    const next = deferred();
    invoke.mockResolvedValueOnce({ ok: true, result: { error: 'task not found' } }).mockReturnValueOnce(next.promise);
    await render(initial);
    expect(container.querySelector('[data-fleet-ticket-result-gone]')).not.toBeNull();
    shown.mockClear();

    await render({ ...initial, updatedAt: 200 });
    expect(container.querySelector('[data-fleet-ticket-result-gone]')).toBeNull();
    expect(shown).not.toHaveBeenCalled();
  });

  it.each([
    { a2aTaskId: 'task-2' },
    { workspaceId: 'ws-2' },
    { state: 'failed' as const },
  ])('does not reuse a report for a changed query identity: %o', async (change) => {
    const next = deferred();
    invoke.mockResolvedValueOnce(reply('Old report')).mockReturnValueOnce(next.promise);
    await render(initial);
    shown.mockClear();
    await render({ ...initial, ...change });
    expect(container.querySelector('[data-fleet-ticket-result]')).toBeNull();
    expect(shown).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('hides a completed report while the ticket is working again', async () => {
    invoke.mockResolvedValueOnce(reply('Old report'));
    await render(initial);
    shown.mockClear();
    await render({ ...initial, state: 'working', updatedAt: 200 });
    expect(container.querySelector('[data-fleet-ticket-result]')).toBeNull();
    expect(shown).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('TicketDetail state word', () => {
  it('says a job that reported back waits on its sender, not that it is working', async () => {
    await render({ ...initial, state: 'working', waitingOn: { workspaceId: 'ws-1', paneId: 'pane-ceo' } });
    expect(container.textContent).toContain(t('fleet.ticket.waitingOnSender'));
    expect(container.textContent).not.toContain(t('fleet.ticket.state.working'));
  });
});
