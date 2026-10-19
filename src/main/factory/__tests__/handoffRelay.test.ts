// A coordinator's relay: `next` on a dispatch, the dispatches wmux sends on,
// the one wake the coordinator gets, taint along the relay, the pointer card
// in General, and what a restart or a stop leaves.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotBinding, BotProfile, BotRole, BotTemplate } from '../../../shared/bot';
import { factDedupeKey, type Fact, type FactDraft } from '../../../shared/facts';
import type { Handoff } from '../../../shared/handoff';
import type { ThreadId } from '../../../shared/room';
import type { WakeItem } from '../../../shared/wake';
import { HANDOFFS_FILENAME, HandoffRouter, deckDecisionPort, forwardKey } from '../handoffRouter';
import { RoomWriter, writeFactCards, type FactoryRoomPorts, type RunningWake } from '../roomWriter';
import { WakeTaint } from '../wakeTaint';
import { startedThreadsOf, threadKey, type WorkOwner } from '../../../shared/botsWork';

let dir = '';
let now = 1_000_000_000_000;
const routers: HandoffRouter[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-relay-'));
  now = 1_000_000_000_000;
});
afterEach(() => {
  for (const r of routers.splice(0)) r.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

let botN = 0;
function bot(role: BotRole, template: BotTemplate, extra: Partial<BotProfile> = {}): BotProfile {
  botN += 1;
  return {
    version: 1, id: `bot-${botN.toString(16).padStart(8, '0')}`, workspaceId: 'ws1', role, template, name: template, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerDay: 1, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 },
    enabled: true, createdAt: botN, updatedAt: botN, ...extra,
  };
}
const binding = (b: BotProfile): BotBinding => ({ workspaceId: b.workspaceId, botId: b.id, role: b.role });

interface Rig {
  router: HandoffRouter;
  rooms: RoomWriter;
  facts: Fact[];
  wakes: Array<Parameters<FactoryRoomPorts['wakes']['enqueue']>[0]>;
  taint: WakeTaint;
  /** Bots whose queue takes no wake. */
  drop: Set<string>;
  /** The wake each bot runs now (its reason drives its taint). */
  running: Map<string, { wake: RunningWake; item: WakeItem; thread: ThreadId | null }>;
  run: (b: BotProfile, reason: WakeItem['reason'], extra?: Partial<RunningWake>, thread?: ThreadId | null) => void;
}

async function rig(bots: BotProfile[], opts: { slowFlush?: boolean; groups?: FactoryRoomPorts['groups'] } = {}): Promise<Rig> {
  const facts: Fact[] = [];
  const subs = new Set<(f: Fact) => void>();
  const rooms = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), now: () => now, log: () => undefined });
  const factLog = {
    append(d: FactDraft): Fact | null {
      const key = factDedupeKey(d);
      if (!key || facts.some((f) => f.dedupeKey === key)) return null;
      const f: Fact = { ...d, id: `f-${facts.length + 1}`, seq: facts.length + 1, dedupeKey: key };
      facts.push(f);
      for (const s of subs) s(f);
      return f;
    },
    subscribe(fn: (f: Fact) => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    readSince: () => ({ facts: [], cursor: null }),
  };
  const directory = { listEnabled: () => bots.filter((b) => b.enabled), get: (id: string) => bots.find((b) => b.id === id) ?? null };
  const wakes: Rig['wakes'] = [];
  const drop = new Set<string>();
  const running: Rig['running'] = new Map();
  const ports: Partial<FactoryRoomPorts> = {
    factLog,
    bots: directory,
    wakes: {
      enqueue(input) {
        if (drop.has(input.botId)) return null;
        wakes.push(input);
        return { id: `w-${wakes.length}`, ...input, enqueuedAt: now, attempts: 0, state: 'queued' } as WakeItem;
      },
      // A wake reaches the disk later: a delivery stays queued until then.
      ...(opts.slowFlush ? { flush: () => new Promise<void>((done) => setTimeout(done, 5)) } : {}),
    },
    currentWakeThread: (botId) => running.get(botId)?.thread ?? null,
    currentWake: (botId) => running.get(botId)?.wake ?? null,
    ...(opts.groups ? { groups: opts.groups } : {}),
  };
  factLog.subscribe((f) => void writeFactCards(rooms, f, directory));
  let router: HandoffRouter | null = null;
  const taint = new WakeTaint({
    facts: (ids) => facts.filter((f) => ids.includes(f.id)),
    handoff: (id) => router?.get(id) ?? null,
    taskRow: () => null,
    runningWake: (botId) => {
      const r = running.get(botId);
      return r ? { item: r.item, startedAt: 0 } : null;
    },
    bot: (id) => directory.get(id),
    log: () => undefined,
  });
  factLog.subscribe((f) => taint.onFact(f));
  router = new HandoffRouter({
    file: path.join(dir, 'factory', HANDOFFS_FILENAME),
    decisions: deckDecisionPort(dir),
    ports: () => ports,
    rooms: () => rooms,
    taint: () => taint,
    now: () => now,
    log: () => undefined,
  });
  routers.push(router);
  await router.start();
  let n = 0;
  const run: Rig['run'] = (b, reason, extra = {}, thread = null) => {
    n += 1;
    const item: WakeItem = { id: `run-w-${n}`, botId: b.id, workspaceId: b.workspaceId, reason, priority: 1, enqueuedAt: now, attempts: 1, state: 'running' };
    const handoffId = reason.kind === 'handoff' ? reason.handoffId : undefined;
    running.set(b.id, { wake: { wakeId: item.id, attempt: 1, ...(handoffId ? { handoffId } : {}), ...extra }, item, thread });
  };
  return { router, rooms, facts, wakes, taint, drop, running, run };
}

const owner = (text = 'go'): WakeItem['reason'] => ({ kind: 'human', text, source: 'desktop', runId: 'run-c-owner', clientMessageId: 'c-owner' });

/** The team: lead (coordinator), researcher, developer, issue. */
function team() {
  const lead = bot('moa', 'coordinator');
  const res = bot('lead', 'researcher');
  const dev = bot('lead', 'developer');
  const iss = bot('triage', 'issue');
  return { lead, res, dev, iss, all: [lead, res, dev, iss] };
}

/** The lead, on the owner's words in General, starts a relay R → D → I. */
async function started(r: Rig, t: ReturnType<typeof team>, next = [t.dev.id, t.iss.id]): Promise<Handoff> {
  r.run(t.lead, owner(), { runId: 'run-c-owner' }, 'general');
  const d = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.res.id, title: 'Ship the widget', body: 'Research, build, file the issue.', next });
  if (!d.ok) throw new Error(`dispatch refused: ${d.message}`);
  r.running.delete(t.lead.id);
  return r.router.get(d.handoffId)!;
}

/** `b` answers the hop that woke it with a plain result. */
function answer(r: Rig, b: BotProfile, hop: Handoff, title: string, reason?: WakeItem['reason']) {
  r.run(b, reason ?? { kind: 'handoff', handoffId: hop.id }, reason ? { handoffId: hop.id } : {});
  const res = r.router.send(binding(b), { kind: 'result', title, body: `${title}: details` });
  r.running.delete(b.id);
  return res;
}

const forwardOf = (r: Rig, resultId: string): Handoff | null => r.router.list({ limit: 200 }).find((h) => h.clientHandoffId === forwardKey(resultId)) ?? null;

describe('a coordinator\'s relay', () => {
  it('walks researcher → developer → issue and wakes the coordinator once, with the last result', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t);
    expect(root).toMatchObject({ depth: 0, runId: 'run-c-owner', next: [t.dev.id, t.iss.id], threadId: `handoff:${root.id}` });
    await r.router.idle();

    const res1 = answer(r, t.res, root, 'Findings');
    expect(res1).toMatchObject({ ok: true, to: { botId: t.lead.id }, relayedTo: { botId: t.dev.id } });
    if (!res1.ok) return;
    const r1 = r.router.get(res1.handoffId)!;
    expect(r1).toMatchObject({ status: 'delivered', depth: 1, replyTo: root.id, threadId: root.threadId });
    const f1 = forwardOf(r, r1.id)!;
    expect(f1).toMatchObject({
      kind: 'dispatch', relay: true, from: { botId: t.lead.id }, to: { botId: t.dev.id }, replyTo: r1.id, depth: 1, next: [t.iss.id],
      threadId: root.threadId, runId: 'run-c-owner', payload: { title: 'Ship the widget' },
    });
    expect(f1.payload.body).toContain('Findings: details');
    await r.router.idle();

    const res2 = answer(r, t.dev, f1, 'Built');
    if (!res2.ok) throw new Error('dev result refused');
    const f2 = forwardOf(r, res2.handoffId)!;
    expect(f2).toMatchObject({ to: { botId: t.iss.id }, depth: 2, relay: true });
    expect(f2.next).toBeUndefined();
    await r.router.idle();

    const res3 = answer(r, t.iss, f2, 'Issue filed');
    expect(res3).toMatchObject({ ok: true, to: { botId: t.lead.id } });
    expect(res3.ok && res3.relayedTo).toBeFalsy();
    await r.router.idle();

    const depths = r.router.list({ limit: 200 }).filter((h) => h.runId === 'run-c-owner').map((h) => h.depth).sort();
    expect(depths).toEqual([0, 1, 1, 2, 2, 3]);
    // The coordinator is woken once: for the last result.
    const leadWakes = r.wakes.filter((w) => w.botId === t.lead.id);
    expect(leadWakes).toEqual([expect.objectContaining({ reason: { kind: 'handoff', handoffId: res3.ok ? res3.handoffId : '' } })]);
    // Its wake shows the trail.
    const summary = r.router.summarize(res3.ok ? res3.handoffId : '')!;
    expect(summary.trail?.length).toBeGreaterThanOrEqual(4);
    expect(summary.trail?.some((x) => x.includes('sent on by wmux'))).toBe(true);
    // The forwarded hops are announced as wmux's.
    expect(r.facts.filter((f) => f.kind === 'handoff.received' && f.payload?.relay === true)).toHaveLength(2);
    expect(r.rooms.read('ws1', { threadId: root.threadId }).cards.some((c) => c.title.includes('(forwarded by wmux)'))).toBe(true);
    // General gets one pointer to the thread.
    const pointers = r.rooms.read('ws1', { threadId: 'general' }).cards.filter((c) => c.refs?.threadId === root.threadId);
    expect(pointers).toHaveLength(1);
    expect(pointers[0]).toMatchObject({ kind: 'fact', title: 'Finished: Ship the widget', notice: { code: 'thread.finished', args: { title: 'Ship the widget' } }, refs: { handoffId: res3.ok ? res3.handoffId : '' } });
    expect(pointers[0].body).toBeUndefined();
  });

  it('a result from a task wake goes on too; a second result for the hop is refused', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t, [t.dev.id]);
    const facts = { kind: 'facts' as const, factIds: ['task.done:wtask-1@2'], trigger: { kind: 'task.done' as const } };
    const res1 = answer(r, t.res, root, 'Findings', facts);
    expect(res1).toMatchObject({ ok: true, relayedTo: { botId: t.dev.id } });
    expect(answer(r, t.res, root, 'Findings again', facts)).toMatchObject({ ok: false, code: 'duplicate_result' });
    expect(r.router.list({ limit: 200 }).filter((h) => h.relay)).toHaveLength(1);
  });

  it('a refusal mid-relay goes to the coordinator and the relay ends', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t);
    r.run(t.res, { kind: 'handoff', handoffId: root.id });
    const no = r.router.send(binding(t.res), { kind: 'refusal', title: 'Cannot research this', body: '' });
    expect(no).toMatchObject({ ok: true, to: { botId: t.lead.id } });
    await r.router.idle();
    expect(r.router.list({ limit: 200 }).some((h) => h.relay)).toBe(false);
    expect(r.wakes.filter((w) => w.botId === t.lead.id)).toHaveLength(1);
    expect(r.rooms.read('ws1', { threadId: 'general' }).cards.filter((c) => c.refs?.threadId === root.threadId).map((c) => c.title)).toEqual(['Stopped: Ship the widget']);
  });

  it('a next bot no longer enabled stops the relay: the coordinator gets the result and the reason', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t);
    t.dev.enabled = false;
    const res1 = answer(r, t.res, root, 'Findings');
    expect(res1.ok && res1.relayedTo).toBeFalsy();
    if (!res1.ok) return;
    expect(r.router.get(res1.handoffId)?.relayStopped).toMatch(/^relay stopped: .* is not an enabled bot/);
    expect(r.wakes.filter((w) => w.botId === t.lead.id)).toEqual([expect.objectContaining({ reason: { kind: 'handoff', handoffId: res1.handoffId } })]);
    expect(r.router.summarize(res1.handoffId)?.relayStopped).toMatch(/relay stopped/);
    expect(forwardOf(r, res1.handoffId)).toBeNull();
  });

  it('a last result past the depth limit is refused and the coordinator is told the relay stopped', async () => {
    const t = team();
    const extra = bot('lead', 'custom');
    const r = await rig([...t.all, extra]);
    // A run already four deep: the coordinator's dispatch answers a result at depth 3.
    const old = await started(r, t, [t.dev.id, t.iss.id]);
    let hop: Handoff = old;
    for (const b of [t.res, t.dev, t.iss]) {
      const res = answer(r, b, hop, `${b.template} done`);
      if (!res.ok) throw new Error('refused early');
      hop = forwardOf(r, res.handoffId) ?? r.router.get(res.handoffId)!;
    }
    // Round two from the last result (depth 3): d4 dispatch, d5, d6, then d7 is refused.
    r.run(t.lead, { kind: 'handoff', handoffId: hop.id });
    const again = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.res.id, title: 'Round two', body: '', next: [t.dev.id, t.iss.id] });
    r.running.delete(t.lead.id);
    if (!again.ok) throw new Error('round two refused');
    expect(r.router.get(again.handoffId)?.depth).toBe(4);
    let h2: Handoff = r.router.get(again.handoffId)!;
    let last: ReturnType<typeof answer> | null = null;
    for (const b of [t.res, t.dev, t.iss]) {
      last = answer(r, b, h2, `${b.template} again`);
      if (!last.ok) break;
      h2 = forwardOf(r, last.handoffId)!;
    }
    expect(last).toMatchObject({ ok: false, code: 'max_depth' });
    if (!last || last.ok || !last.handoffId) return;
    expect(r.router.get(last.handoffId)).toMatchObject({ status: 'refused', depth: 7, relayStopped: expect.stringMatching(/depth limit/) });
    expect(r.facts.some((f) => f.kind === 'handoff.refused' && f.ref?.handoffId === last!.handoffId)).toBe(true);
    expect(r.wakes.filter((w) => w.botId === t.lead.id).at(-1)).toMatchObject({ reason: { kind: 'handoff', handoffId: last.handoffId } });
  });

  it('only a coordinator names a relay, of enabled bots of its workspace, none twice', async () => {
    const t = team();
    const far = bot('lead', 'developer', { workspaceId: 'ws2' });
    const r = await rig([...t.all, far]);
    r.run(t.lead, owner(), { runId: 'run-c-owner' }, 'general');
    expect(r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.res.id, title: 'x', body: '', next: [t.dev.id, t.dev.id] })).toMatchObject({ ok: false, code: 'invalid', message: 'next names a bot twice' });
    expect(r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.res.id, title: 'x', body: '', next: [t.dev.id, t.iss.id, far.id, 'bot-0000aaaa', 'bot-0000bbbb'] })).toMatchObject({ ok: false, code: 'invalid', message: 'next is 1 to 4 bot ids' });
    expect(r.router.send(binding(t.lead), { kind: 'result', title: 'x', body: '', next: [t.dev.id] })).toMatchObject({ ok: false, code: 'invalid' });
    expect(r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.res.id, title: 'x', body: '', next: [far.id] })).toMatchObject({ ok: false, code: 'no_addressee', message: expect.stringMatching(/not in your workspace/) });
    expect(r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.res.id, title: 'x', body: '', next: [t.lead.id] })).toMatchObject({ ok: false, code: 'no_addressee' });
    expect(r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.res.id, title: 'x', body: '', next: [t.res.id] })).toMatchObject({ ok: false, code: 'no_addressee' });
    expect(r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.res.id, title: 'x', body: '', clientHandoffId: 'forward:h-x' })).toMatchObject({ ok: false, code: 'invalid' });
    // A question cannot take a key wmux keeps for its own hops either.
    for (const key of ['forward:h-x', 'mention:c-1:bot-00000001']) {
      expect(await r.router.askPerson(binding(t.lead), { title: 'q', body: '', clientHandoffId: key })).toMatchObject({ ok: false, code: 'invalid' });
    }
    r.run(t.dev, owner());
    expect(r.router.send(binding(t.dev), { kind: 'dispatch', toBotId: t.iss.id, title: 'x', body: '', next: [t.res.id] })).toMatchObject({ ok: false, code: 'surface' });
  });

  it('a coordinator\'s new work said in General opens its own thread; another bot\'s stays where it was said', async () => {
    const t = team();
    const r = await rig(t.all);
    r.run(t.lead, owner(), { runId: 'run-c-owner' }, 'general');
    const d = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.dev.id, title: 'Fix it', body: '' });
    expect(d.ok && d.threadId).toBe(d.ok ? `handoff:${d.handoffId}` : '');
    r.run(t.lead, owner(), { runId: 'run-c-owner' }, 'pr:github.com/acme/app#3' as ThreadId);
    const inPr = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.dev.id, title: 'Fix the PR', body: '' });
    expect(inPr.ok && inPr.threadId).toBe('pr:github.com/acme/app#3');
    r.run(t.dev, owner(), {}, 'general');
    const dev = r.router.send(binding(t.dev), { kind: 'dispatch', toBotId: t.iss.id, title: 'File it', body: '' });
    expect(dev.ok && dev.threadId).toBe('general');
  });
});

describe('taint along a relay', () => {
  it('a forward takes the taint of the result it carries, never the coordinator\'s clean wake', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t, [t.dev.id]);
    // The coordinator is busy on a clean owner wake while the forward is made.
    r.run(t.lead, owner('something else'));
    // The researcher is a researcher: its result is tainted whatever woke it.
    const res1 = answer(r, t.res, root, 'Findings');
    if (!res1.ok) throw new Error('refused');
    const f1 = forwardOf(r, res1.handoffId)!;
    expect(r.taint.handoffTainted(res1.handoffId)).toBe(true);
    expect(r.taint.handoffTainted(f1.id)).toBe(true);
    // The developer woken by it runs a tainted wake.
    expect(r.taint.wakeTainted({ reason: { kind: 'handoff', handoffId: f1.id } })).toBe(true);
  });

  it('a clean relay stays clean; a tainted hop taints every forward after it', async () => {
    const t = team();
    const r = await rig(t.all);
    // A developer-first relay: dev → issue, all on clean wakes.
    r.run(t.lead, owner(), { runId: 'run-c-owner' }, 'general');
    const d = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.dev.id, title: 'Build', body: '', next: [t.iss.id] });
    if (!d.ok) throw new Error('refused');
    r.running.delete(t.lead.id);
    expect(r.taint.handoffTainted(d.handoffId)).toBe(false);
    const res1 = answer(r, t.dev, r.router.get(d.handoffId)!, 'Built');
    if (!res1.ok) throw new Error('refused');
    const f1 = forwardOf(r, res1.handoffId)!;
    expect(r.taint.handoffTainted(f1.id)).toBe(false);
    // The same relay from a tainted first dispatch: every forward is tainted.
    r.run(t.lead, { kind: 'facts', factIds: ['f-gone'], trigger: { kind: 'issue.opened' } }, {}, 'general');
    const dirty = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.dev.id, title: 'Build from the issue', body: '', next: [t.iss.id] });
    if (!dirty.ok) throw new Error('refused');
    r.running.delete(t.lead.id);
    expect(r.taint.handoffTainted(dirty.handoffId)).toBe(true);
    const res2 = answer(r, t.dev, r.router.get(dirty.handoffId)!, 'Built again', owner('clean words'));
    if (!res2.ok) throw new Error('refused');
    expect(r.taint.handoffTainted(forwardOf(r, res2.handoffId)!.id)).toBe(true);
  });

  it('an unmarked forward reads tainted when it is delivered', () => {
    const fromLead = { kind: 'bot' as const, workspaceId: 'ws1', botId: 'bot-0000000a' };
    const f: Handoff = {
      version: 1, id: 'h-f', runId: 'run-1', threadId: 'general', depth: 1, hopsInRun: 2, from: fromLead, to: { kind: 'bot', workspaceId: 'ws1', botId: 'bot-0000000b' },
      kind: 'dispatch', relay: true, attribution: { originator: { kind: 'human' }, chain: [] }, landing: 'wake', payload: { title: 't', body: '' }, status: 'delivered', createdAt: 1, updatedAt: 1,
    };
    const taint = new WakeTaint({
      facts: () => [], handoff: () => f, taskRow: () => null, log: () => undefined,
      // The coordinator's own wake is clean: it must not lend the forward its mark.
      runningWake: () => ({ item: { id: 'w', botId: 'bot-0000000a', workspaceId: 'ws1', reason: { kind: 'human', text: 'x', source: 'desktop' }, priority: 0, enqueuedAt: 0, attempts: 1, state: 'running' }, startedAt: 0 }),
    });
    taint.noteDelivered('h-f');
    expect(taint.handoffTainted('h-f')).toBe(true);
  });
});

describe('a relay that cannot reach its coordinator', () => {
  it('a reply to a tainted hop from a clean wake is still tainted', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t, [t.dev.id]);
    const res1 = answer(r, t.res, root, 'Findings');
    if (!res1.ok) throw new Error('refused');
    const f1 = forwardOf(r, res1.handoffId)!;
    // The developer answers the tainted forward from the owner's clean words, naming it.
    r.run(t.dev, owner('send it'));
    const res2 = r.router.send(binding(t.dev), { kind: 'result', replyTo: f1.id, title: 'Built', body: '' });
    if (!res2.ok) throw new Error('refused');
    expect(r.taint.handoffTainted(res2.handoffId)).toBe(true);
  });

  it('a stop whose wake was not taken is told on the next start', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t);
    t.dev.enabled = false;
    r.drop.add(t.lead.id);
    const res1 = answer(r, t.res, root, 'Findings');
    if (!res1.ok) throw new Error('refused');
    await r.router.idle();
    expect(r.router.get(res1.handoffId)).toMatchObject({ relayStopped: expect.stringMatching(/relay stopped/) });
    expect(r.router.get(res1.handoffId)?.relayStopTold).toBeUndefined();
    expect(r.wakes.filter((w) => w.botId === t.lead.id)).toEqual([]);
    const again = await rig(t.all);
    await again.router.idle();
    expect(again.wakes.filter((w) => w.botId === t.lead.id)).toEqual([expect.objectContaining({ reason: { kind: 'handoff', handoffId: res1.handoffId } })]);
    expect(again.router.get(res1.handoffId)?.relayStopTold).toBe(true);
    // Told: a later start asks no more.
    const third = await rig(t.all);
    await third.router.idle();
    expect(third.wakes.filter((w) => w.botId === t.lead.id)).toEqual([]);
  });

  it('a last result the coordinator\'s queue did not take is brought to it as a stopped relay', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t, [t.dev.id]);
    const res1 = answer(r, t.res, root, 'Findings');
    if (!res1.ok) throw new Error('refused');
    r.drop.add(t.lead.id);
    const res2 = answer(r, t.dev, forwardOf(r, res1.handoffId)!, 'Built');
    expect(res2).toMatchObject({ ok: false, code: 'budget' });
    if (res2.ok || !res2.handoffId) return;
    expect(r.router.get(res2.handoffId)).toMatchObject({ status: 'refused', relayStopped: expect.stringMatching(/queue did not take/) });
    r.drop.delete(t.lead.id);
    const again = await rig(t.all);
    await again.router.idle();
    expect(again.wakes.filter((w) => w.botId === t.lead.id)).toEqual([expect.objectContaining({ reason: { kind: 'handoff', handoffId: res2.handoffId } })]);
  });

  it('a forward refused before its stop was recorded is stopped on the next start', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t, [t.dev.id]);
    const res1 = answer(r, t.res, root, 'Findings');
    if (!res1.ok) throw new Error('refused');
    const f = forwardOf(r, res1.handoffId)!;
    // As if the app stopped right after refusing the forward.
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    fs.appendFileSync(file, `${JSON.stringify({ ...f, status: 'refused', refusal: { code: 'budget', detail: 'queue full' } })}\n`);
    const again = await rig(t.all);
    await again.router.idle();
    expect(again.router.get(res1.handoffId)?.relayStopped).toMatch(/did not take the work/);
    expect(again.wakes.filter((w) => w.botId === t.lead.id)).toEqual([expect.objectContaining({ reason: { kind: 'handoff', handoffId: res1.handoffId } })]);
  });
});

describe('a relay across a restart', () => {
  it('a result stored before its forward was made is sent on once at start, and never twice', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t, [t.dev.id]);
    await r.router.idle();
    // The result as it was stored before a stop cut the forward short.
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    const result: Handoff = {
      ...root, id: 'h-result-1', kind: 'result', from: { kind: 'bot', workspaceId: 'ws1', botId: t.res.id }, to: { kind: 'bot', workspaceId: 'ws1', botId: t.lead.id },
      replyTo: root.id, depth: 1, hopsInRun: 2, attribution: { originator: { kind: 'human' }, chain: [root.id] }, payload: { title: 'Findings', body: '' },
      status: 'delivered', createdAt: now, updatedAt: now,
    };
    delete (result as Partial<Handoff>).next;
    delete (result as Partial<Handoff>).clientHandoffId;
    fs.appendFileSync(file, `${JSON.stringify(result)}\n`);
    const second = await rig(t.all);
    await second.router.idle();
    const f = forwardOf(second, 'h-result-1');
    expect(f).toMatchObject({ to: { botId: t.dev.id }, relay: true });
    // No running turn: the forward takes the result's mark (unmarked → tainted).
    expect(second.taint.handoffTainted(f!.id)).toBe(true);
    // The coordinator is not woken for the intermediate result.
    expect(second.wakes.filter((w) => w.botId === t.lead.id)).toEqual([]);
    const third = await rig(t.all);
    await third.router.idle();
    expect(third.router.list({ limit: 200 }).filter((h) => h.relay)).toHaveLength(1);
  });

  it('a queued forward whose bot was disabled while the app was off stops the relay with a note', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t, [t.dev.id]);
    // The forward stays queued: its wake never reached the disk.
    const res1 = answer(r, t.res, root, 'Findings');
    if (!res1.ok) throw new Error('refused');
    const f = forwardOf(r, res1.handoffId)!;
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    fs.appendFileSync(file, `${JSON.stringify({ ...f, status: 'queued' })}\n`);
    t.dev.enabled = false;
    const again = await rig(t.all);
    await again.router.idle();
    expect(again.router.get(f.id)).toMatchObject({ status: 'refused', refusal: { code: 'no_addressee' } });
    expect(again.router.get(res1.handoffId)?.relayStopped).toMatch(/relay stopped/);
    expect(again.wakes.filter((w) => w.botId === t.lead.id)).toEqual([expect.objectContaining({ reason: { kind: 'handoff', handoffId: res1.handoffId } })]);
  });
});

describe('the General card that points at a coordinator\'s thread', () => {
  const pointers = (r: Rig, thread: string) => r.rooms.read('ws1', { threadId: 'general' }).cards.filter((c) => c.refs?.threadId === thread);

  it('the hop that opens the thread links the owner\'s request card (it names the thread); a bot\'s own work links none', async () => {
    const t = team();
    const r = await rig(t.all);
    const request = r.rooms.append({ workspaceId: 'ws1', threadId: 'general', kind: 'human', actor: { kind: 'human' }, title: 'Add a --version flag' })!;
    r.run(t.lead, owner(), { runId: `run-${request.id}` }, 'general');
    const d = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.res.id, title: 'Ship the widget', body: 'b' });
    if (!d.ok) throw new Error('refused');
    r.running.delete(t.lead.id);
    await r.router.idle();
    const root = r.router.get(d.handoffId)!;
    expect(root.opensThread).toBe(true);
    const opening = r.rooms.read('ws1', { threadId: root.threadId }).cards[0];
    expect(opening.refs?.requestCardId).toBe(request.id);
    // The coordinator's own work (no owner message behind it): no link.
    r.run(t.lead, { kind: 'manual', by: 'human' }, {}, 'general');
    const own = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.res.id, title: 'Tidy up', body: 'b' });
    if (!own.ok) throw new Error('refused');
    r.running.delete(t.lead.id);
    await r.router.idle();
    const ownThread = r.router.get(own.handoffId)!.threadId;
    expect(ownThread).toBe(`handoff:${own.handoffId}`);
    expect(r.rooms.read('ws1', { threadId: ownThread }).cards[0].refs?.requestCardId).toBeUndefined();
  });

  it('work the lead takes on in its 1:1 opens its own thread, linked to the owner\'s 1:1 message; its pointer lands in the 1:1, never in General', async () => {
    const t = team();
    const r = await rig(t.all);
    const dm = `dm:${t.lead.id}` as ThreadId;
    const request = r.rooms.append({ workspaceId: 'ws1', threadId: dm, kind: 'human', actor: { kind: 'human' }, title: 'Add a --version flag', refs: { botId: t.lead.id } })!;
    r.run(t.lead, owner(), { runId: `run-${request.id}` }, dm);
    const d = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.dev.id, title: 'Add the flag', body: 'b' });
    if (!d.ok) throw new Error('refused');
    r.running.delete(t.lead.id);
    await r.router.idle();
    const root = r.router.get(d.handoffId)!;
    expect(root).toMatchObject({ threadId: `handoff:${d.handoffId}`, opensThread: true, openedIn: dm });
    expect(r.rooms.read('ws1', { threadId: root.threadId }).cards[0].refs).toMatchObject({ requestCardId: request.id, threadId: dm });
    const res = answer(r, t.dev, root, 'Added');
    if (!res.ok) throw new Error('refused');
    await r.router.idle();
    expect(r.rooms.read('ws1', { threadId: dm }).cards.filter((c) => c.refs?.threadId === root.threadId))
      .toEqual([expect.objectContaining({ title: 'Finished: Add the flag', replyTo: request.id })]);
    expect(pointers(r, root.threadId)).toEqual([]);
    // The room's thread list says whose 1:1 each of these is (a page of
    // cards that misses the opening hop still knows), and when the 1:1 began.
    const summaries = r.rooms.threads('ws1');
    expect(summaries.find((th) => th.threadId === root.threadId)?.dmBotId).toBe(t.lead.id);
    expect(summaries.find((th) => th.threadId === dm)).toMatchObject({ dmBotId: t.lead.id, firstAt: request.at });
    expect(summaries.find((th) => th.threadId === 'general')?.dmBotId).toBeUndefined();
    // A dispatch from the 1:1 that is refused links the 1:1 too.
    t.iss.enabled = false;
    r.run(t.lead, owner(), { runId: `run-${request.id}` }, dm);
    const refused = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.iss.id, title: 'File it', body: 'b' });
    r.running.delete(t.lead.id);
    expect(refused.ok).toBe(false);
    await r.router.idle();
    const refusedThread = r.rooms.read('ws1').cards.find((c) => c.kind === 'refusal' && c.title.includes('File it'));
    expect(refusedThread?.refs?.threadId).toBe(dm);
    t.iss.enabled = true;
    // The 1:1 it was opened from survives a restart.
    const again = await rig(t.all);
    await again.router.idle();
    expect(again.router.get(d.handoffId)?.openedIn).toBe(dm);
    // A bot names another bot's 1:1 only from a wake running in it.
    expect(r.router.send(binding(t.dev), { kind: 'message', toBotId: t.lead.id, title: 'hi', body: '', threadId: dm })).toMatchObject({ ok: false });
  });

  it('work the lead takes on in a group chat opens its own thread, linked to the group; its pointer lands in the group; only members name the group', async () => {
    const t = team();
    const GROUP = 'group:grp-00000001' as ThreadId;
    const groups = { byThread: (ws: string, th: ThreadId | null | undefined) => (ws === 'ws1' && th === GROUP
      ? { id: 'grp-00000001', workspaceId: 'ws1', name: 'Ship', memberIds: [t.lead.id, t.dev.id], threadId: GROUP, createdAt: 1, updatedAt: 1 }
      : null) };
    const r = await rig(t.all, { groups });
    const request = r.rooms.append({ workspaceId: 'ws1', threadId: GROUP, kind: 'human', actor: { kind: 'human' }, title: 'Add a --version flag', refs: { botIds: [t.lead.id, t.dev.id] } })!;
    r.run(t.lead, owner(), { runId: `run-${request.id}` }, GROUP);
    const d = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.dev.id, title: 'Add the flag', body: 'b' });
    if (!d.ok) throw new Error('refused');
    r.running.delete(t.lead.id);
    await r.router.idle();
    const root = r.router.get(d.handoffId)!;
    expect(root).toMatchObject({ threadId: `handoff:${d.handoffId}`, opensThread: true, openedIn: GROUP });
    expect(r.rooms.read('ws1', { threadId: root.threadId }).cards[0].refs).toMatchObject({ requestCardId: request.id, threadId: GROUP });
    const res = answer(r, t.dev, root, 'Added');
    if (!res.ok) throw new Error('refused');
    await r.router.idle();
    expect(r.rooms.read('ws1', { threadId: GROUP }).cards.filter((c) => c.refs?.threadId === root.threadId))
      .toEqual([expect.objectContaining({ title: 'Finished: Add the flag', replyTo: request.id })]);
    expect(pointers(r, root.threadId)).toEqual([]);
    const summaries = r.rooms.threads('ws1');
    expect(summaries.find((th) => th.threadId === root.threadId)).toMatchObject({ groupId: 'grp-00000001' });
    expect(summaries.find((th) => th.threadId === root.threadId)?.dmBotId).toBeUndefined();
    expect(summaries.find((th) => th.threadId === GROUP)?.groupId).toBe('grp-00000001');
    expect(summaries.find((th) => th.threadId === 'general')?.groupId).toBeUndefined();
    // The group it was opened from survives a restart.
    const again = await rig(t.all, { groups });
    await again.router.idle();
    expect(again.router.get(d.handoffId)?.openedIn).toBe(GROUP);
    // A member names the group's thread; a bot outside it does not.
    expect(r.router.send(binding(t.dev), { kind: 'message', toBotId: t.lead.id, title: 'hi', body: '', threadId: GROUP })).toMatchObject({ ok: true });
    expect(r.router.send(binding(t.iss), { kind: 'message', toBotId: t.lead.id, title: 'hi', body: '', threadId: GROUP })).toMatchObject({ ok: false });
  });

  it('a stopped relay points there too, once: "Stopped: <title>"', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t);
    expect(root.opensThread).toBe(true);
    t.dev.enabled = false;
    const res1 = answer(r, t.res, root, 'Findings');
    if (!res1.ok) throw new Error('refused');
    await r.router.idle();
    expect(pointers(r, root.threadId).map((c) => c.title)).toEqual(['Stopped: Ship the widget']);
    expect(pointers(r, root.threadId)[0].notice).toEqual({ code: 'thread.stopped', args: { title: 'Ship the widget' } });
    expect(r.router.get(res1.handoffId)?.pointed).toBe(true);
    // A restart writes no second card.
    const again = await rig(t.all);
    await again.router.idle();
    expect(pointers(again, root.threadId)).toHaveLength(1);
  });

  it('a restart re-points nothing: the mark is on the result', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t, [t.dev.id]);
    const res1 = answer(r, t.res, root, 'Findings');
    if (!res1.ok) throw new Error('refused');
    const res2 = answer(r, t.dev, forwardOf(r, res1.handoffId)!, 'Built');
    if (!res2.ok) throw new Error('refused');
    await r.router.idle();
    expect(r.router.get(res2.handoffId)).toMatchObject({ status: 'delivered', pointed: true });
    for (let i = 0; i < 2; i++) {
      const again = await rig(t.all);
      await again.router.idle();
      expect(pointers(again, root.threadId)).toHaveLength(1);
    }
  });

  it('after an upgrade, older coordinator dispatches in a thread of their own get no card', async () => {
    const t = team();
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lead = { kind: 'bot' as const, workspaceId: 'ws1', botId: t.lead.id };
    const dev = { kind: 'bot' as const, workspaceId: 'ws1', botId: t.dev.id };
    const base = { version: 1, runId: 'run-c-old', landing: 'wake', createdAt: now, updatedAt: now, hopsInRun: 1 };
    const oldRoot = { ...base, id: 'h-old', threadId: 'handoff:h-old', depth: 0, from: lead, to: dev, kind: 'dispatch', attribution: { originator: { kind: 'human' }, chain: [] }, payload: { title: 'Old work', body: '' }, status: 'delivered' };
    const oldResult = { ...base, id: 'h-old-r', threadId: 'handoff:h-old', depth: 1, hopsInRun: 2, from: dev, to: lead, kind: 'result', replyTo: 'h-old', attribution: { originator: { kind: 'human' }, chain: ['h-old'] }, payload: { title: 'Done', body: '' }, status: 'delivered' };
    fs.writeFileSync(file, `${JSON.stringify(oldRoot)}\n${JSON.stringify(oldResult)}\n`);
    const r = await rig(t.all);
    await r.router.idle();
    expect(pointers(r, 'handoff:h-old')).toEqual([]);
  });

  it('a last result redelivered at start (still queued) is pointed to', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t, [t.dev.id]);
    const res1 = answer(r, t.res, root, 'Findings');
    if (!res1.ok) throw new Error('refused');
    const f = forwardOf(r, res1.handoffId)!;
    // The last result as a stop left it: stored, its wake not on disk yet.
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    const last: Handoff = {
      ...f, id: 'h-last', kind: 'result', from: { kind: 'bot', workspaceId: 'ws1', botId: t.dev.id }, to: { kind: 'bot', workspaceId: 'ws1', botId: t.lead.id },
      replyTo: f.id, depth: 2, hopsInRun: f.hopsInRun + 1, attribution: { originator: { kind: 'human' }, chain: [...f.attribution.chain, f.id] },
      payload: { title: 'Built', body: '' }, status: 'queued', createdAt: now, updatedAt: now,
    };
    for (const k of ['relay', 'next', 'clientHandoffId', 'opensThread'] as const) delete (last as Partial<Handoff>)[k];
    fs.appendFileSync(file, `${JSON.stringify(last)}\n`);
    const again = await rig(t.all, { slowFlush: true });
    // Pointed to at start, while its delivery is still settling.
    expect(pointers(again, root.threadId).map((c) => c.refs?.handoffId)).toEqual(['h-last']);
    await again.router.idle();
    expect(again.router.get('h-last')).toMatchObject({ status: 'delivered', pointed: true });
  });
});

describe('work handed off from a conversation opens its own thread, which the conversation folds', () => {
  const GROUP = 'group:grp-00000002' as ThreadId;
  const groupOf = (memberIds: string[]) => ({ byThread: (ws: string, th: ThreadId | null | undefined) => (ws === 'ws1' && th === GROUP
    ? { id: 'grp-00000002', workspaceId: 'ws1', name: 'Ship', memberIds, threadId: GROUP, createdAt: 1, updatedAt: 1 }
    : null) });
  /** The sender, woken by the owner in `thread`, dispatches with `named` as thread_id. */
  async function dispatchFrom(r: Rig, from: BotProfile, to: BotProfile, thread: ThreadId, named?: ThreadId): Promise<Handoff> {
    const request = r.rooms.append({ workspaceId: 'ws1', threadId: thread, kind: 'human', actor: { kind: 'human' }, title: 'Add a --version flag', refs: { botId: from.id } })!;
    r.run(from, owner(), { runId: `run-${request.id}` }, thread);
    const d = r.router.send(binding(from), { kind: 'dispatch', toBotId: to.id, title: 'Add the flag', body: 'b', ...(named ? { threadId: named } : {}) });
    if (!d.ok) throw new Error(`refused: ${d.message}`);
    r.running.delete(from.id);
    await r.router.idle();
    return r.router.get(d.handoffId)!;
  }
  const folded = (r: Rig, owner: WorkOwner) => startedThreadsOf(owner, r.rooms.read('ws1').cards, { ws1: r.rooms.threads('ws1') });

  it('a coordinator naming its own 1:1 as thread_id opens a thread there, as leaving it out does', async () => {
    const t = team();
    const r = await rig(t.all);
    const dm = `dm:${t.lead.id}` as ThreadId;
    const root = await dispatchFrom(r, t.lead, t.dev, dm, dm);
    expect(root).toMatchObject({ threadId: `handoff:${root.id}`, opensThread: true, openedIn: dm });
    expect(folded(r, { botId: t.lead.id })).toEqual(new Set([threadKey('ws1', root.threadId)]));
  });

  it('a coordinator naming its group chat as thread_id opens a thread there', async () => {
    const t = team();
    const r = await rig(t.all, { groups: groupOf([t.lead.id, t.dev.id]) });
    const root = await dispatchFrom(r, t.lead, t.dev, GROUP, GROUP);
    expect(root).toMatchObject({ threadId: `handoff:${root.id}`, opensThread: true, openedIn: GROUP });
    expect(folded(r, { threadId: GROUP })).toEqual(new Set([threadKey('ws1', root.threadId)]));
  });

  it('a name-only first bot (lead, custom) opens a thread from its 1:1, and its report points back there', async () => {
    const t = team();
    const first = bot('lead', 'custom');
    const r = await rig([first, t.dev]);
    const dm = `dm:${first.id}` as ThreadId;
    const root = await dispatchFrom(r, first, t.dev, dm);
    expect(root).toMatchObject({ threadId: `handoff:${root.id}`, opensThread: true, openedIn: dm });
    // A lead's chain keeps the depth and the powers of a non-coordinator.
    expect(root.depth).toBe(1);
    const res = answer(r, t.dev, root, 'Added');
    if (!res.ok) throw new Error('refused');
    await r.router.idle();
    expect(r.rooms.read('ws1', { threadId: dm }).cards.filter((c) => c.refs?.threadId === root.threadId))
      .toEqual([expect.objectContaining({ title: 'Finished: Add the flag' })]);
    expect(folded(r, { botId: first.id })).toEqual(new Set([threadKey('ws1', root.threadId)]));
    // Its work said in General stays there: only a coordinator's opens a thread from General.
    const inGeneral = await dispatchFrom(r, first, t.dev, 'general' as ThreadId);
    expect(inGeneral.threadId).toBe('general');
    expect(inGeneral.opensThread).toBeUndefined();
  });

  it('naming a thread other than the wake\'s opens none', async () => {
    const t = team();
    const r = await rig(t.all, { groups: groupOf([t.lead.id, t.dev.id]) });
    const dm = `dm:${t.lead.id}` as ThreadId;
    const fromDm = await dispatchFrom(r, t.lead, t.dev, dm, 'general' as ThreadId);
    expect(fromDm.threadId).toBe('general');
    expect(fromDm.opensThread).toBeUndefined();
    const fromGeneral = await dispatchFrom(r, t.lead, t.dev, 'general' as ThreadId, dm);
    expect(fromGeneral.threadId).toBe(dm);
    expect(fromGeneral.opensThread).toBeUndefined();
    const toGroup = await dispatchFrom(r, t.lead, t.dev, dm, GROUP);
    expect(toGroup.threadId).toBe(GROUP);
    expect(toGroup.opensThread).toBeUndefined();
    expect(folded(r, { botId: t.lead.id }).size).toBe(0);
    expect(folded(r, { threadId: GROUP }).size).toBe(0);
  });
});

describe('the General pointer across a stop between its writes', () => {
  const pointers = (r: Rig, thread: string) => r.rooms.read('ws1', { threadId: 'general' }).cards.filter((c) => c.refs?.threadId === thread);
  const file = () => path.join(dir, 'factory', HANDOFFS_FILENAME);

  it('a card written before its mark: the next start repairs the mark and writes no second card', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t, [t.dev.id]);
    const res1 = answer(r, t.res, root, 'Findings');
    if (!res1.ok) throw new Error('refused');
    const res2 = answer(r, t.dev, forwardOf(r, res1.handoffId)!, 'Built');
    if (!res2.ok) throw new Error('refused');
    await r.router.idle();
    // As if the stop came after the card and before the mark.
    fs.appendFileSync(file(), `${JSON.stringify({ ...r.router.get(res2.handoffId)!, pointed: undefined })}\n`);
    const again = await rig(t.all);
    await again.router.idle();
    expect(pointers(again, root.threadId)).toHaveLength(1);
    expect(again.router.get(res2.handoffId)?.pointed).toBe(true);
  });

  it('a stopped relay whose card never got written gets it on the next start', async () => {
    const t = team();
    const r = await rig(t.all);
    const root = await started(r, t);
    t.dev.enabled = false;
    const res1 = answer(r, t.res, root, 'Findings');
    if (!res1.ok) throw new Error('refused');
    await r.router.idle();
    // Remove the card and the mark: a stop right after the stop note.
    const rooms = path.join(dir, 'factory', 'rooms', 'ws1.jsonl');
    fs.writeFileSync(rooms, fs.readFileSync(rooms, 'utf8').split('\n').filter((l) => !l.includes('Stopped: ')).join('\n'));
    fs.appendFileSync(file(), `${JSON.stringify({ ...r.router.get(res1.handoffId)!, pointed: undefined })}\n`);
    const again = await rig(t.all);
    await again.router.idle();
    expect(pointers(again, root.threadId).map((c) => c.title)).toEqual(['Stopped: Ship the widget']);
  });

  it('a plain dispatch\'s last result still settling at start is pointed to', async () => {
    const t = team();
    const r = await rig(t.all);
    r.run(t.lead, owner(), { runId: 'run-c-owner' }, 'general');
    const d = r.router.send(binding(t.lead), { kind: 'dispatch', toBotId: t.dev.id, title: 'Fix it', body: '' });
    if (!d.ok) throw new Error('refused');
    r.running.delete(t.lead.id);
    await r.router.idle();
    const root = r.router.get(d.handoffId)!;
    const last: Handoff = {
      ...root, id: 'h-plain-r', kind: 'result', from: { kind: 'bot', workspaceId: 'ws1', botId: t.dev.id }, to: { kind: 'bot', workspaceId: 'ws1', botId: t.lead.id },
      replyTo: root.id, depth: 1, hopsInRun: 2, attribution: { originator: { kind: 'human' }, chain: [root.id] }, payload: { title: 'Fixed', body: '' }, status: 'queued',
    };
    delete (last as Partial<Handoff>).opensThread;
    delete (last as Partial<Handoff>).clientHandoffId;
    fs.appendFileSync(file(), `${JSON.stringify(last)}\n`);
    const again = await rig(t.all, { slowFlush: true });
    expect(pointers(again, root.threadId).map((c) => c.title)).toEqual(['Finished: Fix it']);
    await again.router.idle();
  });
});
