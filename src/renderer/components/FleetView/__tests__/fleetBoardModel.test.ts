import { describe, expect, it } from 'vitest';
import type { FleetPane, FleetRow } from '../../../stores/selectors/fleet';
import type { ReviewQueueEntry } from '../../../stores/selectors/reviewQueue';
import type { InboxItem } from '../../../stores/selectors/approvalInbox';
import {
  boardAgentCount,
  boardColumnOf,
  boardLayout,
  buildBoardColumns,
  foldByOwner,
  moveOnBoard,
  rowApprovalIndex,
  visibleChips,
  type BoardGrid,
  type BoardItem,
} from '../fleetBoardModel';

function row(id: string, section: FleetRow['section'], over: Partial<FleetPane> = {}): FleetRow {
  const pane = {
    workspaceId: `ws-${id}`, workspaceName: id, paneId: id, surfaceId: `s-${id}`, ptyId: `pty-${id}`,
    agentStatus: 'idle', title: id, surfaceType: 'terminal', isActivePane: true, unverifiable: false,
    ...over,
  } as FleetPane;
  return { pane, section, detailKey: 'fleet.detail.idle' } as FleetRow;
}
const entry = (workspaceId: string): ReviewQueueEntry =>
  ({ workspaceId, taskId: `t-${workspaceId}`, title: workspaceId, ownerWorkspaceId: 'owner' }) as ReviewQueueEntry;

describe('Fleet board columns', () => {
  it('uses the shared sections and splits finished panes into Ready to review', () => {
    expect(boardColumnOf(row('a', 'needsYou', { agentStatus: 'awaiting_input' }))).toBe('needsYou');
    expect(boardColumnOf(row('b', 'needsYou', { agentStatus: 'running', unverifiable: true }))).toBe('needsYou');
    expect(boardColumnOf(row('c', 'needsYou', { agentStatus: 'complete' }))).toBe('review');
    expect(boardColumnOf(row('d', 'running', { agentStatus: 'running' }))).toBe('running');
    expect(boardColumnOf(row('e', 'idle'))).toBe('idle');
    // A stopped supervisor needs you even when its last turn completed.
    expect(boardColumnOf(row('f', 'needsYou', { agentStatus: 'complete', supervision: { status: 'stopped', restartCount: 3 } })))
      .toBe('needsYou');
  });

  it('shows a finished task once — as its review entry — and keeps selector order', () => {
    const cols = buildBoardColumns({
      needsYou: [row('q', 'needsYou', { agentStatus: 'awaiting_input' }), row('done', 'needsYou', { agentStatus: 'complete' }), row('solo', 'needsYou', { agentStatus: 'complete' })],
      running: [row('r1', 'running', { agentStatus: 'running' }), row('r2', 'running', { agentStatus: 'running' })],
      idle: [row('i', 'idle')],
    }, [entry('ws-done')], (ws) => `review:${ws}`);
    const keys = (items: BoardItem[]) => items.map((i) => i.key);
    expect(keys(cols.needsYou)).toEqual(['q']);
    expect(keys(cols.running)).toEqual(['r1', 'r2']);
    expect(keys(cols.review)).toEqual(['review:ws-done', 'solo']);
    expect(keys(cols.idle)).toEqual(['i']);
  });
});

describe('Fleet board layout', () => {
  it('switches between empty, one list, the board and dense cards by count', () => {
    expect(boardLayout(0)).toBe('empty');
    expect(boardLayout(1)).toBe('list');
    expect(boardLayout(3)).toBe('list');
    expect(boardLayout(4)).toBe('board');
    expect(boardLayout(19)).toBe('board');
    expect(boardLayout(20)).toBe('dense');
  });

  it('counts agents, not plain shells parked in Idle', () => {
    const cols = buildBoardColumns({
      needsYou: [], running: [row('r', 'running', { agentStatus: 'running' })],
      idle: [row('shell', 'idle'), row('claude', 'idle', { agentName: 'Claude Code' })],
    }, [], (ws) => ws);
    expect(boardAgentCount(cols)).toBe(2);
  });

  it('draws no chip whose value is zero or unknown', () => {
    expect(visibleChips([
      { id: 'needsYou', count: 2 }, { id: 'running', count: 0 }, { id: 'approvals', count: 0 },
      { id: 'usage', text: '5h 62% · 7d 40%' }, { id: 'next', text: '' }, { id: 'phones', count: 1 },
    ]).map((c) => c.id)).toEqual(['needsYou', 'usage', 'phones']);
  });

  it('folds cards of one mission under the first of them', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => ({ kind: 'pane', key: id, row: row(id, 'running') }) as BoardItem);
    const owner: Record<string, string> = { a: 'orch-1', c: 'orch-1', d: 'orch-2' };
    const groups = foldByOwner(items, (i) => owner[i.key]);
    expect(groups.map((g) => [g.lead.key, g.folded.map((f) => f.key), g.owner])).toEqual([
      ['a', ['c'], 'orch-1'],
      ['b', [], undefined],
      ['d', [], 'orch-2'],
    ]);
  });
});

describe('Fleet board keys', () => {
  const grid: BoardGrid = { needsYou: ['n1', 'n2', 'n3'], running: ['r1'], review: [], idle: ['i1', 'i2'] };

  it('moves within a column, across non-empty columns, and jumps by number', () => {
    expect(moveOnBoard(grid, 'n1', 'down')).toBe('n2');
    expect(moveOnBoard(grid, 'n3', 'down')).toBe('n3');
    expect(moveOnBoard(grid, 'n3', 'right')).toBe('r1');
    // The empty review column is skipped.
    expect(moveOnBoard(grid, 'r1', 'right')).toBe('i1');
    expect(moveOnBoard(grid, 'i2', 'left')).toBe('r1');
    expect(moveOnBoard(grid, 'n1', 'left')).toBe('n1');
    expect(moveOnBoard(grid, 'r1', 4)).toBe('i1');
    expect(moveOnBoard(grid, 'r1', 3)).toBe('r1');
    expect(moveOnBoard(grid, 'n2', 'end')).toBe('n3');
    expect(moveOnBoard(grid, null, 'down')).toBe('n1');
  });
});

describe('rowApprovalIndex', () => {
  const a2a = (key: string, sender: string, receiver: string): InboxItem => ({
    source: 'a2a', key, approvalId: key, taskId: `t-${key}`, messagePreview: 'ls', expiresAt: 0,
    senderWorkspaceId: sender, receiverWorkspaceId: receiver, cwd: null,
  });
  const mcp = (key: string, isCritical: boolean): InboxItem => ({
    source: 'mcp', key, promptId: key, clientName: 'ws-0', declaredCapabilities: ['shell'], isCritical,
  });
  const help: InboxItem = { source: 'browserHelp', key: 'h', requestId: 'h', prompt: 'ws-0', deadlineAt: 0 };

  it('points at the first A2A request sent to or from the workspace', () => {
    const inbox = [a2a('x', 'ws-9', 'ws-1'), a2a('y', 'ws-0', 'ws-2'), a2a('z', 'ws-3', 'ws-0')];
    expect(rowApprovalIndex(inbox, 'ws-0')).toBe(1);
    expect(rowApprovalIndex(inbox, 'ws-1')).toBe(0);
    expect(rowApprovalIndex(inbox, 'ws-4')).toBe(-1);
  });

  it('never matches an MCP grant, critical or not, or a browser help request', () => {
    expect(rowApprovalIndex([mcp('m1', true), mcp('m2', false), help], 'ws-0')).toBe(-1);
    expect(rowApprovalIndex([mcp('m1', true), help, a2a('a', 'ws-x', 'ws-0')], 'ws-0')).toBe(2);
  });
});
