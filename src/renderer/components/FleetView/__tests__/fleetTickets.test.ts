import { describe, expect, it } from 'vitest';
import type { WorkLink } from '../../../../shared/workLink';
import type { MoaPendingDecision } from '../../../../shared/moa';
import type { Task, TaskState } from '../../../../shared/types';
import { buildFleetTickets, openTicketFor, ticketIssueUrl, ticketStateOf, TICKET_RECENT_MS } from '../fleetTickets';

const NOW = 1_000_000_000_000;

function link(extra: Partial<WorkLink> = {}): WorkLink {
  return {
    id: 'wl-1', origin: 'moa', title: 'Fix the login redirect', a2aTaskId: 'task-1',
    owner: { workspaceId: 'ws-1', paneId: 'p1' }, agent: 'claude', state: 'running',
    decisionIds: [], createdAt: NOW - 1000, updatedAt: NOW - 1000,
    ...extra,
  };
}

function task(state: TaskState, extra: Partial<Task['status']> = {}): Task {
  return {
    kind: 'task', id: 'task-1', artifacts: [],
    history: [{ kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'Make /login redirect back.' }] }],
    metadata: { title: 'Fix the login redirect' } as Task['metadata'],
    status: { state, timestamp: new Date(NOW).toISOString(), ...extra },
  };
}

function decision(id: string, extra: Partial<MoaPendingDecision> = {}): MoaPendingDecision {
  return { workspaceId: 'ws-1', decision: { id, question: 'Merge it?', options: [], context: '', raisedAt: NOW - 500 }, ...extra };
}

describe('ticketStateOf', () => {
  it('maps a link to the five ticket states', () => {
    expect(ticketStateOf(link({ state: 'queued', a2aState: 'submitted' }), false)).toBe('queued');
    expect(ticketStateOf(link({ a2aState: 'working' }), false)).toBe('working');
    expect(ticketStateOf(link({ a2aState: 'working' }), true)).toBe('needs-you');
    expect(ticketStateOf(link({ a2aState: 'failed' }), false)).toBe('failed');
    expect(ticketStateOf(link({ a2aState: 'completed' }), false)).toBe('done');
    expect(ticketStateOf(link({ state: 'abandoned', manualClose: true }), false)).toBeNull();
  });
});

describe('buildFleetTickets', () => {
  it('a done ticket carries the worker\'s result and its verification', () => {
    const evidence = { summary: 'Redirect fixed; e2e passes.', items: [{ kind: 'command' as const, status: 'passed' as const, summary: 'unit tests', command: 'npm test' }] };
    const [ticket] = buildFleetTickets({
      links: [link({ a2aState: 'completed', state: 'done' })],
      decisions: [],
      a2aTasks: { 'task-1': task('completed', { evidence }) },
      now: NOW,
    });
    expect(ticket.state).toBe('done');
    expect(ticket.request).toBe('Make /login redirect back.');
    expect(ticket.result?.summary).toBe('Redirect fixed; e2e passes.');
    expect(ticket.result?.verification).toBe('1/1');
  });

  it('lists a hand-off waiting for its click, keeps chat out, and drops old finished work', () => {
    const tickets = buildFleetTickets({
      links: [
        link({ id: 'wl-chat', origin: 'manual', a2aTaskId: undefined }),
        link({ id: 'wl-old', a2aState: 'completed', state: 'done', updatedAt: NOW - TICKET_RECENT_MS - 1 }),
        link({ id: 'wl-run', a2aState: 'working' }),
      ],
      decisions: [decision('d-1', {
        handoff: { body: 'Please fix it', title: 'Hand-off', agentName: 'codex', targetPaneId: 'p2', targetPtyId: 'pty-2', foldsNewlines: false, willQueue: false },
      })],
      a2aTasks: {},
      now: NOW,
    });
    expect(tickets.map((t) => t.id)).toEqual(['handoff:d-1', 'wl-run']);
    expect(tickets[0]).toMatchObject({ state: 'needs-you', request: 'Please fix it', paneId: 'p2', decisionIds: ['d-1'] });
  });

  it('openTicketFor matches the pane, and ignores finished tickets', () => {
    const tickets = buildFleetTickets({
      links: [link({ a2aState: 'working' }), link({ id: 'wl-2', a2aTaskId: 'task-2', owner: { workspaceId: 'ws-1', paneId: 'p9' }, a2aState: 'completed', state: 'done' })],
      decisions: [], a2aTasks: {}, now: NOW,
    });
    expect(openTicketFor(tickets, 'ws-1', 'p1')?.id).toBe('wl-1');
    expect(openTicketFor(tickets, 'ws-1', 'p9')).toBeUndefined();
  });
});

describe('ticketIssueUrl', () => {
  it('prefills a new GitHub issue and nothing else', () => {
    const url = ticketIssueUrl('github.com/acme/app', { title: 'Fix login', request: 'Make it redirect', result: { summary: 'Done' } });
    expect(url).toBe(`https://github.com/acme/app/issues/new?title=Fix%20login&body=${encodeURIComponent('Make it redirect\n\nResult: Done')}`);
  });

  it('has no URL for a repo that is not on GitHub', () => {
    expect(ticketIssueUrl('gitlab.com/acme/app', { title: 'x' })).toBeNull();
    expect(ticketIssueUrl(null, { title: 'x' })).toBeNull();
  });
});
