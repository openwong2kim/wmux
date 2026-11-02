import { describe, it, expect } from 'vitest';
import { buildCompanyBoard, BOARD_LOG_MAX, remoteSeatsOf, seatAsksOf } from '../companyBoard';
import { buildFleetTickets, type FleetTicket } from '../../FleetView/fleetTickets';
import type { WorkspaceAgentRosterRow } from '../../../stores/selectors/workspaceAgentRoster';
import type { WorkLink } from '../../../../shared/workLink';
import type { A2aLinkRecordV1 } from '../../../../shared/a2aRemote';
import type { A2aSpawnOutgoingSummary } from '../../../../shared/a2aSpawn';
import type { A2aRemoteHostStatus } from '../../../../shared/rpc';

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

  it('keeps a seat\'s report to the CEO under the seat, out of Waiting on you', () => {
    const reported = (id: string, requester: WorkLink['requester']): WorkLink => ({
      id, origin: 'manual', a2aTaskId: `task-${id}`, a2aState: 'input-required', owner: { workspaceId: 'co', paneId: 'dev' },
      requester, state: 'running', decisionIds: [], createdAt: 0, updatedAt: 0,
    });
    const links = [
      reported('to-ceo', { workspaceId: 'co', paneId: 'ceo' }),
      // Handed out by a workspace with no pane: the question is the owner's.
      reported('to-owner', { workspaceId: 'hq' }),
    ];
    const tickets = buildFleetTickets({ links, decisions: [], a2aTasks: {}, now: 0, recentMs: Infinity });
    const board = buildCompanyBoard({ ...base, rows: [row('ceo'), row('dev')], tickets, links });
    expect(board.needsYou.map((t) => t.id)).toEqual(['to-owner']);
    const dev = board.seats.find((s) => s.paneId === 'dev');
    expect(dev?.now.map((t) => t.id)).toEqual(['to-owner', 'to-ceo']);
    expect(dev?.now.find((t) => t.id === 'to-ceo')?.waitingOn).toEqual({ workspaceId: 'co', paneId: 'ceo' });
  });
});

describe('seats on other PCs', () => {
  const HOST = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  const seatLink = (linkId: string, over: Partial<A2aLinkRecordV1> = {}): A2aLinkRecordV1 => ({
    v: 1, linkId, version: 1, state: 'active',
    local: { kind: 'pane', workspaceId: 'co', paneId: 'ceo' },
    remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-b', paneId: `pane-${linkId}` },
    allow: { outbound: true, inbound: false },
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', proposer: 'local',
    ...over,
  });
  const hosts = [{ hostId: HOST, name: 'Linux build box' }];
  const seats = (links: A2aLinkRecordV1[], coordinatorPaneId: string | null = 'ceo') =>
    remoteSeatsOf({ workspaceId: 'co', coordinatorPaneId, links, hosts });

  it('takes an active link from the CEO pane to a pane there that this side may send on, and no other', () => {
    const links = [
      seatLink('seat'),
      seatLink('staff-pane', { local: { kind: 'pane', workspaceId: 'co', paneId: 'dev' } }),
      seatLink('brain', { remote: { hostId: HOST, kind: 'brain', workspaceId: 'ws-b' } }),
      seatLink('receive-only', { allow: { outbound: false, inbound: true } }),
      seatLink('revoked', { state: 'revoked', endedReason: 'revoked-remote' }),
      seatLink('broken', { state: 'broken', endedReason: 'pane-closed' }),
      seatLink('proposed', { state: 'proposed-out' }),
      seatLink('other-ws', { local: { kind: 'pane', workspaceId: 'elsewhere', paneId: 'ceo' } }),
    ];
    expect(seats(links).map((s) => s.linkId)).toEqual(['seat']);
    // A vacant CEO seat has no seats on other PCs.
    expect(seats(links, null)).toEqual([]);
  });

  it('names a seat by the link\'s label, else the pane part of its alias, and its PC by this PC\'s name for it', () => {
    const named = seatLink('named', { remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b', label: 'linux-build' } });
    const bare = seatLink('bare', { remote: { hostId: 'ab12cd34-0000-4000-8000-000000000000', kind: 'pane', workspaceId: 'ws-c', paneId: 'pane-c' } });
    expect(seats([named, bare])).toEqual([
      { linkId: 'named', name: 'linux-build', pc: 'Linux build box' },
      // A PC this one has no name for reads as the alias does: its id's first eight characters.
      { linkId: 'bare', name: 'pane-c', pc: 'ab12cd34' },
    ]);
  });

  const remoteLink = (id: string, linkId: string, a2aState: WorkLink['a2aState'], updatedAt = 0): WorkLink => ({
    id, origin: 'manual', a2aTaskId: `task-${id}`, a2aState, owner: { workspaceId: `remote:${linkId}`, name: `Linux build box/ws-b/${linkId}` },
    requester: { workspaceId: 'co', paneId: 'ceo' }, state: 'running', decisionIds: [], createdAt: 0, updatedAt,
  });

  it('puts a seat\'s jobs under it, now and next, and out of Handed out', () => {
    const links = [
      remoteLink('build', 'seat', 'working', 3),
      remoteLink('later', 'seat', 'submitted', 5),
      remoteLink('sooner', 'seat', 'submitted', 1),
      // A link that is not a seat (its local end is another pane) stays handed out.
      remoteLink('peer', 'peer-link', 'working', 2),
    ];
    const tickets = buildFleetTickets({ links, decisions: [], a2aTasks: {}, now: 10, recentMs: Infinity });
    const board = buildCompanyBoard({
      ...base, rows: [row('ceo')], tickets, links, remoteSeats: seats([seatLink('seat')]),
    });
    expect(board.remoteSeats).toHaveLength(1);
    expect(board.remoteSeats[0].now.map((t) => t.id)).toEqual(['build']);
    expect(board.remoteSeats[0].next.map((t) => t.id)).toEqual(['sooner', 'later']);
    expect(board.handedOut.map((t) => t.id)).toEqual(['peer']);
  });

  it('reads a seat\'s report back to the CEO as a report on the seat, not as needs-you', () => {
    const links = [remoteLink('reported', 'seat', 'input-required')];
    const tickets = buildFleetTickets({ links, decisions: [], a2aTasks: {}, now: 0, recentMs: Infinity });
    const board = buildCompanyBoard({ ...base, rows: [row('ceo')], tickets, links, remoteSeats: seats([seatLink('seat')]) });
    expect(board.needsYou).toEqual([]);
    expect(board.handedOut).toEqual([]);
    expect(board.remoteSeats[0].now).toMatchObject([{ id: 'reported', state: 'working', waitingOn: { workspaceId: 'co', paneId: 'ceo' } }]);
  });

  it('logs a seat\'s finished job, and drops the seat with its link', () => {
    const links = [remoteLink('shipped', 'seat', 'completed', 4), remoteLink('open', 'seat', 'working', 2)];
    const tickets = buildFleetTickets({ links, decisions: [], a2aTasks: {}, now: 10, recentMs: Infinity });
    const board = buildCompanyBoard({ ...base, rows: [row('ceo')], tickets, links, remoteSeats: seats([seatLink('seat')]) });
    expect(board.log.map((t) => t.id)).toEqual(['shipped']);
    // The link ended: no seat, and its open job falls back to Handed out.
    const ended = buildCompanyBoard({ ...base, rows: [row('ceo')], tickets, links, remoteSeats: seats([seatLink('seat', { state: 'broken' })]) });
    expect(ended.remoteSeats).toEqual([]);
    expect(ended.handedOut.map((t) => t.id)).toEqual(['open']);
  });

  describe('asks for a seat', () => {
    const NOW = Date.parse('2026-11-01T12:00:00.000Z');
    const iso = (ms: number) => new Date(ms).toISOString();
    const ask = (spawnId: string, over: Partial<A2aSpawnOutgoingSummary> = {}): A2aSpawnOutgoingSummary => ({
      hostId: HOST, hostName: 'linux-box', spawnId, agent: 'claude', rootId: 'wmux',
      from: { kind: 'pane', workspaceId: 'co', paneId: 'ceo' }, state: 'sent',
      createdAt: iso(NOW - 2 * 60_000), updatedAt: iso(NOW - 2 * 60_000), expiresAt: iso(NOW + 22 * 3_600_000),
      ...over,
    });
    const connected = [{ hostId: HOST, name: 'Linux build box', state: 'connected' as const }];
    const asks = (requests: A2aSpawnOutgoingSummary[], h: { hostId: string; name: string; state: A2aRemoteHostStatus['state'] }[] = connected) =>
      seatAsksOf({ workspaceId: 'co', coordinatorPaneId: 'ceo', requests, hosts: h, now: NOW });

    it('lists an open ask from the CEO pane with its name and PC, and whether that PC is on', () => {
      const requests = [
        ask('sp-open', { label: 'linux-build', state: 'waiting' }),
        // Another pane's ask, and a started one (its link is the seat by now), are not listed.
        ask('sp-staff', { from: { kind: 'pane', workspaceId: 'co', paneId: 'dev' } }),
        ask('sp-started', { state: 'started', linkId: 'seat' }),
      ];
      expect(asks(requests)).toEqual([{
        spawnId: 'sp-open', label: 'linux-build', agent: 'claude', pc: 'Linux build box', online: true, pending: true,
        createdAt: NOW - 2 * 60_000, updatedAt: NOW - 2 * 60_000, expiresAt: NOW + 22 * 3_600_000,
      }]);
      // That PC is not connected: the ask waits for it.
      expect(asks(requests, [{ hostId: HOST, name: 'Linux build box', state: 'disconnected' }])[0]).toMatchObject({ online: false, pending: true });
      // Without a name for it here, the name the list gave it.
      expect(asks(requests, [])[0]).toMatchObject({ pc: 'linux-box', online: false });
    });

    it('keeps an ask that ended without a seat for a day, with why, then drops it', () => {
      const declined = ask('sp-declined', { state: 'refused', code: 'declined', createdAt: iso(NOW - 23.5 * 3_600_000), updatedAt: iso(NOW - 23 * 3_600_000) });
      const expired = ask('sp-expired', { state: 'expired', createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 3_600_000) });
      const old = ask('sp-old', { state: 'refused', code: 'not-allowed', updatedAt: iso(NOW - 25 * 3_600_000) });
      expect(asks([declined, expired, old]).map((a) => [a.spawnId, a.pending, a.code])).toEqual([
        ['sp-expired', false, 'expired'],
        ['sp-declined', false, 'declined'],
      ]);
      expect(seatAsksOf({ workspaceId: 'co', coordinatorPaneId: 'ceo', requests: [declined], hosts: connected, now: NOW + 2 * 3_600_000 })).toEqual([]);
    });
  });
});
