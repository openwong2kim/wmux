import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotBinding, BotProfile, BotRole } from '../../../shared/bot';
import { factDedupeKey, type Fact, type FactDraft } from '../../../shared/facts';
import { HANDOFF_LIMITS } from '../../../shared/handoff';
import type { RoomCard, ThreadId } from '../../../shared/room';
import { WAKE_LIMITS, type WakeItem } from '../../../shared/wake';
import { WakeQueue, wakeQueuePath } from '../wakeQueue';
import { clearThreadDecision, loadThreadDecision, loadWorkspaceDecisions, raiseThreadDecisionIfFree, resolveThreadDecision } from '../../deck/deckDecisionStore';
import {
  DISMISSED_ANSWER,
  HANDOFFS_FILENAME,
  HANDOFF_STORE_LIMITS,
  HandoffRouter,
  deckDecisionPort,
  handoffFromLegacy,
  importLegacyMoaHandoffs,
  type HandoffTaintPort,
} from '../handoffRouter';
import { expectWakeTaint } from '../wakeTaint';
import { runFactoryMigrations } from '../migrate';
import { RoomWriter, writeFactCards, type FactoryRoomPorts } from '../roomWriter';
import { TriggerEngine, botSeesFact } from '../triggerEngine';
import { handleRoomPost } from '../../pipe/handlers/room.rpc';
import type { RpcContext } from '../../../shared/rpc';
import { defaultTriggers } from '../roleDefaults';
import { GuestWorkspaceStore, __resetGuestWorkspacesForTesting, setGuestWorkspaceStore } from '../guestWorkspaces';

let dir = '';
let now = 1_000_000_000_000;
const routers: HandoffRouter[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp5-handoffs-'));
  now = 1_000_000_000_000;
});

afterEach(() => {
  for (const r of routers.splice(0)) r.dispose();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

let botN = 0;
function bot(ws: string, role: BotRole, extra: Partial<BotProfile> = {}): BotProfile {
  botN += 1;
  return {
    version: 1, id: `bot-${botN.toString(16).padStart(8, '0')}`, workspaceId: ws, role, name: role, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 },
    enabled: true, createdAt: botN, updatedAt: botN, ...extra,
  };
}

function binding(b: BotProfile): BotBinding {
  return { workspaceId: b.workspaceId, botId: b.id, role: b.role };
}

interface Harness {
  router: HandoffRouter;
  rooms: RoomWriter;
  facts: Fact[];
  wakes: Array<Parameters<FactoryRoomPorts['wakes']['enqueue']>[0]>;
  dropWakesFor: Set<string>;
  ports: Partial<FactoryRoomPorts>;
  wake: { thread: ThreadId | null; id: { wakeId: string; attempt: number; handoffId?: string } | null };
}

async function harness(bots: BotProfile[], opts: { noFactLog?: boolean; wakes?: FactoryRoomPorts['wakes']; taint?: HandoffTaintPort } = {}): Promise<Harness> {
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
  const wakes: Harness['wakes'] = [];
  const dropWakesFor = new Set<string>();
  const wake: Harness['wake'] = { thread: null, id: null };
  const ports: Partial<FactoryRoomPorts> = {
    ...(opts.noFactLog ? {} : { factLog }),
    bots: directory,
    wakes: opts.wakes ?? {
      enqueue(input) {
        if (dropWakesFor.has(input.botId)) return null;
        wakes.push(input);
        return { id: `w-${wakes.length}`, ...input, enqueuedAt: now, attempts: 0, state: 'queued' } as WakeItem;
      },
    },
    currentWakeThread: () => wake.thread,
    currentWake: () => wake.id,
  };
  // What the room module does with every fact.
  factLog.subscribe((f) => void writeFactCards(rooms, f, directory));
  const router = new HandoffRouter({
    file: path.join(dir, 'factory', HANDOFFS_FILENAME),
    decisions: deckDecisionPort(dir),
    ports: () => ports,
    rooms: () => rooms,
    ...(opts.taint ? { taint: () => opts.taint ?? null } : {}),
    now: () => now,
    log: () => undefined,
  });
  routers.push(router);
  await router.start();
  return { router, rooms, facts, wakes, dropWakesFor, ports, wake };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('handoff.send — addressee, attribution, delivery', () => {
  it('a Moa dispatch goes to the target workspace lead: delivered, directed fact, priority-1 wake, cards in both rooms', async () => {
    const moa = { ...bot('hq', 'moa'), name: 'Boss' };
    const lead = { ...bot('ws1', 'lead'), name: 'Ada' };
    const verifier = bot('ws1', 'verifier');
    const h = await harness([moa, lead, verifier]);
    const r = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'Fix the login bug', body: 'details' });
    expect(r).toMatchObject({ ok: true, status: 'delivered', to: { botId: lead.id, role: 'lead', workspaceId: 'ws1' } });
    if (!r.ok) return;
    const stored = h.router.get(r.handoffId)!;
    expect(stored).toMatchObject({ depth: 0, hopsInRun: 1, from: { kind: 'bot', botId: moa.id }, to: { kind: 'bot', botId: lead.id }, attribution: { originator: { kind: 'bot', botId: moa.id }, chain: [] } });
    expect(stored.threadId).toBe(`handoff:${r.handoffId}`);
    expect(h.wakes).toEqual([{ botId: lead.id, workspaceId: 'ws1', reason: { kind: 'handoff', handoffId: r.handoffId }, priority: 1, threadId: `handoff:${r.handoffId}` }]);
    const received = h.facts.find((f) => f.kind === 'handoff.received')!;
    expect(received).toMatchObject({ workspaceId: 'ws1', ref: { handoffId: r.handoffId, botId: lead.id }, actor: { kind: 'bot', id: moa.id } });
    // Directed: only the addressee sees it (the router's own scope rule).
    expect(botSeesFact(lead, received)).toBe(true);
    expect(botSeesFact(verifier, received)).toBe(false);
    expect(h.rooms.read('ws1').cards.map((c) => c.kind)).toEqual(['fact']);
    expect(h.rooms.read('hq').cards).toHaveLength(1);
    // A bot is named by its name alone: its internal role never shows.
    expect(h.rooms.read('ws1').cards[0].title).toBe('dispatch → Ada: Fix the login bug');
    expect(h.router.summarize(r.handoffId)).toEqual({ handoffId: r.handoffId, kind: 'dispatch', from: 'Boss', title: 'Fix the login bug', body: 'details', fromWorkspaceId: 'hq' });
  });

  it('any bot may dispatch into another workspace (messaging is every bot\'s); its chain starts at depth 1', async () => {
    const lead = bot('ws1', 'lead');
    const other = bot('ws2', 'lead');
    const triage = bot('ws1', 'triage');
    const h = await harness([lead, other, triage]);
    const r = h.router.send(binding(triage), { kind: 'dispatch', toWorkspaceId: 'ws2', title: 'x', body: '' });
    expect(r).toMatchObject({ ok: true, status: 'delivered', to: { botId: other.id, workspaceId: 'ws2' } });
    if (!r.ok) return;
    expect(h.router.get(r.handoffId)).toMatchObject({ depth: 1 });
    expect(h.wakes).toMatchObject([{ botId: other.id, workspaceId: 'ws2' }]);
    // Inside its own workspace a dispatch reaches the lead.
    expect(h.router.send(binding(triage), { kind: 'dispatch', title: 'y', body: '' })).toMatchObject({ ok: true, to: { botId: lead.id } });
    const refused = h.router.send(binding(triage), { kind: 'dispatch', toWorkspaceId: 'ws9', title: 'z', body: '' });
    expect(refused).toMatchObject({ ok: false, code: 'no_addressee' });
    if (refused.ok) return;
    expect(h.router.get(refused.handoffId!)!.status).toBe('refused');
    expect(h.facts.find((f) => f.kind === 'handoff.refused')).toMatchObject({ workspaceId: 'ws1', ref: { handoffId: refused.handoffId, botId: triage.id } });
    expect(h.rooms.read('ws1').cards.at(-1)).toMatchObject({ kind: 'refusal' });
  });

  it('no enabled lead, or the lead dispatching to itself → no_addressee', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead, bot('ws2', 'lead', { enabled: false })]);
    expect(h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws2', title: 'x', body: '' })).toMatchObject({ ok: false, code: 'no_addressee' });
    expect(h.router.send(binding(lead), { kind: 'dispatch', title: 'x', body: '' })).toMatchObject({ ok: false, code: 'no_addressee' });
  });

  it('a result replies to the sender of its parent, in the parent\'s thread, one hop deeper; a second result is refused', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead]);
    const d = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'plan item', body: '', threadId: 'plan:p1' });
    if (!d.ok) throw new Error('dispatch failed');
    const res = h.router.send(binding(lead), { kind: 'result', replyTo: d.handoffId, title: 'merged', body: 'all green' });
    expect(res).toMatchObject({ ok: true, to: { botId: moa.id }, threadId: 'plan:p1' });
    if (!res.ok) return;
    expect(h.router.get(res.handoffId)).toMatchObject({ depth: 1, hopsInRun: 2, runId: h.router.get(d.handoffId)!.runId, attribution: { chain: [d.handoffId] } });
    expect(h.router.send(binding(lead), { kind: 'result', replyTo: d.handoffId, title: 'again', body: '' })).toMatchObject({ ok: false, code: 'duplicate_result' });
    expect(h.router.send(binding(lead), { kind: 'refusal', replyTo: d.handoffId, title: 'nope', body: '' })).toMatchObject({ ok: false, code: 'duplicate_result' });
  });

  it('only the addressee of a handoff may reply to it; an unknown replyTo has no addressee', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const triage = bot('ws1', 'triage');
    const h = await harness([moa, lead, triage]);
    const d = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'x', body: '' });
    if (!d.ok) throw new Error('dispatch failed');
    expect(h.router.send(binding(triage), { kind: 'result', replyTo: d.handoffId, title: 'r', body: '' })).toMatchObject({ ok: false, code: 'surface' });
    expect(h.router.send(binding(lead), { kind: 'result', replyTo: 'h-unknown', title: 'r', body: '' })).toMatchObject({ ok: false, code: 'no_addressee' });
  });

  it('a result without replyTo goes to the workspace lead', async () => {
    const lead = bot('ws1', 'lead');
    const triage = bot('ws1', 'triage');
    const h = await harness([lead, triage]);
    expect(h.router.send(binding(triage), { kind: 'result', title: 'repro PR', body: 'link' })).toMatchObject({ ok: true, to: { botId: lead.id } });
    expect(h.router.send(binding(lead), { kind: 'result', title: 'to whom', body: '' })).toMatchObject({ ok: false, code: 'no_addressee' });
  });

  it('refuses the hop past MAX_DEPTH with a card and a fact', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead]);
    let parent = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'd0', body: '' });
    const depths: number[] = [];
    // A Coordinator's chain starts at depth 0: MAX_DEPTH + 1 hops fit.
    for (let i = 1; i <= HANDOFF_LIMITS.MAX_DEPTH; i += 1) {
      if (!parent.ok) throw new Error(`hop ${i} refused`);
      depths.push(h.router.get(parent.handoffId)!.depth);
      const sender = i % 2 === 1 ? lead : moa;
      parent = h.router.send(binding(sender), { kind: i % 2 === 1 ? 'result' : 'dispatch', replyTo: parent.handoffId, toWorkspaceId: 'ws1', title: `d${i}`, body: '' });
    }
    if (!parent.ok) throw new Error('last allowed hop refused');
    depths.push(h.router.get(parent.handoffId)!.depth);
    expect(depths).toEqual(Array.from({ length: HANDOFF_LIMITS.MAX_DEPTH + 1 }, (_, i) => i));
    // One more would exceed the cap.
    const next = HANDOFF_LIMITS.MAX_DEPTH + 1;
    const over = h.router.send(binding(next % 2 === 1 ? lead : moa), { kind: next % 2 === 1 ? 'result' : 'dispatch', replyTo: parent.handoffId, toWorkspaceId: 'ws1', title: 'too deep', body: '' });
    expect(over).toMatchObject({ ok: false, code: 'max_depth' });
    expect(h.facts.filter((f) => f.kind === 'handoff.refused')).toHaveLength(1);
    expect(h.rooms.read(next % 2 === 1 ? 'ws1' : 'hq').cards.filter((c) => c.kind === 'refusal')).toHaveLength(1);
    expect(h.wakes).toHaveLength(HANDOFF_LIMITS.MAX_DEPTH + 1);
  });

  it('refuses the hop past MAX_PER_RUN, counted across the whole run', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead]);
    const d = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'd', body: '' });
    if (!d.ok) throw new Error('dispatch failed');
    const res = h.router.send(binding(lead), { kind: 'result', replyTo: d.handoffId, title: 'r', body: '' });
    if (!res.ok) throw new Error('result failed');
    // Moa fans the same run out again and again (each a sibling hop).
    let last = res as ReturnType<HandoffRouter['send']>;
    for (let hop = 3; hop <= HANDOFF_LIMITS.MAX_PER_RUN; hop += 1) {
      last = h.router.send(binding(moa), { kind: 'dispatch', replyTo: res.handoffId, toWorkspaceId: 'ws1', title: `d${hop}`, body: '' });
      expect(last.ok, `hop ${hop}`).toBe(true);
    }
    const over = h.router.send(binding(moa), { kind: 'dispatch', replyTo: res.handoffId, toWorkspaceId: 'ws1', title: 'one too many', body: '' });
    expect(over).toMatchObject({ ok: false, code: 'max_per_run' });
  });

  it('a wake the queue does not take is a failed hop: refused, not left delivered', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead]);
    h.dropWakesFor.add(lead.id);
    const r = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'x', body: '' });
    expect(r).toMatchObject({ ok: false, code: 'budget' });
    if (r.ok) return;
    expect(h.router.get(r.handoffId!)!.status).toBe('refused');
    // The wake is the delivery: no received fact for a hop that failed.
    expect(h.facts.map((f) => f.kind)).toEqual(['handoff.refused']);
  });

  it('without a fact log the cards are still written', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead], { noFactLog: true });
    h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'x', body: '' });
    h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws9', title: 'y', body: '' });
    expect(h.rooms.read('ws1').cards.map((c) => c.kind)).toEqual(['fact']);
    expect(h.rooms.read('hq').cards.map((c) => c.kind)).toEqual(['fact', 'refusal']);
  });

  it('refuses a role without the tool and invalid params', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const r = h.router.send({ workspaceId: 'ws1', botId: 'bot-ffffffff', role: 'nope' as BotRole }, { kind: 'result', title: 'x', body: '' });
    expect(r).toMatchObject({ ok: false, code: 'surface' });
    expect(h.router.send(binding(lead), { kind: 'answer' as never, title: 'x', body: '' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(h.router.send(binding(lead), { kind: 'dispatch', title: '', body: '' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(h.router.send(binding(lead), { kind: 'dispatch', title: 'x', body: '', threadId: 'bad' as ThreadId })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('one wake per handoff with the trigger engine connected', () => {
  it('the default role triggers do not wake on the handoff fact the router already delivered', async () => {
    const moa = bot('hq', 'moa', { triggers: defaultTriggers('moa') });
    const lead = bot('ws1', 'lead', { triggers: defaultTriggers('lead') });
    const h = await harness([moa, lead]);
    const engine = new TriggerEngine({ factLog: h.ports.factLog!, wakes: h.ports.wakes!, bots: h.ports.bots! }, () => undefined);
    engine.start();
    const d = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'x', body: '' });
    if (!d.ok) throw new Error('dispatch failed');
    h.router.send(binding(lead), { kind: 'result', replyTo: d.handoffId, title: 'r', body: '' });
    engine.dispose();
    expect(h.wakes.map((w) => [w.botId, w.reason.kind])).toEqual([[lead.id, 'handoff'], [moa.id, 'handoff']]);
  });
});

describe('main pins the thread and keys, not the model', () => {
  it('a handoff without a thread lands in the running wake\'s thread', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead]);
    h.wake.thread = 'pr:github.com/acme/app#3';
    expect(h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'x', body: '' })).toMatchObject({ ok: true, threadId: 'pr:github.com/acme/app#3' });
  });

  it('the same clientHandoffId returns the first handoff; a retried wake attempt reuses its default keys', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead]);
    const a = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'x', body: '', clientHandoffId: 'k1' });
    const b = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'x', body: '', clientHandoffId: 'k1' });
    expect(b).toMatchObject({ ok: true, duplicate: true, handoffId: a.ok ? a.handoffId : '' });
    expect(h.wakes).toHaveLength(1);

    h.wake.id = { wakeId: 'wake-retry-1', attempt: 1 };
    const first = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'one', body: '' });
    const second = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'two', body: '' });
    expect(first.ok && second.ok && first.handoffId !== second.handoffId).toBe(true);
    h.wake.id = { wakeId: 'wake-retry-1', attempt: 2 };
    const retried = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'one', body: '' });
    expect(retried).toMatchObject({ ok: true, duplicate: true, handoffId: first.ok ? first.handoffId : '' });
    expect(h.wakes).toHaveLength(3);
  });
});

describe('chain limits follow the wake', () => {
  it('a handoff sent from a handoff wake continues that chain without replyTo', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const triage = bot('ws1', 'triage');
    const h = await harness([moa, lead, triage]);
    const d = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'item', body: '' });
    if (!d.ok) throw new Error('dispatch failed');
    h.wake.id = { wakeId: 'w-chain-1', attempt: 1, handoffId: d.handoffId };
    const onward = h.router.send(binding(lead), { kind: 'result', title: 'onward', body: '' });
    expect(onward.ok).toBe(true);
    if (!onward.ok) return;
    expect(onward.to?.botId).toBe(moa.id);
    expect(h.router.get(onward.handoffId)).toMatchObject({ replyTo: d.handoffId, depth: 1, hopsInRun: 2, runId: h.router.get(d.handoffId)!.runId, attribution: { chain: [d.handoffId] } });
    // It answered the handoff: a second result is refused.
    expect(h.router.send(binding(lead), { kind: 'result', title: 'again', body: '' })).toMatchObject({ ok: false, code: 'duplicate_result' });
    // A wake handoff addressed to someone else is not this bot's chain.
    h.wake.id = { wakeId: 'w-chain-2', attempt: 1, handoffId: d.handoffId };
    const other = h.router.send(binding(triage), { kind: 'result', title: 'x', body: '' });
    expect(other.ok && h.router.get(other.handoffId)!.depth).toBe(1);
    expect(other.ok && h.router.get(other.handoffId)!.runId).not.toBe(h.router.get(d.handoffId)!.runId);
  });

  it('one turn sends at most MAX_PER_RUN handoffs, each parentless one its own run', async () => {
    const moa = bot('hq', 'moa');
    const h = await harness([moa, ...Array.from({ length: 3 }, (_, i) => bot(`ws${i}`, 'lead'))]);
    h.wake.id = { wakeId: 'w-fanout', attempt: 1 };
    const results = Array.from({ length: HANDOFF_LIMITS.MAX_PER_RUN + 1 }, (_, i) =>
      h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: `ws${i % 3}`, title: `d${i}`, body: '' }));
    expect(results.slice(0, HANDOFF_LIMITS.MAX_PER_RUN).every((r) => r.ok)).toBe(true);
    expect(results.at(-1)).toMatchObject({ ok: false, code: 'max_per_run' });
    const runs = new Set(results.filter((r) => r.ok).map((r) => (r.ok ? h.router.get(r.handoffId)!.runId : '')));
    expect(runs.size).toBe(HANDOFF_LIMITS.MAX_PER_RUN);
    // The next turn may send again.
    h.wake.id = { wakeId: 'w-fanout-2', attempt: 1 };
    expect(h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws0', title: 'next', body: '' })).toMatchObject({ ok: true });
  });

  it('the hop count survives pruning of earlier hops of the run', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const last = {
      version: 1, id: 'h-last', runId: 'run-old', threadId: 'handoff:h-last', depth: 1, hopsInRun: HANDOFF_LIMITS.MAX_PER_RUN,
      from: { kind: 'bot', workspaceId: 'hq', botId: moa.id }, to: { kind: 'bot', workspaceId: 'ws1', botId: lead.id }, kind: 'dispatch',
      attribution: { originator: { kind: 'bot', workspaceId: 'hq', botId: moa.id }, chain: [] }, landing: 'wake',
      payload: { title: 'x', body: '' }, status: 'delivered', createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(file, `${JSON.stringify(last)}\n`);
    const h = await harness([moa, lead]);
    expect(h.router.send(binding(lead), { kind: 'result', replyTo: 'h-last', title: 'r', body: '' })).toMatchObject({ ok: false, code: 'max_per_run' });
  });
});

describe('crash and write-failure boundaries', () => {
  it('a handoff stored but not delivered before a stop is delivered on start', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      version: 1, id: 'h-q', runId: 'run-q', threadId: 'handoff:h-q', depth: 0, hopsInRun: 1,
      from: { kind: 'bot', workspaceId: 'hq', botId: moa.id }, to: { kind: 'bot', workspaceId: 'ws1', botId: lead.id }, kind: 'dispatch',
      attribution: { originator: { kind: 'bot', workspaceId: 'hq', botId: moa.id }, chain: [] }, landing: 'wake',
      payload: { title: 'x', body: '' }, status: 'queued', createdAt: now, updatedAt: now,
    })}\n`);
    const h = await harness([moa, lead]);
    expect(h.router.get('h-q')!.status).toBe('delivered');
    expect(h.wakes).toEqual([{ botId: lead.id, workspaceId: 'ws1', reason: { kind: 'handoff', handoffId: 'h-q' }, priority: 1, threadId: 'handoff:h-q' }]);
    const again = await harness([moa, lead]);
    expect(again.wakes).toEqual([]);
  });

  it('the handoff is marked delivered only once its wake is on disk', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead]);
    let land!: () => void;
    const inner = h.ports.wakes!;
    h.ports.wakes = { enqueue: (i) => inner.enqueue(i), flush: () => new Promise<void>((r) => { land = r; }) };
    const r = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'Fix it', body: '' });
    expect(r).toMatchObject({ ok: true, status: 'delivered', wakeId: 'w-1' });
    if (!r.ok) return;
    // Not yet on disk: stored queued, no received fact.
    expect(h.router.get(r.handoffId)!.status).toBe('queued');
    expect(h.facts.some((f) => f.kind === 'handoff.received')).toBe(false);
    land();
    await h.router.idle();
    expect(h.router.get(r.handoffId)!.status).toBe('delivered');
    expect(h.facts.filter((f) => f.kind === 'handoff.received')).toHaveLength(1);
  });

  it('a wake that did not reach the disk leaves the handoff queued; the next start redelivers into the one wake', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const queueFile = wakeQueuePath(dir);
    const q1 = new WakeQueue(queueFile);
    const h = await harness([moa, lead]);
    // The wake is written, but the router hears a failure (its status line never lands).
    h.ports.wakes = { enqueue: (i) => q1.enqueue(i), flush: () => q1.flush().then(() => { throw new Error('disk'); }) };
    const r = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'Fix it', body: '' });
    if (!r.ok) throw new Error('not sent');
    await h.router.idle();
    expect(h.router.get(r.handoffId)!.status).toBe('queued');
    h.router.dispose();

    // Restart: the queue reloads its file and the router redelivers what is queued.
    const q2 = new WakeQueue(queueFile);
    expect(q2.load()).toEqual([]);
    const again = await harness([moa, lead], { wakes: q2 });
    await again.router.idle();
    expect(again.router.get(r.handoffId)!.status).toBe('delivered');
    expect(q2.list({ botId: lead.id }).filter((i) => i.reason.kind === 'handoff').map((i) => i.id)).toEqual([r.wakeId]);
    expect(again.facts.filter((f) => f.kind === 'handoff.received')).toHaveLength(1);
  });

  it('a question whose decision was raised before a stop adopts that decision', async () => {
    const lead = bot('ws1', 'lead');
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      version: 1, id: 'h-ask', runId: 'run-a', threadId: 'task:t1', depth: 0, hopsInRun: 1,
      from: { kind: 'bot', workspaceId: 'ws1', botId: lead.id }, to: { kind: 'human' }, kind: 'ask_person',
      attribution: { originator: { kind: 'bot', workspaceId: 'ws1', botId: lead.id }, chain: [] }, landing: 'room+phone',
      payload: { title: 'Q?', body: '' }, status: 'queued', createdAt: now, updatedAt: now,
    })}\n`);
    const d = await raiseThreadDecisionIfFree('ws1', 'task:t1', { question: 'Q?', origin: 'ask_person', handoffId: 'h-ask' }, dir);
    const h = await harness([lead]);
    expect(h.router.get('h-ask')!.status).toBe('delivered');
    expect(h.rooms.read('ws1').cards.filter((c) => c.kind === 'question')).toHaveLength(1);
    await resolveThreadDecision('ws1', d!.id, 'A', {}, dir);
    await h.router.reconcile();
    expect(h.router.get('h-ask')!.status).toBe('answered');
    expect(h.wakes).toHaveLength(1);
  });

  it('a decision left behind by a closed question is cleared so the thread frees', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const ask = await h.router.askPerson(binding(lead), { title: 'q', body: '', threadId: 'task:t2' });
    if (!ask.ok) throw new Error('ask failed');
    await h.router.answer(ask.handoffId, 'done');
    // As if the clear after the answer had failed.
    await raiseThreadDecisionIfFree('ws1', 'task:t2', { question: 'q', origin: 'ask_person', handoffId: ask.handoffId }, dir);
    await h.router.reconcile();
    expect(loadThreadDecision('ws1', 'task:t2', dir)).toBeNull();
  });

  it('a send that cannot be stored fails without waking anyone', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead]);
    // The handoffs file becomes unwritable.
    fs.mkdirSync(path.join(dir, 'factory', HANDOFFS_FILENAME, 'blocker'), { recursive: true });
    expect(h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'x', body: '' })).toMatchObject({ ok: false, code: 'write_failed' });
    expect(await h.router.askPerson(binding(lead), { title: 'q', body: '' })).toMatchObject({ ok: false, code: 'write_failed' });
    expect(h.wakes).toEqual([]);
    expect(h.router.list()).toEqual([]);
  });

  it('a key taken by a send is not answered as a question, whatever the call order', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead]);
    h.wake.id = { wakeId: 'w-mixed', attempt: 1 };
    const ask = h.router.askPerson(binding(moa), { title: 'q', body: '' });
    const sent = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'd', body: '' });
    const asked = await ask;
    if (!asked.ok || !sent.ok) throw new Error('first attempt failed');
    expect(h.router.get(asked.handoffId)!.clientHandoffId).toBe('wake:w-mixed:h1');
    h.wake.id = { wakeId: 'w-mixed', attempt: 2 };
    expect(await h.router.askPerson(binding(moa), { title: 'q', body: '' })).toMatchObject({ ok: true, duplicate: true, handoffId: asked.handoffId });
    expect(h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'd', body: '' })).toMatchObject({ ok: true, duplicate: true, handoffId: sent.handoffId });
    expect(await h.router.askPerson(binding(moa), { title: 'q', body: '', clientHandoffId: 'wake:w-mixed:h2' })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('ask_person', () => {
  it('raises a decision in the thread, then the owner\'s answer wakes the bot that asked', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const ask = await h.router.askPerson(binding(lead), { title: 'Ship it?', body: 'CI green', options: ['Yes', 'No'], threadId: 'pr:github.com/acme/app#7' });
    expect(ask).toMatchObject({ ok: true, status: 'delivered', threadId: 'pr:github.com/acme/app#7' });
    if (!ask.ok) return;
    const d = loadThreadDecision('ws1', 'pr:github.com/acme/app#7', dir)!;
    expect(d).toMatchObject({ origin: 'ask_person', handoffId: ask.handoffId, question: 'Ship it?', options: ['Yes', 'No'], status: 'pending' });
    expect(ask.decisionId).toBe(d.id);
    const q = h.rooms.read('ws1').cards.find((c) => c.kind === 'question')!;
    expect(q).toMatchObject({ state: 'open', refs: { handoffId: ask.handoffId, decisionId: d.id }, actor: { kind: 'bot', botId: lead.id } });
    expect(h.wakes).toEqual([]);

    // Any resolve path (deck card, phone, room.resolve) goes through the store.
    await resolveThreadDecision('ws1', d.id, 'Yes', {}, dir);
    await h.router.reconcile();
    expect(h.router.get(ask.handoffId)!.status).toBe('answered');
    const answer = h.router.list({ workspaceId: 'ws1' }).find((x) => x.kind === 'answer')!;
    expect(answer).toMatchObject({ from: { kind: 'human' }, to: { kind: 'bot', botId: lead.id }, replyTo: ask.handoffId, threadId: 'pr:github.com/acme/app#7', status: 'delivered', payload: { body: 'Yes' } });
    expect(h.wakes).toEqual([{ botId: lead.id, workspaceId: 'ws1', reason: { kind: 'handoff', handoffId: answer.id }, priority: 1, threadId: 'pr:github.com/acme/app#7', overCap: true }]);
    expect(h.facts.find((f) => f.kind === 'handoff.received')).toMatchObject({ ref: { botId: lead.id, handoffId: answer.id } });
    expect(loadThreadDecision('ws1', 'pr:github.com/acme/app#7', dir)).toBeNull();
    expect(h.rooms.get('ws1', q.id)!.state).toBe('resolved');
    expect(h.rooms.read('ws1').cards.some((c) => c.title.startsWith('Answered'))).toBe(true);
  });

  it('the answer reaches the asker even when its queue is at the cap; the question closes once', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const queue = new WakeQueue(wakeQueuePath(dir));
    for (let i = 0; i < WAKE_LIMITS.PER_BOT_QUEUE_CAP; i++) queue.enqueue({ botId: lead.id, workspaceId: 'ws1', reason: { kind: 'manual', by: 'human' }, priority: 1 });
    h.ports.wakes = queue;
    // A dispatch to the full queue is still refused: only answers go past the cap.
    expect(queue.enqueue({ botId: lead.id, workspaceId: 'ws1', reason: { kind: 'handoff', handoffId: 'h-other' }, priority: 1 })).toBeNull();
    const ask = await h.router.askPerson(binding(lead), { title: 'Ship it?', body: '', threadId: 'pr:github.com/acme/app#7' });
    if (!ask.ok) throw new Error('not asked');
    const answered = await h.router.answer(ask.handoffId, 'Yes');
    expect(answered).toMatchObject({ ok: true, status: 'answered', answerHandoffId: expect.any(String) });
    if (!answered.ok) return;
    await h.router.idle();
    expect(h.router.get(answered.answerHandoffId!)).toMatchObject({ kind: 'answer', status: 'delivered' });
    const answerWakes = queue.list({ botId: lead.id, states: ['queued'] }).filter((i) => i.reason.kind === 'handoff');
    expect(answerWakes).toEqual([expect.objectContaining({ reason: { kind: 'handoff', handoffId: answered.answerHandoffId } })]);
    expect(h.facts.some((f) => f.kind === 'handoff.refused')).toBe(false);
    await queue.flush();
  });

  it('the answer is on disk before its question closes; an answer that cannot be stored leaves the question open', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    const ask = await h.router.askPerson(binding(lead), { title: 'Ship it?', body: '' });
    if (!ask.ok) throw new Error('not asked');
    fs.chmodSync(file, 0o444);
    try {
      expect(await h.router.answer(ask.handoffId, 'Yes')).toMatchObject({ ok: false, code: 'write_failed' });
    } finally {
      fs.chmodSync(file, 0o644);
    }
    expect(h.router.get(ask.handoffId)).toMatchObject({ status: 'delivered' });
    expect(h.wakes).toHaveLength(0);
    // The resolved decision is settled again once the file takes writes.
    await h.router.reconcile();
    expect(h.router.get(ask.handoffId)).toMatchObject({ status: 'answered' });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { id: string; kind: string; status: string; replyTo?: string });
    const answerAt = lines.findIndex((l) => l.kind === 'answer' && l.replyTo === ask.handoffId);
    const closedAt = lines.findIndex((l) => l.id === ask.handoffId && l.status === 'answered');
    expect(answerAt).toBeGreaterThanOrEqual(0);
    expect(answerAt).toBeLessThan(closedAt);
    expect(h.wakes).toEqual([expect.objectContaining({ botId: lead.id, reason: { kind: 'handoff', handoffId: lines[answerAt].id } })]);
  });

  it('the answer wakes the asker in the question\'s thread, so its next post without a thread lands there', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    h.wake.thread = 'pr:github.com/acme/app#5';
    const ask = await h.router.askPerson(binding(lead), { title: 'Merge order?', body: '', options: ['ship', 'hold'] });
    if (!ask.ok) throw new Error('ask failed');
    expect(ask.threadId).toBe('pr:github.com/acme/app#5');
    h.wake.thread = null;
    await resolveThreadDecision('ws1', ask.decisionId!, 'ship', {}, dir);
    await h.router.reconcile();
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]).toMatchObject({ botId: lead.id, reason: { kind: 'handoff' }, threadId: 'pr:github.com/acme/app#5' });
    // The runtime runs that wake: its thread is the running wake's thread.
    h.wake.thread = h.wakes[0].threadId ?? null;
    const posted = await handleRoomPost({ kind: 'status', title: 'Answer received' }, { bot: binding(lead) } as RpcContext, { writer: () => h.rooms, ports: () => h.ports, wmuxDir: () => dir }) as { ok: boolean; card?: { threadId: string } };
    expect(posted).toMatchObject({ ok: true, card: { threadId: 'pr:github.com/acme/app#5' } });
  });

  it('without a thread it lands in the running wake\'s thread, else a thread of its own', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const own = await h.router.askPerson(binding(lead), { title: 'q1', body: '' });
    expect(own.ok && own.threadId === `handoff:${own.handoffId}`).toBe(true);
    h.wake.thread = 'task:wt-5';
    expect(await h.router.askPerson(binding(lead), { title: 'q2', body: '' })).toMatchObject({ ok: true, threadId: 'task:wt-5' });
  });

  it('a thread busy with another bot\'s question queues the question and raises it once the open one is answered', async () => {
    const lead = bot('ws1', 'lead');
    const other = bot('ws1', 'triage');
    const h = await harness([lead, other]);
    const first = await h.router.askPerson(binding(lead), { title: 'first', body: '', threadId: 'task:t1' });
    const second = await h.router.askPerson(binding(other), { title: 'second', body: '', threadId: 'task:t1' });
    if (!first.ok || !second.ok) throw new Error('asks failed');
    expect(second).toMatchObject({ status: 'queued', queuedBehind: first.decisionId });
    expect(h.rooms.read('ws1').cards.filter((c) => c.kind === 'question')).toHaveLength(1);
    await resolveThreadDecision('ws1', first.decisionId!, 'ok', {}, dir);
    await h.router.reconcile();
    expect(h.router.get(second.handoffId)!.status).toBe('delivered');
    expect(loadThreadDecision('ws1', 'task:t1', dir)).toMatchObject({ question: 'second', handoffId: second.handoffId });
    expect(h.rooms.read('ws1').cards.filter((c) => c.kind === 'question').map((c) => c.title)).toEqual(['first', 'second']);
  });

  it('a question asked in a guest-sourced wake is raised later as a guest-sourced card, and its closing card is too', async () => {
    const lead = bot('ws1', 'lead');
    const other = bot('ws1', 'triage');
    const guestBots = new Set<string>([other.id]);
    const taint: HandoffTaintPort = {
      markSent: () => false, markForward: () => false,
      runningGuest: (botId) => guestBots.has(botId),
      handoffGuest: () => false,
    };
    const h = await harness([lead, other], { taint });
    const first = await h.router.askPerson(binding(lead), { title: 'first', body: '', threadId: 'task:t1' });
    const second = await h.router.askPerson(binding(other), { title: 'second', body: '', threadId: 'task:t1' });
    if (!first.ok || !second.ok) throw new Error('asks failed');
    expect(h.router.get(first.handoffId)?.guestSourced).toBe(false);
    expect(h.router.get(second.handoffId)?.guestSourced).toBe(true);
    // Raised after the asking wake ended: the card still says where it came from.
    guestBots.clear();
    await resolveThreadDecision('ws1', first.decisionId!, 'ok', {}, dir);
    await h.router.reconcile();
    expect(h.rooms.read('ws1').cards.filter((c) => c.kind === 'question').map((c) => c.title)).toEqual(['first']);
    const card = h.rooms.read('ws1', { guests: true }).cards.find((c) => c.title === 'second');
    expect(card?.origin).toBe('guest');
    await h.router.reconcile();
    expect(h.rooms.read('ws1', { guests: true }).cards.filter((c) => c.title === 'second')).toHaveLength(1);
    // Its answer is as guest-sourced as it is.
    expect(await h.router.answer(second.handoffId, 'yes')).toMatchObject({ ok: true });
    const answered = h.router.list({}).find((x) => x.kind === 'answer' && x.replyTo === second.handoffId);
    expect(answered?.guestSourced).toBe(true);
  });

  it('a question keeps the provenance of the wake that asked it when it is stored after that wake', async () => {
    const lead = bot('ws1', 'lead');
    const guestBots = new Set<string>([lead.id]);
    const taint: HandoffTaintPort = { markSent: () => false, markForward: () => false, runningGuest: (botId) => guestBots.has(botId), handoffGuest: () => false };
    const h = await harness([lead], { taint });
    const asked = h.router.askPerson(binding(lead), { title: 'later', body: '' });
    // A clean wake is running by the time the queued question is stored.
    guestBots.clear();
    const r = await asked;
    if (!r.ok) throw new Error('ask failed');
    expect(h.router.get(r.handoffId)?.guestSourced).toBe(true);
  });

  it('a dismissed question answers the bot that it was closed without a choice', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const ask = await h.router.askPerson(binding(lead), { title: 'q', body: '', options: ['a', 'b'] });
    if (!ask.ok) throw new Error('ask failed');
    await resolveThreadDecision('ws1', ask.decisionId!, '', { dismissed: true }, dir);
    await h.router.reconcile();
    const answer = h.router.list().find((x) => x.kind === 'answer')!;
    expect(answer.payload.body).toBe(DISMISSED_ANSWER);
    // Its wake still holds over budget, but it carries no instruction.
    expect(h.router.summarize(answer.id)).toMatchObject({ ownerWords: true, dismissed: true });
    // Closing a question is not overriding the bot's recommendation.
    expect(h.facts.filter((f) => f.kind === 'human.correction')).toEqual([]);
  });

  it('an answer outside the offered options is one human.correction keyed by the question card; an offered option is none', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const picked = await h.router.askPerson(binding(lead), { title: 'p', body: '', threadId: 'task:p', options: ['a', 'b'] });
    if (!picked.ok) throw new Error('ask failed');
    await resolveThreadDecision('ws1', picked.decisionId!, 'b', {}, dir);
    await h.router.reconcile();
    expect(h.facts.filter((f) => f.kind === 'human.correction')).toEqual([]);
    const ask = await h.router.askPerson(binding(lead), { title: 'q', body: '', options: ['a', 'b'] });
    if (!ask.ok) throw new Error('ask failed');
    await resolveThreadDecision('ws1', ask.decisionId!, 'neither, c', {}, dir);
    await h.router.reconcile();
    await h.router.reconcile();
    const card = h.rooms.read('ws1').cards.find((c) => c.kind === 'question' && c.title === 'q')!;
    const corrections = h.facts.filter((f) => f.kind === 'human.correction');
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      dedupeKey: `human.correction:${card.id}`,
      ref: { botId: lead.id, messageId: card.id },
      payload: { category: 'question-override', cardKind: 'question', note: 'neither, c' },
    });
  });

  it('expires a question whose decision disappeared, and one past its time limit', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const gone = await h.router.askPerson(binding(lead), { title: 'gone', body: '', threadId: 'task:a' });
    const old = await h.router.askPerson(binding(lead), { title: 'old', body: '', threadId: 'task:b' });
    if (!gone.ok || !old.ok) throw new Error('asks failed');
    await clearThreadDecision('ws1', 'task:a', undefined, dir);
    await h.router.reconcile();
    expect(h.router.get(gone.handoffId)!.status).toBe('expired');
    now += HANDOFF_LIMITS.ASK_PERSON_TTL_MS + 1;
    await h.router.reconcile();
    expect(h.router.get(old.handoffId)!.status).toBe('expired');
    expect(loadThreadDecision('ws1', 'task:b', dir)).toBeNull();
    expect(h.wakes).toEqual([]);
    expect(h.rooms.read('ws1').cards.filter((c) => c.kind === 'question').every((c) => c.state === 'resolved')).toBe(true);
  });

  it('a guest-sourced question\'s closing card is guest-sourced: it stays out of a clean read, across a reload', async () => {
    const lead = bot('ws1', 'lead');
    const taint: HandoffTaintPort = { markSent: () => false, markForward: () => false, runningGuest: () => true, handoffGuest: () => true };
    const h = await harness([lead], { taint });
    const gone = await h.router.askPerson(binding(lead), { title: 'GUEST-ASKED', body: '', threadId: 'task:a' });
    if (!gone.ok) throw new Error('ask failed');
    await clearThreadDecision('ws1', 'task:a', undefined, dir);
    await h.router.reconcile();
    expect(h.router.get(gone.handoffId)!.status).toBe('expired');
    const closed = h.rooms.read('ws1', { guests: true }).cards.find((c) => c.title === 'Question closed: GUEST-ASKED');
    expect(closed).toMatchObject({ actor: { kind: 'system' }, origin: 'guest' });
    const reloaded = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), now: () => now, log: () => undefined });
    expect(reloaded.read('ws1').cards.map((c) => c.title).join('\n')).not.toContain('GUEST-ASKED');
    expect(reloaded.read('ws1', { guests: true }).cards.find((c) => c.id === closed!.id)?.origin).toBe('guest');
  });

  it('handoff.answer answers a raised question and a queued one', async () => {
    const lead = bot('ws1', 'lead');
    const other = bot('ws1', 'triage');
    const h = await harness([lead, other]);
    const a = await h.router.askPerson(binding(lead), { title: 'a', body: '', threadId: 'task:t' });
    const b = await h.router.askPerson(binding(other), { title: 'b', body: '', threadId: 'task:t' });
    if (!a.ok || !b.ok) throw new Error('asks failed');
    const queuedAnswer = await h.router.answer(b.handoffId, 'later');
    expect(queuedAnswer).toMatchObject({ ok: true, status: 'answered' });
    const raisedAnswer = await h.router.answer(a.handoffId, 'now');
    expect(raisedAnswer).toMatchObject({ ok: true, status: 'answered' });
    expect(raisedAnswer.ok && raisedAnswer.answerHandoffId).toBeTruthy();
    expect(await h.router.answer(a.handoffId, 'again')).toMatchObject({ ok: false, code: 'not_pending' });
    expect(await h.router.answer('h-nope', 'x')).toMatchObject({ ok: false, code: 'not_found' });
    expect(h.wakes).toHaveLength(2);
  });

  it('a queued question whose answer was stored but not closed closes with it after a restart, never asked again', async () => {
    const lead = bot('ws1', 'lead');
    const other = bot('ws1', 'triage');
    const h = await harness([lead, other]);
    const a = await h.router.askPerson(binding(lead), { title: 'a', body: '', threadId: 'task:t' });
    const b = await h.router.askPerson(binding(other), { title: 'b', body: '', threadId: 'task:t' });
    if (!a.ok || !b.ok) throw new Error('asks failed');
    expect(await h.router.answer(b.handoffId, 'later')).toMatchObject({ ok: true, status: 'answered' });
    h.router.dispose();
    // A stop between the two writes: the answer is on disk, the close is not.
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const closedAt = lines.findIndex((l) => { const r = JSON.parse(l) as { id: string; status: string }; return r.id === b.handoffId && r.status === 'answered'; });
    fs.writeFileSync(file, `${lines.slice(0, closedAt).join('\n')}\n`);
    const again = await harness([lead, other]);
    expect(again.router.get(b.handoffId)).toMatchObject({ status: 'answered' });
    expect(again.wakes.filter((w) => w.botId === other.id)).toHaveLength(1);
    // Once a's question closes, b's is not raised in the thread.
    expect(await again.router.answer(a.handoffId, 'now')).toMatchObject({ ok: true, status: 'answered' });
    await again.router.reconcile();
    expect(loadWorkspaceDecisions('ws1', dir).filter((d) => d.handoffId === b.handoffId)).toEqual([]);
    expect(again.wakes.filter((w) => w.botId === other.id)).toHaveLength(1);
  });

  it('caps open questions per workspace', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    for (let i = 0; i < HANDOFF_STORE_LIMITS.OPEN_ASKS_PER_WORKSPACE; i += 1) {
      expect((await h.router.askPerson(binding(lead), { title: `q${i}`, body: '', threadId: `task:t${i}` })).ok).toBe(true);
    }
    expect(await h.router.askPerson(binding(lead), { title: 'one more', body: '' })).toMatchObject({ ok: false, code: 'budget' });
  });

  it('an answer given while the app was off is delivered on the next start, and the queued question raised', async () => {
    const lead = bot('ws1', 'lead');
    const other = bot('ws1', 'triage');
    const h = await harness([lead, other]);
    const first = await h.router.askPerson(binding(lead), { title: 'first', body: '', threadId: 'task:t1' });
    const second = await h.router.askPerson(binding(other), { title: 'second', body: '', threadId: 'task:t1' });
    if (!first.ok || !second.ok) throw new Error('asks failed');
    h.router.dispose();
    await resolveThreadDecision('ws1', first.decisionId!, 'yes', {}, dir);
    await settle();
    expect(h.wakes).toEqual([]);
    const restarted = await harness([lead, other]);
    expect(restarted.router.get(first.handoffId)!.status).toBe('answered');
    expect(restarted.router.get(second.handoffId)!.status).toBe('delivered');
    expect(restarted.wakes).toHaveLength(1);
    expect(loadWorkspaceDecisions('ws1', dir).map((d) => d.question)).toEqual(['second']);
  });
});

describe('persistence and migration', () => {
  it('reloads handoffs (last line of an id wins) and keeps counting hops of a run', async () => {
    const moa = bot('hq', 'moa');
    const lead = bot('ws1', 'lead');
    const h = await harness([moa, lead]);
    const d = h.router.send(binding(moa), { kind: 'dispatch', toWorkspaceId: 'ws1', title: 'x', body: '' });
    if (!d.ok) throw new Error('dispatch failed');
    const again = await harness([moa, lead]);
    expect(again.router.get(d.handoffId)!.status).toBe('delivered');
    const res = again.router.send(binding(lead), { kind: 'result', replyTo: d.handoffId, title: 'r', body: '' });
    expect(res.ok && again.router.get(res.handoffId)!.hopsInRun).toBe(2);
  });

  it('imports moa-handoffs.json once as depth-0 dispatches and keeps the legacy file', () => {
    const legacy = {
      version: 1,
      items: {
        a: { id: 'a', hqWorkspaceId: 'hq', target: { workspaceId: 'ws1' }, title: 'Fix it', body: 'please', state: 'delivered', taskId: 'wtask-1', createdAt: 5, at: 6 },
        b: { id: 'b', title: 'Old', body: '', state: 'canceled', createdAt: 7, at: 8 },
        c: { nope: true },
      },
    };
    fs.writeFileSync(path.join(dir, 'moa-handoffs.json'), JSON.stringify(legacy));
    const factoryDir = path.join(dir, 'factory');
    expect(importLegacyMoaHandoffs({ wmuxDir: dir, factoryDir, now })).toBe(2);
    expect(importLegacyMoaHandoffs({ wmuxDir: dir, factoryDir, now })).toBe(0);
    const lines = fs.readFileSync(path.join(factoryDir, HANDOFFS_FILENAME), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: 'h-legacy-a', depth: 0, kind: 'dispatch', status: 'delivered', payload: { title: 'Fix it', refs: { taskId: 'wtask-1' } } });
    expect(lines[0].payload.body).toContain('Target workspace: ws1');
    expect(lines[1]).toMatchObject({ id: 'h-legacy-b', status: 'expired' });
    expect(fs.existsSync(path.join(dir, 'moa-handoffs.json'))).toBe(true);
    expect(handoffFromLegacy({ id: 'x', state: 'delivered', endedAt: 9, createdAt: 1 }, now)!.status).toBe('answered');
  });

  it('the shipped migration step imports through runFactoryMigrations and a router loads the result', async () => {
    fs.writeFileSync(path.join(dir, 'moa-handoffs.json'), JSON.stringify({ version: 1, items: { a: { id: 'a', title: 'T', body: '', state: 'delivered', createdAt: now, at: now } } }));
    const r = runFactoryMigrations(dir, { now });
    expect(r.notes).toEqual(['imported 1 Moa hand-offs into handoffs.jsonl']);
    expect(runFactoryMigrations(dir, { now }).notes).toEqual([]);
    const h = await harness([]);
    expect(h.router.get('h-legacy-a')).toMatchObject({ kind: 'dispatch', depth: 0 });
  });
});

describe('messages and room mentions (group rooms)', () => {
  const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, threadId: 'general' as ThreadId, title: `card ${id}`, body: `body of ${id}`, ...extra });

  it('a message goes to the named bot in any workspace; it needs toBotId, never the sender, never a disabled bot', async () => {
    const a = bot('ws1', 'lead');
    const b = bot('ws2', 'triage');
    const off = bot('ws1', 'verifier', { enabled: false });
    const h = await harness([a, b, off]);
    const r = h.router.send(binding(a), { kind: 'message', toBotId: b.id, title: 'hello', body: 'over there' });
    expect(r).toMatchObject({ ok: true, to: { botId: b.id, workspaceId: 'ws2' } });
    if (!r.ok) return;
    expect(h.router.get(r.handoffId)).toMatchObject({ kind: 'message', depth: 1, to: { kind: 'bot', botId: b.id } });
    expect(h.wakes.at(-1)).toMatchObject({ botId: b.id, reason: { kind: 'handoff', handoffId: r.handoffId } });
    // A plain message is a line in the addressee's room (no card said it).
    expect(h.rooms.read('ws2').cards.map((c) => c.kind)).toEqual(['fact']);
    expect(h.router.send(binding(a), { kind: 'message', title: 'x', body: '' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(h.router.send(binding(a), { kind: 'message', toBotId: a.id, title: 'x', body: '' })).toMatchObject({ ok: false, code: 'no_addressee' });
    expect(h.router.send(binding(a), { kind: 'message', toBotId: off.id, title: 'x', body: '' })).toMatchObject({ ok: false, code: 'no_addressee' });
    expect(h.router.send(binding(a), { kind: 'result', toBotId: b.id, title: 'x', body: '' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(h.router.send(binding(a), { kind: 'message', toBotId: 'nope', title: 'x', body: '' })).toMatchObject({ ok: false, code: 'invalid' });
    // The mention keys are the router's own.
    expect(h.router.send(binding(a), { kind: 'message', toBotId: b.id, title: 'x', body: '', clientHandoffId: `mention:c-1:${b.id}` })).toMatchObject({ ok: false, code: 'invalid' });
    // A dispatch may name its bot too.
    expect(h.router.send(binding(a), { kind: 'dispatch', toBotId: b.id, title: 'do it', body: '' })).toMatchObject({ ok: true, to: { botId: b.id } });
  });

  it('a mention wakes each named bot once as a `mention` wake; a repeat or a restart wakes nobody again', async () => {
    const a = bot('ws1', 'lead');
    const b = bot('ws1', 'triage');
    const c = bot('ws1', 'verifier');
    const h = await harness([a, b, c]);
    const out = h.router.mention(binding(a), card('c-one', { refs: { pr: 7 } }), [b.id, c.id]);
    expect(out.map((o) => o.result.ok)).toEqual([true, true]);
    expect(h.wakes.map((w) => [w.botId, w.reason])).toEqual([
      [b.id, { kind: 'mention', cardId: 'c-one', handoffId: out[0].result.ok ? out[0].result.handoffId : '', fromBotId: a.id }],
      [c.id, { kind: 'mention', cardId: 'c-one', handoffId: out[1].result.ok ? out[1].result.handoffId : '', fromBotId: a.id }],
    ]);
    // The mentioning card said it: its deliveries add no room line.
    expect(h.rooms.read('ws1').cards).toHaveLength(0);
    const stored = out[0].result.ok ? h.router.get(out[0].result.handoffId)! : null;
    expect(stored).toMatchObject({ kind: 'message', threadId: 'general', payload: { title: 'card c-one', body: 'body of c-one', refs: { pr: 7, messageId: 'c-one' } } });
    // The same card again: the first outcome, marked duplicate, no new wake.
    const again = h.router.mention(binding(a), card('c-one'), [b.id]);
    expect(again[0].result).toMatchObject({ ok: true, duplicate: true });
    expect(h.wakes).toHaveLength(2);
    // After a restart the records answer the same.
    const later = await harness([a, b, c]);
    expect(later.router.mention(binding(a), card('c-one'), [b.id, c.id]).every((o) => o.result.ok && o.result.duplicate)).toBe(true);
    expect(later.wakes).toEqual([]);
  });

  it('a mention keeps its card\'s guest provenance, whatever turn routes it', async () => {
    const a = bot('ws1', 'lead');
    const b = bot('ws1', 'triage');
    const sent: Array<[string, boolean | undefined]> = [];
    const taint: HandoffTaintPort = {
      markSent: (id, _sender, _answers, guestSource) => { sent.push([id, guestSource]); return guestSource ? 'guest' : false; },
      markForward: () => false, runningGuest: () => false, handoffGuest: () => false,
    };
    const h = await harness([a, b], { taint });
    const [guestOut] = h.router.mention(binding(a), card('c-guest', { origin: 'guest' }), [b.id]);
    const [cleanOut] = h.router.mention(binding(a), card('c-clean'), [b.id]);
    if (!guestOut.result.ok || !cleanOut.result.ok) throw new Error('mentions failed');
    expect(h.router.get(guestOut.result.handoffId)?.guestSourced).toBe(true);
    expect(h.router.get(cleanOut.result.handoffId)?.guestSourced).toBe(false);
    expect(sent).toEqual([[guestOut.result.handoffId, true], [cleanOut.result.handoffId, false]]);
  });

  it('a hop not known clean is refused, with the reason, to a bot whose engine cannot hold its tools back; a clean one goes through', async () => {
    const a = bot('ws1', 'lead');
    const acp = bot('ws1', 'triage', { engine: { kind: 'acp', command: 'agent', args: [] } });
    let guest = true;
    const taint: HandoffTaintPort = {
      markSent: () => (guest ? 'guest' : false), markForward: () => false,
      runningGuest: () => guest, handoffGuest: () => guest,
    };
    const h = await harness([a, acp], { taint });
    const [out] = h.router.mention(binding(a), { id: 'c-g', threadId: 'general' as ThreadId, title: 't', body: '', origin: 'guest' }, [acp.id]);
    expect(out.result).toMatchObject({ ok: false, code: 'no_addressee', message: expect.stringContaining('can\'t take guest messages') });
    expect(h.router.send(binding(a), { kind: 'message', toBotId: acp.id, title: 'x', body: '' })).toMatchObject({ ok: false, code: 'no_addressee' });
    expect(h.wakes).toEqual([]);
    guest = false;
    expect(h.router.send(binding(a), { kind: 'message', toBotId: acp.id, title: 'y', body: '' })).toMatchObject({ ok: true });
    expect(h.wakes).toHaveLength(1);
  });

  it('a hop not known clean stays in the sender\'s workspace; a clean one still reaches any workspace', async () => {
    const a = bot('ws1', 'lead');
    const same = bot('ws1', 'triage');
    const far = bot('ws2', 'lead');
    let guest = true;
    const taint: HandoffTaintPort = {
      markSent: (_id, _s, _a, source) => ((source ?? guest) ? 'guest' : false), markForward: () => false,
      runningGuest: () => guest, handoffGuest: () => guest,
    };
    const h = await harness([a, same, far], { taint });
    const refusedFar = h.router.send(binding(a), { kind: 'message', toBotId: far.id, title: 'x', body: '' });
    expect(refusedFar).toMatchObject({ ok: false, code: 'no_addressee', message: expect.stringContaining('its own workspace') });
    expect(h.router.send(binding(a), { kind: 'dispatch', toWorkspaceId: 'ws2', title: 'x', body: '' })).toMatchObject({ ok: false, code: 'no_addressee' });
    const [mentioned] = h.router.mention(binding(a), { id: 'c-g', threadId: 'general' as ThreadId, title: 't', body: '', origin: 'guest' }, [far.id]);
    expect(mentioned.result).toMatchObject({ ok: false, code: 'no_addressee' });
    expect(h.router.send(binding(a), { kind: 'message', toBotId: same.id, title: 'x', body: '' })).toMatchObject({ ok: true });
    expect(h.wakes.map((w) => w.botId)).toEqual([same.id]);
    guest = false;
    expect(h.router.send(binding(a), { kind: 'message', toBotId: far.id, title: 'y', body: '' })).toMatchObject({ ok: true, to: { workspaceId: 'ws2' } });
    const [clean] = h.router.mention(binding(a), { id: 'c-c', threadId: 'general' as ThreadId, title: 't', body: '' }, [far.id]);
    expect(clean.result).toMatchObject({ ok: true });
  });

  it('without a tracker where one is expected, a send and a question are guest-sourced', async () => {
    const a = bot('ws1', 'triage');
    const lead = bot('ws1', 'lead');
    const h = await harness([a, lead]);
    expectWakeTaint();
    try {
      const sent = h.router.send(binding(a), { kind: 'dispatch', title: 'x', body: '' });
      const asked = await h.router.askPerson(binding(a), { title: 'q', body: '' });
      if (!sent.ok || !asked.ok) throw new Error('refused');
      expect(h.router.get(sent.handoffId)?.guestSourced).toBe(true);
      expect(h.router.get(asked.handoffId)?.guestSourced).toBe(true);
    } finally {
      expectWakeTaint(false);
    }
  });

  it('a refused send says its provenance on the record, so the refusal does not wake its sender as unknown', async () => {
    const a = bot('ws1', 'triage');
    let guest = false;
    const taint: HandoffTaintPort = { markSent: () => false, markForward: () => false, runningGuest: () => guest, handoffGuest: () => false };
    const h = await harness([a], { taint });
    const clean = h.router.send(binding(a), { kind: 'dispatch', toWorkspaceId: 'ws9', title: 'x', body: '' });
    guest = true;
    const fromGuest = h.router.send(binding(a), { kind: 'dispatch', toWorkspaceId: 'ws9', title: 'y', body: '' });
    if (clean.ok || fromGuest.ok) throw new Error('expected refusals');
    expect(h.router.get(clean.handoffId!)).toMatchObject({ status: 'refused', guestSourced: false });
    expect(h.router.get(fromGuest.handoffId!)).toMatchObject({ status: 'refused', guestSourced: true });
  });

  it('a broadcast in General from a wake the owner started in the poster\'s 1:1 wakes its room\'s bots in that 1:1', async () => {
    const coord = bot('ws1', 'lead');
    const b = bot('ws1', 'triage');
    const far = bot('ws2', 'verifier');
    const h = await harness([coord, b, far]);
    const dm = `dm:${coord.id}` as ThreadId;
    h.wake.thread = dm;
    h.wake.id = { wakeId: 'w-own', attempt: 1, reasonKind: 'human', ownerCardId: 'c-owner' } as Harness['wake']['id'];
    const out = h.router.mention(binding(coord), card('c-ask'), [b.id, far.id]);
    const [mine, theirs] = out.map((o) => (o.result.ok ? h.router.get(o.result.handoffId)! : null));
    expect(mine).toMatchObject({ kind: 'message', threadId: dm });
    expect(h.wakes.find((w) => w.botId === b.id)).toMatchObject({ threadId: dm, reason: { kind: 'mention' } });
    // A bot of another room answers in its own room, as before.
    expect(theirs).toMatchObject({ threadId: 'general' });
    // Woken there, the bot's answer lands in the 1:1 (its wake's thread).
    const posted = await handleRoomPost({ kind: 'status', title: 'Checked' }, { bot: binding(b) } as RpcContext, { writer: () => h.rooms, ports: () => h.ports, wmuxDir: () => dir }) as { ok: boolean; card?: { threadId: string } };
    expect(posted).toMatchObject({ ok: true, card: { threadId: dm } });
  });

  it('any other mention keeps the card\'s thread', async () => {
    const coord = bot('ws1', 'lead');
    const b = bot('ws1', 'triage');
    const h = await harness([coord, b]);
    const dm = `dm:${coord.id}` as ThreadId;
    const cases: Array<{ thread: ThreadId; reasonKind: string; cardThread: ThreadId }> = [
      // Not an owner message: a handoff the coordinator runs in its 1:1.
      { thread: dm, reasonKind: 'handoff', cardThread: 'general' },
      // The owner's message in General.
      { thread: 'general', reasonKind: 'human', cardThread: 'general' },
      // A card the poster put in another subject's thread on purpose.
      { thread: dm, reasonKind: 'human', cardThread: 'pr:github.com/acme/app#5' },
    ];
    for (const [i, c] of cases.entries()) {
      h.wake.thread = c.thread;
      h.wake.id = { wakeId: `w-${i}`, attempt: 1, reasonKind: c.reasonKind } as Harness['wake']['id'];
      const [o] = h.router.mention(binding(coord), card(`c-other${i}`, { threadId: c.cardThread }), [b.id]);
      expect(o.result.ok && h.router.get(o.result.handoffId)).toMatchObject({ threadId: c.cardThread });
    }
  });

  it('a queued mention redelivered on start wakes as the same mention', async () => {
    const a = bot('ws1', 'lead');
    const b = bot('ws1', 'triage');
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      version: 1, id: 'h-m', runId: 'run-m', threadId: 'general', depth: 1, hopsInRun: 1,
      from: { kind: 'bot', workspaceId: 'ws1', botId: a.id }, to: { kind: 'bot', workspaceId: 'ws1', botId: b.id }, kind: 'message',
      attribution: { originator: { kind: 'bot', workspaceId: 'ws1', botId: a.id }, chain: [] }, landing: 'wake',
      payload: { title: 'x', body: '', refs: { messageId: 'c-m' } }, status: 'queued', clientHandoffId: `mention:c-m:${b.id}`, createdAt: now, updatedAt: now,
    })}\n`);
    const h = await harness([a, b]);
    expect(h.wakes).toEqual([{ botId: b.id, workspaceId: 'ws1', reason: { kind: 'mention', cardId: 'c-m', handoffId: 'h-m', fromBotId: a.id }, priority: 1, threadId: 'general' }]);
  });

  it('every bot an owner message woke speaks in one run, owned by the owner; its first hops are never capped', async () => {
    const bots = Array.from({ length: 7 }, (_, i) => bot('ws1', i === 0 ? 'lead' : 'triage'));
    const h = await harness(bots);
    const runId = 'run-c-owner1';
    // Each of the seven answers the owner by mentioning the six others: 42
    // first hops, more than MAX_PER_RUN, none refused.
    let n = 0;
    for (const sender of bots) {
      h.wake.id = { wakeId: `w-owner-${sender.id}`, attempt: 1, runId } as never;
      const out = h.router.mention(binding(sender), card(`c-r${n += 1}`), bots.filter((b) => b.id !== sender.id).map((b) => b.id));
      expect(out.every((o) => o.result.ok)).toBe(true);
    }
    expect(7 * 6).toBeGreaterThan(HANDOFF_LIMITS.MAX_PER_RUN);
    const hops = h.router.list({ limit: 200 }).filter((x) => x.kind === 'message');
    expect(hops).toHaveLength(42);
    expect(new Set(hops.map((x) => x.runId))).toEqual(new Set([runId]));
    expect(hops.every((x) => x.depth === 1 && x.attribution.originator.kind === 'human')).toBe(true);
    // A deeper hop of that run meets the cap.
    const first = hops.find((x) => x.to.kind === 'bot' && x.to.botId === bots[1].id)!;
    h.wake.id = { wakeId: 'w-deeper', attempt: 1, handoffId: first.id };
    const deeper = h.router.mention(binding(bots[1]), card('c-deeper'), [bots[2].id]);
    expect(deeper[0].result).toMatchObject({ ok: false, code: 'max_per_run' });
    const refused = h.facts.filter((f) => f.kind === 'handoff.refused');
    expect(refused).toHaveLength(1);
    expect(h.rooms.read('ws1').cards.filter((c) => c.kind === 'refusal')).toHaveLength(1);
  });

  it('a mention ping-pong stops at MAX_DEPTH with a refusal card', async () => {
    const a = bot('ws1', 'lead');
    const b = bot('ws1', 'triage');
    const h = await harness([a, b]);
    let woken: string | undefined;
    let last: ReturnType<HandoffRouter['send']> | null = null;
    for (let i = 0; i <= HANDOFF_LIMITS.MAX_DEPTH; i += 1) {
      const [from, to] = i % 2 === 0 ? [a, b] : [b, a];
      h.wake.id = { wakeId: `w-pp-${i}`, attempt: 1, ...(woken ? { handoffId: woken } : {}) };
      last = h.router.mention(binding(from), card(`c-pp${i}`), [to.id])[0].result;
      if (last.ok) woken = last.handoffId;
      else break;
    }
    expect(last).toMatchObject({ ok: false, code: 'max_depth' });
    expect(h.wakes).toHaveLength(HANDOFF_LIMITS.MAX_DEPTH);
    expect(h.rooms.read('ws1').cards.filter((c) => c.kind === 'refusal')).toHaveLength(1);
  });
});

describe('closing questions nobody needs to answer (A5)', () => {
  const ownerWake = (threadId: ThreadId | undefined, enqueuedAt: number) => ({
    reason: { kind: 'human' as const, text: 'do X', source: 'desktop' as const },
    workspaceId: 'ws1',
    enqueuedAt,
    ...(threadId ? { threadId } : {}),
  });
  const open = (h: Harness) => h.rooms.read('ws1').cards.filter((c) => c.kind === 'question' && c.state === 'open').map((c) => c.title);

  it('a newer question of the same bot in the same thread replaces its open one; nobody is woken', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const first = await h.router.askPerson(binding(lead), { title: 'first', body: '', threadId: 'task:t1' });
    const second = await h.router.askPerson(binding(lead), { title: 'second', body: '', threadId: 'task:t1' });
    if (!first.ok || !second.ok) throw new Error('asks failed');
    expect(second.status).toBe('delivered');
    expect(h.router.get(first.handoffId)!.status).toBe('expired');
    expect(loadThreadDecision('ws1', 'task:t1', dir)).toMatchObject({ question: 'second' });
    expect(open(h)).toEqual(['second']);
    await h.router.reconcile();
    expect(h.wakes).toEqual([]);
    expect(h.router.list().some((x) => x.kind === 'answer')).toBe(false);
  });

  it('the owner answering in chat closes the bot\'s earlier questions there or in their own thread, not the ones it asked in that turn or elsewhere', async () => {
    const lead = bot('ws1', 'lead');
    const other = bot('ws1', 'triage');
    const h = await harness([lead, other]);
    const own = await h.router.askPerson(binding(lead), { title: 'greeting', body: '' });
    const inGeneral = await h.router.askPerson(binding(lead), { title: 'general q', body: '', threadId: 'general' });
    const elsewhere = await h.router.askPerson(binding(lead), { title: 'pr q', body: '', threadId: 'pr:github.com/acme/app#2' });
    const others = await h.router.askPerson(binding(other), { title: 'other bot', body: '', threadId: 'task:x' });
    const said = now + 1;
    now += 5;
    const during = await h.router.askPerson(binding(lead), { title: 'asked in the turn', body: '', threadId: 'task:during' });
    if (!own.ok || !inGeneral.ok || !elsewhere.ok || !others.ok || !during.ok) throw new Error('asks failed');
    const closed = await h.router.closeAnsweredInChat(lead.id, ownerWake('general', said));
    expect(closed.sort()).toEqual([own.handoffId, inGeneral.handoffId].sort());
    expect(open(h).sort()).toEqual(['asked in the turn', 'other bot', 'pr q']);
    // Words to the whole room close no question of a thread of its own.
    const greeting = await h.router.askPerson(binding(other), { title: 'what should I do?', body: '' });
    if (!greeting.ok) throw new Error('ask failed');
    now += 5;
    expect(await h.router.closeAnsweredInChat(other.id, { ...ownerWake('general', now), reason: { kind: 'human', text: 'Hi', source: 'desktop', room: true } })).toEqual([]);
    // Nor do words to the room that only its coordinator got.
    expect(await h.router.closeAnsweredInChat(other.id, { ...ownerWake('general', now), reason: { kind: 'human', text: 'Hi', source: 'desktop', lead: true } })).toEqual([]);
    expect(await h.router.closeAnsweredInChat(other.id, ownerWake('general', now))).toEqual([greeting.handoffId]);
    // A wake that is not the owner's words closes nothing.
    expect(await h.router.closeAnsweredInChat(lead.id, { ...ownerWake('pr:github.com/acme/app#2', now + 10), reason: { kind: 'manual', by: 'human' } })).toEqual([]);
    expect(h.wakes).toEqual([]);
  });

  it('chat words do not close a question with options: its choices stay on the card', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const pick = await h.router.askPerson(binding(lead), { title: 'Where should I start?', body: '', options: ['Repo', 'Issues'] });
    if (!pick.ok) throw new Error('ask failed');
    now += 5;
    expect(await h.router.closeAnsweredInChat(lead.id, ownerWake('general', now))).toEqual([]);
    expect(h.router.get(pick.handoffId)!.status).toBe('delivered');
    expect(open(h)).toEqual(['Where should I start?']);
  });

  it('chat words that are one of the options answer the question with that option', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const pick = await h.router.askPerson(binding(lead), { title: 'Where should I start?', body: '', options: ['Repo', 'Issues'] });
    if (!pick.ok) throw new Error('ask failed');
    now += 5;
    const said = { ...ownerWake('general', now), reason: { kind: 'human' as const, text: '  issues ', source: 'desktop' as const } };
    expect(await h.router.closeAnsweredInChat(lead.id, said)).toEqual([pick.handoffId]);
    await h.router.reconcile();
    expect(h.router.get(pick.handoffId)!.status).toBe('answered');
    const answer = h.router.list({ workspaceId: 'ws1' }).find((x) => x.kind === 'answer')!;
    // Stored as delivered: the bot read the words in the turn that ended; no second wake.
    expect(answer).toMatchObject({ from: { kind: 'human' }, to: { kind: 'bot', botId: lead.id }, replyTo: pick.handoffId, payload: { body: 'Issues' }, status: 'delivered' });
    expect(h.wakes).toEqual([]);
    expect(open(h)).toEqual([]);
    expect(h.rooms.read('ws1').cards.some((c) => c.title.startsWith('Question closed'))).toBe(false);
  });

  it('words that are an option of several open questions answer none of them', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const a = await h.router.askPerson(binding(lead), { title: 'Ship it?', body: '', options: ['Yes', 'No'] });
    const b = await h.router.askPerson(binding(lead), { title: 'Delete it?', body: '', options: ['Yes', 'No'] });
    if (!a.ok || !b.ok) throw new Error('asks failed');
    now += 5;
    const said = { ...ownerWake('general', now), reason: { kind: 'human' as const, text: 'Yes', source: 'desktop' as const } };
    expect(await h.router.closeAnsweredInChat(lead.id, said)).toEqual([]);
    expect(open(h).sort()).toEqual(['Delete it?', 'Ship it?']);
  });

  it('a greeting question is marked, and closes once the bot has a job', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    h.wake.id = { wakeId: 'w-intro', attempt: 1, reasonKind: 'intro' } as never;
    const greet = await h.router.askPerson(binding(lead), { title: 'What should I do?', body: '' });
    h.wake.id = { wakeId: 'w-2', attempt: 1, reasonKind: 'human' } as never;
    const later = await h.router.askPerson(binding(lead), { title: 'Which repo?', body: '', threadId: 'task:r' });
    if (!greet.ok || !later.ok) throw new Error('asks failed');
    const card = h.rooms.read('ws1').cards.find((c) => c.title === 'What should I do?')!;
    expect(card.greeting).toBe(true);
    expect(h.rooms.read('ws1').cards.find((c) => c.title === 'Which repo?')!.greeting).toBeUndefined();
    expect(await h.router.closeIntroQuestions(lead.id)).toEqual([greet.handoffId]);
    expect(open(h)).toEqual(['Which repo?']);
  });

  it('the greeting closes on the owner\'s next words to the bot, in any thread and through the room, choices or not', async () => {
    const lead = bot('ws1', 'lead');
    const other = bot('ws1', 'triage');
    const h = await harness([lead, other]);
    h.wake.id = { wakeId: 'w-intro', attempt: 1, reasonKind: 'intro' } as never;
    const greet = await h.router.askPerson(binding(lead), { title: 'What should I do?', body: '', options: ['Look at the repo', 'Triage issues'] });
    h.wake.id = { wakeId: 'w-2', attempt: 1, reasonKind: 'human' } as never;
    const pick = await h.router.askPerson(binding(lead), { title: 'Ship it?', body: '', options: ['Yes', 'No'] });
    if (!greet.ok || !pick.ok) throw new Error('asks failed');
    const said = now;
    now += 5;
    // Another bot's words, or the owner's words from before it, leave it open.
    expect(await h.router.closeAnsweredInChat(other.id, { ...ownerWake('general', now), reason: { kind: 'human', text: 'Fix the login bug', source: 'desktop', lead: true } })).toEqual([]);
    expect(await h.router.closeAnsweredInChat(lead.id, { ...ownerWake('general', said - 1), reason: { kind: 'human', text: 'Fix the login bug', source: 'desktop', lead: true } })).toEqual([]);
    // The owner just gives the lead work in the room, in a thread of its own.
    const work = { ...ownerWake('handoff:h-xyz', now), reason: { kind: 'human' as const, text: 'Fix the login bug', source: 'desktop' as const, lead: true as const } };
    expect(await h.router.closeAnsweredInChat(lead.id, work)).toEqual([greet.handoffId]);
    // Other questions with choices keep the usual rule.
    expect(open(h)).toEqual(['Ship it?']);
  });

  it('a bot cannot set the owner\'s request a thread answers (main\'s ref only)', async () => {
    const lead = bot('ws1', 'lead');
    const other = bot('ws1', 'triage');
    const h = await harness([lead, other]);
    const q = await h.router.askPerson(binding(lead), { title: 'Which?', body: '', refs: { requestCardId: 'c-1', taskId: 'wtask-1' } as never });
    const d = h.router.send(binding(lead), { kind: 'message', toBotId: other.id, title: 'hi', body: '', refs: { requestCardId: 'c-1' } as never });
    if (!q.ok || !d.ok) throw new Error('refused');
    expect(h.router.get(q.handoffId)!.payload.refs).toEqual({ taskId: 'wtask-1' });
    expect(h.router.get(d.handoffId)!.payload.refs).toBeUndefined();
    expect(h.rooms.read('ws1').cards.some((c) => c.refs?.requestCardId)).toBe(false);
  });

  it('a thread whose subject ended closes its open questions', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const q = await h.router.askPerson(binding(lead), { title: 'merge?', body: '', threadId: 'pr:github.com/acme/app#3' });
    if (!q.ok) throw new Error('ask failed');
    expect(await h.router.closeThreadQuestions('ws2', 'pr:github.com/acme/app#3')).toEqual([]);
    expect(await h.router.closeThreadQuestions('ws1', 'pr:github.com/acme/app#3')).toEqual([q.handoffId]);
    expect(loadThreadDecision('ws1', 'pr:github.com/acme/app#3', dir)).toBeNull();
  });

  it('a question asked in a wake about one task carries it, and closes once the task stops waiting', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    h.wake.id = { wakeId: 'w-t', attempt: 1, reasonKind: 'facts', taskId: 'wtask-9' } as never;
    const q = await h.router.askPerson(binding(lead), { title: 'push refused, what now?', body: '' });
    h.wake.id = null;
    const named = await h.router.askPerson(binding(lead), { title: 'named', body: '', refs: { taskId: 'wtask-1' } });
    if (!q.ok || !named.ok) throw new Error('asks failed');
    expect(h.rooms.read('ws1').cards.find((c) => c.title === 'push refused, what now?')!.refs).toMatchObject({ taskId: 'wtask-9' });
    expect(await h.router.closeTaskQuestions('wtask-9')).toEqual([q.handoffId]);
    expect(open(h)).toEqual(['named']);
  });

  it('question_close: a bot closes only its own open question card', async () => {
    const lead = bot('ws1', 'lead');
    const other = bot('ws1', 'triage');
    const h = await harness([lead, other]);
    const q = await h.router.askPerson(binding(lead), { title: 'q', body: '', threadId: 'task:q' });
    if (!q.ok) throw new Error('ask failed');
    const card = h.rooms.read('ws1').cards.find((c) => c.kind === 'question')!;
    expect(await h.router.closeOwnQuestion(binding(other), card.id)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await h.router.closeOwnQuestion(binding(lead), 'nope')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await h.router.closeOwnQuestion(binding(lead), 7)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await h.router.closeOwnQuestion(binding(lead), card.id)).toEqual({ ok: true, handoffId: q.handoffId });
    expect(await h.router.closeOwnQuestion(binding(lead), card.id)).toMatchObject({ ok: false, code: 'not_found' });
    expect(h.wakes).toEqual([]);
  });
});

describe('closing questions: the owner\'s answer and blocked threads (review)', () => {
  it('a question the owner already answered is not closed quietly: the answer still reaches the bot', async () => {
    const lead = bot('ws1', 'lead');
    const h = await harness([lead]);
    const q = await h.router.askPerson(binding(lead), { title: 'which?', body: '', threadId: 'task:z', refs: { taskId: 'wtask-z' } });
    if (!q.ok) throw new Error('ask failed');
    await resolveThreadDecision('ws1', q.decisionId!, 'the second', {}, dir);
    expect(await h.router.closeTaskQuestions('wtask-z')).toEqual([]);
    await h.router.reconcile();
    expect(h.router.get(q.handoffId)!.status).toBe('answered');
    expect(h.wakes).toHaveLength(1);
  });

  it('a thread held by the decision of a closed question frees when the next question comes', async () => {
    const lead = bot('ws1', 'lead');
    const other = bot('ws1', 'triage');
    const h = await harness([lead, other]);
    const q = await h.router.askPerson(binding(lead), { title: 'first', body: '', threadId: 'task:b' });
    if (!q.ok) throw new Error('ask failed');
    // Its clear failed: the question is closed, its decision still there.
    const d = loadThreadDecision('ws1', 'task:b', dir)!;
    const realClear = deckDecisionPort(dir).clear;
    (h.router as unknown as { opts: { decisions: { clear: typeof realClear } } }).opts.decisions.clear = async () => false;
    await h.router.closeOwnQuestion(binding(lead), h.rooms.read('ws1').cards.find((c) => c.kind === 'question')!.id);
    expect(loadThreadDecision('ws1', 'task:b', dir)?.id).toBe(d.id);
    (h.router as unknown as { opts: { decisions: { clear: typeof realClear } } }).opts.decisions.clear = realClear;
    const next = await h.router.askPerson(binding(other), { title: 'second', body: '', threadId: 'task:b' });
    expect(next).toMatchObject({ ok: true, status: 'delivered' });
    expect(loadThreadDecision('ws1', 'task:b', dir)).toMatchObject({ question: 'second' });
  });
});

describe('the team lead and a chain that outlives a worker', () => {
  it('a workspace\'s lead is its coordinator: a result without replyTo and a dispatch without a bot reach it', async () => {
    const dev = bot('ws1', 'lead');
    const lead = bot('ws1', 'moa');
    const issue = bot('ws1', 'triage');
    const h = await harness([dev, lead, issue]);
    expect(h.router.send(binding(issue), { kind: 'result', title: 'found it', body: '' })).toMatchObject({ ok: true, to: { botId: lead.id } });
    expect(h.router.send(binding(dev), { kind: 'dispatch', title: 'take this', body: '' })).toMatchObject({ ok: true, to: { botId: lead.id } });
    // The coordinator's own dispatch or result goes to the room's `lead`-role bot, as before.
    expect(h.router.send(binding(lead), { kind: 'dispatch', title: 'build', body: '' })).toMatchObject({ ok: true, to: { botId: dev.id } });
    expect(h.router.send(binding(lead), { kind: 'result', title: 'r', body: '' })).toMatchObject({ ok: true, to: { botId: dev.id } });
    // Without an enabled coordinator, the oldest `lead`-role bot leads as before.
    lead.enabled = false;
    expect(h.router.send(binding(issue), { kind: 'result', title: 'again', body: '' })).toMatchObject({ ok: true, to: { botId: dev.id } });
  });

  it('a result sent from a task wake answers the dispatch its task was started for', async () => {
    const lead = bot('ws1', 'moa');
    const dev = bot('ws1', 'lead');
    const h = await harness([lead, dev]);
    h.wake.id = { wakeId: 'w-owner', attempt: 1, runId: 'run-c-1' } as Harness['wake']['id'];
    const d = h.router.send(binding(lead), { kind: 'dispatch', toBotId: dev.id, title: 'Build it', body: '' });
    if (!d.ok) throw new Error('dispatch failed');
    // The developer's task wake carries the dispatch its task recorded (runningWakeOf).
    h.wake.id = { wakeId: 'w-task', attempt: 1, handoffId: d.handoffId, reasonKind: 'facts' } as Harness['wake']['id'];
    const r = h.router.send(binding(dev), { kind: 'result', title: 'Built', body: 'done' });
    expect(r).toMatchObject({ ok: true, to: { botId: lead.id } });
    if (!r.ok) return;
    expect(h.router.get(r.handoffId)).toMatchObject({ replyTo: d.handoffId, runId: 'run-c-1', depth: 1, attribution: { originator: { kind: 'human' }, chain: [d.handoffId] } });
    expect(h.router.summarize(d.handoffId)).toMatchObject({ answered: true });
    // A later task wake of the same dispatch: its result goes to the lead in
    // the same chain, never refused as a second answer.
    h.wake.id = { wakeId: 'w-task-2', attempt: 1, handoffId: d.handoffId, reasonKind: 'facts' } as Harness['wake']['id'];
    const later = h.router.send(binding(dev), { kind: 'result', title: 'Also tidied', body: '' });
    expect(later).toMatchObject({ ok: true, to: { botId: lead.id } });
    if (later.ok) expect(h.router.get(later.handoffId)).toMatchObject({ runId: 'run-c-1', depth: 1 });
    if (later.ok) expect(h.router.get(later.handoffId)?.replyTo).toBeUndefined();
    // The handoff wake itself still answers only once.
    h.wake.id = { wakeId: 'w-hop', attempt: 1, handoffId: d.handoffId, reasonKind: 'handoff' } as Harness['wake']['id'];
    expect(h.router.send(binding(dev), { kind: 'result', title: 'again', body: '' })).toMatchObject({ ok: false, code: 'duplicate_result' });
  });

  it('a question asked mid-hop: the answer\'s wake still answers that hop', async () => {
    const lead = bot('ws1', 'moa');
    const dev = bot('ws1', 'lead');
    const h = await harness([lead, dev]);
    h.wake.id = { wakeId: 'w-owner', attempt: 1, runId: 'run-c-2' } as Harness['wake']['id'];
    const d = h.router.send(binding(lead), { kind: 'dispatch', toBotId: dev.id, title: 'Build it', body: '' });
    if (!d.ok) throw new Error('dispatch failed');
    h.wake.id = { wakeId: 'w-dev', attempt: 1, handoffId: d.handoffId };
    const ask = await h.router.askPerson(binding(dev), { title: 'Which DB?', body: '' });
    if (!ask.ok) throw new Error('not asked');
    expect(h.router.get(ask.handoffId)).toMatchObject({ forHop: d.handoffId });
    const answered = await h.router.answer(ask.handoffId, 'Postgres');
    if (!answered.ok || !answered.answerHandoffId) throw new Error('not answered');
    h.wake.id = { wakeId: 'w-answer', attempt: 1, handoffId: answered.answerHandoffId };
    const r = h.router.send(binding(dev), { kind: 'result', title: 'Built on Postgres', body: '' });
    expect(r).toMatchObject({ ok: true, to: { botId: lead.id } });
    if (r.ok) expect(h.router.get(r.handoffId)).toMatchObject({ replyTo: d.handoffId, runId: 'run-c-2', depth: 1 });
    // A question asked once the hop has its result holds no hop.
    h.wake.id = { wakeId: 'w-dev-2', attempt: 1, handoffId: d.handoffId };
    const late = await h.router.askPerson(binding(dev), { title: 'Anything else?', body: '', threadId: 'general' });
    if (!late.ok) throw new Error('not asked');
    expect(h.router.get(late.handoffId)?.forHop).toBeUndefined();
  });
});

describe('the handoff a bot\'s worker belongs to (taskHandoff)', () => {
  const PR = (n: number) => `pr:github.com/acme/app#${n}` as ThreadId;
  const subject = (n: number, thread = true) => ({ ...(thread ? { threadId: PR(n) } : {}), pr: { number: n, threadId: PR(n) } });
  async function reviewerRig() {
    const lead = bot('ws1', 'moa');
    const reviewer = bot('ws1', 'verifier');
    const other = bot('ws1', 'verifier');
    const h = await harness([lead, reviewer, other]);
    const send = (to: BotProfile, n: number, extra: { threadId?: ThreadId; refs?: { pr: number } } = { threadId: PR(n) }) => {
      const d = h.router.send(binding(lead), { kind: 'dispatch', toBotId: to.id, title: `verify PR #${n}`, body: '', ...extra });
      if (!d.ok) throw new Error('dispatch failed');
      return d.handoffId;
    };
    return { h, lead, reviewer, other, send, me: { workspaceId: reviewer.workspaceId, botId: reviewer.id } };
  }

  it('a worker for PR #X started from the wake about #Y answers #X\'s dispatch, and #Y\'s stays open', async () => {
    const { h, lead, reviewer, send, me } = await reviewerRig();
    const y = send(reviewer, 2);
    const x = send(reviewer, 1);
    const bound = h.router.taskHandoff(me, subject(1), y);
    expect(bound).toBe(x);
    // The task's wake carries what its row recorded (runningWakeOf).
    h.wake.id = { wakeId: 'w-task', attempt: 1, handoffId: String(bound), reasonKind: 'facts' } as Harness['wake']['id'];
    const r = h.router.send(binding(reviewer), { kind: 'result', title: 'PR #1 passes', body: '' });
    expect(r).toMatchObject({ ok: true, to: { botId: lead.id } });
    if (r.ok) expect(h.router.get(r.handoffId)?.replyTo).toBe(x);
    expect(h.router.summarize(x)).toMatchObject({ answered: true });
    expect(h.router.summarize(y)?.answered).toBeUndefined();
  });

  it('a coordinator\'s dispatches in their own threads: the PR is told by refs.pr, or by the thread the bot names', async () => {
    const { h, reviewer, send, me } = await reviewerRig();
    const y = send(reviewer, 2, { refs: { pr: 2 } });
    const x = send(reviewer, 1, { refs: { pr: 1 } });
    expect(h.router.get(x)?.threadId).toBe(`handoff:${x}`);
    expect(h.router.taskHandoff(me, subject(1, false), y)).toBe(x);
    const plainY = send(reviewer, 4, {});
    const plainX = send(reviewer, 3, {});
    expect(h.router.taskHandoff(me, { threadId: `handoff:${plainX}` as ThreadId }, plainY)).toBe(plainX);
  });

  it('a worker for the wake\'s own subject keeps the wake\'s handoff', async () => {
    const { h, reviewer, send, me } = await reviewerRig();
    const y = send(reviewer, 2);
    send(reviewer, 1);
    expect(h.router.taskHandoff(me, subject(2), y)).toBe(y);
    expect(h.router.taskHandoff(me, {}, y)).toBe(y);
    // A dispatch in its own thread with no PR named: nothing says it is about another PR.
    const plain = send(reviewer, 5, {});
    expect(h.router.taskHandoff(me, subject(5, false), plain)).toBe(plain);
  });

  it('no open dispatch, or several, for the task\'s subject: bound to none, never to the wake\'s', async () => {
    const { h, reviewer, send, me } = await reviewerRig();
    const y = send(reviewer, 2);
    expect(h.router.taskHandoff(me, subject(1), y)).toBeNull();
    send(reviewer, 1);
    send(reviewer, 1, { refs: { pr: 1 } });
    expect(h.router.taskHandoff(me, subject(1), y)).toBeNull();
  });

  it('a dispatch addressed to another bot, or one already answered, is never the task\'s', async () => {
    const { h, reviewer, other, send, me } = await reviewerRig();
    const y = send(reviewer, 2);
    send(other, 1);
    expect(h.router.taskHandoff(me, subject(1), y)).toBeNull();
    const x = send(reviewer, 1);
    h.wake.id = { wakeId: 'w-x', attempt: 1, handoffId: x, reasonKind: 'handoff' } as Harness['wake']['id'];
    expect(h.router.send(binding(reviewer), { kind: 'refusal', title: 'busy', body: '' })).toMatchObject({ ok: true });
    expect(h.router.taskHandoff(me, subject(1), y)).toBeNull();
  });

  it('another bot\'s wake handoff is never kept; PR #n of another repository is not this one\'s', async () => {
    const { h, reviewer, other, send, me } = await reviewerRig();
    const foreign = send(other, 2);
    expect(h.router.taskHandoff(me, {}, foreign)).toBeNull();
    expect(h.router.taskHandoff(me, subject(2), foreign)).toBeNull();
    const y = send(reviewer, 2);
    send(reviewer, 1, { threadId: 'pr:github.com/acme/other#1' as ThreadId, refs: { pr: 1 } });
    expect(h.router.taskHandoff(me, subject(1), y)).toBeNull();
  });

  it('an answer\'s wake is judged by the dispatch its question was asked on', async () => {
    const { h, reviewer, send, me } = await reviewerRig();
    const y = send(reviewer, 2, { refs: { pr: 2 } });
    h.wake.id = { wakeId: 'w-y', attempt: 1, handoffId: y };
    const ask = await h.router.askPerson(binding(reviewer), { title: 'Which base?', body: '' });
    if (!ask.ok) throw new Error('not asked');
    const answered = await h.router.answer(ask.handoffId, 'main');
    if (!answered.ok || !answered.answerHandoffId) throw new Error('not answered');
    const a = answered.answerHandoffId;
    expect(h.router.taskHandoff(me, subject(2, false), a)).toBe(a);
    expect(h.router.taskHandoff(me, subject(1, false), a)).toBeNull();
    const x = send(reviewer, 1, { refs: { pr: 1 } });
    expect(h.router.taskHandoff(me, subject(1, false), a)).toBe(x);
  });
});

describe('retention of a hop held by an open question', () => {
  it('an old dispatch stays while a question asked on it is open', async () => {
    const lead = bot('ws1', 'moa');
    const dev = bot('ws1', 'lead');
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = now - HANDOFF_STORE_LIMITS.RETAIN_MS - 1000;
    const base = { version: 1, runId: 'run-old', depth: 0, hopsInRun: 1, landing: 'wake', status: 'delivered', createdAt: old, updatedAt: old };
    const dispatch = { ...base, id: 'h-held', threadId: 'handoff:h-held', from: { kind: 'bot', workspaceId: 'ws1', botId: lead.id }, to: { kind: 'bot', workspaceId: 'ws1', botId: dev.id }, kind: 'dispatch', attribution: { originator: { kind: 'human' }, chain: [] }, payload: { title: 'Build it', body: '' } };
    const loose = { ...dispatch, id: 'h-loose', threadId: 'handoff:h-loose' };
    const ask = { ...base, id: 'h-ask', runId: 'run-ask', threadId: 'handoff:h-held', from: { kind: 'bot', workspaceId: 'ws1', botId: dev.id }, to: { kind: 'human' }, kind: 'ask_person', attribution: { originator: { kind: 'bot', workspaceId: 'ws1', botId: dev.id }, chain: [] }, payload: { title: 'Which DB?', body: '' }, status: 'queued', forHop: 'h-held', createdAt: now, updatedAt: now };
    fs.writeFileSync(file, [dispatch, loose, ask].map((x) => JSON.stringify(x)).join('\n') + '\n');
    const h = await harness([lead, dev]);
    expect(h.router.get('h-held')).not.toBeNull();
    expect(h.router.get('h-loose')).toBeNull();
    expect(h.router.get('h-ask')?.forHop).toBe('h-held');
  });
});

describe('a guest workspace is an island (handoffs, mentions, their cards)', () => {
  afterEach(() => __resetGuestWorkspacesForTesting());

  async function island(): Promise<void> {
    const store = new GuestWorkspaceStore({ file: path.join(dir, 'factory', 'guest-workspaces.json'), log: () => undefined });
    store.load();
    await store.add('wsg');
    await store.add('wsh');
    setGuestWorkspaceStore(store);
  }

  const queued = (id: string, from: BotProfile, to: BotProfile, extra: Record<string, unknown> = {}) => JSON.stringify({
    version: 1, id, runId: `run-${id}`, threadId: 'general', depth: 1, hopsInRun: 1,
    from: { kind: 'bot', workspaceId: from.workspaceId, botId: from.id }, to: { kind: 'bot', workspaceId: to.workspaceId, botId: to.id }, kind: 'message',
    attribution: { originator: { kind: 'bot', workspaceId: from.workspaceId, botId: from.id }, chain: [] }, landing: 'wake',
    payload: { title: `title of ${id}`, body: '' }, status: 'queued', createdAt: now, updatedAt: now, ...extra,
  });

  it('a hop either way across the boundary is refused, guest A to guest B too; inside one it is delivered', async () => {
    await island();
    const g = bot('wsg', 'lead');
    const g2 = bot('wsg', 'lead');
    const other = bot('wsh', 'lead');
    const clean = bot('ws1', 'lead');
    const h = await harness([g, g2, other, clean]);
    expect(h.router.send(binding(clean), { kind: 'message', toBotId: g.id, title: 'in', body: '' })).toMatchObject({ ok: false, code: 'no_addressee' });
    expect(h.router.send(binding(g), { kind: 'message', toBotId: clean.id, title: 'out', body: '' })).toMatchObject({ ok: false, code: 'no_addressee' });
    expect(h.router.send(binding(g), { kind: 'message', toBotId: other.id, title: 'across', body: '' })).toMatchObject({ ok: false, code: 'no_addressee' });
    const [m1] = h.router.mention(binding(clean), { id: 'c-1', threadId: 'general' as ThreadId, title: 't', body: '' }, [g.id]);
    const [m2] = h.router.mention(binding(g), { id: 'c-2', threadId: 'general' as ThreadId, title: 't', body: '' }, [clean.id]);
    expect(m1.result).toMatchObject({ ok: false, code: 'no_addressee' });
    expect(m2.result).toMatchObject({ ok: false, code: 'no_addressee' });
    expect(h.wakes).toEqual([]);
    expect(h.router.send(binding(g), { kind: 'message', toBotId: g2.id, title: 'inside', body: '' })).toMatchObject({ ok: true });
    expect(h.wakes.map((w) => w.botId)).toEqual([g2.id]);
  });

  it('a refused hop\'s card is written only in the sender\'s room: nothing crosses', async () => {
    await island();
    const g = bot('wsg', 'lead');
    const clean = bot('ws1', 'lead');
    const h = await harness([g, clean]);
    h.router.send(binding(g), { kind: 'message', toBotId: clean.id, title: 'guest words', body: '' });
    h.router.send(binding(clean), { kind: 'message', toBotId: g.id, title: 'clean words', body: '' });
    const titles = (ws: string) => h.rooms.read(ws, { guests: true }).cards.map((c) => c.title).join('\n');
    expect(titles('wsg')).toContain('guest words');
    expect(titles('wsg')).not.toContain('clean words');
    expect(titles('ws1')).toContain('clean words');
    expect(titles('ws1')).not.toContain('guest words');
  });

  it('a hop stored before a restart, a relay\'s forward or a mention, is refused when it crosses', async () => {
    await island();
    const g = bot('wsg', 'lead');
    const clean = bot('ws1', 'moa', { template: 'coordinator' });
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      queued('h-in', clean, g, { kind: 'dispatch', relay: true }),
      queued('h-out', g, clean),
      queued('h-mention', clean, g, { clientHandoffId: `mention:c-m:${g.id}`, payload: { title: 'x', body: '', refs: { messageId: 'c-m' } } }),
    ].join('\n') + '\n');
    const h = await harness([g, clean]);
    expect(h.wakes).toEqual([]);
    for (const id of ['h-in', 'h-out', 'h-mention']) expect(h.router.get(id)?.status, id).toBe('refused');
  });
});


describe('a room with a coordinator: the owner talks to it, and the work it dispatches comes back to it', () => {
  it('an untagged owner message wakes the coordinator alone; a review it dispatches reports back to it, pointed to from where the owner asked', async () => {
    const coordinator = bot('ws1', 'moa');
    const reviewer = bot('ws1', 'verifier');
    const dev = bot('ws1', 'lead');
    const issue = bot('ws1', 'triage');
    const h = await harness([coordinator, reviewer, dev, issue]);
    const OPERATOR: RpcContext = { origin: 'local', operator: true, firstParty: true };
    const posted = await handleRoomPost({ workspaceId: 'ws1', title: 'Review PR #5 please' }, OPERATOR, { writer: () => h.rooms, ports: () => h.ports, wmuxDir: () => dir }) as { ok: true; card: { id: string } };
    expect(posted.ok).toBe(true);
    expect(h.wakes.map((w) => [w.botId, w.reason.kind === 'human' && w.reason.lead])).toEqual([[coordinator.id, true]]);
    // The coordinator's turn on it dispatches the review.
    h.wake.thread = 'general';
    h.wake.id = { wakeId: 'w-owner', attempt: 1, runId: `run-${posted.card.id}` } as Harness['wake']['id'];
    const d = h.router.send(binding(coordinator), { kind: 'dispatch', toBotId: reviewer.id, title: 'Verify PR #5', body: 'pass or fail at the head', refs: { pr: 5 } });
    if (!d.ok) throw new Error('dispatch failed');
    // The reviewer's verify task wake (the gate recorded) answers the dispatch.
    h.wake.thread = null;
    h.wake.id = { wakeId: 'w-gated', attempt: 1, handoffId: d.handoffId, reasonKind: 'facts' } as Harness['wake']['id'];
    const r = h.router.send(binding(reviewer), { kind: 'result', title: 'PR #5 passes', body: 'gate green at abc1234' });
    expect(r).toMatchObject({ ok: true, to: { botId: coordinator.id } });
    // The result wakes the coordinator, in the dispatch's thread, to report.
    const back = h.wakes.filter((w) => w.botId === coordinator.id && w.reason.kind === 'handoff');
    expect(back).toHaveLength(1);
    expect(back[0].threadId).toBe(h.router.get(d.handoffId)?.threadId);
    // And a pointer to that thread lands in General, under the owner's message.
    const pointer = h.rooms.read('ws1').cards.find((c) => c.threadId === 'general' && c.actor.kind === 'system' && c.refs?.threadId === h.router.get(d.handoffId)?.threadId);
    expect(pointer).toMatchObject({ title: 'Finished: Verify PR #5', replyTo: posted.card.id });
    // Nobody else was woken by the owner's message.
    expect(h.wakes.filter((w) => w.botId !== coordinator.id).map((w) => [w.botId, w.reason.kind])).toEqual([[reviewer.id, 'handoff']]);
  });

  it('an unpicked reply in a thread the group\'s work opened goes to the coordinator as lead and to the bot waiting there; it closes no question elsewhere', async () => {
    const coordinator = bot('ws1', 'moa', { template: 'coordinator' });
    const dev = bot('ws1', 'lead');
    const rev = bot('ws1', 'verifier');
    const h = await harness([coordinator, dev, rev]);
    const GROUP = 'group:grp-0000abcd' as ThreadId;
    h.ports.groups = { byThread: (ws, th) => (ws === 'ws1' && th === GROUP ? { id: 'grp-0000abcd', workspaceId: 'ws1', name: 'Ship', memberIds: [coordinator.id, dev.id, rev.id], threadId: GROUP, createdAt: 1, updatedAt: 1 } : null) };
    const OPERATOR: RpcContext = { origin: 'local', operator: true, firstParty: true };
    const deps = { writer: () => h.rooms, ports: () => h.ports, wmuxDir: () => dir };
    const asked = await handleRoomPost({ workspaceId: 'ws1', threadId: GROUP, title: 'Add a --version flag' }, OPERATOR, deps) as { ok: true; card: { id: string } };
    // The coordinator takes it in the group and opens the work's thread.
    h.wake.thread = GROUP;
    h.wake.id = { wakeId: 'w-lead', attempt: 1, runId: `run-${asked.card.id}` } as Harness['wake']['id'];
    const d = h.router.send(binding(coordinator), { kind: 'dispatch', toBotId: dev.id, title: 'Add the flag', body: 'b' });
    if (!d.ok) throw new Error('dispatch failed');
    await h.router.idle();
    const work = h.router.get(d.handoffId)!.threadId;
    expect(work).toBe(`handoff:${d.handoffId}`);
    const elsewhere = await h.router.askPerson(binding(coordinator), { title: 'Which repo next?', body: '', threadId: 'task:other' });
    // The developer asks the owner a free-text question there.
    h.wake.thread = work;
    h.wake.id = { wakeId: 'w-dev', attempt: 1, handoffId: d.handoffId };
    const q = await h.router.askPerson(binding(dev), { title: 'Which flag name?', body: '' });
    if (!q.ok || !elsewhere.ok) throw new Error('asks failed');
    h.wake.thread = null;
    h.wake.id = null;
    now += 10;
    const before = h.wakes.length;
    const reply = await handleRoomPost({ workspaceId: 'ws1', threadId: work, title: 'Use --version' }, OPERATOR, deps) as { ok: true; card: RoomCard };
    expect(reply.card.refs?.botIds).toEqual([coordinator.id, dev.id]);
    expect(reply.card.routed).toEqual({ lead: coordinator.id, waiting: [dev.id] });
    const woke = h.wakes.slice(before);
    const flags = (w: (typeof woke)[number]) => (w.reason.kind === 'human' ? [w.reason.room, w.reason.lead, w.reason.roomWide] : null);
    expect(woke.map((w) => [w.botId, w.threadId, flags(w)])).toEqual([[coordinator.id, work, [true, true, undefined]], [dev.id, work, [true, undefined, undefined]]]);
    // Typed approval reads the words as the room's (approvals.ts onFact).
    const replyFacts = h.facts.filter((f) => f.kind === 'human.message' && f.payload?.cardId === reply.card.id);
    expect(replyFacts.map((f) => [f.ref?.botId, f.payload?.lead])).toEqual([[coordinator.id, true], [dev.id, true]]);
    // The developer's question there is answered; the coordinator's question
    // in another thread stays open.
    const item = (w: (typeof woke)[number]) => ({ reason: w.reason, workspaceId: w.workspaceId, threadId: w.threadId, enqueuedAt: now });
    expect(await h.router.closeAnsweredInChat(coordinator.id, item(woke[0]))).toEqual([]);
    expect(await h.router.closeAnsweredInChat(dev.id, item(woke[1]))).toEqual([q.handoffId]);
    expect(h.router.get(elsewhere.handoffId)?.status).toBe('delivered');
    expect(h.wakes.some((w) => w.botId === rev.id)).toBe(false);
  });
});
