import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseHandOutPick, pickHandOut, type HandOutPickDeps } from '../handOutPick';
import { HandOutStore } from '../handOutStore';
import { WorkLinkStore } from '../../workLink/workLinkStore';
import { watchHandoffWorktreeLinks } from '../../git/handoff';
import { buildHandOutMessage, type HandOutItem } from '../../../shared/handOut';
import type { LedgerStatus } from '../../../shared/ledger';
import type { FanOutRequest, FanOutResult } from '../../worktask/FanOutService';

const target = { workspaceId: 'ws-target', paneId: 'pane-1', surfaceId: 'surf-1', ptyId: 'pty-1', agentName: 'Claude Code', agentSlug: 'claude' };

let dir: string;
let links: WorkLinkStore;
let store: HandOutStore;
let item: HandOutItem;
/** What the next send's renderer answers; the send joins the named link as a2a.rpc does. */
let sendReply: Record<string, unknown>;
let cancelTakes: boolean;
let fanOut: (req: FanOutRequest) => Promise<FanOutResult>;
let invoke: Mock<(method: string, params: Record<string, unknown>) => Promise<unknown>>;

function deps(over: Partial<HandOutPickDeps> = {}): HandOutPickDeps {
  return {
    invoke,
    links: { list: (f) => links.list(f), upsert: (i) => links.upsert(i), setState: (id, st, why) => links.setState(id, st, why) },
    startFanOut: vi.fn((req: FanOutRequest) => fanOut(req)),
    store,
    confinePath: async (folder) => `/real${folder}`,
    ...over,
  };
}
const sends = () => invoke.mock.calls.filter((c) => c[0] === 'a2a.task.send').map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-hand-out-pick-'));
  links = new WorkLinkStore({ dir, pendingDecisionIds: () => new Set() });
  store = new HandOutStore({ dir, links });
  const added = store.add({ title: 'Fix the crash', folder: '/repo/app', agent: 'claude', note: 'logs first' }, { kind: 'owner' });
  if (!added.ok) throw new Error('add failed');
  item = added.item;
  sendReply = { ok: true, taskId: 'task-9', delivery: { notified: true, submit: 'assured' } };
  cancelTakes = true;
  fanOut = async () => ({ ok: true, tasks: [{ index: 0, title: 't', ok: true, workspaceId: 'ws-new', worktreePath: '/wt/hand-out', branch: 'hand-out-fix-the-crash-abc123', agent: 'claude' }] });
  invoke = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'a2a.task.send') {
      if (sendReply.ok === true && typeof sendReply.taskId === 'string' && typeof params.workLinkId === 'string') {
        await links.upsert({ id: params.workLinkId, a2aTaskId: sendReply.taskId, a2aState: 'submitted' });
      }
      return { ok: true, result: sendReply };
    }
    if (method === 'a2a.task.cancel') {
      if (!cancelTakes) return { ok: true, result: { ok: false } };
      await links.upsert({ a2aTaskId: params.taskId as string, a2aState: 'canceled' });
      return { ok: true, result: { ok: true } };
    }
    return null;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('a pick to an agent pane', () => {
  it('records the item\'s link, then sends the item as a gated task joined to it; the item is out', async () => {
    const res = await pickHandOut(deps(), { itemId: item.id, to: { kind: 'pane', target } });
    expect(res).toMatchObject({ ok: true, taskId: 'task-9', delivered: true, assurance: 'assured' });
    const linkId = res.ok ? res.linkId : '';
    expect(links.get(linkId)).toMatchObject({
      origin: 'hand-out', handOutId: item.id, title: 'Fix the crash', a2aTaskId: 'task-9', state: 'queued',
      owner: { workspaceId: 'ws-target', paneId: 'pane-1' }, agent: 'claude',
    });
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatchObject({
      workspaceId: 'ws-human', to: 'ws-target', paneId: 'pane-1', surfaceId: 'surf-1', workLinkId: linkId,
      gatedDelivery: true, referenceDelivery: true, title: 'Fix the crash', message: buildHandOutMessage(item),
    });
    expect(store.get(item.id)).toMatchObject({ state: 'out', linkId });
  });

  it('a company pick is the owner\'s task to its CEO, asking it to brief a seat', async () => {
    const res = await pickHandOut(deps(), { itemId: item.id, to: { kind: 'company', target } });
    expect(res).toMatchObject({ ok: true, delivered: true });
    expect(sends()[0].message).toBe(buildHandOutMessage(item, { company: true }));
    expect(String(sends()[0].message)).toContain('Brief one of your seats with it');
    expect(store.get(item.id)?.state).toBe('out');
  });

  it('a send that was not delivered cancels its task, and the item is open again', async () => {
    sendReply = { ok: true, taskId: 'task-9', delivery: { notified: false, reason: 'agent_busy' } };
    const res = await pickHandOut(deps(), { itemId: item.id, to: { kind: 'pane', target } });
    expect(res).toMatchObject({ ok: true, taskId: 'task-9', delivered: false, reason: 'agent_busy' });
    expect(res).not.toHaveProperty('assurance');
    expect(invoke.mock.calls.find((c) => c[0] === 'a2a.task.cancel')?.[1]).toMatchObject({ taskId: 'task-9' });
    expect(links.get(res.ok ? res.linkId : '')?.state).toBe('abandoned');
    expect(store.get(item.id)?.state).toBe('open');
    // The reservation ended with the call: it can be picked again.
    expect(store.reserve(item.id)).toBe(true);
  });

  it('a refused send closes the link, and the item is open again', async () => {
    sendReply = { error: 'the pane has no agent' };
    const res = await pickHandOut(deps(), { itemId: item.id, to: { kind: 'pane', target } });
    expect(res).toEqual({ ok: false, code: 'refused', message: 'the pane has no agent' });
    expect(links.list().map((l) => l.state)).toEqual(['abandoned']);
    expect(store.get(item.id)?.state).toBe('open');
  });

  it('an undelivered task whose cancel did not take is closed by hand', async () => {
    sendReply = { ok: true, taskId: 'task-9', delivery: { notified: false } };
    cancelTakes = false;
    await pickHandOut(deps(), { itemId: item.id, to: { kind: 'pane', target } });
    expect(store.get(item.id)?.state).toBe('open');
  });
});

describe('what a pick refuses', () => {
  it('an item that is out is taken; nothing is sent', async () => {
    await pickHandOut(deps(), { itemId: item.id, to: { kind: 'pane', target } });
    invoke.mockClear();
    const res = await pickHandOut(deps(), { itemId: item.id, to: { kind: 'pane', target } });
    expect(res).toMatchObject({ ok: false, code: 'taken' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a second pick while the first one sends is taken', async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const first = deps({
      invoke: vi.fn(async (method: string, params: Record<string, unknown>) => {
        await gate;
        return invoke(method, params);
      }),
    });
    const running = pickHandOut(first, { itemId: item.id, to: { kind: 'pane', target } });
    await vi.waitFor(() => expect(first.invoke).toHaveBeenCalled(), { timeout: 5_000 });
    const second = await pickHandOut(deps(), { itemId: item.id, to: { kind: 'worktree', workspaceId: 'ws-repo' } });
    expect(second).toMatchObject({ ok: false, code: 'taken' });
    open();
    expect(await running).toMatchObject({ ok: true, delivered: true });
    expect(sends()).toHaveLength(1);
  });

  it('an item no longer on the list is unknown; a malformed request is invalid', async () => {
    expect(await pickHandOut(deps(), { itemId: `ho-${randomUUID()}`, to: { kind: 'pane', target } })).toMatchObject({ ok: false, code: 'unknown' });
    expect(await pickHandOut(deps(), { itemId: item.id, to: { kind: 'pane', target: { ...target, paneId: 'pane 1; x' } } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await pickHandOut(deps(), { itemId: item.id, to: { kind: 'worktree', workspaceId: 'remote:link-1' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await pickHandOut(deps(), { itemId: item.id, to: { kind: 'worktree', workspaceId: 'ws-repo', agentCmd: 'claude\nrm -rf ~' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await pickHandOut(deps(), { itemId: item.id, to: { kind: 'elsewhere' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(invoke).not.toHaveBeenCalled();
    expect(links.list()).toEqual([]);
  });

  it('parses each target kind', () => {
    expect(parseHandOutPick({ itemId: item.id, to: { kind: 'company', target } })).toEqual({ itemId: item.id, to: { kind: 'company', target } });
    expect(parseHandOutPick({ itemId: item.id, to: { kind: 'worktree', workspaceId: 'ws-repo', agentCmd: 'codex' } }))
      .toEqual({ itemId: item.id, to: { kind: 'worktree', workspaceId: 'ws-repo', agentCmd: 'codex' } });
    expect(parseHandOutPick({ itemId: 'ho-1', to: { kind: 'pane', target } })).toBeNull();
  });
});

describe('a pick to a new worktree', () => {
  it('starts the fan-out in the item\'s folder on a hand-out branch, with the item as the prompt, and links the worktree', async () => {
    const d = deps();
    const res = await pickHandOut(d, { itemId: item.id, to: { kind: 'worktree', workspaceId: 'ws-repo', agentCmd: 'codex' } });
    const req = (d.startFanOut as ReturnType<typeof vi.fn>).mock.calls[0][0] as FanOutRequest;
    expect(req).toMatchObject({
      prompt: buildHandOutMessage(item), repoPath: '/real/repo/app', agentCmd: 'codex', worktree: true,
      verifiedWorkspaceId: 'ws-repo', prepOrigin: 'human',
    });
    expect(req.idempotencyKey).toMatch(/^hand-out-/);
    expect(req.branches?.[0]).toMatch(/^hand-out-fix-the-crash-[0-9a-f]{6}$/);
    expect(req.titles).toEqual(req.branches);
    expect(res).toMatchObject({ ok: true, branch: 'hand-out-fix-the-crash-abc123' });
    expect(links.get(res.ok ? res.linkId : '')).toMatchObject({
      origin: 'hand-out', handOutId: item.id, owner: { workspaceId: 'ws-new' }, agent: 'claude',
      worktree: { path: '/wt/hand-out', branch: 'hand-out-fix-the-crash-abc123' },
    });
    expect(store.get(item.id)?.state).toBe('out');
  });

  it('starts nothing when its link cannot be recorded, so the item never runs while it reads open', async () => {
    const d = deps({ links: { list: (f) => links.list(f), upsert: async () => null, setState: (id, st, why) => links.setState(id, st, why) } });
    expect(await pickHandOut(d, { itemId: item.id, to: { kind: 'worktree', workspaceId: 'ws-repo' } })).toMatchObject({ ok: false, code: 'error' });
    expect(d.startFanOut).not.toHaveBeenCalled();
    expect(store.get(item.id)?.state).toBe('open');
  });

  it('keeps the worktree on the link when the link refuses the agent the start reported', async () => {
    fanOut = async () => ({ ok: true, tasks: [{ index: 0, title: 't', ok: true, workspaceId: 'ws-new', worktreePath: '/wt/hand-out', branch: 'hand-out-x-abc123', agent: 'not a slug!' }] });
    const res = await pickHandOut(deps(), { itemId: item.id, to: { kind: 'worktree', workspaceId: 'ws-repo' } });
    expect(links.get(res.ok ? res.linkId : '')).toMatchObject({ owner: { workspaceId: 'ws-new' }, worktree: { path: '/wt/hand-out', branch: 'hand-out-x-abc123' } });
  });

  it('the fan-out mission finishing takes the item off the list', async () => {
    let transition: (t: { entry: { taskWorkspaceId: string }; to: LedgerStatus }) => void = () => undefined;
    const stop = watchHandoffWorktreeLinks({ onTransition: (fn) => { transition = fn; return () => undefined; } }, links);
    await pickHandOut(deps(), { itemId: item.id, to: { kind: 'worktree', workspaceId: 'ws-repo' } });
    transition({ entry: { taskWorkspaceId: 'ws-new' }, to: 'completed' });
    await vi.waitFor(() => expect(store.get(item.id)).toBeNull(), { timeout: 5_000 });
    expect(store.list()).toEqual([]);
    stop();
  });

  it('a folder the app may not open, or a fan-out that fails, leaves the item open', async () => {
    const confined = deps({ confinePath: async () => null });
    expect(await pickHandOut(confined, { itemId: item.id, to: { kind: 'worktree', workspaceId: 'ws-repo' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(confined.startFanOut).not.toHaveBeenCalled();
    fanOut = async () => ({ ok: false, error: 'not a git repository', tasks: [] });
    expect(await pickHandOut(deps(), { itemId: item.id, to: { kind: 'worktree', workspaceId: 'ws-repo' } }))
      .toEqual({ ok: false, code: 'error', message: 'not a git repository' });
    expect(links.list().map((l) => l.state)).toEqual(['abandoned']);
    expect(store.get(item.id)?.state).toBe('open');
  });
});
