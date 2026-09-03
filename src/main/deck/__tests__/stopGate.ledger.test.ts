// Lane F step 4 — the Stop gate on the task ledger (`deck.ledgerGate`).
// Table-driven: flag off unchanged; 0 open; 1 working; 1 input_required;
// ledger read error; 3 consecutive blocks release with the ledger flag.

import { describe, it, expect } from 'vitest';
import {
  evaluateStopGate,
  describeOpenLedgerTasksForDecision,
  type StopGateLedgerInput,
  type StopGateLedgerTask,
} from '../stopGate';
import type { FleetSnapshot } from '../../../shared/workspaceMirror';

const quiet: FleetSnapshot = { workspaceId: 'ws-1', ts: Date.now(), panes: [] };
const working: StopGateLedgerTask = { id: 'wtask-1', title: 'lane A', status: 'working' };
const blocked: StopGateLedgerTask = { id: 'wtask-2', title: 'lane B', status: 'input_required' };
const review: StopGateLedgerTask = { id: 'wtask-3', title: 'lane C', status: 'review_requested' };

const table: Array<{ name: string; ledger: StopGateLedgerInput | undefined; blocks: number; expectBlock: boolean; reason?: RegExp }> = [
  { name: 'flag off, open tasks present → unchanged (allow)', ledger: { enabled: false, openTasks: [working] }, blocks: 0, expectBlock: false },
  { name: 'no ledger input at all → unchanged (allow)', ledger: undefined, blocks: 0, expectBlock: false },
  { name: 'flag on, 0 open → allow', ledger: { enabled: true, openTasks: [] }, blocks: 0, expectBlock: false },
  { name: 'flag on, 1 working → block naming the task', ledger: { enabled: true, openTasks: [working] }, blocks: 0, expectBlock: true, reason: /wtask-1 "lane A" \(working/ },
  { name: 'flag on, 1 input_required → block with the blocked hint', ledger: { enabled: true, openTasks: [blocked] }, blocks: 0, expectBlock: true, reason: /wtask-2 .*input_required: the worker is blocked/ },
  { name: 'flag on, 1 review_requested → block with the gate hint', ledger: { enabled: true, openTasks: [review] }, blocks: 0, expectBlock: true, reason: /review_requested: the worker claims done/ },
  { name: 'flag on, ledger read error (null) → snapshot inference decides (allow on a quiet fleet)', ledger: { enabled: true, openTasks: null }, blocks: 0, expectBlock: false },
  { name: 'flag on, 3 consecutive blocks → released', ledger: { enabled: true, openTasks: [working] }, blocks: 3, expectBlock: false },
];

describe('evaluateStopGate — ledger path', () => {
  for (const row of table) {
    it(row.name, () => {
      const verdict = evaluateStopGate({ snapshot: quiet, ledger: row.ledger, consecutiveBlocks: row.blocks });
      expect(verdict.block).toBe(row.expectBlock);
      if (verdict.block && row.reason) expect(verdict.reason).toMatch(row.reason);
      if (verdict.block) {
        expect(verdict.reason).toContain('Do NOT close or kill a pane');
        expect(verdict.reason).toContain('deck_ask_decision');
        expect(verdict.outstandingPtyIds).toEqual([]);
      }
    });
  }

  it('the cap-out carries ledgerReleased and a fingerprint that suppresses the same open set next turn', () => {
    const ledger: StopGateLedgerInput = { enabled: true, openTasks: [working, blocked] };
    const capped = evaluateStopGate({ snapshot: quiet, ledger, consecutiveBlocks: 3 });
    expect(capped.block).toBe(false);
    if (capped.block) throw new Error('unreachable');
    expect(capped.ledgerReleased).toBe(true);
    expect(capped.cappedOutFingerprint).toContain('wtask-1:working');
    const again = evaluateStopGate({ snapshot: quiet, ledger, consecutiveBlocks: 0, suppressedFingerprint: capped.cappedOutFingerprint });
    expect(again.block).toBe(false);
    // A status change re-arms the gate.
    const changed = evaluateStopGate({
      snapshot: quiet,
      ledger: { enabled: true, openTasks: [working, { ...blocked, status: 'review_requested' }] },
      consecutiveBlocks: 0,
      suppressedFingerprint: capped.cappedOutFingerprint,
    });
    expect(changed.block).toBe(true);
  });

  it('a pane cap-out without open tasks is NOT flagged ledgerReleased', () => {
    const busy: FleetSnapshot = { workspaceId: 'ws-1', ts: Date.now(), panes: [{ ptyId: 'p', agentName: 'c', agentStatus: 'running', isActivePane: false }] };
    const capped = evaluateStopGate({ snapshot: busy, ledger: { enabled: true, openTasks: [] }, consecutiveBlocks: 3 });
    expect(capped.block).toBe(false);
    if (!capped.block) expect(capped.ledgerReleased).toBeUndefined();
  });

  it('rule 4 is not flipped: a pending decision releases the gate even with open tasks', () => {
    const verdict = evaluateStopGate({ snapshot: quiet, ledger: { enabled: true, openTasks: [working] }, pendingDecision: true, consecutiveBlocks: 0 });
    expect(verdict.block).toBe(false);
  });

  it('a stale snapshot still contributes no panes; open tasks alone hold the turn and name no pane', () => {
    const stale: FleetSnapshot = { workspaceId: 'ws-1', ts: Date.now() - 120_000, panes: [{ ptyId: 'p', agentName: 'c', agentStatus: 'running', isActivePane: false }] };
    const verdict = evaluateStopGate({ snapshot: stale, ledger: { enabled: true, openTasks: [working] }, consecutiveBlocks: 0 });
    expect(verdict.block).toBe(true);
    if (verdict.block) expect(verdict.outstandingPtyIds).toEqual([]);
  });
});

describe('describeOpenLedgerTasksForDecision', () => {
  it('renders one bracketed line, empty when nothing is open', () => {
    expect(describeOpenLedgerTasksForDecision([])).toBe('');
    expect(describeOpenLedgerTasksForDecision([working, blocked])).toBe(
      '[open tasks in the ledger: wtask-1 "lane A" (working), wtask-2 "lane B" (input_required)]',
    );
  });
});
