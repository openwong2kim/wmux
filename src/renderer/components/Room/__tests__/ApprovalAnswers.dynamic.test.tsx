// @vitest-environment jsdom
//
// An approval card's answers come from the request main holds: Approve /
// Deny / Always allow while it waits (no Always allow for a release), the
// Undo countdown once a merge is approved, then the outcome; the composer
// chip approves the thread's pending requests through main; Settings lists
// the rules with Revoke.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RoomCard as RoomCardData } from '../../../../shared/room';
import { ApprovalAnswers, ApprovePendingChip } from '../ApprovalAnswers';
import { approvalPhase, pendingForChip, refreshApprovals, setApprovalsApiForTests, type ApprovalView, type ApprovalsApi } from '../approvalsStore';
import { ApprovalRules } from '../../Settings/ApprovalRules';

const WS = 'ws-a';
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key;

let container: HTMLDivElement;
let root: Root;

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
  setApprovalsApiForTests(undefined);
});

const req = (over: Partial<ApprovalView> = {}): ApprovalView => ({
  requestId: 'apr-aaaaaaaa1', action: 'merge', repoKey: 'github.com/o/r', prNumber: 3, headSha: 'a'.repeat(40), botId: 'bot-1', workspaceId: WS,
  threadId: 'general', reason: 'green', tainted: false, cardId: 'c1', state: 'pending', createdAt: 1, updatedAt: 1, ...over,
});
const card = (over: Partial<RoomCardData> = {}): RoomCardData => ({
  version: 1, id: 'c1', seq: 1, workspaceId: WS, threadId: 'general', kind: 'approval', at: 1, actor: { kind: 'bot', workspaceId: WS, botId: 'bot-1' },
  title: 'Merge PR #3?', state: 'open', refs: { approvalId: 'apr-aaaaaaaa1', pr: 3 }, ...over,
});

function fakeApi(requests: ApprovalView[]): ApprovalsApi & { decide: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => ({ ok: true as const, requests })),
    decide: vi.fn(async () => ({ ok: true as const, request: requests[0] })),
    rules: vi.fn(async () => ({ ok: true as const, rules: [{ ruleId: 'rule-1', action: 'merge' as const, repoKey: 'github.com/o/r', scope: { botId: 'bot-1' }, createdAt: 1 }] })),
    revokeRule: vi.fn(async () => ({ ok: true as const })),
  } as unknown as ApprovalsApi & { decide: ReturnType<typeof vi.fn> };
}

async function render(el: React.ReactElement) {
  await act(async () => root.render(el));
  await act(async () => { await refreshApprovals(); });
}

describe('approvalPhase', () => {
  it('reads the request: waiting, undo window, merging, outcome', () => {
    expect(approvalPhase(req(), 0)).toEqual({ phase: 'pending', canAlways: true });
    expect(approvalPhase(req({ action: 'release' }), 0)).toEqual({ phase: 'pending', canAlways: false });
    expect(approvalPhase(req({ action: 'issue_create' }), 0)).toEqual({ phase: 'pending', canAlways: false });
    expect(approvalPhase(req({ state: 'approved', executeAfter: 10_000 }), 1_000)).toEqual({ phase: 'undo', secondsLeft: 9 });
    expect(approvalPhase(req({ state: 'approved', executeAfter: 10_000 }), 10_000)).toEqual({ phase: 'merging' });
    expect(approvalPhase(req({ state: 'refused', refusal: 'head-moved' }), 0)).toMatchObject({ phase: 'refused', headMoved: true });
    expect(approvalPhase(req({ state: 'approved', action: 'issue_create' }), 0)).toMatchObject({ phase: 'approved', recordedOnly: true });
    expect(approvalPhase(undefined, 0)).toEqual({ phase: 'unknown' });
  });

  it('the chip counts the thread\'s pending requests shown here (a 1:1: its bot\'s)', () => {
    const list = [req(), req({ requestId: 'apr-b', cardId: 'c2', botId: 'bot-2' }), req({ requestId: 'apr-c', cardId: 'c3', threadId: 'task:x' as never }), req({ requestId: 'apr-d', cardId: 'gone' })];
    const shown = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
    expect(pendingForChip(list, shown, { workspaceId: WS, threadId: 'general' }).map((r) => r.requestId)).toEqual(['apr-aaaaaaaa1', 'apr-b']);
    expect(pendingForChip(list, shown, { workspaceId: WS, threadId: 'general', botId: 'bot-2' }).map((r) => r.requestId)).toEqual(['apr-b']);
  });

  it('the chip shows wherever the card is shown: the whole room or 1:1 counts a PR thread\'s request; a narrowed view only its thread', () => {
    const pr = 'pr:github.com/o/r#1' as never;
    const list = [
      req({ requestId: 'apr-pr', cardId: 'c1', threadId: pr }),
      req({ requestId: 'apr-gen', cardId: 'c2', botId: 'bot-2' }),
      req({ requestId: 'apr-other-ws', cardId: 'c3', workspaceId: 'ws-b' }),
      req({ requestId: 'apr-done', cardId: 'c4', threadId: pr, state: 'executed' }),
      req({ requestId: 'apr-hidden', cardId: 'not-shown', threadId: pr }),
    ];
    const shown = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }];
    // The room's whole view (General's composer): its PR thread's request too.
    expect(pendingForChip(list, shown, { workspaceId: WS, threadId: null }).map((r) => r.requestId)).toEqual(['apr-pr', 'apr-gen']);
    // A 1:1 spans rooms, its bot's only.
    expect(pendingForChip(list, shown, { botId: 'bot-1' }).map((r) => r.requestId)).toEqual(['apr-pr', 'apr-other-ws']);
    // Narrowed to the PR thread: that thread's only.
    expect(pendingForChip(list, shown, { workspaceId: WS, threadId: pr }).map((r) => r.requestId)).toEqual(['apr-pr']);
  });
});

describe('ApprovalAnswers: main\'s words, never its codes', () => {
  it('a refusal and a skipped rule show main\'s text; without it, no code', async () => {
    setApprovalsApiForTests(fakeApi([req({ state: 'refused', refusal: 'required-checks-green:no-required-checks', refusalText: 'The repository has no required checks' })]));
    await render(createElement(ApprovalAnswers, { card: card(), t }));
    expect(container.querySelector('[data-approval-refused]')?.textContent).toBe('room.approval.refused(reason=The repository has no required checks)');
    setApprovalsApiForTests(fakeApi([req({ state: 'refused', refusal: 'lane-paused' })]));
    await render(createElement(ApprovalAnswers, { card: card(), t }));
    expect(container.querySelector('[data-approval-refused]')?.textContent).toBe('room.approval.notMerged');
    setApprovalsApiForTests(fakeApi([req({ ruleSkipped: 'tainted', ruleSkippedText: 'It started from outside text' })]));
    await render(createElement(ApprovalAnswers, { card: card(), t }));
    expect(container.querySelector('[data-approval-rule-skipped]')?.textContent).toBe('room.approval.ruleSkipped(reason=It started from outside text)');
    setApprovalsApiForTests(fakeApi([req({ ruleSkipped: 'tainted' })]));
    await render(createElement(ApprovalAnswers, { card: card(), t }));
    expect(container.querySelector('[data-approval-rule-skipped]')).toBeNull();
  });
});

describe('ApprovalAnswers', () => {
  it('a skipped rule names its condition in the owner\'s language; a merge no rule covers says what a rule still needs under Always allow', async () => {
    setApprovalsApiForTests(fakeApi([req({ ruleSkipped: 'required-checks-green:no-required-checks', ruleSkippedText: 'The repository has no required checks', ruleSkippedCondition: 'noChecks' })]));
    await render(createElement(ApprovalAnswers, { card: card(), t }));
    expect(container.querySelector('[data-approval-rule-skipped]')?.textContent).toBe('room.approval.ruleSkipped(reason=room.approval.ruleCondition.noChecks(sha=aaaaaaa))');
    expect(container.querySelector('[data-approval-rule-needs]')).toBeNull();
    setApprovalsApiForTests(fakeApi([req({ ruleNeeds: ['verifier', 'noChecks'] })]));
    await render(createElement(ApprovalAnswers, { card: card(), t }));
    const needs = container.querySelector('[data-approval-rule-needs]');
    expect(needs?.textContent).toBe('room.approval.ruleNeeds(needs=room.approval.ruleNeed.verifierroom.approval.ruleNeedsJoinroom.approval.ruleNeed.noChecks)');
    // Under the buttons, after Always allow.
    expect(container.querySelector('[data-testid="approval-always"]')?.compareDocumentPosition(needs as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // No Always allow offered (a release): no line.
    setApprovalsApiForTests(fakeApi([req({ action: 'release', ruleNeeds: ['verifier'] })]));
    await render(createElement(ApprovalAnswers, { card: card(), t }));
    expect(container.querySelector('[data-approval-rule-needs]')).toBeNull();
  });

  it('a waiting request takes Deny, Always allow and Approve (the primary); the answer goes to main', async () => {
    const api = fakeApi([req({ tainted: true })]);
    setApprovalsApiForTests(api);
    await render(createElement(ApprovalAnswers, { card: card(), t }));
    expect(container.querySelector('[data-approval-outside]')).not.toBeNull();
    const approve = container.querySelector('[data-testid="approval-approve"]') as HTMLButtonElement;
    expect(container.querySelector('[data-testid="approval-always"]')).not.toBeNull();
    await act(async () => approve.click());
    expect(api.decide).toHaveBeenCalledWith({ requestId: 'apr-aaaaaaaa1', decision: 'approve' });
  });

  it('a release offers no Always allow; paused shows no answers', async () => {
    setApprovalsApiForTests(fakeApi([req({ action: 'release', prNumber: undefined })]));
    await render(createElement(ApprovalAnswers, { card: card(), t }));
    expect(container.querySelector('[data-testid="approval-always"]')).toBeNull();
    await render(createElement(ApprovalAnswers, { card: card(), t, readOnly: true }));
    expect(container.querySelector('[data-testid="approval-approve"]')).toBeNull();
  });

  it('an approved merge shows its countdown with Undo; a moved head says a new request is needed', async () => {
    const api = fakeApi([req({ state: 'approved', executeAfter: 9_000 })]);
    setApprovalsApiForTests(api);
    await render(createElement(ApprovalAnswers, { card: card({ state: 'resolved' }), t, now: 1_000 }));
    expect(container.querySelector('[data-approval-countdown]')?.textContent).toBe('room.approval.mergingIn(seconds=8)');
    await act(async () => (container.querySelector('[data-testid="approval-undo"]') as HTMLButtonElement).click());
    expect(api.decide).toHaveBeenCalledWith({ requestId: 'apr-aaaaaaaa1', decision: 'undo' });
    setApprovalsApiForTests(fakeApi([req({ state: 'refused', refusal: 'head-moved' })]));
    await render(createElement(ApprovalAnswers, { card: card({ state: 'resolved' }), t }));
    expect(container.textContent).toContain('room.approval.headMoved');
  });

  it('the chip approves each pending id through main', async () => {
    const api = fakeApi([req()]);
    setApprovalsApiForTests(api);
    await render(createElement(ApprovePendingChip, { ids: ['apr-aaaaaaaa1', 'apr-b'], t }));
    const chip = container.querySelector('[data-testid="approve-pending-chip"]') as HTMLButtonElement;
    expect(chip.textContent).toBe('room.approval.chip(count=2)');
    await act(async () => chip.click());
    expect(api.decide.mock.calls.map((c) => c[0])).toEqual([{ requestId: 'apr-aaaaaaaa1', decision: 'approve' }, { requestId: 'apr-b', decision: 'approve' }]);
    await render(createElement(ApprovePendingChip, { ids: [], t }));
    expect(container.querySelector('[data-testid="approve-pending-chip"]')).toBeNull();
  });
});

describe('Settings rules', () => {
  it('lists each rule with its scope and revokes it through main', async () => {
    const api = fakeApi([]);
    await render(createElement(ApprovalRules, { t, api, botName: () => 'Dev', workspaceName: (id: string) => id }));
    const row = container.querySelector('[data-approval-rule="rule-1"]');
    expect(row?.textContent).toContain('settings.factory.ruleByBot(name=Dev)');
    await act(async () => (row?.querySelector('[data-testid="approval-rule-revoke"]') as HTMLButtonElement).click());
    expect(api.revokeRule).toHaveBeenCalledWith('rule-1');
  });
});
