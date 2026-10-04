import { describe, it, expect, vi } from 'vitest';
import { findInProgress, parseHandoffRef, parseHandoffTarget, sendHandoff, startHandoffWorktree, type HandoffDeps } from '../handoff';
import { isPaneQuiet, waitForQuietInput } from '../../pipe/handlers/quietInput';
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

function deps(over: { links?: WorkLink[]; invokeResult?: unknown } = {}) {
  const upserts: unknown[] = [];
  const d: HandoffDeps = {
    invoke: vi.fn(async () => over.invokeResult ?? { ok: true, result: { ok: true, taskId: 'task-9', delivery: { notified: true } } }),
    links: {
      list: vi.fn(() => over.links ?? []),
      upsert: vi.fn(async (i) => { upserts.push(i); return { ...link({}), id: 'link-new' } as WorkLink; }),
    },
    startFanOut: vi.fn(async () => ({ ok: true, tasks: [{ index: 0, title: 't', ok: true, workspaceId: 'ws-new', worktreePath: '/wt/issue-12', branch: 'issue-12-crash-on-launch', agent: 'claude' }] }) as never),
  };
  return { d, upserts };
}

describe('hand-off input validation', () => {
  it('accepts URL-consistent refs and a well-formed target only', () => {
    expect(parseHandoffRef({ kind: 'issue', ref: issue })?.ref.number).toBe(12);
    expect(parseHandoffRef({ kind: 'pr', ref: pr })?.ref.number).toBe(7);
    expect(parseHandoffRef({ kind: 'issue', ref: { ...issue, number: 13 } })).toBeNull();
    expect(parseHandoffRef({ kind: 'pr', ref: issue })).toBeNull();
    expect(parseHandoffRef({ kind: 'other', ref: issue })).toBeNull();
    expect(parseHandoffTarget(target)).toEqual(target);
    expect(parseHandoffTarget({ ...target, paneId: 'pane 1; rm' })).toBeNull();
    expect(parseHandoffTarget({ ...target, agentSlug: 'Bad Slug' })).toEqual({ ...target, agentSlug: undefined } as never);
  });
});

describe('sendHandoff', () => {
  it('records an issue link owned by the target, then sends the fixed reference as a gated A2A task joined to it', async () => {
    const { d, upserts } = deps();
    const res = await sendHandoff(d, { item: { kind: 'issue', ref: issue }, target, note: 'start with the logs' });
    expect(res).toEqual({ ok: true, linkId: 'link-new', taskId: 'task-9', delivered: true });
    expect(upserts[0]).toMatchObject({
      origin: 'issue', issue: { number: 12 }, title: "Crash on 'launch'", owner: { workspaceId: 'ws-target', paneId: 'pane-1' }, agent: 'claude',
    });
    const [method, params] = (d.invoke as ReturnType<typeof vi.fn>).mock.calls[0];
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
    expect((d.invoke as ReturnType<typeof vi.fn>).mock.calls[0][1].message).toContain('gh pr diff 7 --repo Acme/Widgets');
  });

  it('refuses while the item is linked to work in progress, unless sent anyway', async () => {
    const { d } = deps({ links: [link({ state: 'running' })] });
    const res = await sendHandoff(d, { item: { kind: 'issue', ref: issue }, target });
    expect(res).toEqual({ ok: false, code: 'in-progress', inProgress: { linkId: 'link-1', workspaceId: 'ws-other', state: 'running' } });
    expect(d.invoke).not.toHaveBeenCalled();
    expect((await sendHandoff(d, { item: { kind: 'issue', ref: issue }, target, force: true })).ok).toBe(true);
  });

  it('a queued link with no task or worktree behind it is not "in progress"', () => {
    const { d } = deps({ links: [link({ state: 'queued' })] });
    expect(findInProgress(d.links, { kind: 'issue', ref: issue })).toBeNull();
    const { d: d2 } = deps({ links: [link({ state: 'queued', a2aTaskId: 'task-1' })] });
    expect(findInProgress(d2.links, { kind: 'issue', ref: issue })?.linkId).toBe('link-1');
  });

  it('reports a stored-but-not-delivered task with its hint, and a refused send', async () => {
    const stored = deps({ invokeResult: { ok: true, result: { ok: true, taskId: 't', delivery: { notified: false, hint: 'Someone was typing' } } } });
    expect(await sendHandoff(stored.d, { item: { kind: 'issue', ref: issue }, target })).toEqual({
      ok: true, linkId: 'link-new', taskId: 't', delivered: false, note: 'Someone was typing',
    });
    const refused = deps({ invokeResult: { ok: true, result: { error: 'a2a.task.send: target "x" not found' } } });
    expect(await sendHandoff(refused.d, { item: { kind: 'issue', ref: issue }, target })).toEqual({
      ok: false, code: 'refused', message: 'a2a.task.send: target "x" not found',
    });
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
    const res = await startHandoffWorktree(d, { item: { kind: 'issue', ref: issue }, repoPath: '/repo', workspaceId: 'ws-repo', agentCmd: 'codex' });
    expect(res).toEqual({ ok: true, linkId: 'link-new', workspaceId: 'ws-new', branch: 'issue-12-crash-on-launch' });
    const req = (d.startFanOut as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req).toMatchObject({
      titles: ['issue-12-crash-on-launch'], branches: ['issue-12-crash-on-launch'], repoPath: '/repo', agentCmd: 'codex',
      worktree: true, verifiedWorkspaceId: 'ws-repo',
    });
    expect(req.prompt).toContain('Read it with: gh issue view 12 --repo Acme/Widgets');
    expect(upserts[0]).toMatchObject({
      origin: 'issue', owner: { workspaceId: 'ws-new' }, agent: 'claude', worktree: { path: '/wt/issue-12', branch: 'issue-12-crash-on-launch' },
    });
  });

  it('defaults the agent to claude, refuses in-progress work, and reports a failed fan-out', async () => {
    const busy = deps({ links: [link({ state: 'needs-you' })] });
    expect((await startHandoffWorktree(busy.d, { item: { kind: 'issue', ref: issue }, repoPath: '/r', workspaceId: 'ws' })).ok).toBe(false);
    const { d } = deps();
    (d.startFanOut as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'preflight: branch already exists: issue-12-crash-on-launch', tasks: [] });
    const res = await startHandoffWorktree(d, { item: { kind: 'issue', ref: issue }, repoPath: '/r', workspaceId: 'ws', agentCmd: 'x; rm -rf /' });
    expect(res).toEqual({ ok: false, code: 'error', message: 'preflight: branch already exists: issue-12-crash-on-launch' });
    expect((d.startFanOut as ReturnType<typeof vi.fn>).mock.calls[0][0].agentCmd).toBe('claude');
  });
});

describe('waiting for the person to stop typing', () => {
  it('isPaneQuiet: no draft and keys idle for the window', () => {
    expect(isPaneQuiet({ hasDraft: false, keyInputIdleMs: 12_000 })).toBe(true);
    expect(isPaneQuiet({ hasDraft: true, keyInputIdleMs: 60_000 })).toBe(false);
    expect(isPaneQuiet({ keyInputIdleMs: 2_000 })).toBe(false);
    // An older daemon without the idle time answers with its short flag.
    expect(isPaneQuiet({ keyInputQuiet: true })).toBe(true);
    expect(isPaneQuiet({ keyInputQuiet: false })).toBe(false);
  });

  it('waits until quiet, gives up when typing goes on, and does not hold an unreadable pane', async () => {
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
    const states = [{ hasDraft: true }, { keyInputIdleMs: 3_000 }, { keyInputIdleMs: 11_000 }];
    let i = 0;
    expect(await waitForQuietInput(async () => states[Math.min(i++, 2)], clock)).toBe(true);
    t = 0;
    expect(await waitForQuietInput(async () => ({ hasDraft: true }), clock)).toBe(false);
    expect(t).toBeLessThanOrEqual(14_000);
    expect(await waitForQuietInput(async () => null, clock)).toBe(true);
  });
});
