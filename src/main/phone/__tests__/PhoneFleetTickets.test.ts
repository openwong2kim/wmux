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
  const full: PhoneFleetTicketDetail = { id: 'a', updatedAt: T, request: 'do it', result: 'done', verification: '1/1', verificationItems: [{ kind: 'command', status: 'passed', summary: 's', command: 'npm test' }] };

  it('keeps the request and evidence once the mirror loses them, across a new version too', () => {
    const store = new PhoneFleetTicketStore();
    store.remember([ticket('a', { state: 'done', workspaceName: 'Alpha' })], [full], T);
    // The daemon dropped the task: the projection now has the link's report only.
    store.remember([ticket('a', { state: 'done' })], [{ id: 'a', updatedAt: T, result: 'done' }], T + 1);
    expect(store.detail('a', T + 1)).toEqual(full);
    // A later change (a PR merged): the evidence the projection no longer has stays.
    store.remember([ticket('a', { state: 'done', updatedAt: T + 5 })], [{ id: 'a', updatedAt: T + 5, result: 'done again' }], T + 6);
    expect(store.detail('a', T + 6)).toEqual({ ...full, updatedAt: T + 5, result: 'done again' });
    // The workspace closed: its name is remembered for the list.
    expect(store.withWorkspaceNames([ticket('a'), ticket('b')])).toEqual([ticket('a', { workspaceName: 'Alpha' }), ticket('b')]);
  });

  it('ignores a snapshot whose version went backwards, and drops the report of a reopened ticket', () => {
    const store = new PhoneFleetTicketStore();
    store.remember([ticket('a', { state: 'done', updatedAt: T + 10 })], [{ ...full, updatedAt: T + 10 }], T);
    store.remember([ticket('a', { state: 'working', updatedAt: T })], [{ id: 'a', updatedAt: T, request: 'stale' }], T + 1);
    expect(store.detail('a', T + 1)).toEqual({ ...full, updatedAt: T + 10 });
    store.remember([ticket('a', { state: 'working', updatedAt: T + 20 })], [{ id: 'a', updatedAt: T + 20 }], T + 2);
    expect(store.detail('a', T + 2)).toEqual({ id: 'a', updatedAt: T + 20, request: 'do it' });
  });

  it("expires a finished ticket 24 h after its own last change, like the list, however recently it was seen", () => {
    const store = new PhoneFleetTicketStore();
    store.remember([ticket('done', { state: 'done' }), ticket('open')], [], T + DAY);
    expect(store.detail('done', T + DAY + 1)).toBeUndefined();
    expect(store.detail('open', T + DAY + 1)).toEqual({ id: 'open', updatedAt: T });
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
    // Finished just now: the real clock is inside its 24-hour window.
    const at = Date.now();
    const detail = { id: 'wl-poll', updatedAt: at, request: 'line one\nline two', result: 'ok' };
    send.mockImplementation(async (_w: unknown, method: string) => method === 'workspace.list' ? [] : sidebarWith([ticket('wl-poll', { state: 'done', updatedAt: at, requestLine: 'line one' })], [detail]));
    const list = await handlePhoneWorkspaces('workspaces.list', {}, () => null) as { sidebar: Record<string, unknown> };
    expect(list.sidebar.fleetTickets).toEqual([ticket('wl-poll', { state: 'done', updatedAt: at, requestLine: 'line one' })]);
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
    // A repeated miss within seconds never reaches the renderer.
    expect(await handlePhoneWorkspaces('workspaces.fleetTicket', { id: 'wl-nope' }, () => null)).toEqual({ notFound: true });
    expect(send).not.toHaveBeenCalled();
    expect(await handlePhoneWorkspaces('workspaces.fleetTicket', { id: { toString: 'x' } }, () => null)).toEqual({ notFound: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('answers unavailable, not notFound, when the renderer fails or cannot compute tickets', async () => {
    send.mockRejectedValue(new Error('RPC timeout'));
    expect(await handlePhoneWorkspaces('workspaces.fleetTicket', { id: 'wl-slow' }, () => null)).toEqual({ unavailable: true });
    send.mockResolvedValue({ activeWorkspaceId: null, workspaces: [], panes: [] });
    expect(await handlePhoneWorkspaces('workspaces.fleetTicket', { id: 'wl-slow' }, () => null)).toEqual({ unavailable: true });
    // Neither counted as a miss: the next lookup asks again.
    send.mockResolvedValue(sidebarWith([ticket('wl-slow')], []));
    expect(await handlePhoneWorkspaces('workspaces.fleetTicket', { id: 'wl-slow' }, () => null)).toEqual({ ticket: { id: 'wl-slow', updatedAt: T } });
  });
});

describe('fitSidebarToBudget — Fleet tickets', () => {
  it('cuts the tickets before any older field, so a layout that fit before still arrives', () => {
    const base = { workspaces: [{ id: 'ws-1', name: 'One', sessionId: 'pty-0' }] };
    const layout = { root: { kind: 'leaf' as const, paneId: 'p-0', surfaces: [{ surfaceId: 'sf-0', kind: 'terminal' as const, ptyId: 'pty-0' }], activeIndex: 0 } };
    const old: PhoneSidebarSnapshot = { activeWorkspaceId: null, workspaces: [{ id: 'ws-1', order: 0, pinned: false, layout }], panes: [] };
    const size = (candidate: PhoneSidebarSnapshot) => Buffer.byteLength(JSON.stringify({ ...base, sidebar: candidate }));
    const withTickets: PhoneSidebarSnapshot = { ...old, fleetTickets: Array.from({ length: 5 }, (_, i) => ticket(`t${i}`, { requestLine: 'r'.repeat(160) })) };
    const reasons: string[] = [];
    expect(fitSidebarToBudget(base, withTickets, size(old), (r) => reasons.push(r))).toEqual(old);
    expect(reasons).toEqual(['budget.fleetTicketText', 'budget.fleetTickets']);
  });

  it('drops the ticket text (title included) first, then the tickets whole, before Moa jobs', () => {
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
    expect(textless.fleetTickets).toEqual([ticket('a', { title: 'Task' })]);
    expect(textless.moaDelegations).toEqual(sidebar.moaDelegations);
    expect(reasons).toEqual(['budget.fleetTicketText']);
    const none = fitSidebarToBudget(base, sidebar, size(textless) - 1)!;
    expect(none).not.toHaveProperty('fleetTickets');
    expect(none.moaDelegations).toEqual(sidebar.moaDelegations);
    expect(none.nextScheduleAt).toBe(T);
  });
});
