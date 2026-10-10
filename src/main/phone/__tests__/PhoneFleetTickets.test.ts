import { beforeEach, describe, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: send }));
import { fitSidebarToBudget, handlePhoneWorkspaces } from '../PhoneWorkspaces';
import { PhoneFleetTicketStore } from '../PhoneFleetTicketStore';
import type { PhoneSidebarSnapshot } from '../../../shared/phoneFleetSidebar';
import type { PhoneFleetTicket, PhoneFleetTicketDetail } from '../../../shared/phoneFleetTickets';

const T = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ticket = (id: string, over: Partial<PhoneFleetTicket> = {}): PhoneFleetTicket => ({
  id, origin: 'manual', workspaceId: 'ws-1', title: `Job ${id}`, state: 'working', updatedAt: T, ...over,
});

beforeEach(() => send.mockReset());

describe('PhoneFleetTicketStore', () => {
  it('keeps the request and evidence once the mirror loses them, and replaces the report on a new version', () => {
    const store = new PhoneFleetTicketStore();
    const full: PhoneFleetTicketDetail = { id: 'a', updatedAt: T, request: 'do it', result: 'done', verification: '1/1', verificationItems: [{ kind: 'command', status: 'passed', summary: 's', command: 'npm test' }] };
    store.remember([ticket('a', { workspaceName: 'Alpha' })], [full], T);
    // The daemon dropped the task: the projection now has the link's report only.
    store.remember([ticket('a')], [{ id: 'a', updatedAt: T, result: 'done' }], T + 1);
    expect(store.detail('a', T + 1)).toEqual(full);
    // Reopened and finished again: a new report, the same request.
    store.remember([ticket('a', { updatedAt: T + 5 })], [{ id: 'a', updatedAt: T + 5, result: 'redone' }], T + 6);
    expect(store.detail('a', T + 6)).toEqual({ id: 'a', updatedAt: T + 5, request: 'do it', result: 'redone' });
    // The workspace closed: its name is remembered for the list.
    expect(store.withWorkspaceNames([ticket('a'), ticket('b')])).toEqual([ticket('a', { workspaceName: 'Alpha' }), ticket('b')]);
  });

  it('forgets a ticket unseen for 24 h, and the least recently seen over the bound', () => {
    const store = new PhoneFleetTicketStore(3);
    store.remember(['1', '2', '3', '4'].map((id) => ticket(id)), [], T);
    expect(store.size).toBe(3);
    expect(store.detail('1', T)).toBeUndefined();
    store.remember([ticket('4')], [], T + DAY);
    expect(store.detail('2', T + DAY + 1)).toBeUndefined();
    expect(store.detail('4', T + DAY + 1)).toEqual({ id: '4', updatedAt: T });
  });
});

describe('workspaces.fleetTicket', () => {
  const sidebarWith = (tickets: PhoneFleetTicket[], details: unknown[]) => ({
    activeWorkspaceId: null, workspaces: [], panes: [], fleetTickets: tickets, fleetTicketDetails: details,
  });

  it('keeps the details from a list poll, never forwards them, and answers the detail from memory', async () => {
    const detail = { id: 'wl-poll', updatedAt: T, request: 'line one\nline two', result: 'ok' };
    send.mockImplementation(async (_w: unknown, method: string) => method === 'workspace.list' ? [] : sidebarWith([ticket('wl-poll', { requestLine: 'line one' })], [detail]));
    const list = await handlePhoneWorkspaces('workspaces.list', {}, () => null) as { sidebar: Record<string, unknown> };
    expect(list.sidebar.fleetTickets).toEqual([ticket('wl-poll', { requestLine: 'line one' })]);
    expect(JSON.stringify(list)).not.toContain('line two');
    send.mockReset();
    expect(await handlePhoneWorkspaces('workspaces.fleetTicket', { id: 'wl-poll' }, () => null)).toEqual({ ticket: detail });
    expect(send).not.toHaveBeenCalled();
  });

  it('asks the renderer once on a miss, and answers notFound for an unknown or invalid id', async () => {
    send.mockResolvedValue(sidebarWith([ticket('wl-fresh')], [{ id: 'wl-fresh', updatedAt: T, request: 'hi' }]));
    expect(await handlePhoneWorkspaces('workspaces.fleetTicket', { id: 'wl-fresh' }, () => null)).toEqual({ ticket: { id: 'wl-fresh', updatedAt: T, request: 'hi' } });
    expect(send).toHaveBeenCalledWith(expect.any(Function), 'workspace.phoneSidebar', {}, { timeoutMs: 1500 });
    expect(await handlePhoneWorkspaces('workspaces.fleetTicket', { id: 'wl-nope' }, () => null)).toEqual({ notFound: true });
    send.mockReset();
    expect(await handlePhoneWorkspaces('workspaces.fleetTicket', { id: { toString: 'x' } }, () => null)).toEqual({ notFound: true });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('fitSidebarToBudget — Fleet tickets', () => {
  it('drops the ticket text first, then the tickets whole, before Moa jobs and hand-offs', () => {
    const base = { workspaces: [{ id: 'ws-1', name: 'One', sessionId: 'pty-0' }] };
    const sidebar: PhoneSidebarSnapshot = {
      activeWorkspaceId: null,
      workspaces: [{ id: 'ws-1', order: 0, pinned: false }],
      panes: [],
      moaDelegations: [{ taskId: 'task-1', workspaceId: 'ws-1', agentName: 'Codex CLI', title: 'Ship it', state: 'working', since: T }],
      fleetTickets: [ticket('a', { requestLine: 'r'.repeat(160), resultSummary: 's'.repeat(240), verification: '1/2' })],
      nextScheduleAt: T,
    };
    const size = (candidate: PhoneSidebarSnapshot) => Buffer.byteLength(JSON.stringify({ ...base, sidebar: candidate }));
    const reasons: string[] = [];
    const textless = fitSidebarToBudget(base, sidebar, size(sidebar) - 1, (r) => reasons.push(r))!;
    expect(textless.fleetTickets).toEqual([ticket('a')]);
    expect(textless.moaDelegations).toEqual(sidebar.moaDelegations);
    expect(reasons).toEqual(['budget.fleetTicketText']);
    const none = fitSidebarToBudget(base, sidebar, size(textless) - 1)!;
    expect(none).not.toHaveProperty('fleetTickets');
    expect(none.moaDelegations).toEqual(sidebar.moaDelegations);
    expect(none.nextScheduleAt).toBe(T);
  });
});
