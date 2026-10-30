import { describe, it, expect } from 'vitest';
import { buildCompanyBoard, BOARD_LOG_MAX } from '../companyBoard';
import type { FleetTicket } from '../../FleetView/fleetTickets';
import type { WorkspaceAgentRosterRow } from '../../../stores/selectors/workspaceAgentRoster';
import type { WorkLink } from '../../../../shared/workLink';

const row = (paneId: string, status: WorkspaceAgentRosterRow['status'] = 'idle'): WorkspaceAgentRosterRow => ({
  workspaceId: 'co', paneId, surfaceId: `s-${paneId}`, ptyId: `pty-${paneId}`, agentName: 'Claude Code',
  paneName: paneId, surfaceIndex: 0, surfaceCount: 1, status, hasAttention: false, needsAttention: false, isFocused: false,
});
const ticket = (id: string, state: FleetTicket['state'], workspaceId: string, paneId?: string, updatedAt = 0): FleetTicket => ({
  id, title: id, workspaceId, state, decisionIds: [], origin: 'manual', updatedAt, ...(paneId ? { paneId } : {}),
});
const link = (id: string, requesterWs: string): WorkLink =>
  ({ id, origin: 'manual', owner: { workspaceId: 'x' }, requester: { workspaceId: requesterWs }, state: 'running', decisionIds: [], createdAt: 0, updatedAt: 0 }) as unknown as WorkLink;

const base = { workspaceId: 'co', coordinatorPaneId: 'ceo', paneIds: ['dev', 'ceo', 'shell'], agentPaneIds: new Set<string>(), links: [] as WorkLink[], paneRole: {} };

describe('buildCompanyBoard', () => {
  it('seats every pane with the CEO first, and keeps a job on its seat while the agent is gone', () => {
    const board = buildCompanyBoard({
      ...base,
      rows: [row('dev', 'running'), row('ceo')],
      paneRole: { dev: ' release ' },
      tickets: [
        ticket('ask', 'needs-you', 'co', 'shell', 3),
        ticket('build', 'working', 'co', 'dev', 2),
        ticket('later', 'queued', 'co', 'dev', 5),
        ticket('sooner', 'queued', 'co', 'dev', 1),
      ],
    });
    expect(board.seats.map((s) => [s.paneId, s.coordinator, !!s.row])).toEqual([['ceo', true, true], ['dev', false, true], ['shell', false, false]]);
    expect(board.seats[1]).toMatchObject({ owns: 'release', now: [{ id: 'build' }] });
    expect(board.seats[1].next.map((t) => t.id)).toEqual(['sooner', 'later']);
    expect(board.seats[2].now.map((t) => t.id)).toEqual(['ask']);
    expect(board.needsYou.map((t) => t.id)).toEqual(['ask']);
    expect(board.unseated).toEqual([]);
  });

  it('gives a job with no pane to the only seat with an agent, and leaves it unseated when there are several', () => {
    const tickets = [ticket('loose', 'working', 'co')];
    const stashedShell = { ...row('shell'), agentName: '', stashed: true };
    const sole = buildCompanyBoard({ ...base, rows: [row('ceo'), stashedShell], tickets });
    expect(sole.seats[0].now.map((t) => t.id)).toEqual(['loose']);
    expect(sole.seats.find((s) => s.paneId === 'shell')?.row).toBeUndefined();
    // A stashed pane whose agent is on a background tab still holds an agent seat.
    const twoAgents = buildCompanyBoard({ ...base, agentPaneIds: new Set(['shell']), rows: [row('ceo'), stashedShell], tickets });
    expect(twoAgents.seats.find((s) => s.paneId === 'shell')?.agent).toBe(true);
    expect(twoAgents.unseated.map((t) => t.id)).toEqual(['loose']);
    expect(buildCompanyBoard({ ...base, rows: [row('ceo'), row('dev')], tickets }).unseated.map((t) => t.id)).toEqual(['loose']);
  });

  it('lists work handed to other workspaces, and logs finished work both ways newest first', () => {
    const tickets = [
      ticket('out-ask', 'needs-you', 'other', 'p9', 4),
      ticket('out-run', 'working', 'other', 'p9', 3),
      ticket('stranger', 'working', 'other', 'p9', 9),
      ticket('out-done', 'done', 'other', 'p9', 8.5),
      ...Array.from({ length: BOARD_LOG_MAX }, (_, i) => ticket(`in-done-${i}`, 'done', 'co', 'dev', i)),
    ];
    const links = ['out-ask', 'out-run', 'out-done'].map((id) => link(id, 'co'));
    const board = buildCompanyBoard({ ...base, rows: [], tickets, links });
    expect(board.handedOut.map((t) => t.id)).toEqual(['out-ask', 'out-run']);
    expect(board.needsYou.map((t) => t.id)).toEqual(['out-ask']);
    expect(board.log).toHaveLength(BOARD_LOG_MAX);
    expect(board.log.slice(0, 3).map((t) => t.id)).toEqual(['in-done-9', 'out-done', 'in-done-8']);
  });
});
