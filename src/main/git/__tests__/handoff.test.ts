import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  findInProgress,
  findReusableLink,
  handoffBranch,
  linkStateForLedger,
  parseAgentCmd,
  parseHandoffRef,
  parseHandoffTarget,
  sendHandoff,
  startHandoffWorktree,
  watchHandoffWorktreeLinks,
  type HandoffDeps,
} from '../handoff';
import { agentIdentityHolds, isPaneQuiet, quietWaitBudget, typedPastOwnInput, waitForQuietAgent } from '../../pipe/handlers/quietInput';
import { buildHandoffMessage } from '../../../shared/gitHandoff';
import { WorkLinkStore } from '../../workLink/workLinkStore';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import type { WorkLink } from '../../../shared/workLink';

const issue = { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 12, title: 'Crash\non "launch"', url: 'https://github.com/Acme/Widgets/issues/12' };
const pr = { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 7, title: 'feat: x', url: 'https://github.com/Acme/Widgets/pull/7' };
const target = { workspaceId: 'ws-target', paneId: 'pane-1', surfaceId: 'surf-1', ptyId: 'pty-1', agentName: 'Claude Code', agentSlug: 'claude' };

function link(over: Partial<WorkLink>): WorkLink {
  return {
    id: 'link-1', origin: 'issue', owner: { workspaceId: 'ws-other' }, state: 'running', decisionIds: [], createdAt: 1, updatedAt: 1,
    issue: { ...issue, title: 'Crash' }, ...over,
  } as WorkLink;
}

const DELIVERED = { ok: true, result: { ok: true, taskId: 'task-9', delivery: { notified: true, submit: 'assured' } } };

function deps(over: { links?: WorkLink[]; invoke?: (method: string, params: Record<string, unknown>) => Promise<unknown> } = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const d: HandoffDeps = {
    invoke: vi.fn(over.invoke ?? (async () => DELIVERED)),
    links: {
      list: vi.fn(() => over.links ?? []),
      upsert: vi.fn(async (i) => { upserts.push(i as Record<string, unknown>); return { ...link({}), id: (i as { id?: string }).id ?? 'link-new' } as WorkLink; }),
      setState: vi.fn(async () => null),
    },
    startFanOut: vi.fn(async () => ({ ok: true, tasks: [{ index: 0, title: 't', ok: true, workspaceId: 'ws-new', worktreePath: '/wt/issue-12', branch: 'issue-12-crash-on-launch', agent: 'claude' }] }) as never),
  };
  return { d, upserts };
}
const invokeCalls = (d: HandoffDeps) => (d.invoke as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;

describe('hand-off input validation', () => {
  it('accepts URL-consistent github.com refs and a well-formed target only', () => {
    expect(parseHandoffRef({ kind: 'issue', ref: issue })?.ref.number).toBe(12);
    expect(parseHandoffRef({ kind: 'pr', ref: pr })?.ref.number).toBe(7);
    expect(parseHandoffRef({ kind: 'issue', ref: { ...issue, number: 13 } })).toBeNull();
    expect(parseHandoffRef({ kind: 'pr', ref: issue })).toBeNull();
    expect(parseHandoffRef({ kind: 'other', ref: issue })).toBeNull();
    // Another host, even a well-formed one, is not the Git page's.
    expect(parseHandoffRef({ kind: 'issue', ref: { ...issue, host: 'git.example.com', url: 'https://git.example.com/Acme/Widgets/issues/12' } })).toBeNull();
    expect(parseHandoffTarget(target)).toEqual(target);
    expect(parseHandoffTarget({ ...target, paneId: 'pane 1; rm' })).toBeNull();
    expect(parseHandoffTarget({ ...target, agentSlug: 'Bad Slug' })).toEqual({ ...target, agentSlug: undefined } as never);
  });

  it('the agent command follows the fan-out rule and refuses what cannot be one line', () => {
    expect(parseAgentCmd(undefined)).toEqual({ ok: true, cmd: 'claude' });
    expect(parseAgentCmd('  ')).toEqual({ ok: true, cmd: 'claude' });
    expect(parseAgentCmd('codex --model=gpt-5')).toEqual({ ok: true, cmd: 'codex --model=gpt-5' });
    expect(parseAgentCmd('"C:\\Program Files\\Claude\\claude.exe" --model opus')).toEqual({ ok: true, cmd: '"C:\\Program Files\\Claude\\claude.exe" --model opus' });
    expect(parseAgentCmd('claude\nrm -rf ~')).toMatchObject({ ok: false });
    expect(parseAgentCmd(42)).toMatchObject({ ok: false });
  });
});

describe('the fixed reference', () => {
  it('a title cannot expand in a shell: no $, no backtick, no backslash, no invisible characters', () => {
    const msg = buildHandoffMessage({ kind: 'issue', ref: { ...issue, title: 'Fix $(id) and `whoami` \\n ${HOME}\u202e\u200bx\ufeff' } });
    const line = msg.split('\n')[0];
    expect(line).not.toMatch(/[$`\\\u202e\u200b\ufeff]/);
    expect(line).toBe(`[wmux] Issue Acme/Widgets#12: "Fix (id) and 'whoami' /n {HOME}x" — ${issue.url}`);
  });
});

describe('sendHandoff', () => {
  it('a delivery not known to have started a turn is reported unverified (pasted, maybe not submitted)', async () => {
    for (const delivery of [{ notified: true, submit: 'unverified' }, { notified: true }]) {
      const { d } = deps({ invoke: async () => ({ ok: true, result: { ok: true, taskId: 'task-9', delivery } }) });
      const res = await sendHandoff(d, { item: { kind: 'issue', ref: issue }, target });
      expect(res).toMatchObject({ ok: true, delivered: true, assurance: 'unverified' });
    }
  });

  it('records an issue link owned by the target, then sends the fixed reference as a gated A2A task joined to it', async () => {
    const { d, upserts } = deps();
    const res = await sendHandoff(d, { item: { kind: 'issue', ref: issue }, target, note: 'start with the logs' });
    expect(res).toEqual({ ok: true, linkId: 'link-new', taskId: 'task-9', delivered: true, assurance: 'assured' });
    expect(upserts[0]).toMatchObject({
      origin: 'issue', issue: { number: 12 }, title: "Crash on 'launch'", owner: { workspaceId: 'ws-target', paneId: 'pane-1' }, agent: 'claude',
    });
    const [method, params] = invokeCalls(d)[0];
    expect(method).toBe('a2a.task.send');
    expect(params).toMatchObject({
      workspaceId: 'ws-human', to: 'ws-target', paneId: 'pane-1', surfaceId: 'surf-1', workLinkId: 'link-new', gatedDelivery: true, referenceDelivery: true,
      title: 'Issue Acme/Widgets#12',
    });
    expect(params.message).toBe(
      "[wmux] Issue Acme/Widgets#12: \"Crash on 'launch'\" — https://github.com/Acme/Widgets/issues/12\n"
      + 'Read it with: gh issue view 12 --repo Acme/Widgets\n\nstart with the logs',
    );
  });

  it('a PR link has origin pr and its PR ref', async () => {
    const { d, upserts } = deps();
    await sendHandoff(d, { item: { kind: 'pr', ref: pr }, target });
    expect(upserts[0]).toMatchObject({ origin: 'pr', pr: { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 7, url: pr.url } });
    expect(invokeCalls(d)[0][1].message).toContain('gh pr diff 7 --repo Acme/Widgets');
  });

  it('refuses while the item is linked to work in progress, unless sent anyway', async () => {
    const { d } = deps({ links: [link({ state: 'running' })] });
    const res = await sendHandoff(d, { item: { kind: 'issue', ref: issue }, target });
    expect(res).toEqual({ ok: false, code: 'in-progress', inProgress: { linkId: 'link-1', workspaceId: 'ws-other', state: 'running' } });
    expect(d.invoke).not.toHaveBeenCalled();
    expect((await sendHandoff(d, { item: { kind: 'issue', ref: issue }, target, force: true })).ok).toBe(true);
  });

  it('a queued link with nothing behind it is taken over, not twinned (and is not "in progress")', async () => {
    const idle = link({ id: 'link-idle', state: 'queued' });
    const { d, upserts } = deps({ links: [idle] });
    expect(findInProgress(d.links, { kind: 'issue', ref: issue })).toBeNull();
    expect(findReusableLink(d.links, { kind: 'issue', ref: issue })?.id).toBe('link-idle');
    await sendHandoff(d, { item: { kind: 'issue', ref: issue }, target });
    expect(upserts[0]).toMatchObject({ id: 'link-idle', origin: 'issue' });
    expect(invokeCalls(d)[0][1].workLinkId).toBe('link-idle');
    // One with a task behind it is in progress, and never reused.
    const { d: d2 } = deps({ links: [link({ state: 'queued', a2aTaskId: 'task-1' })] });
    expect(findInProgress(d2.links, { kind: 'issue', ref: issue })?.linkId).toBe('link-1');
    expect(findReusableLink(d2.links, { kind: 'issue', ref: issue })).toBeNull();
  });

  it('one hand-off of an item at a time: a second while the first is in flight is refused', async () => {
    let release!: () => void;
    let held = false;
    // Only the first send hangs until released.
    const { d } = deps({
      invoke: async () => {
        if (held) return DELIVERED;
        held = true;
        return new Promise((r) => { release = () => r(DELIVERED); });
      },
    });
    const first = sendHandoff(d, { item: { kind: 'issue', ref: issue }, target });
    await vi.waitFor(() => expect(d.invoke).toHaveBeenCalled());
    // Same item, URL in another case: still the same item.
    const second = await sendHandoff(d, { item: { kind: 'issue', ref: { ...issue, owner: 'acme', url: 'https://github.com/acme/Widgets/issues/12' } }, target });
    expect(second).toMatchObject({ ok: false, code: 'refused' });
    release();
    expect((await first).ok).toBe(true);
    // Free again once it finished.
    expect((await sendHandoff(d, { item: { kind: 'issue', ref: issue }, target, force: true })).ok).toBe(true);
  });

  it('not delivered: the task is cancelled so a retry is not blocked; the link is closed when the cancel fails', async () => {
    const stored = deps({
      invoke: async (m) => (m === 'a2a.task.send'
        ? { ok: true, result: { ok: true, taskId: 't', delivery: { notified: false, hint: 'Someone was typing', reason: 'user_typing' } } }
        : { ok: true, result: { ok: true } }),
    });
    expect(await sendHandoff(stored.d, { item: { kind: 'issue', ref: issue }, target })).toEqual({
      ok: true, linkId: 'link-new', taskId: 't', delivered: false, note: 'Someone was typing', reason: 'user_typing',
    });
    expect(invokeCalls(stored.d)[1]).toEqual(['a2a.task.cancel', { taskId: 't', workspaceId: 'ws-human' }]);
    expect(stored.d.links.setState).not.toHaveBeenCalled();

    const cancelFails = deps({
      invoke: async (m) => (m === 'a2a.task.send'
        ? { ok: true, result: { ok: true, taskId: 't', delivery: { notified: false } } }
        : { ok: true, result: { error: 'not found' } }),
    });
    await sendHandoff(cancelFails.d, { item: { kind: 'issue', ref: issue }, target });
    expect(cancelFails.d.links.setState).toHaveBeenCalledWith('link-new', 'abandoned', 'other');
  });

  it('a refused send closes its link and reports the reason', async () => {
    const refused = deps({ invoke: async () => ({ ok: true, result: { error: 'a2a.task.send: target "x" not found' } }) });
    expect(await sendHandoff(refused.d, { item: { kind: 'issue', ref: issue }, target })).toEqual({
      ok: false, code: 'refused', message: 'a2a.task.send: target "x" not found',
    });
    expect(refused.d.links.setState).toHaveBeenCalledWith('link-new', 'abandoned', 'other');
  });

  it('rejects an invalid payload without touching links or sending', async () => {
    const { d } = deps();
    expect((await sendHandoff(d, { item: { kind: 'issue', ref: { ...issue, url: 'javascript:x' } }, target })).ok).toBe(false);
    expect(d.links.upsert).not.toHaveBeenCalled();
    expect(d.invoke).not.toHaveBeenCalled();
  });
});

describe('startHandoffWorktree', () => {
  it('runs the fan-out with branch issue-<n>-<slug> and the fixed reference, then records the worktree on the link', async () => {
    const { d, upserts } = deps();
    const res = await startHandoffWorktree(d, { item: { kind: 'issue', ref: issue }, repoPath: '/repo', workspaceId: 'ws-repo', agentCmd: 'codex --model=gpt-5' });
    expect(res).toEqual({ ok: true, linkId: 'link-new', workspaceId: 'ws-new', branch: 'issue-12-crash-on-launch' });
    const req = (d.startFanOut as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req).toMatchObject({
      titles: ['issue-12-crash-on-launch'], branches: ['issue-12-crash-on-launch'], repoPath: '/repo', agentCmd: 'codex --model=gpt-5',
      worktree: true, verifiedWorkspaceId: 'ws-repo',
    });
    expect(req.prompt).toContain('Read it with: gh issue view 12 --repo Acme/Widgets');
    expect(upserts[0]).toMatchObject({
      origin: 'issue', owner: { workspaceId: 'ws-new' }, agent: 'claude', worktree: { path: '/wt/issue-12', branch: 'issue-12-crash-on-launch' },
    });
  });

  it('refuses in-progress work and an invalid agent command, and reports a failed fan-out', async () => {
    const busy = deps({ links: [link({ state: 'needs-you' })] });
    expect((await startHandoffWorktree(busy.d, { item: { kind: 'issue', ref: issue }, repoPath: '/r', workspaceId: 'ws' })).ok).toBe(false);
    const { d } = deps();
    expect(await startHandoffWorktree(d, { item: { kind: 'issue', ref: issue }, repoPath: '/r', workspaceId: 'ws', agentCmd: 'claude\nx' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(d.startFanOut).not.toHaveBeenCalled();
    (d.startFanOut as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'preflight: branch already exists: issue-12-crash-on-launch', tasks: [] });
    const res = await startHandoffWorktree(d, { item: { kind: 'issue', ref: issue }, repoPath: '/r', workspaceId: 'ws' });
    expect(res).toEqual({ ok: false, code: 'error', message: 'preflight: branch already exists: issue-12-crash-on-launch' });
    expect((d.startFanOut as ReturnType<typeof vi.fn>).mock.calls[0][0].agentCmd).toBe('claude');
  });

  it('a PR branch carries a suffix, so a second start does not collide', () => {
    expect(handoffBranch({ kind: 'pr', ref: pr }, () => 'abc123')).toBe('pr-7-abc123');
    expect(handoffBranch({ kind: 'pr', ref: pr })).not.toBe(handoffBranch({ kind: 'pr', ref: pr }));
    expect(handoffBranch({ kind: 'issue', ref: issue })).toBe('issue-12-crash-on-launch');
  });
});

describe('a worktree hand-off follows its fan-out mission', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wmux-handoff-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('maps every ledger status to a link state', () => {
    expect(linkStateForLedger('working')).toEqual({ state: 'running' });
    expect(linkStateForLedger('review_requested')).toEqual({ state: 'review' });
    expect(linkStateForLedger('input_required')).toEqual({ state: 'needs-you', reason: 'input-required' });
    expect(linkStateForLedger('failed')).toEqual({ state: 'blocked', reason: 'task-failed' });
    expect(linkStateForLedger('completed')).toEqual({ state: 'done' });
    expect(linkStateForLedger('cancelled')).toEqual({ state: 'abandoned' });
  });

  it('the mission running, asking for review, then closing moves the link to running, review, then abandoned, and frees the item', async () => {
    const store = new WorkLinkStore({ dir, pendingDecisionIds: () => new Set() });
    const ledger = new TaskLedger({ dir });
    const links = { list: (f: Parameters<WorkLinkStore['list']>[0]) => store.list(f), setState: store.setState.bind(store), upsert: store.upsert.bind(store) };
    const created = await store.upsert({
      origin: 'issue', issue, title: 'Crash', owner: { workspaceId: 'ws-new' }, worktree: { path: '/wt/issue-12', branch: 'issue-12-crash' },
    });
    const other = await store.upsert({ origin: 'manual', owner: { workspaceId: 'ws-elsewhere' } });
    const stop = watchHandoffWorktreeLinks(ledger, links);
    const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await store.flush(); };

    // Queued with a worktree: this blocks a second hand-off of the item.
    expect(findInProgress(links, { kind: 'issue', ref: issue })?.linkId).toBe(created!.id);
    await ledger.register({ id: 'wtask-1', taskWorkspaceId: 'ws-new', ownerWorkspaceId: 'ws-repo', title: 'issue-12-crash' });
    await settle();
    expect(store.get(created!.id)?.state).toBe('running');
    // The worker asks for review: the link shows it.
    await ledger.update({ id: 'wtask-1', status: 'review_requested', actor: { kind: 'worker', workspaceId: 'ws-new' }, expectedRev: 1 });
    await settle();
    expect(store.get(created!.id)?.state).toBe('review');
    await ledger.closeTask('wtask-1');
    await settle();
    expect(store.get(created!.id)?.state).toBe('abandoned');
    expect(findInProgress(links, { kind: 'issue', ref: issue })).toBeNull();
    // A link on another workspace is left alone.
    expect(store.get(other!.id)?.state).toBe('queued');
    stop();
  });
});

describe('waiting for the person to stop typing', () => {
  const agent = { agentName: 'Claude Code', agentStatus: 'waiting', incarnationId: 'i1', agentVerified: false };

  it('isPaneQuiet: no draft and keys idle for the window', () => {
    expect(isPaneQuiet({ hasDraft: false, keyInputIdleMs: 12_000 })).toBe(true);
    expect(isPaneQuiet({ hasDraft: true, keyInputIdleMs: 60_000 })).toBe(false);
    expect(isPaneQuiet({ keyInputIdleMs: 2_000 })).toBe(false);
    // An older daemon without the idle time answers with its short flag.
    expect(isPaneQuiet({ keyInputQuiet: true })).toBe(true);
    expect(isPaneQuiet({ keyInputQuiet: false })).toBe(false);
  });

  it('the agent identity holds only while nothing about it changed', () => {
    const base = { agentName: 'Claude Code', incarnationId: 'i1', agentVerified: true };
    expect(agentIdentityHolds(base, { ...agent, agentVerified: true })).toBe(true);
    expect(agentIdentityHolds(base, { ...agent, agentVerified: false })).toBe(false);
    expect(agentIdentityHolds(base, { ...agent, agentVerified: true, incarnationId: 'i2' })).toBe(false);
    // Idle with a name is a fresh agent at its first prompt; the shell has no name.
    expect(agentIdentityHolds(base, { ...agent, agentVerified: true, agentStatus: 'idle' })).toBe(true);
    expect(agentIdentityHolds(base, { ...agent, agentVerified: true, agentName: null, agentStatus: 'idle' })).toBe(false);
    expect(agentIdentityHolds(base, { ...agent, agentVerified: true, agentName: 'Codex CLI' })).toBe(false);
  });

  it('our own paste is not "typing"; a key after it is, however soon', () => {
    // Expected 8: the pane stood at 7 and our paste is one write.
    expect(typedPastOwnInput({ keyInputRevision: 8, keyInputIdleMs: 0 }, 8)).toBe(false);
    expect(typedPastOwnInput({ keyInputRevision: 7 }, 8)).toBe(false);
    expect(typedPastOwnInput({ keyInputRevision: 9, keyInputIdleMs: 50 }, 8)).toBe(true);
    expect(typedPastOwnInput({ keyInputIdleMs: 60_000 }, 8)).toBe(true);
    expect(typedPastOwnInput({ keyInputRevision: 8 }, undefined)).toBe(true);
  });

  it('the wait gets what the deadline leaves after the rest of the delivery, never more than its cap', () => {
    expect(quietWaitBudget(100_000, 0)).toBe(20_000);
    expect(quietWaitBudget(25_000, 0)).toBe(4_000);
    expect(quietWaitBudget(10_000, 0)).toBe(0);
  });

  it('waits until quiet; a failed read is not quiet; the agent leaving is refused', async () => {
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
    const states = [{ ...agent, hasDraft: true }, null, { ...agent, keyInputIdleMs: 3_000 }, { ...agent, keyInputIdleMs: 11_000 }];
    let i = 0;
    expect(await waitForQuietAgent(async () => states[Math.min(i++, 3)], clock)).toMatchObject({ ok: true, baseline: { agentName: 'Claude Code' } });
    t = 0;
    expect(await waitForQuietAgent(async () => { throw new Error('timeout'); }, clock)).toMatchObject({ ok: false, reason: 'user_typing' });
    expect(t).toBeLessThanOrEqual(20_000);
    let n = 0;
    expect(await waitForQuietAgent(async () => (n++ < 2 ? { ...agent, hasDraft: true } : { ...agent, agentName: null, agentStatus: 'idle' }), clock))
      .toMatchObject({ ok: false, reason: 'agent_changed' });
    expect(await waitForQuietAgent(async () => ({ ...agent, keyInputIdleMs: 60_000 }), { ...clock, expectAgent: 'Codex CLI' }))
      .toMatchObject({ ok: false, reason: 'agent_changed' });
  });
});
