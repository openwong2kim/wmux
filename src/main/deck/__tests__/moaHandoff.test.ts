import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoaHandoffService, looksLikeRefusal, handoffTitle, type MoaHandoffPorts, type ResolvedTarget } from '../moaHandoff';
import type { WorkspaceDecision } from '../deckDecisionStore';
import type { AgentMode } from '../deckAutonomyStore';
import type { DeliveryCheck } from '../../pipe/deliveryGuards';
import { HANDOFF_MARKER, HANDOFF_MESSAGE_MAX_CHARS } from '../../../shared/moaHandoff';

const HQ = 'ws-hq';
const SEAL = 'ws-seal';

function target(over: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return { workspaceId: SEAL, paneId: 'pane-1', ptyId: 'pty-1', agentName: 'Claude Code', agentStatus: 'idle', ...over };
}

interface Rig {
  svc: MoaHandoffService;
  ports: MoaHandoffPorts;
  modes: Record<string, AgentMode>;
  slots: Map<string, WorkspaceDecision>;
  checks: Map<string, DeliveryCheck>;
  deliver: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  state: { auto: boolean; operatorRequest: boolean; pane: 'gone' | 'shell' | 'agent' | 'unknown'; target: ResolvedTarget | null };
  file: string;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-handoff-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rig(over: Partial<MoaHandoffPorts> = {}, file = path.join(dir, 'moa-handoffs.json')): Rig {
  const modes: Record<string, AgentMode> = { [HQ]: 'assist', [SEAL]: 'assist' };
  const slots = new Map<string, WorkspaceDecision>();
  const checks = new Map<string, DeliveryCheck>();
  const state = { auto: true, operatorRequest: true, pane: 'agent' as 'gone' | 'shell' | 'agent' | 'unknown', target: target() as ResolvedTarget | null };
  let n = 0;
  const deliver = vi.fn(async (args: { guardKey?: string; presetTaskId?: string }) => {
    if (args.guardKey) {
      const c = checks.get(args.guardKey);
      const why = (await c?.beforePaste()) ?? (await c?.beforeEnter());
      if (why) return { ok: true as const, delivered: false, assurance: 'unverified' as const, reason: 'guard_refused' };
    }
    return { ok: true as const, taskId: args.presetTaskId, delivered: true, assurance: 'assured' as const };
  });
  const release = vi.fn(async () => undefined);
  const invoke = vi.fn(async () => ({ ok: true, result: { ok: true } }));
  const ports: MoaHandoffPorts = {
    hqWorkspaceId: () => HQ,
    moaReady: () => true,
    modeOf: (ws) => modes[ws] ?? 'off',
    autoHandoffEnabled: () => state.auto,
    hqServesOperatorRequest: () => state.operatorRequest,
    workspaceExists: () => true,
    workspaceName: (ws) => (ws === SEAL ? 'wseal' : ws),
    resolveTarget: async () => state.target,
    paneState: () => state.pane,
    decisions: {
      raiseIfFree: async (ws, card) => {
        if (slots.has(ws)) return null;
        const d: WorkspaceDecision = { id: `d${++n}`, question: card.question, options: card.options, context: card.context, status: 'pending', raisedAt: 1, origin: card.origin, ref: card.ref };
        slots.set(ws, d);
        return d;
      },
      load: (ws) => slots.get(ws) ?? null,
      resolve: async (ws, id, res) => {
        const d = slots.get(ws);
        if (!d || d.id !== id || d.status !== 'pending') return null;
        const r = { ...d, status: 'resolved' as const, resolution: res };
        slots.set(ws, r);
        return r;
      },
      clearResolved: async (ws, id) => {
        if (slots.get(ws)?.id === id) slots.delete(ws);
      },
      clearPendingIfUnchanged: async (ws, d) => {
        if (slots.get(ws)?.id === d.id) slots.delete(ws);
        return true;
      },
    },
    links: {
      upsert: async () => ({ id: 'link-1' }) as never,
      setState: async () => null,
      setLastQuestion: vi.fn(async () => undefined),
    },
    invoke,
    deliver: deliver as never,
    release,
    registerCheck: (key, c) => {
      checks.set(key, c);
      return () => checks.delete(key);
    },
    filePath: file,
    ...over,
  };
  return { svc: new MoaHandoffService(ports), ports, modes, slots, checks, deliver, release, invoke, state, file };
}

const propose = (r: Rig, body = 'Run a security audit of the auth module.', extra: Record<string, unknown> = {}) =>
  r.svc.propose(HQ, { ptyId: 'pty-1', body, ...extra });

describe('moa hand-off — the card', () => {
  it('a card says why it asks: outside danger mode, outside text, auto off, or this hour\'s cap', async () => {
    const r = rig();
    await propose(r);
    expect(r.svc.cardInfo(r.slots.get(SEAL)!.id)?.askReason).toBe('not-danger');
    r.slots.clear();
    r.modes[HQ] = 'danger';
    r.modes[SEAL] = 'danger';
    r.state.auto = false;
    await propose(r, 'Second task.');
    expect(r.svc.cardInfo(r.slots.get(SEAL)!.id)?.askReason).toBe('auto-off');
    r.slots.clear();
    r.state.auto = true;
    await propose(r, 'Third task.', { externalSource: true });
    expect(r.svc.cardInfo(r.slots.get(SEAL)!.id)?.askReason).toBe('external');
    expect(r.svc.cardInfo(r.slots.get(SEAL)!.id)?.id).toEqual(expect.any(String));
  });

  it('a card left over after Moa moved workspaces says so, not that the hourly cap was reached', async () => {
    let hq = HQ;
    const r = rig({ hqWorkspaceId: () => hq });
    await propose(r);
    const record = r.svc.byDecision(r.slots.get(SEAL)!.id)!;
    hq = 'ws-new-hq';
    expect((r.svc as unknown as { askReasonOf: (x: unknown) => string }).askReasonOf(record)).toBe('hq-moved');
  });

  it('raises a main-owned card in the TARGET slot and delivers nothing', async () => {
    const r = rig();
    const res = await propose(r);
    expect(res).toMatchObject({ ok: true, mode: 'card' });
    const d = r.slots.get(SEAL)!;
    expect(d.origin).toBe('moa-handoff');
    expect(d.options).toEqual(['Hand off', 'Edit', 'Cancel']);
    expect(r.slots.has(HQ)).toBe(false);
    expect(r.deliver).not.toHaveBeenCalled();
  });

  it('answers busy when the target slot is taken', async () => {
    const r = rig();
    r.slots.set(SEAL, { id: 'x', question: 'q', options: [], context: '', status: 'pending', raisedAt: 1 });
    expect(await propose(r)).toEqual({ ok: false, error: 'busy' });
  });

  it('refuses a caller that is not the HQ, an HQ target and an over-long body', async () => {
    const r = rig();
    expect(await r.svc.propose('ws-other', { ptyId: 'pty-1', body: 'x' })).toEqual({ ok: false, error: 'not_hq' });
    r.state.target = target({ workspaceId: HQ });
    expect(await propose(r)).toEqual({ ok: false, error: 'target_is_hq' });
    r.state.target = target();
    expect(await propose(r, 'x'.repeat(HANDOFF_MESSAGE_MAX_CHARS))).toEqual({ ok: false, error: 'body_too_long' });
    r.state.target = target({ agentName: null });
    expect(await propose(r)).toEqual({ ok: false, error: 'no_agent' });
  });

  it('warns on the card when the agent folds newlines or is mid-turn', async () => {
    let busy = true;
    const r = rig({ agentBusy: () => busy });
    r.state.target = target({ agentName: 'some-cli', agentStatus: 'running' });
    await propose(r);
    const d = r.slots.get(SEAL)!;
    expect(d.context).toMatch(/takes one line/);
    expect(d.context).toMatch(/will queue/);
    expect(r.svc.cardInfo(d.id)).toMatchObject({ foldsNewlines: true, willQueue: true });
    // "Working right now" follows the agent's live status, not the moment
    // Moa proposed: once its turn ended the card stops saying so.
    busy = false;
    expect(r.svc.cardInfo(d.id)).toMatchObject({ willQueue: false });
  });
});

describe('moa hand-off — the operator answers', () => {
  it('delivers only on the click, the stored body with the task line, as a new task', async () => {
    const r = rig();
    await propose(r);
    expect(r.deliver).not.toHaveBeenCalled();
    const d = r.slots.get(SEAL)!;
    const res = await r.svc.resolve(SEAL, d.id, 'handoff');
    expect(res).toMatchObject({ ok: true, delivered: true });
    const args = r.deliver.mock.calls[0][0] as { message: string; presetTaskId: string; guardKey?: string };
    expect(args.message.startsWith('Run a security audit of the auth module.')).toBe(true);
    expect(args.message).toContain(HANDOFF_MARKER);
    expect(args.message).toContain(args.presetTaskId.replace(/^task-/, '').slice(0, 8));
    expect(args.guardKey).toBeUndefined();
    expect(r.slots.has(SEAL)).toBe(false);
    // The task now routes to the HQ.
    expect(r.svc.hqForTask(args.presetTaskId)).toBe(HQ);
  });

  it('delivers the operator-edited body, refuses an empty edit', async () => {
    const r = rig();
    await propose(r);
    const d = r.slots.get(SEAL)!;
    expect(await r.svc.resolve(SEAL, d.id, 'handoff', '   ')).toEqual({ ok: false, code: 'body_empty' });
    await r.svc.resolve(SEAL, d.id, 'handoff', 'Audit only the login flow.');
    expect((r.deliver.mock.calls[0][0] as { message: string }).message.startsWith('Audit only the login flow.')).toBe(true);
  });

  it('cancel delivers nothing; a second click is not_pending', async () => {
    const r = rig();
    await propose(r);
    const d = r.slots.get(SEAL)!;
    expect(await r.svc.resolve(SEAL, d.id, 'cancel')).toEqual({ ok: true, delivered: false });
    expect(await r.svc.resolve(SEAL, d.id, 'handoff')).toBeNull();
    expect(r.deliver).not.toHaveBeenCalled();
  });

  it('a failed delivery releases the task and raises a notice card', async () => {
    const r = rig();
    r.deliver.mockResolvedValueOnce({ ok: true, delivered: false, assurance: 'unverified', reason: 'agent_changed' });
    await propose(r);
    const d = r.slots.get(SEAL)!;
    const res = await r.svc.resolve(SEAL, d.id, 'handoff');
    expect(res).toMatchObject({ ok: true, delivered: false });
    expect(r.release).toHaveBeenCalled();
    const notice = r.slots.get(SEAL)!;
    expect(notice.options).toEqual(['OK']);
    expect(notice.origin).toBe('moa-handoff');
    expect(await r.svc.resolve(SEAL, notice.id, 'ack')).toEqual({ ok: true, delivered: false });
    expect(r.slots.has(SEAL)).toBe(false);
  });
});

describe('moa hand-off — danger mode without a click', () => {
  const danger = (r: Rig) => {
    r.modes[HQ] = 'danger';
    r.modes[SEAL] = 'danger';
  };

  it('danger + danger delivers at once, no card, origin moa-auto, with a receipt', async () => {
    const upsert = vi.fn(async () => ({ id: 'link-1' }) as never);
    const r = rig();
    r.ports.links.upsert = upsert;
    danger(r);
    const res = await propose(r);
    expect(res).toMatchObject({ ok: true, mode: 'auto' });
    expect(r.slots.has(SEAL)).toBe(false);
    expect((upsert.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({ origin: 'moa-auto' });
    expect((r.deliver.mock.calls[0][0] as { guardKey?: string }).guardKey).toBeTruthy();
    expect(r.svc.receipts()).toHaveLength(1);
  });

  it('assist on either side asks with a card', async () => {
    const r = rig();
    r.modes[HQ] = 'danger';
    expect(await propose(r)).toMatchObject({ mode: 'card' });
    expect(r.deliver).not.toHaveBeenCalled();
  });

  it('a mode flipped mid-delivery falls back to the card', async () => {
    const r = rig();
    danger(r);
    r.deliver.mockImplementationOnce(async (args: { guardKey?: string }) => {
      r.modes[SEAL] = 'assist';
      const why = await r.checks.get(args.guardKey!)!.beforeEnter();
      expect(why).toMatch(/mode/);
      return { ok: true, delivered: false, assurance: 'unverified', reason: 'guard_refused' };
    });
    expect(await propose(r)).toMatchObject({ ok: true, mode: 'card' });
    expect(r.release).toHaveBeenCalled();
    expect(r.slots.get(SEAL)?.origin).toBe('moa-handoff');
  });

  it('an outside-source body, or no live operator request, asks with a card', async () => {
    const r = rig();
    danger(r);
    expect(await propose(r, 'Fix issue #12: <text from GitHub>', { externalSource: true })).toMatchObject({ mode: 'card' });
    r.slots.clear();
    r.state.operatorRequest = false;
    expect(await propose(r)).toMatchObject({ mode: 'card' });
    expect(r.deliver).not.toHaveBeenCalled();
  });

  it('the Settings switch off asks with a card', async () => {
    const r = rig();
    danger(r);
    r.state.auto = false;
    expect(await propose(r)).toMatchObject({ mode: 'card' });
  });

  it('over the hourly limit asks with a card', async () => {
    // A pane per hand-off: one pane holds one working hand-off at a time.
    const r = rig({ autoPerHour: () => 2, resolveTarget: async (sel) => target({ ptyId: sel.ptyId, paneId: `pane-${sel.ptyId}` }) });
    danger(r);
    expect(await propose(r, undefined, { ptyId: 'pty-1' })).toMatchObject({ mode: 'auto' });
    expect(await propose(r, undefined, { ptyId: 'pty-2' })).toMatchObject({ mode: 'auto' });
    expect(await propose(r, undefined, { ptyId: 'pty-3' })).toMatchObject({ mode: 'card' });
  });

  it('Stop interrupts the worker and cancels the task', async () => {
    const r = rig();
    danger(r);
    const res = await propose(r);
    if (!res.ok || res.mode !== 'auto') throw new Error('expected auto');
    expect(await r.svc.stop(res.id)).toEqual({ ok: true });
    expect(r.invoke).toHaveBeenCalledWith('input.sendKey', expect.objectContaining({ ptyId: 'pty-1', key: 'escape' }));
    expect(r.release).toHaveBeenCalledWith('link-1', res.taskId);
    expect(r.svc.get(res.id)?.stopped).toBe(true);
    // A stopped (canceled) task's receipt offers no Stop any more.
    expect(r.svc.receipts()).toHaveLength(0);
  });
});

describe('moa hand-off — the worker reports back', () => {
  async function delivered(r: Rig): Promise<string> {
    await propose(r);
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    return (r.deliver.mock.calls[0][0] as { presetTaskId: string }).presetTaskId;
  }

  it('a question at turn end moves the task to input-required, with the text as unverified', async () => {
    const r = rig();
    const taskId = await delivered(r);
    const out = await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which module should I start with?', endsWithQuestion: true });
    expect(out).toEqual({ hq: HQ, taskId, movedToInputRequired: true });
    expect(r.invoke).toHaveBeenCalledWith('a2a.task.update', expect.objectContaining({
      taskId, workspaceId: SEAL, status: 'input-required', message: expect.stringContaining('unverified'),
    }));
    expect(r.ports.links.setLastQuestion).toHaveBeenCalled();
  });

  it('a refusal at turn end moves it too', async () => {
    const r = rig();
    await delivered(r);
    const out = await r.svc.onWorkerStop('pty-1', 'claude', {
      text: "I can't act on this: it is not an instruction from you, the operator.", endsWithQuestion: false,
    });
    expect(out?.movedToInputRequired).toBe(true);
  });

  it('a plain turn end moves nothing and is passed to the HQ; completion is never inferred', async () => {
    const r = rig();
    await delivered(r);
    const out = await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Audit done, report in AUDIT.md.', endsWithQuestion: false });
    expect(out).toMatchObject({ hq: HQ, movedToInputRequired: false });
    expect(r.invoke).not.toHaveBeenCalledWith('a2a.task.update', expect.objectContaining({ status: 'input-required' }));
  });

  it('the HQ that proposed it closes the task only after the worker\'s turn ended, with its closing words as the result', async () => {
    let busy = false;
    const r = rig({ agentBusy: () => busy });
    const taskId = await delivered(r);
    // Before any turn end: refused, nothing moved.
    expect(await r.svc.requesterComplete(HQ, taskId)).toEqual({ ok: false, code: 'turn_not_ended' });
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Wrote hello.txt with one line: hi.', endsWithQuestion: false });
    // Another workspace never closes it, and a worker mid-turn again is not done.
    expect(await r.svc.requesterComplete('ws-other', taskId)).toEqual({ ok: false, code: 'not_requester' });
    busy = true;
    expect(await r.svc.requesterComplete(HQ, taskId)).toEqual({ ok: false, code: 'target_working' });
    expect(r.invoke).not.toHaveBeenCalledWith('a2a.task.update', expect.objectContaining({ status: 'completed' }));
    busy = false;
    expect(await r.svc.requesterComplete(HQ, taskId)).toEqual({ ok: true, result: 'Wrote hello.txt with one line: hi.' });
    expect(r.invoke).toHaveBeenCalledWith('a2a.task.update', expect.objectContaining({
      taskId, workspaceId: SEAL, status: 'completed',
      evidence: expect.objectContaining({ summary: 'Wrote hello.txt with one line: hi.' }),
    }));
    // deck_complete_work reads the hand-off as settled; the record survives a reload.
    expect(r.svc.handoffTaskStatus(taskId)).toBe('settled');
    expect(r.svc.closedByHq(taskId)).toBe(true);
    const reloaded = rig({}, r.file);
    expect(reloaded.svc.byTask(taskId)).toMatchObject({ taskState: 'completed', closedByHq: true, lastStop: { text: 'Wrote hello.txt with one line: hi.' } });
    expect(await r.svc.requesterComplete(HQ, taskId)).toEqual({ ok: false, code: 'ended' });
  });

  it('an interrupted turn (no Stop hook) ends by agent status: running, then idle', async () => {
    let busy: boolean | undefined = false;
    const r = rig({ agentBusy: () => busy });
    const taskId = await delivered(r);
    // Idle before the worker ever ran: no turn has ended yet.
    expect(await r.svc.sweepTurnEnds()).toEqual([]);
    expect(await r.svc.requesterComplete(HQ, taskId)).toEqual({ ok: false, code: 'turn_not_ended' });
    busy = true;
    expect(await r.svc.sweepTurnEnds()).toEqual([]);
    expect(await r.svc.requesterComplete(HQ, taskId)).toEqual({ ok: false, code: 'turn_not_ended' });
    // The mirror cannot tell: never read as a turn end.
    busy = undefined;
    expect(await r.svc.sweepTurnEnds()).toEqual([]);
    busy = false;
    expect(await r.svc.sweepTurnEnds()).toEqual([{ hq: HQ, taskId }]);
    // Counted once.
    expect(await r.svc.sweepTurnEnds()).toEqual([]);
    expect(await r.svc.requesterComplete(HQ, taskId)).toMatchObject({ ok: true });
  });

  it('a turn end the Stop hook already reported is not counted again by status, and keeps its words', async () => {
    let busy = true;
    let at = 1_000;
    const now = { t: 2_000 };
    const r = rig({ agentSample: () => ({ busy, at }), now: () => now.t });
    const taskId = await delivered(r);
    await r.svc.sweepTurnEnds();
    expect(r.svc.byTask(taskId)?.sawRunning).toBe(true);
    now.t = 3_000;
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Done.', endsWithQuestion: false });
    // One write: the hook's turn end cleared sawRunning and it stays cleared.
    expect(r.svc.byTask(taskId)?.sawRunning).toBeUndefined();
    // A running snapshot sampled before that turn end is about that turn.
    at = 2_500;
    expect(await r.svc.sweepTurnEnds()).toEqual([]);
    expect(r.svc.byTask(taskId)?.sawRunning).toBeUndefined();
    busy = false;
    expect(await r.svc.sweepTurnEnds()).toEqual([]);
    expect(await r.svc.requesterComplete(HQ, taskId)).toEqual({ ok: true, result: 'Done.' });
  });

  it('a queued hand-off whose earlier turn was interrupted (no Stop) still sees its own turn end', async () => {
    let busy = true;
    const r = rig({ agentBusy: () => busy });
    r.state.target = target({ agentStatus: 'running' });
    const taskId = await delivered(r);
    expect(r.svc.byTask(taskId)?.skipStops).toBe(1);
    // The earlier turn runs, then is interrupted: no Stop hook.
    await r.svc.sweepTurnEnds();
    busy = false;
    expect(await r.svc.sweepTurnEnds()).toEqual([]);
    expect(r.svc.byTask(taskId)?.skipStops).toBe(0);
    // The hand-off's own turn runs and ends with a Stop: recorded, not skipped.
    busy = true;
    await r.svc.sweepTurnEnds();
    const out = await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Wrote the file.', endsWithQuestion: false });
    expect(out).toMatchObject({ hq: HQ, taskId });
    busy = false;
    expect(await r.svc.requesterComplete(HQ, taskId)).toEqual({ ok: true, result: 'Wrote the file.' });
  });

  it('a task waiting on the operator (a question at turn end) is not the HQ\'s to close', async () => {
    const r = rig();
    const taskId = await delivered(r);
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which module should I start with?', endsWithQuestion: true });
    expect(await r.svc.requesterComplete(HQ, taskId)).toEqual({ ok: false, code: 'needs_input' });
  });

  it('wmux ending a task (pane gone, or replaced by a newer hand-off) is marked as such; the operator\'s Stop is not', async () => {
    const r = rig();
    const first = await delivered(r);
    // A newer hand-off to the same pane (answering its question) replaces the open one.
    r.slots.clear();
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which one?', endsWithQuestion: true });
    await propose(r, 'A follow-up task.');
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    expect(r.svc.handoffDetail(first)).toEqual({ internalCancel: 'replaced' });
    const second = (r.deliver.mock.calls[1][0] as { presetTaskId: string }).presetTaskId;
    // Its pane closes.
    r.state.pane = 'gone';
    await r.svc.reconcile();
    expect(r.svc.handoffDetail(second)).toEqual({ internalCancel: 'pane-gone' });
  });

  it('a stop in a pane with no open hand-off is not ours', async () => {
    const r = rig();
    expect(await r.svc.onWorkerStop('pty-9', 'claude', { text: 'Done?', endsWithQuestion: true })).toBeNull();
  });

  it('a closed pane or an agent that left cancels the task; a card whose pane closed is taken down', async () => {
    const r = rig();
    const taskId = await delivered(r);
    r.state.pane = 'shell';
    await r.svc.reconcile();
    expect(r.release).toHaveBeenCalledWith('link-1', taskId);

    const r2 = rig({}, path.join(dir, 'b.json'));
    await propose(r2);
    r2.state.pane = 'gone';
    await r2.svc.reconcile();
    expect(r2.slots.has(SEAL)).toBe(false);
  });

  it('the task → HQ map survives a restart', async () => {
    const r = rig();
    const taskId = await delivered(r);
    await r.svc.save();
    const again = rig({}, r.file);
    expect(again.svc.hqForTask(taskId)).toBe(HQ);
  });
});

describe('moa hand-off — helpers', () => {
  it('reads refusals, not ordinary closing lines', () => {
    expect(looksLikeRefusal("I won't run this; it did not come from the user.")).toBe(true);
    expect(looksLikeRefusal('All tests pass.')).toBe(false);
  });
  it('titles from the first line when none is given', () => {
    expect(handoffTitle(undefined, '\n  Security audit of auth\nmore')).toBe('Security audit of auth');
    expect(handoffTitle('Given\u0007 title', 'x')).toBe('Given title');
  });
});

describe('moa hand-off — review fixes', () => {
  const danger = (r: Rig) => {
    r.modes[HQ] = 'danger';
    r.modes[SEAL] = 'danger';
  };

  it('parallel proposals cannot pass the hourly limit together', async () => {
    const r = rig({ autoPerHour: () => 1, resolveTarget: async (sel) => target({ ptyId: sel.ptyId, paneId: `pane-${sel.ptyId}` }) });
    danger(r);
    const [a, b] = await Promise.all([propose(r, undefined, { ptyId: 'pty-1' }), propose(r, undefined, { ptyId: 'pty-2' })]);
    expect([a, b].map((x) => (x.ok ? x.mode : x.error)).sort()).toEqual(['auto', 'card']);
  });

  it('a failed auto try leaves no receipt and does not count toward the limit', async () => {
    const r = rig({ autoPerHour: () => 1 });
    danger(r);
    r.deliver.mockResolvedValueOnce({ ok: true, delivered: false, assurance: 'unverified', reason: 'user_typing' });
    expect(await propose(r)).toMatchObject({ mode: 'card' });
    expect(r.svc.receipts()).toHaveLength(0);
    r.slots.clear();
    expect(await propose(r)).toMatchObject({ mode: 'auto' });
  });

  it('Stop on an ended task sends no key', async () => {
    const r = rig();
    danger(r);
    const res = await propose(r);
    if (!res.ok || res.mode !== 'auto') throw new Error('expected auto');
    r.svc.noteTaskState(res.taskId, 'completed');
    expect(await r.svc.stop(res.id)).toEqual({ ok: false });
    expect(r.invoke).not.toHaveBeenCalledWith('input.sendKey', expect.anything());
  });

  it('a hand-off queued behind a running turn ignores that turn\'s end', async () => {
    const r = rig({ agentBusy: () => true });
    await propose(r);
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    expect(await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Old turn: shall I go on?', endsWithQuestion: true })).toBeNull();
    expect((await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which module first?', endsWithQuestion: true }))?.movedToInputRequired).toBe(true);
  });

  it('a follow-up hand-off to the same pane ends the one it replaces, so a turn end has one owner', async () => {
    const r = rig();
    await propose(r);
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    const first = (r.deliver.mock.calls[0][0] as { presetTaskId: string }).presetTaskId;
    // The worker asked a question: a follow-up is how it gets answered.
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which module?', endsWithQuestion: true });
    await propose(r, 'Second job: answer to your question.');
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    const second = (r.deliver.mock.calls[1][0] as { presetTaskId: string }).presetTaskId;
    expect(r.release).toHaveBeenCalledWith('link-1', first);
    expect(r.svc.byTask(first)?.taskState).toBe('canceled');
    const out = await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which one?', endsWithQuestion: true });
    expect(out).toMatchObject({ taskId: second, movedToInputRequired: true });
  });

  it('the wake quotes the END of the worker\'s words, where its question is', async () => {
    const r = rig();
    await propose(r);
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    const taskId = (r.deliver.mock.calls[0][0] as { presetTaskId: string }).presetTaskId;
    await r.svc.onWorkerStop('pty-1', 'claude', { text: `${'context '.repeat(80)}Which framework is it?`, endsWithQuestion: true });
    const q = r.svc.handoffDetail(taskId)!.question!;
    expect(q.endsWith('Which framework is it?')).toBe(true);
    expect([...q].length).toBeLessThanOrEqual(281);
  });

  it('Cancel tells the HQ', async () => {
    const onOperatorCancel = vi.fn();
    const r = rig({ onOperatorCancel });
    await propose(r);
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'cancel');
    expect(onOperatorCancel).toHaveBeenCalledTimes(1);
  });

  it('a card whose body could not be saved is taken down', async () => {
    const r = rig({}, path.join(dir, 'missing-dir', 'nested', 'x.json'));
    fs.writeFileSync(path.join(dir, 'missing-dir'), 'a file, so the directory cannot be created');
    expect(await propose(r)).toMatchObject({ ok: false, error: 'error' });
    expect(r.slots.has(SEAL)).toBe(false);
  });

  it('a delivery the app stopped in the middle of is released, with a notice', async () => {
    let now = 1_000_000;
    const r = rig({ now: () => now });
    let hang: () => void = () => undefined;
    r.deliver.mockImplementationOnce(() => new Promise((res) => { hang = () => res({ ok: false, code: 'error', message: 'x' }); }));
    await propose(r);
    void r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    await new Promise((res) => setTimeout(res, 10));
    now += 5 * 60_000;
    const fresh = rig({ now: () => now }, r.file);
    await r.svc.save();
    const reloaded = new MoaHandoffService({ ...fresh.ports, filePath: r.file });
    await reloaded.reconcile();
    expect(fresh.release).toHaveBeenCalled();
    expect(fresh.slots.get(SEAL)?.options).toEqual(['OK']);
    hang();
  });
});

describe('moa hand-off — panel review round 2', () => {
  it('a save that fails before delivery delivers nothing and releases the link', async () => {
    const r = rig();
    await propose(r);
    const d = r.slots.get(SEAL)!;
    // From here on every write fails.
    const notADir = path.join(dir, 'plain-file');
    fs.writeFileSync(notADir, 'x');
    (r.ports as { filePath?: string }).filePath = path.join(notADir, 'moa-handoffs.json');
    const res = await r.svc.resolve(SEAL, d.id, 'handoff');
    expect(res).toMatchObject({ ok: true, delivered: false });
    expect(r.deliver).not.toHaveBeenCalled();
    expect(r.release).toHaveBeenCalledWith('link-1', undefined);
  });

  it('after a restart, a "delivering" record is settled from the canonical task state', async () => {
    let now = 1_000_000;
    const r = rig({ now: () => now });
    let finish: () => void = () => undefined;
    r.deliver.mockImplementationOnce((args: { presetTaskId: string }) => new Promise((res) => {
      finish = () => res({ ok: true, taskId: args.presetTaskId, delivered: true, assurance: 'assured' });
    }));
    await propose(r);
    void r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    await new Promise((res) => setTimeout(res, 10));
    // The app stops here: disk says "delivering". The task exists and is open.
    now += 5 * 60_000;
    const after = rig({ now: () => now, taskState: async () => 'working' }, r.file);
    await after.svc.reconcile();
    expect(after.release).not.toHaveBeenCalled();
    const rec = Object.values((after.svc as unknown as { file: { items: Record<string, { state: string; taskState?: string }> } }).file.items)[0];
    expect(rec).toMatchObject({ state: 'delivered', taskState: 'working' });
    finish();
  });

  it('a task event that lands before the send answers is not rolled back', async () => {
    const r = rig();
    r.deliver.mockImplementationOnce(async (args: { presetTaskId: string }) => {
      // The worker finished before the delivery call returned.
      r.svc.noteTaskState(args.presetTaskId, 'completed');
      return { ok: true, taskId: args.presetTaskId, delivered: true, assurance: 'assured' };
    });
    r.modes[HQ] = 'danger';
    r.modes[SEAL] = 'danger';
    const res = await propose(r);
    if (!res.ok || res.mode !== 'auto') throw new Error('expected auto');
    expect(r.svc.byTask(res.taskId)?.taskState).toBe('completed');
    // …so Stop cannot reach a later turn in that pane, and the receipt is gone.
    expect(await r.svc.stop(res.id)).toEqual({ ok: false });
    expect(r.svc.receipts()).toHaveLength(0);
  });

  it('the card preview never splits a surrogate pair', async () => {
    const r = rig();
    await propose(r, `${'a'.repeat(599)}😀${'b'.repeat(50)}`);
    const ctx = r.slots.get(SEAL)!.context;
    expect(ctx).toContain('😀…');
    expect(ctx).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});


describe('moa hand-off — live dogfood findings', () => {
  async function delivered(r: Rig): Promise<string> {
    await propose(r);
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    return (r.deliver.mock.calls[0][0] as { presetTaskId: string }).presetTaskId;
  }
  const statuses = (r: Rig): string[] =>
    r.invoke.mock.calls.filter((c) => c[0] === 'a2a.task.update').map((c) => (c[1] as { status: string }).status);

  it('a delivered task is marked working, so a later question can move it to input-required', async () => {
    const r = rig();
    const taskId = await delivered(r);
    expect(statuses(r)).toEqual(['working']);
    expect(r.svc.byTask(taskId)?.taskState).toBe('working');
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which stack is it?', endsWithQuestion: true });
    expect(statuses(r)).toEqual(['working', 'input-required']);
  });

  it('a task the delivery could not mark working is stepped through working before input-required', async () => {
    const r = rig();
    r.invoke.mockImplementation(async (_m: string, p: { status?: string }) =>
      p.status === 'working' && r.invoke.mock.calls.length === 1 ? { ok: true, result: { error: 'busy' } } : { ok: true, result: { ok: true } });
    const taskId = await delivered(r);
    expect(r.svc.byTask(taskId)?.taskState).toBe('submitted');
    const out = await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which stack is it?', endsWithQuestion: true });
    expect(out?.movedToInputRequired).toBe(true);
    expect(statuses(r).slice(-2)).toEqual(['working', 'input-required']);
  });

  it('the wake for the task carries the question; the HQ waits on the hand-off without a decision', async () => {
    const r = rig();
    await propose(r);
    expect(r.svc.waitingOnHandoff(HQ)).toBe(true); // the card is up
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    const taskId = (r.deliver.mock.calls[0][0] as { presetTaskId: string }).presetTaskId;
    expect(r.svc.waitingOnHandoff(HQ)).toBe(true); // the task is open
    expect(r.svc.handoffTaskStatus(taskId)).toBe('open');
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which stack is it?', endsWithQuestion: true });
    expect(r.svc.handoffDetail(taskId)).toEqual({ question: 'Which stack is it?' });
    r.svc.noteTaskState(taskId, 'canceled');
    expect(r.svc.handoffTaskStatus(taskId)).toBe('settled');
    expect(r.svc.waitingOnHandoff(HQ)).toBe(false);
    expect(r.svc.handoffTaskStatus('task-other')).toBeNull();
  });
});

describe('moa hand-off — no wrong wakes, no stale cards', () => {
  async function delivered(r: Rig): Promise<string> {
    await propose(r);
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    return (r.deliver.mock.calls[0][0] as { presetTaskId: string }).presetTaskId;
  }

  it('a worker sitting on a permission prompt has not ended its turn (the run\'s exact sequence)', async () => {
    // Delivered → running → Bash prompt → running → second prompt → running → idle.
    let status = 'idle' as 'idle' | 'running' | 'awaiting_input';
    let n = 0;
    const r = rig({
      agentBusy: () => status !== 'idle',
      agentSample: () => ({ busy: status === 'running', ...(status === 'awaiting_input' ? { blocked: true } : {}), at: Date.now() + ++n }),
    });
    const taskId = await delivered(r);
    const steps: Array<typeof status> = ['running', 'awaiting_input', 'running', 'awaiting_input', 'awaiting_input', 'running'];
    for (const s of steps) {
      status = s;
      expect(await r.svc.sweepTurnEnds()).toEqual([]);
    }
    // Moa may not close the task while the worker waits on a prompt.
    status = 'awaiting_input';
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Done.', endsWithQuestion: false });
    expect(await r.svc.requesterComplete(HQ, taskId)).toEqual({ ok: false, code: 'target_working' });
    status = 'running';
    await r.svc.sweepTurnEnds();
    // The real turn end wakes once.
    status = 'idle';
    expect(await r.svc.sweepTurnEnds()).toEqual([{ hq: HQ, taskId }]);
    expect(await r.svc.sweepTurnEnds()).toEqual([]);
  });

  it('a second proposal for a pane whose hand-off is still working is refused, and raises no card', async () => {
    const r = rig();
    const taskId = await delivered(r);
    const res = await propose(r, 'Report the result of the subtract task.');
    expect(res).toMatchObject({ ok: false, error: 'task_open' });
    expect(r.slots.has(SEAL)).toBe(false);
    // Once the task is done, a new job for that pane is a card again.
    r.svc.noteTaskState(taskId, 'completed');
    expect(await propose(r, 'A new job.')).toMatchObject({ ok: true, mode: 'card' });
  });

  it('a card for a pane whose task completes is taken down (requester close)', async () => {
    const r = rig();
    const taskId = await delivered(r);
    // A follow-up card raised while the worker was asking a question.
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Add a test too?', endsWithQuestion: true });
    expect(await propose(r, 'Yes, add one test.')).toMatchObject({ ok: true, mode: 'card' });
    const card = r.slots.get(SEAL)!;
    expect(r.svc.waitingOnHandoff(HQ)).toBe(true);
    // The task completes (the worker's own close, seen as an A2A event).
    r.svc.noteTaskState(taskId, 'completed');
    await vi.waitFor(() => expect(r.svc.cardInfo(card.id)).toBeNull());
    expect(r.slots.has(SEAL)).toBe(false);
    expect(r.svc.byDecision(card.id)).toBeNull();
  });

  it('finishing the job (deck_complete_work) takes down every unanswered card Moa raised', async () => {
    const r = rig();
    await propose(r);
    const card = r.slots.get(SEAL)!;
    expect(await r.svc.closeMootCards('ws-other-hq')).toBe(0);
    expect(r.slots.get(SEAL)).toBe(card);
    expect(await r.svc.closeMootCards(HQ)).toBe(1);
    expect(r.slots.has(SEAL)).toBe(false);
    expect(r.svc.waitingOnHandoff(HQ)).toBe(false);
    // The record is not pending any more after a restart either.
    expect(rig({}, r.file).svc.cardInfo(card.id)).toBeNull();
  });

  it('a first sample on the prompt itself still counts as the turn under way', async () => {
    let status = 'idle' as 'idle' | 'running' | 'awaiting_input';
    let n = 0;
    const r = rig({
      agentBusy: () => status !== 'idle',
      agentSample: () => ({ busy: status === 'running', ...(status === 'awaiting_input' ? { blocked: true } : {}), at: Date.now() + ++n }),
    });
    const taskId = await delivered(r);
    // The agent took the text and hit a prompt before any sample saw it run.
    status = 'awaiting_input';
    expect(await r.svc.sweepTurnEnds()).toEqual([]);
    status = 'idle';
    expect(await r.svc.sweepTurnEnds()).toEqual([{ hq: HQ, taskId }]);
  });

  it('a task that fails or is canceled takes down its follow-up card too', async () => {
    const r = rig();
    const taskId = await delivered(r);
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which file?', endsWithQuestion: true });
    await propose(r, 'math.js.');
    const card = r.slots.get(SEAL)!;
    r.svc.noteTaskState(taskId, 'canceled');
    await vi.waitFor(() => expect(r.svc.cardInfo(card.id)).toBeNull());
    expect(r.slots.has(SEAL)).toBe(false);
  });

  it('an open task of a former HQ blocks a proposal to that pane, even a follow-up', async () => {
    let hq = HQ;
    const r = rig({ hqWorkspaceId: () => hq });
    await delivered(r);
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which file?', endsWithQuestion: true });
    hq = 'ws-new-hq';
    expect(await r.svc.propose('ws-new-hq', { ptyId: 'pty-1', body: 'math.js.' })).toMatchObject({ ok: false, error: 'task_open' });
  });

  it('a task ending closes only its own follow-up card, not another job\'s card on the same pane', async () => {
    const r = rig();
    const t1 = await delivered(r);
    r.svc.noteTaskState(t1, 'completed');
    // A new job for the same pane: its card follows no task.
    expect(await propose(r, 'A different job.')).toMatchObject({ ok: true, mode: 'card' });
    const card = r.slots.get(SEAL)!;
    // A late end event of the old task (completed → canceled).
    r.svc.noteTaskState(t1, 'canceled');
    await new Promise((res) => setTimeout(res, 0));
    expect(r.svc.cardInfo(card.id)).not.toBeNull();
    expect(r.slots.get(SEAL)).toBe(card);
  });

  it('the requester close takes down that pane\'s card too', async () => {
    let busy = false;
    const r = rig({ agentBusy: () => busy });
    const taskId = await delivered(r);
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which file?', endsWithQuestion: true });
    await propose(r, 'math.js.');
    expect(r.slots.has(SEAL)).toBe(true);
    // Back to working, the worker finishes; Moa closes the task.
    r.svc.noteTaskState(taskId, 'working');
    await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Added subtract.', endsWithQuestion: false });
    busy = false;
    expect(await r.svc.requesterComplete(HQ, taskId)).toMatchObject({ ok: true });
    expect(r.slots.has(SEAL)).toBe(false);
  });
});
