import { describe, expect, it } from 'vitest';
import { PHONE_SIDEBAR_LIMITS, parsePhoneSidebarSnapshot } from '../phoneFleetSidebar';
import { clampTicketText, firstTicketLine, parsePhoneFleetTicketDetail, parsePhoneFleetTicketDetails, withoutTicketTranscript, PHONE_FLEET_TICKET_DETAIL_LIMITS } from '../phoneFleetTickets';

const T = 1_700_000_000_000;
const row = (id: string, over: Record<string, unknown> = {}) => ({ id, origin: 'manual', workspaceId: 'ws-1', title: 'Job', state: 'done', updatedAt: T, ...over });
const parseTickets = (fleetTickets: unknown, drops: string[] = []) =>
  parsePhoneSidebarSnapshot({ activeWorkspaceId: null, workspaces: [], panes: [], fleetTickets }, (r) => drops.push(r))?.fleetTickets;

describe('fleetTickets in the sidebar parser', () => {
  it('keeps listed fields, drops a bad optional field alone, and drops a row without its required ones', () => {
    const drops: string[] = [];
    const list = parseTickets([
      row('a', { taskId: 'task-a', workspaceName: 'Alpha', agentName: 'Codex', requestLine: 'do it', resultSummary: 'did it', verification: '3/4', transcript: 'x' }),
      row('b', { requestLine: 'two\nlines', verification: 'all', agentName: 'x'.repeat(65) }),
      row('c', { state: 'archived' }),
      row('d', { origin: 'elsewhere' }),
      row('e', { state: 7 }),
      row('f', { origin: 'bad\u0007' }),
      row('a'),
    ], drops);
    expect(list).toEqual([
      row('a', { taskId: 'task-a', workspaceName: 'Alpha', agentName: 'Codex', requestLine: 'do it', resultSummary: 'did it', verification: '3/4' }),
      row('b'),
      // A newer desktop's word reads as the contract says, not as a lost row.
      row('c', { state: 'working' }),
      row('d', { origin: 'manual' }),
    ]);
    expect(drops.sort()).toEqual(['fleetTickets.duplicate', 'fleetTickets.row', 'fleetTickets.row']);
  });

  it('caps the list and keeps the producer order', () => {
    const drops: string[] = [];
    const list = parseTickets(Array.from({ length: 40 }, (_, i) => row(`t${i}`, { updatedAt: T + i })), drops);
    expect(list).toHaveLength(PHONE_SIDEBAR_LIMITS.fleetTickets);
    expect(list?.[0].id).toBe('t0');
    expect(drops).toEqual(['fleetTickets.overLimit']);
  });

  it('withoutTicketTranscript strips the agent-authored fields and replaces the title', () => {
    expect(withoutTicketTranscript(row('a', { title: 'Fix the secret thing', requestLine: 'r', resultSummary: 's', verification: '1/1', agentName: 'A' }) as never))
      .toEqual(row('a', { title: 'Task', agentName: 'A' }));
    expect(withoutTicketTranscript(row('h', { origin: 'handoff' }) as never).title).toBe('Hand-off waiting');
  });
});

describe('ticket detail', () => {
  it('keeps multi-line text, refuses control and bidi characters, and bounds the items', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ kind: 'command', status: 'passed', summary: `item ${i}`, command: 'npm test', location: 'ignored' }));
    const detail = parsePhoneFleetTicketDetail({ id: 'a', updatedAt: T, request: 'line\nline', result: 'bad‮result', verification: '1/2', verificationItems: items, extra: 1 });
    expect(detail).toMatchObject({ id: 'a', updatedAt: T, request: 'line\nline', verification: '1/2' });
    expect(detail).not.toHaveProperty('result');
    expect(detail).not.toHaveProperty('extra');
    expect(detail?.verificationItems).toHaveLength(PHONE_FLEET_TICKET_DETAIL_LIMITS.items);
    expect(detail?.verificationItems?.[0]).toEqual({ kind: 'command', status: 'passed', summary: 'item 0', command: 'npm test' });
    expect(parsePhoneFleetTicketDetail({ id: 'a' })).toBeNull();
    expect(parsePhoneFleetTicketDetail({ id: '__proto__', updatedAt: T })).toBeNull();
    expect(parsePhoneFleetTicketDetails([{ id: 'a', updatedAt: T }, { id: 'a', updatedAt: T + 1 }, 'junk'])).toEqual([{ id: 'a', updatedAt: T }]);
  });

  it('clampTicketText normalises line ends, strips unsafe characters and cuts at a pair boundary', () => {
    expect(clampTicketText('  a\r\nb\rc\u0007‮d  ')).toBe('a\nb\ncd');
    expect(clampTicketText('x'.repeat(3999) + '\u{1F600}')).toBe('x'.repeat(3999));
    expect(clampTicketText(' \n ')).toBeUndefined();
    expect(firstTicketLine('\n\n  first\tline\nsecond', 160)).toBe('first line');
  });
});
