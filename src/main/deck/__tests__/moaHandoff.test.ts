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
    const r = rig();
    r.state.target = target({ agentName: 'some-cli', agentStatus: 'running' });
    await propose(r);
    const d = r.slots.get(SEAL)!;
    expect(d.context).toMatch(/takes one line/);
    expect(d.context).toMatch(/will queue/);
    expect(r.svc.cardInfo(d.id)).toMatchObject({ foldsNewlines: true, willQueue: true });
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
    const r = rig({ autoPerHour: () => 2 });
    danger(r);
    expect(await propose(r)).toMatchObject({ mode: 'auto' });
    expect(await propose(r)).toMatchObject({ mode: 'auto' });
    expect(await propose(r)).toMatchObject({ mode: 'card' });
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
    const r = rig({ autoPerHour: () => 1 });
    danger(r);
    const [a, b] = await Promise.all([propose(r), propose(r)]);
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

  it('two open hand-offs in one pane: a turn end moves neither', async () => {
    const r = rig();
    await propose(r);
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    await propose(r, 'Second job.');
    await r.svc.resolve(SEAL, r.slots.get(SEAL)!.id, 'handoff');
    const out = await r.svc.onWorkerStop('pty-1', 'claude', { text: 'Which one?', endsWithQuestion: true });
    expect(out?.movedToInputRequired).toBe(false);
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
