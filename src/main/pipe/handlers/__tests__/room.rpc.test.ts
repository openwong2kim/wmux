import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotBinding, BotProfile, BotRole } from '../../../../shared/bot';
import type { Fact, FactDraft } from '../../../../shared/facts';
import type { RpcContext } from '../../../../shared/rpc';
import type { WakeItem } from '../../../../shared/wake';
import { ROOM_LIMITS, type RoomCard, type ThreadId } from '../../../../shared/room';

const ROOM_TITLE_MAX = ROOM_LIMITS.TITLE_MAX;
const ROOM_BODY_MAX = ROOM_LIMITS.CARD_BODY_MAX;
import { loadThreadDecision } from '../../../deck/deckDecisionStore';
import { HANDOFFS_FILENAME, HandoffRouter, deckDecisionPort, invitesFreeText, setHandoffRouter } from '../../../factory/handoffRouter';
import { RoomWriter, type FactoryRoomPorts } from '../../../factory/roomWriter';
import { humanAddressees, humanCardIdOfRun, humanRunId, postHumanMessage } from '../../../factory/humanMessage';
import { GuestWorkspaceStore, __resetGuestWorkspacesForTesting, setGuestWorkspaceStore } from '../../../factory/guestWorkspaces';
import { islandRooms, writeFactCards } from '../../../factory/roomWriter';
import { routePlanAnswer } from '../../../factory/morningReport';
import { __resetRedactedSecretsForTesting, setRedactedSecrets } from '../../../factory/secretRedaction';
import { botSeesFact } from '../../../factory/triggerEngine';
import {
  createRoomModule,
  handleRoomPost,
  handleRoomRead,
  handleRoomResolve,
  handleRoomSearch,
  handleRoomThreads,
  humanAddressee,
  onRoomCardResolved,
  postTurnText,
  resolutionCorrection,
  settleMentions,
  type RoomHandlerDeps,
} from '../room.rpc';
import { handleAskPerson, handleHandoffAnswer, handleHandoffList, handleHandoffSend, handleQuestionClose } from '../handoff.rpc';

let dir = '';
let botN = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp5-roomrpc-'));
});

afterEach(() => {
  setHandoffRouter(null);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function bot(ws: string, role: BotRole, extra: Partial<BotProfile> = {}): BotProfile {
  botN += 1;
  return {
    version: 1, id: `bot-${botN.toString(16).padStart(8, '0')}`, workspaceId: ws, role, name: role, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 },
    enabled: true, createdAt: botN, updatedAt: botN, ...extra,
  };
}

const asBot = (b: BotProfile): RpcContext => ({ origin: 'local', bot: { workspaceId: b.workspaceId, botId: b.id, role: b.role } as BotBinding });
const OPERATOR: RpcContext = { origin: 'local', operator: true, firstParty: true };
const WIRE: RpcContext = { origin: 'local', externalWire: true };

function setup(bots: BotProfile[]) {
  const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), log: () => undefined });
  const facts: Fact[] = [];
  const wakes: Array<Parameters<FactoryRoomPorts['wakes']['enqueue']>[0]> = [];
  const wake: { thread: string | null; id: { wakeId: string; attempt: number; handoffId?: string } | null } = { thread: null, id: null };
  const ports: Partial<FactoryRoomPorts> = {
    factLog: {
      append: (d: FactDraft) => {
        const f = { ...d, id: `f-${facts.length + 1}`, seq: facts.length + 1, dedupeKey: String(facts.length) } as Fact;
        facts.push(f);
        return f;
      },
      subscribe: () => () => undefined,
      readSince: () => ({ facts: [], cursor: null }),
    },
    // Like the wake queue: a human message's clientMessageId is queued once per bot.
    wakes: {
      enqueue: (i) => {
        const key = i.reason.kind === 'human' ? i.reason.clientMessageId : undefined;
        const prior = key ? wakes.findIndex((w) => w.botId === i.botId && w.reason.kind === 'human' && w.reason.clientMessageId === key) : -1;
        if (prior >= 0) return { id: `w-${prior + 1}`, ...wakes[prior] } as WakeItem;
        wakes.push(i);
        return { id: `w-${wakes.length}`, ...i } as WakeItem;
      },
    },
    bots: { listEnabled: () => bots.filter((b) => b.enabled), get: (id) => bots.find((b) => b.id === id) ?? null },
    currentWakeThread: () => wake.thread as never,
    currentWake: () => wake.id,
  };
  const deps: RoomHandlerDeps = { writer: () => writer, ports: () => ports, wmuxDir: () => dir, signedIn: () => false };
  return { writer, facts, wakes, wake, ports, deps };
}

describe('room.post', () => {
  it('refuses a caller that is neither a bot nor the operator', async () => {
    const s = setup([]);
    expect(await handleRoomPost({ kind: 'status', title: 'x' }, WIRE, s.deps)).toMatchObject({ ok: false, code: 'not_bot' });
    expect(await handleRoomPost({ kind: 'status', title: 'x' }, undefined, s.deps)).toMatchObject({ ok: false, code: 'not_bot' });
    expect(s.writer.read('ws1').cards).toEqual([]);
  });

  it('answers not_started before the room module started', async () => {
    const s = setup([]);
    expect(await handleRoomPost({ kind: 'status', title: 'x' }, OPERATOR, { ...s.deps, writer: () => null })).toMatchObject({ ok: false, code: 'not_started' });
  });

  it('a post cannot set the owner\'s request a thread answers (main\'s ref only)', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    const r = await handleRoomPost({ kind: 'status', title: 'x', workspaceId: 'ws1', refs: { requestCardId: 'c-1', pr: 3 } }, asBot(lead), s.deps) as { ok: true; card: { refs?: Record<string, unknown> } };
    expect(r.card.refs).toEqual({ pr: 3 });
  });

  it('a bot posts only its output kinds, into its own room, as itself', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    const r = await handleRoomPost({ kind: 'status', title: 'Working on #3', workspaceId: 'ws1' }, asBot(lead), s.deps) as { ok: true; card: { actor: unknown; workspaceId: string; threadId: string } };
    expect(r).toMatchObject({ ok: true, card: { workspaceId: 'ws1', threadId: 'general', actor: { kind: 'bot', workspaceId: 'ws1', botId: lead.id } } });
    for (const kind of ['human', 'question', 'fact', 'refusal', 'budget', 'login_request', 'secret_request']) {
      expect(await handleRoomPost({ kind, title: 'x' }, asBot(lead), s.deps), kind).toMatchObject({ ok: false, code: 'card_kind' });
    }
    expect(await handleRoomPost({ kind: 'status', title: 'x', workspaceId: 'ws2' }, asBot(lead), s.deps)).toMatchObject({ ok: false, code: 'cross_workspace' });
    const moa = bot('hq', 'moa');
    expect(await handleRoomPost({ kind: 'opinion', title: 'x', workspaceId: 'ws1' }, asBot(moa), s.deps)).toMatchObject({ ok: false, code: 'cross_workspace' });
    expect(s.writer.read('ws2').cards).toEqual([]);
  });

  it('a bot post without a thread lands in its running wake\'s thread; a retried turn writes nothing twice', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    s.wake.thread = 'issue:github.com/acme/app#7';
    s.wake.id = { wakeId: 'w-room-1', attempt: 1 };
    const a = await handleRoomPost({ kind: 'triage', title: 'repro' }, asBot(lead), s.deps);
    expect(a).toMatchObject({ ok: true, card: { threadId: 'issue:github.com/acme/app#7', clientPostId: 'wake:w-room-1:1' } });
    s.wake.id = { wakeId: 'w-room-1', attempt: 2 };
    const again = await handleRoomPost({ kind: 'triage', title: 'repro' }, asBot(lead), s.deps);
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(s.writer.read('ws1').cards).toHaveLength(1);
    expect(await handleRoomPost({ kind: 'status', title: 'g', threadId: 'general' }, asBot(lead), s.deps)).toMatchObject({ card: { threadId: 'general' } });
  });

  it('naming a bot in a card wakes nobody', async () => {
    const lead = bot('ws1', 'lead');
    const verifier = bot('ws1', 'verifier');
    const s = setup([lead, verifier]);
    await handleRoomPost({ kind: 'status', title: '@verifier please check', body: '@lead @moa Verifier finished' }, asBot(lead), s.deps);
    expect(s.wakes).toEqual([]);
    // Addressed to the lead, a named verifier is just text.
    await handleRoomPost({ workspaceId: 'ws1', kind: 'human', title: '@verifier look at this', to: 'lead' }, OPERATOR, s.deps);
    expect(s.wakes.map((w) => w.botId)).toEqual([lead.id]);
    // To the room, the text does not narrow it: every bot of the room is woken.
    await handleRoomPost({ workspaceId: 'ws1', kind: 'human', title: '@verifier only you' }, OPERATOR, s.deps);
    expect(s.wakes.map((w) => w.botId)).toEqual([lead.id, lead.id, verifier.id]);
    expect(s.facts.map((f) => f.kind)).toEqual(['human.message', 'human.message', 'human.message']);
  });

  it('the owner posts to the room: one card, a directed fact and a priority-0 wake per bot of the room, one run', async () => {
    const lead = bot('ws1', 'lead');
    const verifier = bot('ws1', 'verifier');
    const moa = bot('hq', 'moa');
    const s = setup([lead, verifier, moa]);
    const r = await handleRoomPost({ workspaceId: 'ws1', title: 'Please look at #5', clientPostId: 'cm-1' }, OPERATOR, s.deps) as { card: { id: string; refs?: Record<string, unknown> } };
    expect(r).toMatchObject({
      ok: true,
      card: { kind: 'human', actor: { kind: 'human' } },
      addressee: { botId: lead.id, role: 'lead' },
      addressees: [{ botId: lead.id, role: 'lead', wakeId: 'w-1' }, { botId: verifier.id, role: 'verifier', wakeId: 'w-2' }],
    });
    expect(r.card.refs).toEqual({ botIds: [lead.id, verifier.id] });
    expect(s.facts).toHaveLength(2);
    const f = s.facts[0];
    expect(f).toMatchObject({ kind: 'human.message', workspaceId: 'ws1', ref: { botId: lead.id, messageId: `${r.card.id}:${lead.id}` }, actor: { kind: 'human' }, payload: { cardId: r.card.id } });
    expect(botSeesFact(lead, f)).toBe(true);
    expect(botSeesFact(verifier, f)).toBe(false);
    const runId = `run-${r.card.id}`;
    expect(s.wakes).toEqual([lead, verifier].map((b) => ({
      botId: b.id, workspaceId: 'ws1',
      reason: { kind: 'human', text: 'Please look at #5', source: 'desktop', clientMessageId: r.card.id, runId, room: true, roomWide: true, roomAnswerer: lead.id },
      priority: 0, threadId: 'general', overCap: true,
    })));
    // Same client id: the same card, no second fact or wake.
    expect(await handleRoomPost({ workspaceId: 'ws1', title: 'Please look at #5', clientPostId: 'cm-1' }, OPERATOR, s.deps)).toMatchObject({ ok: true, duplicate: true });
    expect(s.wakes).toHaveLength(2);
    expect(s.facts).toHaveLength(2);
    // `to` addresses another role; moa is the HQ bot wherever it lives.
    expect(await handleRoomPost({ workspaceId: 'ws1', title: 'check', to: 'verifier' }, OPERATOR, s.deps)).toMatchObject({ addressee: { botId: verifier.id } });
    expect(await handleRoomPost({ workspaceId: 'ws1', title: 'opinion?', to: 'moa' }, OPERATOR, s.deps)).toMatchObject({ addressee: { botId: moa.id } });
    expect(await handleRoomPost({ workspaceId: 'ws1', title: 'x', to: 'boss' }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handleRoomPost({ workspaceId: 'ws1', title: 'x', kind: 'status' }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'card_kind' });
    expect(await handleRoomPost({ title: 'x' }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('the owner hears "sent" once the wakes are on disk; a failed write is a retryable refusal', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    let fail = true;
    let flushed = 0;
    const wakes = s.ports.wakes as FactoryRoomPorts['wakes'];
    s.ports.wakes = { enqueue: (i) => wakes.enqueue(i), flush: async () => { flushed++; if (fail) throw new Error('disk full'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = await handleRoomPost({ workspaceId: 'ws1', title: 'Ship it', clientPostId: 'cm-9' }, OPERATOR, s.deps);
    warn.mockRestore();
    expect(first).toMatchObject({ ok: false, code: 'write_failed', card: { kind: 'human' } });
    fail = false;
    expect(await handleRoomPost({ workspaceId: 'ws1', title: 'Ship it', clientPostId: 'cm-9' }, OPERATOR, s.deps)).toMatchObject({ ok: true, duplicate: true });
    expect(flushed).toBe(2);
    expect(s.wakes).toHaveLength(1);
    expect(s.writer.read('ws1').cards).toHaveLength(1);
  });

  it('the owner\'s mentions wake only those bots, in any workspace; one mention is a 1:1 (refs.botId)', async () => {
    const lead = bot('ws1', 'lead');
    const verifier = bot('ws1', 'verifier');
    const moa = bot('hq', 'moa');
    const off = bot('ws1', 'triage', { enabled: false });
    const s = setup([lead, verifier, moa, off]);
    const one = await handleRoomPost({ workspaceId: 'ws1', title: 'you only', mentions: [verifier.id] }, OPERATOR, s.deps) as { card: { refs?: Record<string, unknown> } };
    expect(one).toMatchObject({ ok: true, addressee: { botId: verifier.id }, addressees: [{ botId: verifier.id }] });
    expect(one.card.refs).toEqual({ botIds: [verifier.id], botId: verifier.id });
    expect(s.wakes.map((w) => [w.botId, w.reason.kind === 'human' && w.reason.room])).toEqual([[verifier.id, undefined]]);
    // Several, across workspaces; a disabled or unknown bot is left out.
    const two = await handleRoomPost({ workspaceId: 'ws1', title: 'you two', mentions: [moa.id, off.id, 'bot-0badf00d', lead.id] }, OPERATOR, s.deps) as { card: { refs?: Record<string, unknown> } };
    expect(two.card.refs).toEqual({ botIds: [moa.id, lead.id] });
    expect(s.wakes.slice(1).map((w) => [w.botId, w.workspaceId])).toEqual([[moa.id, 'hq'], [lead.id, 'ws1']]);
    // A forged addressee in refs is never kept.
    const forged = await handleRoomPost({ workspaceId: 'ws1', title: 'x', mentions: [lead.id], refs: { botIds: [verifier.id], botId: verifier.id } }, OPERATOR, s.deps) as { card: { refs?: Record<string, unknown> } };
    expect(forged.card.refs).toEqual({ botIds: [lead.id], botId: lead.id });
    // Malformed mentions are refused before anything is written.
    for (const mentions of ['bot-00000001', ['nope'], Array.from({ length: 17 }, (_, i) => `bot-${String(i).padStart(8, '0')}`)]) {
      expect(await handleRoomPost({ workspaceId: 'ws1', title: 'bad', mentions }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    }
  });

  it('a partly full queue answers queue_full per addressee; the same clientPostId queues only the missing wake', async () => {
    const lead = bot('ws1', 'lead');
    const verifier = bot('ws1', 'verifier');
    const s = setup([lead, verifier]);
    const full = new Set([verifier.id]);
    const enqueue = s.ports.wakes!.enqueue;
    s.ports.wakes = { enqueue: (i) => (full.has(i.botId) ? null : enqueue(i)) };
    const r = await handleRoomPost({ workspaceId: 'ws1', title: 'Hi', clientPostId: 'cm-full' }, OPERATOR, s.deps);
    expect(r).toMatchObject({ ok: false, code: 'queue_full', addressees: [{ botId: lead.id, wakeId: 'w-1' }, { botId: verifier.id }] });
    expect((r as { addressees: Array<{ wakeId?: string }> }).addressees[1].wakeId).toBeUndefined();
    full.clear();
    const retry = await handleRoomPost({ workspaceId: 'ws1', title: 'Hi', clientPostId: 'cm-full' }, OPERATOR, s.deps);
    expect(retry).toMatchObject({ ok: true, duplicate: true, addressees: [{ botId: lead.id, wakeId: 'w-1' }, { botId: verifier.id, wakeId: 'w-2' }] });
    expect(s.wakes.map((w) => w.botId)).toEqual([lead.id, verifier.id]);
    expect(s.writer.read('ws1').cards).toHaveLength(1);
  });

  it('a room message keeps its addressees and mode on a retry, whatever the room has become; a room with a coordinator talks to it alone', async () => {
    const dev = bot('ws1', 'lead');
    const issue = bot('ws1', 'triage');
    const bots = [dev, issue];
    const s = setup(bots);
    const full = new Set([issue.id]);
    const enqueue = s.ports.wakes!.enqueue;
    s.ports.wakes = { enqueue: (i) => (full.has(i.botId) ? null : enqueue(i)) };
    expect(await handleRoomPost({ workspaceId: 'ws1', title: 'Hi', clientPostId: 'cm-mode' }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'queue_full' });
    // A bot joins before the retry: the first card still names its two, and
    // the retry wakes them as the room's bots whatever it names itself.
    bots.push(bot('ws1', 'moa', { template: 'coordinator' }));
    full.clear();
    expect(await handleRoomPost({ workspaceId: 'ws1', title: 'Hi', clientPostId: 'cm-mode', mentions: [issue.id] }, OPERATOR, s.deps)).toMatchObject({ ok: true, duplicate: true, card: { routed: {} } });
    const flags = (w: (typeof s.wakes)[number]) => (w.reason.kind === 'human' ? [w.reason.room, w.reason.roomWide, w.reason.lead] : null);
    expect(s.wakes.map((w) => [w.botId, flags(w)])).toEqual([[dev.id, [true, true, undefined]], [issue.id, [true, true, undefined]]]);
    // An untagged message in a room with a coordinator wakes the coordinator
    // alone, as the room's lead; the fact says the words were the room's.
    const coordinator = bots[2];
    const next = await handleRoomPost({ workspaceId: 'ws1', title: 'Next task', clientPostId: 'cm-lead' }, OPERATOR, s.deps) as { card: RoomCard };
    expect(next).toMatchObject({ ok: true, addressees: [{ botId: coordinator.id }], card: { refs: { botIds: [coordinator.id], botId: coordinator.id } } });
    expect(s.wakes.slice(2).map((w) => [w.botId, flags(w)])).toEqual([[coordinator.id, [undefined, undefined, true]]]);
    expect(s.facts.at(-1)).toMatchObject({ ref: { botId: coordinator.id }, payload: { lead: true } });
    expect(next.card.routed).toEqual({ lead: coordinator.id });
    // Its retry is the coordinator's again, as its card recorded, even with
    // other fields and a template changed since.
    full.add(coordinator.id);
    expect(await handleRoomPost({ workspaceId: 'ws1', title: 'Again', clientPostId: 'cm-lead-2' }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'queue_full' });
    full.clear();
    coordinator.template = 'developer';
    expect(await handleRoomPost({ workspaceId: 'ws1', title: 'Again', clientPostId: 'cm-lead-2', mentions: [dev.id] }, OPERATOR, s.deps)).toMatchObject({ ok: true, duplicate: true });
    coordinator.template = 'coordinator';
    expect(s.wakes.slice(3).map((w) => [w.botId, flags(w)])).toEqual([[coordinator.id, [undefined, undefined, true]]]);
    // Mentions still wake exactly the bots named, the coordinator left out;
    // the card records no routing.
    const named = await handleRoomPost({ workspaceId: 'ws1', title: 'You two', mentions: [dev.id, issue.id] }, OPERATOR, s.deps) as { card: RoomCard };
    expect(named.card.routed).toBeUndefined();
    expect(s.wakes.slice(4).map((w) => [w.botId, flags(w)])).toEqual([[dev.id, [true, undefined, undefined]], [issue.id, [true, undefined, undefined]]]);
  });

  it('humanAddressees: mentions win, then the phone\'s toBotId (enabled only), then the role, else the whole room', () => {
    const lead = bot('ws1', 'lead');
    const verifier = bot('ws1', 'verifier');
    const off = bot('ws1', 'triage', { enabled: false });
    const ports = { listEnabled: () => [lead, verifier, off] } as unknown as FactoryRoomPorts['bots'];
    expect(humanAddressees(ports, 'ws1', { mentions: [verifier.id], toBotId: lead.id })).toEqual({ bots: [verifier], room: false });
    expect(humanAddressees(ports, 'ws1', { toBotId: verifier.id, to: 'lead' })).toEqual({ bots: [verifier], room: false });
    expect(humanAddressees(ports, 'ws1', { toBotId: off.id })).toEqual({ bots: [], room: false });
    expect(humanAddressees(ports, 'ws1', { to: 'lead' })).toEqual({ bots: [lead], room: false });
    expect(humanAddressees(ports, 'ws1', {})).toEqual({ bots: [lead, verifier], room: true });
    // A room message reaches at most MENTIONS_MAX bots, the oldest: the card
    // can name them all, so a retry reaches the same ones.
    const many = Array.from({ length: 17 }, () => bot('ws3', 'lead'));
    const room = humanAddressees({ listEnabled: () => [...many].reverse() } as unknown as FactoryRoomPorts['bots'], 'ws3', {});
    expect(room.bots.map((b) => b.id)).toEqual(many.slice(0, 16).map((b) => b.id));
  });

  it('humanAddressees: an unnamed message goes to the room\'s (the group\'s) oldest coordinator; members bound it, at most MENTIONS_MAX', () => {
    const dev = bot('ws1', 'lead', { createdAt: 1 });
    const lead = bot('ws1', 'lead', { template: 'coordinator', createdAt: 2 });
    const younger = bot('ws1', 'moa', { createdAt: 3 });
    const far = bot('ws2', 'moa', { createdAt: 0 });
    const issue = bot('ws1', 'triage', { createdAt: 4 });
    const ports = { listEnabled: () => [far, younger, dev, lead, issue] } as unknown as FactoryRoomPorts['bots'];
    expect(humanAddressees(ports, 'ws1', {})).toEqual({ bots: [lead], room: false, lead: true });
    expect(humanAddressees(ports, 'ws1', { members: [younger.id, issue.id, far.id] })).toEqual({ bots: [younger], room: false, lead: true });
    // A group without a coordinator: every member.
    expect(humanAddressees(ports, 'ws1', { members: [dev.id, issue.id, far.id] })).toEqual({ bots: [dev, issue], room: true });
    // Mentions win over the coordinator.
    expect(humanAddressees(ports, 'ws1', { mentions: [dev.id, issue.id] })).toEqual({ bots: [dev, issue], room: false });
    expect(humanAddressees(ports, 'ws1', { mentions: [dev.id], members: [lead.id] })).toEqual({ bots: [dev], room: false });
    const many = Array.from({ length: 17 }, () => bot('ws3', 'lead'));
    const group = humanAddressees({ listEnabled: () => [...many].reverse() } as unknown as FactoryRoomPorts['bots'], 'ws3', { members: many.map((b) => b.id) });
    expect(group.bots.map((b) => b.id)).toEqual(many.slice(0, 16).map((b) => b.id));
  });

  it('humanAddressees: a coordinator that is off or parked (by the owner, or for an error) is no lead; a budget park still is; a lone coordinator is its room\'s lead', () => {
    const dev = bot('ws1', 'lead', { createdAt: 1 });
    const issue = bot('ws1', 'triage', { createdAt: 2 });
    const lead = bot('ws1', 'moa', { template: 'coordinator', createdAt: 3 });
    const ports = { listEnabled: () => [dev, issue, lead] } as unknown as FactoryRoomPorts['bots'];
    expect(humanAddressees(ports, 'ws1', {})).toEqual({ bots: [lead], room: false, lead: true });
    for (const reason of ['human', 'error'] as const) {
      lead.parked = { reason, at: 1 };
      expect(humanAddressees(ports, 'ws1', {}), reason).toEqual({ bots: [dev, issue, lead], room: true });
    }
    lead.parked = { reason: 'budget', at: 1 };
    expect(humanAddressees(ports, 'ws1', {})).toEqual({ bots: [lead], room: false, lead: true });
    delete lead.parked;
    lead.enabled = false;
    expect(humanAddressees(ports, 'ws1', {})).toEqual({ bots: [dev, issue], room: true });
    lead.enabled = true;
    // Its room holds only it.
    const alone = { listEnabled: () => [lead] } as unknown as FactoryRoomPorts['bots'];
    expect(humanAddressees(alone, 'ws1', {})).toEqual({ bots: [lead], room: false, lead: true });
    // The bots waiting on the owner follow the lead, oldest first.
    expect(humanAddressees(ports, 'ws1', { waiting: [issue.id, dev.id] })).toEqual({ bots: [lead, dev, issue], room: false, lead: true });
  });

  it('an unpicked message reaches a bot waiting on the owner in its thread as addressed; the room\'s first bot answers a room-wide one', async () => {
    const dev = bot('ws1', 'lead', { createdAt: 1 });
    const issue = bot('ws1', 'triage', { createdAt: 2 });
    const lead = bot('ws1', 'moa', { template: 'coordinator', createdAt: 3 });
    const bots = [dev, issue, lead];
    const s = setup(bots);
    const flags = (w: (typeof s.wakes)[number]) => (w.reason.kind === 'human' ? [w.reason.room, w.reason.lead, w.reason.roomWide, w.reason.roomAnswerer] : null);
    // The issue bot asked the owner something in General.
    s.writer.post({ workspaceId: 'ws1', kind: 'question', actor: { kind: 'bot', workspaceId: 'ws1', botId: issue.id }, title: 'Which label?', state: 'open' });
    const r = await handleRoomPost({ workspaceId: 'ws1', title: 'bug' }, OPERATOR, s.deps) as { card: RoomCard };
    expect(r.card.routed).toEqual({ lead: lead.id, waiting: [issue.id] });
    expect(s.wakes.map((w) => [w.botId, flags(w)])).toEqual([[lead.id, [true, true, undefined, undefined]], [issue.id, [true, undefined, undefined, undefined]]]);
    // A parked coordinator: every bot, the waiting one (asked again since
    // the owner last spoke) first and as addressed, the others room-wide
    // with the first one not waiting that takes turns as the answerer.
    lead.parked = { reason: 'human', at: 1 };
    s.writer.post({ workspaceId: 'ws1', kind: 'question', actor: { kind: 'bot', workspaceId: 'ws1', botId: issue.id }, title: 'And the milestone?', state: 'open' });
    const wide = await handleRoomPost({ workspaceId: 'ws1', title: 'anyone?' }, OPERATOR, s.deps) as { card: RoomCard };
    expect(wide.card.refs?.botIds).toEqual([issue.id, dev.id, lead.id]);
    expect(wide.card.routed).toEqual({ waiting: [issue.id], answerer: dev.id });
    expect(s.wakes.slice(2).map((w) => [w.botId, flags(w)])).toEqual([
      [issue.id, [true, undefined, undefined, undefined]],
      [dev.id, [true, undefined, true, dev.id]],
      [lead.id, [true, undefined, true, dev.id]],
    ]);
    // Words since then answered it: a wait older than the owner's previous
    // message in the thread keeps nobody waiting.
    const later = await handleRoomPost({ workspaceId: 'ws1', title: 'ok, thanks' }, OPERATOR, s.deps) as { card: RoomCard };
    expect(later.card.routed).toEqual({ answerer: dev.id });
    // An open approval card waits only until the owner next speaks there.
    s.writer.post({ workspaceId: 'ws1', kind: 'approval', actor: { kind: 'bot', workspaceId: 'ws1', botId: issue.id }, title: 'Close issue #3', state: 'open' });
    expect((await handleRoomPost({ workspaceId: 'ws1', title: 'approve' }, OPERATOR, s.deps) as { card: RoomCard }).card.routed).toEqual({ waiting: [issue.id], answerer: dev.id });
    expect((await handleRoomPost({ workspaceId: 'ws1', title: 'next thing' }, OPERATOR, s.deps) as { card: RoomCard }).card.routed).toEqual({ answerer: dev.id });
  });

  it('a parked coordinator that is the room\'s oldest bot is not its answerer, also on a retry', async () => {
    const lead = bot('ws1', 'moa', { template: 'coordinator', createdAt: 1, parked: { reason: 'human', at: 1 } });
    const dev = bot('ws1', 'lead', { createdAt: 2 });
    const issue = bot('ws1', 'triage', { createdAt: 3 });
    const s = setup([lead, dev, issue]);
    const full = new Set([issue.id]);
    const enqueue = s.ports.wakes!.enqueue;
    s.ports.wakes = { enqueue: (i) => (full.has(i.botId) ? null : enqueue(i)) };
    const r = await handleRoomPost({ workspaceId: 'ws1', title: 'Hi', clientPostId: 'cm-ans' }, OPERATOR, s.deps) as { card: RoomCard };
    expect(r.card.refs?.botIds).toEqual([lead.id, dev.id, issue.id]);
    expect(r.card.routed).toEqual({ answerer: dev.id });
    full.clear();
    // The developer is parked before the retry: the answerer stays as recorded.
    dev.parked = { reason: 'human', at: 2 };
    await handleRoomPost({ workspaceId: 'ws1', title: 'Hi', clientPostId: 'cm-ans' }, OPERATOR, s.deps);
    expect(s.wakes.map((w) => [w.botId, w.reason.kind === 'human' && w.reason.roomAnswerer])).toEqual([[lead.id, dev.id], [dev.id, dev.id], [issue.id, dev.id]]);
  });

  it('a bot outside General\'s group that asked the owner in a PR thread hears the unpicked reply there', async () => {
    const lead = bot('ws1', 'moa', { template: 'coordinator', createdAt: 1 });
    const dev = bot('ws1', 'lead', { createdAt: 2 });
    const rev = bot('ws1', 'verifier', { createdAt: 3 });
    const s = setup([lead, dev, rev]);
    s.ports.groups = { byThread: (ws, t) => (ws === 'ws1' && t === 'general' ? { id: 'grp-0000beef', workspaceId: 'ws1', name: '', memberIds: [lead.id, dev.id], threadId: 'general', createdAt: 1, updatedAt: 1 } : null) };
    const PR = 'pr:github.com/acme/app#42' as ThreadId;
    s.writer.post({ workspaceId: 'ws1', threadId: PR, kind: 'question', actor: { kind: 'bot', workspaceId: 'ws1', botId: rev.id }, title: 'Verify at the new head too?', state: 'open' });
    const r = await handleRoomPost({ workspaceId: 'ws1', threadId: PR, title: 'Yes, the new head' }, OPERATOR, s.deps) as { card: RoomCard };
    expect(r.card.routed).toEqual({ lead: lead.id, waiting: [rev.id] });
    expect(s.wakes.map((w) => [w.botId, w.threadId])).toEqual([[lead.id, PR], [rev.id, PR]]);
    // Without a coordinator in the group, the waiting bot comes first, as
    // addressed, then the group's bots.
    lead.enabled = false;
    s.writer.post({ workspaceId: 'ws1', threadId: PR, kind: 'question', actor: { kind: 'bot', workspaceId: 'ws1', botId: rev.id }, title: 'And the old one?', state: 'open' });
    const wide = await handleRoomPost({ workspaceId: 'ws1', threadId: PR, title: 'No' }, OPERATOR, s.deps) as { card: RoomCard };
    expect(wide.card.refs?.botIds).toEqual([rev.id, dev.id]);
    expect(wide.card.routed).toEqual({ waiting: [rev.id], answerer: dev.id });
  });

  it('humanAddressees: waiting bots come first, before the mention cap cuts the room', () => {
    const many = Array.from({ length: 17 }, (_, i) => bot('ws4', 'lead', { createdAt: i }));
    const late = many[16];
    const ports = { listEnabled: () => many } as unknown as FactoryRoomPorts['bots'];
    const room = humanAddressees(ports, 'ws4', { waiting: [late.id] });
    expect(room.bots).toHaveLength(ROOM_LIMITS.MENTIONS_MAX);
    expect(room.bots[0]).toBe(late);
  });

  describe('a group chat\'s thread (owner decision 2026-10-15)', () => {
    const GROUP = 'group:grp-0000aaaa' as ThreadId;
    function withGroup(bots: BotProfile[], memberIds: string[], threadId: ThreadId = GROUP) {
      const s = setup(bots);
      const live = { on: true };
      s.ports.groups = {
        byThread: (ws, t) => (live.on && ws === 'ws1' && t === threadId
          ? { id: 'grp-0000aaaa', workspaceId: 'ws1', name: 'Ship', memberIds, threadId, createdAt: 1, updatedAt: 1 }
          : null),
      };
      return { ...s, live };
    }

    it('an untagged message goes to every enabled member, pinned to the group; others in the workspace sleep', async () => {
      const a = bot('ws1', 'lead', { createdAt: 1 });
      const b = bot('ws1', 'verifier', { createdAt: 2 });
      const c = bot('ws1', 'triage', { template: 'coordinator', createdAt: 3 });
      const off = bot('ws1', 'maintainer', { enabled: false, createdAt: 4 });
      const s = withGroup([a, b, c, off], [b.id, a.id, off.id]);
      const r = await handleRoomPost({ workspaceId: 'ws1', threadId: GROUP, title: 'Hi all' }, OPERATOR, s.deps) as { ok: boolean; card: RoomCard };
      expect(r).toMatchObject({ ok: true, card: { threadId: GROUP, refs: { botIds: [a.id, b.id] } } });
      expect(r.card.refs?.botId).toBeUndefined();
      expect(s.wakes.map((w) => [w.botId, w.threadId, w.reason.kind === 'human' && w.reason.room, w.reason.kind === 'human' && w.reason.roomWide])).toEqual([[a.id, GROUP, true, true], [b.id, GROUP, true, true]]);
      expect(s.facts.map((f) => f.ref?.botId)).toEqual([a.id, b.id]);
    });

    it('in a group with a coordinator, an untagged message goes to it alone; picked bots get exactly theirs', async () => {
      const a = bot('ws1', 'lead', { createdAt: 1 });
      const b = bot('ws1', 'verifier', { template: 'coordinator', createdAt: 2 });
      const c = bot('ws1', 'triage', { createdAt: 3 });
      const s = withGroup([a, b, c], [a.id, b.id, c.id]);
      const r = await handleRoomPost({ workspaceId: 'ws1', threadId: GROUP, title: 'Review PR 5' }, OPERATOR, s.deps) as { ok: boolean; card: RoomCard };
      expect(r).toMatchObject({ ok: true, card: { threadId: GROUP, refs: { botIds: [b.id], botId: b.id } } });
      expect(s.wakes.map((w) => [w.botId, w.threadId, w.reason.kind === 'human' && w.reason.lead, w.reason.kind === 'human' && w.reason.roomWide])).toEqual([[b.id, GROUP, true, undefined]]);
      expect(s.facts.map((f) => f.ref?.botId)).toEqual([b.id]);
      await handleRoomPost({ workspaceId: 'ws1', threadId: GROUP, title: 'You two', mentions: [a.id, c.id] }, OPERATOR, s.deps);
      expect(s.wakes.slice(1).map((w) => [w.botId, w.reason.kind === 'human' && w.reason.lead])).toEqual([[a.id, undefined], [c.id, undefined]]);
    });

    it('picked (or typed @) bots only; a bot outside the group is refused; a deleted group takes no post', async () => {
      const a = bot('ws1', 'lead', { createdAt: 1 });
      const b = bot('ws1', 'verifier', { createdAt: 2 });
      const c = bot('ws1', 'triage', { createdAt: 3 });
      const s = withGroup([a, b, c], [a.id, b.id]);
      expect(await handleRoomPost({ workspaceId: 'ws1', threadId: GROUP, title: 'B only', mentions: [b.id] }, OPERATOR, s.deps)).toMatchObject({ ok: true, card: { refs: { botId: b.id, botIds: [b.id] } } });
      expect(s.wakes.map((w) => [w.botId, w.reason.kind === 'human' && w.reason.room])).toEqual([[b.id, undefined]]);
      expect(await handleRoomPost({ workspaceId: 'ws1', threadId: GROUP, title: 'C?', mentions: [a.id, c.id] }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
      s.live.on = false;
      expect(await handleRoomPost({ workspaceId: 'ws1', threadId: GROUP, title: 'gone' }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
      expect(s.wakes).toHaveLength(1);
    });

    it('a group made from the room lives on in General: an untagged message there goes to its members', async () => {
      const a = bot('ws1', 'lead', { createdAt: 1 });
      const b = bot('ws1', 'verifier', { createdAt: 2 });
      const late = bot('ws1', 'triage', { createdAt: 3 });
      const s = withGroup([a, b, late], [a.id, b.id], 'general');
      await handleRoomPost({ workspaceId: 'ws1', title: 'Hi' }, OPERATOR, s.deps);
      expect(s.wakes.map((w) => w.botId)).toEqual([a.id, b.id]);
      // A post that names its bot by role still reaches that bot alone.
      await handleRoomPost({ workspaceId: 'ws1', title: 'Verifier?', to: 'verifier' }, OPERATOR, s.deps);
      expect(s.wakes.slice(2).map((w) => w.botId)).toEqual([b.id]);
    });

    it('a bot posts in a group it is in, or where its wake runs; never in another group', async () => {
      const a = bot('ws1', 'lead');
      const b = bot('ws1', 'verifier');
      const outsider = bot('ws1', 'triage');
      const s = withGroup([a, b, outsider], [a.id, b.id]);
      expect(await handleRoomPost({ kind: 'status', title: 'in', threadId: GROUP }, asBot(a), s.deps)).toMatchObject({ ok: true, card: { threadId: GROUP } });
      expect(await handleRoomPost({ kind: 'status', title: 'out', threadId: GROUP }, asBot(outsider), s.deps)).toMatchObject({ ok: false, code: 'invalid' });
      // Mentioned into the group's work, its wake runs there: it answers there.
      s.wake.thread = GROUP;
      expect(await handleRoomPost({ kind: 'status', title: 'asked', threadId: GROUP }, asBot(outsider), s.deps)).toMatchObject({ ok: true });
    });
  });

  it('a bot card\'s mentions are settled by main and routed through the handoff router, once per card', async () => {
    const lead = bot('ws1', 'lead');
    const verifier = bot('ws1', 'verifier');
    const far = bot('ws2', 'triage');
    const off = bot('ws1', 'maintainer', { enabled: false });
    const s = setup([lead, verifier, far, off]);
    const router = new HandoffRouter({ file: path.join(dir, 'factory', HANDOFFS_FILENAME), decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    await router.start();
    setHandoffRouter(router);
    s.wake.id = { wakeId: 'w-ment-1', attempt: 1 };
    const r = await handleRoomPost({ kind: 'opinion', title: 'thoughts?', mentions: [verifier.id, lead.id, far.id, off.id], refs: { botIds: [off.id] } }, asBot(lead), s.deps) as {
      card: { id: string; refs?: Record<string, unknown> }; mentions: Array<{ botId: string; ok: boolean }>; droppedMentions: unknown;
    };
    expect(r.card.refs).toEqual({ botIds: [verifier.id, far.id] });
    expect(r.mentions.map((m) => [m.botId, m.ok])).toEqual([[verifier.id, true], [far.id, true]]);
    expect(r.droppedMentions).toEqual([{ botId: lead.id, reason: 'self' }, { botId: off.id, reason: 'not_enabled' }]);
    expect(s.wakes.map((w) => [w.botId, w.reason.kind, w.reason.kind === 'mention' ? w.reason.cardId : null])).toEqual([[verifier.id, 'mention', r.card.id], [far.id, 'mention', r.card.id]]);
    // The retried turn posts the same card: nobody is woken twice.
    s.wake.id = { wakeId: 'w-ment-1', attempt: 2 };
    const again = await handleRoomPost({ kind: 'opinion', title: 'thoughts?', mentions: [verifier.id] }, asBot(lead), s.deps);
    expect(again).toMatchObject({ ok: true, duplicate: true, mentions: [{ ok: true, duplicate: true }, { ok: true, duplicate: true }] });
    expect(s.wakes).toHaveLength(2);
    // A repeat past the retry window routes nothing.
    vi.useFakeTimers({ now: Date.now() + 25 * 3_600_000, toFake: ['Date'] });
    s.wake.id = { wakeId: 'w-ment-1', attempt: 3 };
    try {
      const late = await handleRoomPost({ kind: 'opinion', title: 'thoughts?', mentions: [verifier.id] }, asBot(lead), s.deps) as Record<string, unknown>;
      expect(late).toMatchObject({ ok: true, duplicate: true });
      expect(late.mentions).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(s.wakes).toHaveLength(2);
    expect(await handleRoomPost({ kind: 'opinion', title: 'x', mentions: 'all' }, asBot(lead), s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    router.dispose();
  });

  it('with no bot to address, the card is written and nothing is directed', async () => {
    const s = setup([]);
    expect(await handleRoomPost({ workspaceId: 'ws1', title: 'hello' }, OPERATOR, s.deps)).toMatchObject({ ok: true, addressee: null });
    expect(s.facts).toEqual([]);
    expect(s.wakes).toEqual([]);
  });

  it('humanAddressee: lead first, else the HQ bot of this room', () => {
    const moa = bot('hq', 'moa');
    const dirOf = (bots: BotProfile[]) => ({ listEnabled: () => bots, get: () => null });
    expect(humanAddressee(dirOf([moa]), 'hq', undefined)).toMatchObject({ bot: { id: moa.id }, role: 'moa' });
    expect(humanAddressee(dirOf([moa]), 'ws1', undefined)).toEqual({ bot: null, role: null });
  });
});

describe('a turn that ended with plain text: its words become the bot\'s card (round 7)', () => {
  function rig(bots: BotProfile[], threadId: ThreadId) {
    const s = setup(bots);
    s.wake.thread = threadId;
    s.wake.id = { wakeId: 'w-1', attempt: 1 };
    // The turn began before anything in the test is written.
    const since = Date.now() - 1;
    const text = (b: BotProfile, words: string) => postTurnText(b, { id: 'w-1' }, words, since, s.deps);
    const cards = () => s.writer.read('ws1', { threadId }).cards;
    return { ...s, since, text, cards };
  }

  it('a conversation that holds data from a signed-in task: the owner\'s message in General is answered in the bot\'s 1:1', async () => {
    const dev = bot('ws1', 'maintainer');
    const r = rig([dev], 'general' as ThreadId);
    const res = await postTurnText(dev, { id: 'w-1' }, 'Here is the summary.\nThree pages, two owners.', r.since, { ...r.deps, signedIn: () => true }) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(r.cards()).toEqual([]);
    expect(r.writer.read('ws1', { threadId: `dm:${dev.id}` as ThreadId }).cards).toEqual([expect.objectContaining({
      kind: 'status', threadId: `dm:${dev.id}`, title: 'Here is the summary.', body: 'Three pages, two owners.', actor: { kind: 'bot', workspaceId: 'ws1', botId: dev.id },
    })]);
    // Handed over again, still one card.
    await postTurnText(dev, { id: 'w-1' }, 'Here is the summary.', r.since, { ...r.deps, signedIn: () => true });
    expect(r.writer.read('ws1', { threadId: `dm:${dev.id}` as ThreadId }).cards).toHaveLength(1);
  });

  it('a 1:1: the words are one status card from the bot in its thread; the first line is the title', async () => {
    const dev = bot('ws1', 'maintainer');
    const r = rig([dev], `dm:${dev.id}` as ThreadId);
    const res = await r.text(dev, 'All green.\n\nThe CI run passed.\u0000') as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(r.cards()).toEqual([expect.objectContaining({
      kind: 'status', threadId: `dm:${dev.id}`, title: 'All green.', body: 'The CI run passed.',
      actor: { kind: 'bot', workspaceId: 'ws1', botId: dev.id }, clientPostId: 'wake:w-1:text',
    })]);
    // The same turn handed over twice still makes one card.
    await r.text(dev, 'All green.');
    expect(r.cards()).toHaveLength(1);
  });

  it('a group chat: posted in the group\'s thread; a long first line keeps the whole text, capped like a room_post body', async () => {
    const GROUP = 'group:grp-0000aaaa' as ThreadId;
    const a = bot('ws1', 'lead');
    const r = rig([a], GROUP);
    r.ports.groups = { byThread: (ws, t) => (t === GROUP ? { id: 'grp-0000aaaa', workspaceId: ws, name: 'Ship', memberIds: [a.id], threadId: GROUP, createdAt: 1, updatedAt: 1 } : null) };
    const long = 'x'.repeat(ROOM_TITLE_MAX + 50) + '\n' + 'y'.repeat(20_000);
    await r.text(a, long);
    const [card] = r.cards();
    expect(card).toMatchObject({ threadId: GROUP, kind: 'status' });
    expect(card.title).toHaveLength(ROOM_TITLE_MAX);
    expect(card.body?.length).toBe(ROOM_BODY_MAX);
    expect(card.body?.startsWith('x')).toBe(true);
  });

  it('a turn that already posted in the thread, or ended with no words, adds nothing', async () => {
    const dev = bot('ws1', 'maintainer');
    const r = rig([dev], `dm:${dev.id}` as ThreadId);
    expect(await r.text(dev, '   \n ')).toBeNull();
    expect(r.cards()).toEqual([]);
    await handleRoomPost({ kind: 'report', title: 'Done', clientPostId: 'own-key' }, asBot(dev), r.deps);
    expect(await r.text(dev, 'Done, see the report.')).toBeNull();
    expect(r.cards().map((c) => c.title)).toEqual(['Done']);
  });

  it('a card from an earlier attempt of the wake answered it; a card from an earlier wake did not; a busy thread hides nothing', async () => {
    const dev = bot('ws1', 'maintainer');
    const r = rig([dev], `dm:${dev.id}` as ThreadId);
    const dm = `dm:${dev.id}` as ThreadId;
    const actor = { kind: 'bot' as const, workspaceId: 'ws1', botId: dev.id };
    // The previous wake's answer, written as this turn began.
    r.writer.post({ workspaceId: 'ws1', threadId: dm, kind: 'status', actor, title: 'old', at: r.since, clientPostId: 'wake:w-0:1' });
    // An earlier attempt of this wake posted, then failed; then a hundred more cards.
    r.writer.post({ workspaceId: 'ws1', threadId: dm, kind: 'status', actor, title: 'first try', at: r.since - 10, clientPostId: 'wake:w-1:1' });
    for (let i = 0; i < ROOM_LIMITS.PAGE + 5; i++) r.writer.append({ workspaceId: 'ws1', threadId: dm, kind: 'fact', actor: { kind: 'system' }, title: `f${i}` });
    expect(await r.text(dev, 'Same answer again.')).toBeNull();
    // Without that attempt's card, the reply is posted.
    const r2 = rig([dev], 'general' as ThreadId);
    r2.writer.post({ workspaceId: 'ws1', threadId: 'general' as ThreadId, kind: 'status', actor, title: 'old', at: r2.since, clientPostId: 'wake:w-0:1' });
    expect(await r2.text(dev, 'New answer.')).toMatchObject({ ok: true });
  });

  it('another bot\'s card in the thread is not this bot\'s answer', async () => {
    const dev = bot('ws1', 'maintainer');
    const other = bot('ws1', 'lead');
    const r2 = rig([dev, other], `dm:${dev.id}` as ThreadId);
    r2.writer.post({ workspaceId: 'ws1', threadId: `dm:${dev.id}` as ThreadId, kind: 'status', actor: { kind: 'bot', workspaceId: 'ws1', botId: other.id }, title: 'hello' });
    await r2.text(dev, 'Here is my answer.');
    expect(r2.cards().map((c) => c.title)).toEqual(['hello', 'Here is my answer.']);
  });
});

describe('a bot\'s reply links the owner message its wake answers', () => {
  type Card = { id: string; threadId: string; replyTo?: string };
  /** Each bot runs the wake given here, as main's runningWakeOf derives it
   *  from the wake item (its id, and the owner card its run names). */
  function rig(bots: BotProfile[]) {
    const s = setup(bots);
    const running = new Map<string, { wakeId: string; attempt: number; ownerCardId?: string; thread: string | null }>();
    s.ports.currentWake = (botId) => running.get(botId) ?? null;
    s.ports.currentWakeThread = (botId) => (running.get(botId)?.thread ?? null) as never;
    /** Run the n-th queued wake (1-based) for its bot. */
    const run = (n: number) => {
      const w = s.wakes[n - 1];
      const ownerCardId = w.reason.kind === 'human' ? humanCardIdOfRun(w.reason.runId) : null;
      running.set(w.botId, { wakeId: `w-${n}`, attempt: 1, thread: w.threadId ?? null, ...(ownerCardId ? { ownerCardId } : {}) });
    };
    const owner = async (title: string, extra: Record<string, unknown> = {}) =>
      ((await handleRoomPost({ workspaceId: 'ws1', kind: 'human', title, ...extra }, OPERATOR, s.deps)) as { card: Card }).card;
    const reply = async (b: BotProfile, extra: Record<string, unknown> = {}) =>
      ((await handleRoomPost({ kind: 'status', title: 'on it', ...extra }, asBot(b), s.deps)) as { ok: boolean; card: Card });
    return { ...s, running, run, owner, reply };
  }

  it('a run names its owner card and nothing else does', () => {
    expect(humanCardIdOfRun(humanRunId('c-abc'))).toBe('c-abc');
    for (const v of [undefined, '', 'run-', 'h-1', 42]) expect(humanCardIdOfRun(v)).toBeNull();
  });

  it('one bot: its cards answer the owner message; an explicit replyTo and another thread stay as given', async () => {
    const lead = bot('ws1', 'lead');
    const r = rig([lead]);
    const m = await r.owner('fix the login', { mentions: [lead.id] });
    r.run(1);
    expect((await r.reply(lead)).card).toMatchObject({ threadId: 'general', replyTo: m.id });
    const own = (await r.reply(lead, { title: 'first' })).card;
    expect((await r.reply(lead, { title: 'second', replyTo: own.id })).card.replyTo).toBe(own.id);
    // A card in another thread answers nothing by default, and is still posted.
    const elsewhere = await r.reply(lead, { threadId: 'task:t-9' });
    expect(elsewhere.ok).toBe(true);
    expect(elsewhere.card.replyTo).toBeUndefined();
    // A wake no owner message started links nothing.
    r.running.set(lead.id, { wakeId: 'w-h', attempt: 1, thread: 'general' });
    expect((await r.reply(lead, { title: 'handoff work' })).card.replyTo).toBeUndefined();
  });

  it('a 1:1: the owner\'s post in dm:<bot> wakes that bot alone, pinned there, and its reply stays in the 1:1', async () => {
    const lead = bot('ws1', 'lead');
    const dev = bot('ws1', 'maintainer');
    const r = rig([lead, dev]);
    // Whatever else it names, a 1:1 message is for its bot.
    const m = await r.owner('fix the login', { threadId: `dm:${dev.id}`, mentions: [lead.id] });
    expect(m).toMatchObject({ threadId: `dm:${dev.id}`, refs: { botId: dev.id } });
    expect(r.wakes.map((w) => [w.botId, w.threadId])).toEqual([[dev.id, `dm:${dev.id}`]]);
    r.run(1);
    expect((await r.reply(dev)).card).toMatchObject({ threadId: `dm:${dev.id}`, replyTo: m.id });
    expect(r.writer.read('ws1', { threadId: 'general' }).cards).toEqual([]);
    // Another bot does not post into this 1:1; a 1:1 lives in its bot's room.
    expect(await handleRoomPost({ kind: 'status', title: 'x', threadId: `dm:${dev.id}` }, asBot(lead), r.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await handleRoomPost({ workspaceId: 'ws2', kind: 'human', title: 'x', threadId: `dm:${dev.id}` }, OPERATOR, r.deps)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('two owner messages back to back: each wake\'s cards answer its own message', async () => {
    const lead = bot('ws1', 'lead');
    const r = rig([lead]);
    const m1 = await r.owner('first ask', { mentions: [lead.id] });
    const m2 = await r.owner('second ask', { mentions: [lead.id] });
    r.run(1);
    expect((await r.reply(lead, { title: 'about the first' })).card.replyTo).toBe(m1.id);
    r.run(2);
    expect((await r.reply(lead, { title: 'about the second' })).card.replyTo).toBe(m2.id);
  });

  it('a group room: every bot\'s card answers the one owner message', async () => {
    const lead = bot('ws1', 'lead');
    const verifier = bot('ws1', 'verifier');
    const r = rig([lead, verifier]);
    const m = await r.owner('status, everyone?');
    expect(r.wakes.map((w) => w.botId)).toEqual([lead.id, verifier.id]);
    r.run(1);
    r.run(2);
    const a = (await r.reply(lead)).card;
    const b = (await r.reply(verifier)).card;
    expect([a.replyTo, b.replyTo]).toEqual([m.id, m.id]);
  });
});

describe('a question a bot asks about an owner message answers it, raised now or after a restart', () => {
  it('the question card replies to the owner card, also when it was queued and the router restarted', async () => {
    const lead = bot('ws1', 'lead');
    const verifier = bot('ws1', 'verifier');
    const s = setup([lead, verifier]);
    const m = ((await handleRoomPost({ workspaceId: 'ws1', kind: 'human', title: 'should we ship?' }, OPERATOR, s.deps)) as { card: { id: string } }).card;
    s.ports.currentWake = () => ({ wakeId: 'w-q', attempt: 1, ownerCardId: m.id });
    s.ports.currentWakeThread = () => 'general' as never;
    const file = path.join(dir, 'factory', HANDOFFS_FILENAME);
    const router = new HandoffRouter({ file, decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    await router.start();
    const first = await handleAskPerson({ title: 'Ship now?' }, asBot(lead), { router: () => router, signedIn: () => false }) as { ok: boolean; decisionId?: string };
    // The thread holds the lead's open question: the verifier's waits.
    const second = await handleAskPerson({ title: 'Run the slow suite first?' }, asBot(verifier), { router: () => router, signedIn: () => false }) as { ok: boolean; status: string };
    expect([first.ok, !!first.decisionId, second.status]).toEqual([true, true, 'queued']);
    const questions = () => s.writer.read('ws1').cards.filter((c) => c.kind === 'question');
    expect(questions().map((c) => [c.title, c.replyTo])).toEqual([['Ship now?', m.id]]);
    // The lead's question closes; a new router (an app restart) raises the
    // queued one from its stored record.
    const q = questions()[0];
    expect(await handleQuestionClose({ cardId: q.id }, asBot(lead), { router: () => router, signedIn: () => false })).toMatchObject({ ok: true });
    expect(questions()).toHaveLength(1);
    s.ports.currentWake = () => null;
    const restarted = new HandoffRouter({ file, decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    await restarted.start();
    expect(questions().map((c) => [c.title, c.replyTo])).toEqual([['Ship now?', m.id], ['Run the slow suite first?', m.id]]);
  });
});

describe('one PR is one thread however the caller spells it', () => {
  it('posts, reads, read positions, handoffs and questions all use the canonical thread', async () => {
    const lead = bot('ws1', 'lead');
    const moa = bot('hq', 'moa');
    const s = setup([lead, moa]);
    const canonical = 'pr:github.com/acme/app#12';
    s.writer.append({ workspaceId: 'ws1', threadId: canonical, kind: 'fact', actor: { kind: 'system' }, title: 'merged' });
    // The owner names the thread with another spelling: the card, the fact and the wake use the canonical one.
    const human = await handleRoomPost({ workspaceId: 'ws1', threadId: 'pr:Acme/App#12', title: 'note' }, OPERATOR, s.deps);
    expect(human).toMatchObject({ ok: true, card: { threadId: canonical } });
    expect(s.facts[0].payload).toMatchObject({ threadId: canonical });
    expect(s.wakes[0]).toMatchObject({ threadId: canonical });
    // A bot naming it either way.
    expect(await handleRoomPost({ kind: 'status', title: 'b', threadId: 'pr:GitHub.com/Acme/App#12' }, asBot(lead), s.deps)).toMatchObject({ card: { threadId: canonical } });
    expect(s.writer.threads('ws1').filter((t) => t.threadId.startsWith('pr:')).map((t) => t.threadId)).toEqual([canonical]);
    expect(handleRoomRead({ workspaceId: 'ws1', threadId: 'pr:acme/app#12' }, OPERATOR, s.deps)).toMatchObject({ ok: true, threadId: canonical, cards: [{}, {}, {}] });
    handleRoomRead({ workspaceId: 'ws1', threadId: 'pr:Acme/App#12', markThroughSeq: 3 }, OPERATOR, s.deps);
    expect(s.writer.summary('ws1', canonical).unread).toBe(0);
    // Handoffs and questions store the canonical thread too.
    const router = new HandoffRouter({ file: path.join(dir, 'factory', HANDOFFS_FILENAME), decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    const deps = { router: () => router, signedIn: () => false };
    expect(handleHandoffSend({ kind: 'dispatch', toWorkspaceId: 'ws1', title: 'go', body: '', threadId: 'pr:Acme/App#12' }, asBot(moa), deps)).toMatchObject({ ok: true, threadId: canonical });
    const ask = await handleAskPerson({ title: 'order?', threadId: 'pr:Acme/App#12' }, asBot(lead), deps);
    expect(ask).toMatchObject({ ok: true, threadId: canonical });
    expect(loadThreadDecision('ws1', canonical, dir)).toMatchObject({ question: 'order?' });
    // question_close: a bot's own question only; never the owner's call.
    const q = s.writer.read('ws1').cards.find((c) => c.kind === 'question')!;
    expect(await handleQuestionClose({ cardId: q.id }, OPERATOR, deps)).toMatchObject({ ok: false, code: 'bot_only' });
    expect(await handleQuestionClose({ cardId: q.id }, asBot(moa), deps)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await handleQuestionClose({ cardId: q.id }, asBot(lead), { router: () => null, signedIn: () => false })).toMatchObject({ ok: false, code: 'not_started' });
    expect(await handleQuestionClose({ cardId: q.id }, asBot(lead), deps)).toMatchObject({ ok: true });
    expect(loadThreadDecision('ws1', canonical, dir)).toBeNull();
  });
});

describe('a bot whose conversation holds data from a signed-in task', () => {
  it('posts only in its own 1:1, and mentions no bot there; with no live conversation it posts nowhere else either', async () => {
    const lead = bot('ws1', 'lead');
    const dev = bot('ws1', 'lead');
    const s = setup([lead, dev]);
    const signedIn = { ...s.deps, signedIn: () => true };
    const dm = `dm:${lead.id}`;
    s.wake.thread = dm;
    s.wake.id = { wakeId: 'w-dm', attempt: 1 };
    expect(await handleRoomPost({ kind: 'status', title: 'Here is the page summary' }, asBot(lead), signedIn)).toMatchObject({ ok: true, card: { threadId: dm } });
    for (const threadId of ['general', 'issue:github.com/acme/app#7']) {
      expect(await handleRoomPost({ kind: 'status', title: 'summary', threadId }, asBot(lead), signedIn))
        .toMatchObject({ ok: false, code: 'not_now', message: expect.stringContaining('holds data from a signed-in task, so it can\'t post outside your 1:1') });
    }
    // A wake in General posts nothing there.
    s.wake.thread = 'general';
    expect(await handleRoomPost({ kind: 'status', title: 'summary' }, asBot(lead), signedIn)).toMatchObject({ ok: false, code: 'not_now' });
    s.wake.thread = dm;
    expect(await handleRoomPost({ kind: 'status', title: 'over to you', mentions: [dev.id] }, asBot(lead), signedIn))
      .toMatchObject({ ok: false, code: 'not_now', message: expect.stringContaining('mention another bot') });
    // The default reads the conversation's marks: none live is not known clean.
    expect(await handleRoomPost({ kind: 'status', title: 'summary', threadId: 'general' }, asBot(lead), { ...s.deps, signedIn: undefined })).toMatchObject({ ok: false, code: 'not_now' });
    expect(s.writer.read('ws1').cards.map((c) => c.threadId)).toEqual([dm]);
  });

  it('another bot reads none of its 1:1, by thread or by search; it reads its own, and the owner reads both', async () => {
    const a = bot('ws1', 'lead');
    const b = bot('ws1', 'lead');
    const s = setup([a, b]);
    const dmA = `dm:${a.id}`;
    s.wake.thread = dmA;
    s.wake.id = { wakeId: 'w-a', attempt: 1 };
    expect(await handleRoomPost({ kind: 'status', title: 'Page summary', body: 'quarterly figures' }, asBot(a), s.deps)).toMatchObject({ ok: true, card: { threadId: dmA } });
    s.wake.thread = 'general';
    s.wake.id = { wakeId: 'w-b', attempt: 1 };
    expect(await handleRoomPost({ kind: 'status', title: 'General note', body: 'quarterly plan' }, asBot(b), s.deps)).toMatchObject({ ok: true });
    // B: by thread refused, unthreaded and search leave A's 1:1 out.
    expect(handleRoomRead({ threadId: dmA }, asBot(b), s.deps)).toMatchObject({ ok: false, code: 'not_yours' });
    expect((handleRoomRead({}, asBot(b), s.deps) as { cards: Array<{ threadId: string }> }).cards.map((c) => c.threadId)).toEqual(['general']);
    expect((handleRoomSearch({ query: 'quarterly' }, asBot(b), s.deps) as { hits: Array<{ threadId: string }> }).hits.map((h) => h.threadId)).toEqual(['general']);
    // A reads its own.
    expect((handleRoomRead({ threadId: dmA }, asBot(a), s.deps) as { cards: Array<{ title: string }> }).cards.map((c) => c.title)).toEqual(['Page summary']);
    expect((handleRoomSearch({ query: 'quarterly' }, asBot(a), s.deps) as { hits: unknown[] }).hits).toHaveLength(2);
    // The owner's views are unchanged.
    expect((handleRoomRead({ workspaceId: 'ws1', threadId: dmA }, OPERATOR, s.deps) as { cards: unknown[] }).cards).toHaveLength(1);
    expect((handleRoomSearch({ workspaceId: 'ws1', query: 'quarterly' }, OPERATOR, s.deps) as { hits: unknown[] }).hits).toHaveLength(2);
  });

  it('hands no work to another bot; it may still ask the owner', async () => {
    const lead = bot('ws1', 'lead');
    const dev = bot('ws1', 'lead');
    const s = setup([lead, dev]);
    const router = new HandoffRouter({ file: path.join(dir, 'factory', HANDOFFS_FILENAME), decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    const deps = { router: () => router, signedIn: () => true };
    for (const kind of ['dispatch', 'result']) {
      expect(handleHandoffSend({ kind, toBotId: dev.id, title: 'the notes', body: 'what it read' }, asBot(lead), deps))
        .toMatchObject({ ok: false, code: 'not_now', message: expect.stringContaining('holds data from a signed-in task, so it can\'t hand work to another bot') });
    }
    expect(router.list({})).toEqual([]);
    expect(await handleAskPerson({ title: 'Save it as a routine?', threadId: `dm:${lead.id}` }, asBot(lead), deps)).toMatchObject({ ok: true });
  });

  it('asks the owner only in its own 1:1: a question aimed nowhere lands there, one aimed at General or a task thread is refused', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    const router = new HandoffRouter({ file: path.join(dir, 'factory', HANDOFFS_FILENAME), decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    const dm = `dm:${lead.id}`;
    // The signed-in task's report wake runs in its task thread.
    s.wake.thread = 'task:t-signed';
    s.wake.id = { wakeId: 'w-report', attempt: 1 };
    const signedIn = { router: () => router, signedIn: () => true };
    for (const threadId of ['general', 'task:t-signed']) {
      expect(await handleAskPerson({ title: 'Share the forecast?', body: 'Q3 revenue 4.2M', threadId }, asBot(lead), signedIn))
        .toMatchObject({ ok: false, code: 'not_now', message: expect.stringContaining('holds data from a signed-in task, so it can\'t ask a question outside your 1:1') });
    }
    expect(await handleAskPerson({ title: 'Share the forecast?', body: 'Q3 revenue 4.2M' }, asBot(lead), signedIn)).toMatchObject({ ok: true, threadId: dm });
    // The default reads the conversation's marks: none live is not known clean.
    s.wake.id = { wakeId: 'w-report-2', attempt: 1 };
    expect(await handleAskPerson({ title: 'And the margin?', body: 'Q3 margin 12%' }, asBot(lead), { router: () => router })).toMatchObject({ ok: true, threadId: dm });
    expect(s.writer.read('ws1').cards.filter((c) => c.kind === 'question').map((c) => c.threadId)).toEqual([dm, dm]);
    expect(router.list({}).map((h) => h.threadId)).toEqual([dm, dm]);
  });
});

describe('a delegate woken in a thread its dispatch opened posts there', () => {
  const GROUP = 'group:grp-00000009';
  async function opened(groupMembers?: (lead: BotProfile, dev: BotProfile) => string[]) {
    const lead = bot('ws1', 'moa');
    const dev = bot('ws1', 'lead');
    const s = setup([lead, dev]);
    if (groupMembers) {
      const memberIds = groupMembers(lead, dev);
      s.ports.groups = { byThread: (ws, th) => (ws === 'ws1' && th === GROUP
        ? { id: 'grp-00000009', workspaceId: 'ws1', name: 'Ship', memberIds, threadId: GROUP as ThreadId, createdAt: 1, updatedAt: 1 }
        : null) };
    }
    const router = new HandoffRouter({ file: path.join(dir, 'factory', HANDOFFS_FILENAME), decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    await router.start();
    setHandoffRouter(router);
    const said = (groupMembers ? GROUP : `dm:${lead.id}`) as ThreadId;
    // The coordinator, woken by the owner in its 1:1 or the group, dispatches.
    s.wake.thread = said;
    s.wake.id = { wakeId: 'w-lead', attempt: 1 };
    const d = handleHandoffSend({ kind: 'dispatch', toBotId: dev.id, title: 'Write coord.txt', body: 'b' }, asBot(lead), { router: () => router, signedIn: () => false }) as { ok: true; handoffId: string; threadId: string };
    expect(d).toMatchObject({ ok: true, threadId: `handoff:${d.handoffId}` });
    await router.idle();
    // The delegate runs the dispatch's wake, pinned to the opened thread.
    s.wake.thread = d.threadId;
    s.wake.id = { wakeId: 'w-dev', attempt: 1, handoffId: d.handoffId };
    const post = async (b: BotProfile, threadId?: string) => (await handleRoomPost({ kind: 'status', title: 'Got it: worker starting', ...(threadId ? { threadId } : {}) }, asBot(b), s.deps)) as { ok: boolean; card?: RoomCard };
    return { lead, dev, s, router, said, thread: d.threadId, post };
  }

  it('from a coordinator\'s 1:1: by default, and when it names that 1:1, the delegate\'s status lands in the opened thread', async () => {
    const o = await opened();
    expect((await o.post(o.dev)).card?.threadId).toBe(o.thread);
    expect((await o.post(o.dev, o.said)).card?.threadId).toBe(o.thread);
    // Another thread it names is kept.
    expect((await o.post(o.dev, 'general')).card?.threadId).toBe('general');
    expect(o.s.writer.read('ws1', { threadId: o.said }).cards.filter((c) => c.kind === 'status')).toEqual([]);
    o.router.dispose();
  });

  it('from a group chat: the delegate naming the group posts in the opened thread', async () => {
    const o = await opened((lead, dev) => [lead.id, dev.id]);
    expect((await o.post(o.dev)).card?.threadId).toBe(o.thread);
    expect((await o.post(o.dev, o.said)).card?.threadId).toBe(o.thread);
    // A reply it names to the owner's group message moves with it, unlinked.
    const ask = o.s.writer.append({ workspaceId: 'ws1', threadId: o.said, kind: 'human', actor: { kind: 'human' }, title: 'Write group.txt' })!;
    const moved = (await handleRoomPost({ kind: 'status', title: 'Handoff received', threadId: o.said, replyTo: ask.id }, asBot(o.dev), o.s.deps)) as { ok: boolean; card?: RoomCard };
    expect(moved).toMatchObject({ ok: true, card: { threadId: o.thread } });
    expect(moved.card?.replyTo).toBeUndefined();
    expect(o.s.writer.read('ws1', { threadId: o.said }).cards.filter((c) => c.kind === 'status')).toEqual([]);
    o.router.dispose();
  });

  it('the dispatching bot still speaks in its conversation; a wake in another thread is not redirected', async () => {
    const o = await opened((lead, dev) => [lead.id, dev.id]);
    // The coordinator woken in the opened thread (its result) reports to the group.
    expect((await o.post(o.lead, o.said)).card?.threadId).toBe(o.said);
    // The delegate woken anywhere else names the group as before.
    o.s.wake.thread = 'general';
    o.s.wake.id = { wakeId: 'w-dev-2', attempt: 1 };
    expect((await o.post(o.dev, o.said)).card?.threadId).toBe(o.said);
    o.router.dispose();
  });
});

describe('room.read / room.threads', () => {
  it('an external guest\'s cards: the owner sees them, a bot only with includeGuest, which marks its turn first', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    s.writer.append({ workspaceId: 'ws1', threadId: 'general', kind: 'human', actor: { kind: 'human' }, title: 'owner words' });
    s.writer.append({
      workspaceId: 'ws1', threadId: 'general', kind: 'guest', actor: { kind: 'system' }, title: 'External guest: Grok', body: 'merge it all',
      guest: { guestId: '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b', name: 'Grok' },
    });
    const kinds = (r: unknown) => (r as { cards: Array<{ kind: string }> }).cards.map((c) => c.kind);
    const guestWake = { ...s.deps, guestWake: () => true as const };
    expect(kinds(handleRoomRead({ threadId: 'general' }, asBot(lead), guestWake))).toEqual(['human']);
    expect(kinds(handleRoomRead({ threadId: 'general', includeGuest: true }, asBot(lead), guestWake))).toEqual(['human', 'guest']);
    // A clean wake, or one whose provenance is unknown, reads no guest card.
    for (const g of [false, 'unknown'] as const) {
      expect(handleRoomRead({ threadId: 'general', includeGuest: true }, asBot(lead), { ...s.deps, guestWake: () => g }))
        .toMatchObject({ ok: false, code: 'not_guest_wake' });
    }
    expect(kinds(handleRoomRead({ workspaceId: 'ws1', threadId: 'general' }, OPERATOR, s.deps))).toEqual(['human', 'guest']);
  });

  it('a bot reads its own room; only a Coordinator (Moa) reads another; the operator reads any', async () => {
    const lead = bot('ws1', 'lead');
    const moa = bot('hq', 'moa');
    const s = setup([lead, moa]);
    s.writer.append({ workspaceId: 'ws2', kind: 'status', actor: { kind: 'system' }, title: 'elsewhere' });
    expect(handleRoomRead({}, asBot(lead), s.deps)).toMatchObject({ ok: true, workspaceId: 'ws1', cards: [] });
    expect(handleRoomRead({ workspaceId: 'ws2' }, asBot(lead), s.deps)).toMatchObject({ ok: false, code: 'cross_workspace' });
    expect(handleRoomRead({ workspaceId: 'ws2' }, asBot(moa), s.deps)).toMatchObject({ ok: true, cards: [{ title: 'elsewhere' }] });
    expect(handleRoomRead({ workspaceId: 'ws2' }, OPERATOR, s.deps)).toMatchObject({ ok: true, nextSinceSeq: 1, hasMore: false });
    expect(handleRoomRead({}, WIRE, s.deps)).toMatchObject({ ok: false, code: 'not_bot' });
  });

  it('the cross-workspace read follows the live template, not the role tag', async () => {
    const coordinator = { ...bot('ws1', 'lead'), template: 'coordinator' as const };
    const demoted = { ...bot('hq', 'moa'), template: 'developer' as const };
    const s = setup([coordinator, demoted]);
    s.writer.append({ workspaceId: 'ws2', kind: 'status', actor: { kind: 'system' }, title: 'elsewhere' });
    expect(handleRoomRead({ workspaceId: 'ws2' }, asBot(coordinator), s.deps)).toMatchObject({ ok: true, cards: [{ title: 'elsewhere' }] });
    expect(handleRoomRead({ workspaceId: 'ws2' }, asBot(demoted), s.deps)).toMatchObject({ ok: false, code: 'cross_workspace' });
  });

  it('the operator records a read position; a bot cannot', () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    s.writer.append({ workspaceId: 'ws1', threadId: 'task:t', kind: 'status', actor: { kind: 'system' }, title: 'a' });
    expect(handleRoomRead({ markThroughSeq: 1, threadId: 'task:t' }, asBot(lead), s.deps)).toMatchObject({ ok: false, code: 'operator_only' });
    expect(handleRoomRead({ workspaceId: 'ws1', markThroughSeq: 1 }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    handleRoomRead({ workspaceId: 'ws1', threadId: 'task:t', markThroughSeq: 1 }, OPERATOR, s.deps);
    expect(s.writer.summary('ws1', 'task:t').unread).toBe(0);
  });

  it('room.threads is the operator\'s', () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    expect(handleRoomThreads({ workspaceId: 'ws1' }, asBot(lead), s.deps)).toMatchObject({ ok: false, code: 'operator_only' });
    expect(handleRoomThreads({ workspaceId: 'ws1' }, OPERATOR, s.deps)).toMatchObject({ ok: true, threads: [{ threadId: 'general' }] });
  });
});

describe('room.search', () => {
  type Hits = { hits: Array<{ seq: number; title: string; snippet: string; threadId: string }>; nextBefore: number; hasMore: boolean };
  const hits = (r: unknown) => (r as Hits).hits.map((h) => h.title);

  it('matches every term case-insensitively in title or body, newest first, with a snippet', () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    s.writer.append({ workspaceId: 'ws1', kind: 'human', actor: { kind: 'human' }, title: 'Deploy the staging server', body: 'use the blue Database' });
    s.writer.append({ workspaceId: 'ws1', kind: 'status', actor: { kind: 'system' }, title: 'unrelated' });
    s.writer.append({ workspaceId: 'ws1', threadId: 'task:t', kind: 'human', actor: { kind: 'human' }, title: 'the DATABASE password rotates', body: 'staging only' });
    s.writer.append({ workspaceId: 'ws1', kind: 'human', actor: { kind: 'human' }, title: 'database alone' });
    const r = handleRoomSearch({ query: 'database  Staging' }, asBot(lead), s.deps) as Hits;
    expect(r).toMatchObject({ ok: true, workspaceId: 'ws1', hasMore: false, nextBefore: 1 });
    expect(hits(r)).toEqual(['the DATABASE password rotates', 'Deploy the staging server']);
    expect(r.hits[0]).toMatchObject({ seq: 3, threadId: 'task:t', kind: 'human', actor: { kind: 'human' } });
    expect(r.hits[1].snippet).toContain('blue Database');
  });

  it('caps a page and pages older hits with before', () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    for (let i = 1; i <= 15; i += 1) s.writer.append({ workspaceId: 'ws1', kind: 'human', actor: { kind: 'human' }, title: `note ${i}` });
    const first = handleRoomSearch({ query: 'note' }, asBot(lead), s.deps) as Hits;
    expect(first.hits.map((h) => h.seq)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
    expect(first).toMatchObject({ hasMore: true, nextBefore: 6 });
    const next = handleRoomSearch({ query: 'note', before: first.nextBefore, limit: 3 }, asBot(lead), s.deps) as Hits;
    expect(next.hits.map((h) => h.seq)).toEqual([5, 4, 3]);
    expect(next.hasMore).toBe(true);
    const last = handleRoomSearch({ query: 'note', before: 3, limit: 50 }, asBot(lead), s.deps) as Hits;
    expect(last).toMatchObject({ hasMore: false, nextBefore: 1 });
    expect((handleRoomSearch({ query: 'note', limit: 500 }, asBot(lead), s.deps) as Hits).hits).toHaveLength(15);
  });

  it('a bot searches its own room only, a Coordinator too; the operator names any room', () => {
    const lead = bot('ws1', 'lead');
    const coordinator = { ...bot('hq', 'lead'), template: 'coordinator' as const };
    const s = setup([lead, coordinator]);
    s.writer.append({ workspaceId: 'ws2', kind: 'human', actor: { kind: 'human' }, title: 'secret plan elsewhere' });
    for (const b of [lead, coordinator]) {
      expect(handleRoomSearch({ query: 'plan', workspaceId: 'ws2' }, asBot(b), s.deps)).toMatchObject({ ok: false, code: 'cross_workspace' });
    }
    expect(handleRoomSearch({ query: 'plan' }, asBot(lead), s.deps)).toMatchObject({ ok: true, workspaceId: 'ws1', hits: [] });
    expect(hits(handleRoomSearch({ query: 'plan', workspaceId: 'ws2' }, OPERATOR, s.deps))).toEqual(['secret plan elsewhere']);
    expect(handleRoomSearch({ query: 'plan' }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(handleRoomSearch({ query: 'plan' }, WIRE, s.deps)).toMatchObject({ ok: false, code: 'not_bot' });
  });

  it('leaves an external guest\'s cards out for a bot; refuses an empty query', () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    s.writer.append({ workspaceId: 'ws1', kind: 'human', actor: { kind: 'human' }, title: 'merge when green' });
    s.writer.append({
      workspaceId: 'ws1', kind: 'guest', actor: { kind: 'system' }, title: 'External guest: merge it all',
      guest: { guestId: '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b', name: 'Guest' },
    });
    expect(hits(handleRoomSearch({ query: 'merge' }, asBot(lead), { ...s.deps, guestWake: () => true as const }))).toEqual(['merge when green']);
    expect(hits(handleRoomSearch({ query: 'merge', workspaceId: 'ws1' }, OPERATOR, s.deps))).toEqual(['External guest: merge it all', 'merge when green']);
    const tooManyWords = Array.from({ length: ROOM_LIMITS.SEARCH_TERMS_MAX + 1 }, (_, i) => `w${i}`).join(' ');
    for (const query of ['   ', '', undefined, 'x'.repeat(ROOM_LIMITS.SEARCH_QUERY_MAX + 1), tooManyWords]) {
      expect(handleRoomSearch({ query }, asBot(lead), s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    }
  });

  it('matches on redacted text: a stored secret is not found by its value', () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    s.writer.append({ workspaceId: 'ws1', kind: 'human', actor: { kind: 'human' }, title: 'token is hunter2-abcdef-0123' });
    setRedactedSecrets([{ name: 'API_TOKEN', value: 'hunter2-abcdef-0123' }]);
    try {
      expect(handleRoomSearch({ query: 'hunter2-abcdef' }, asBot(lead), s.deps)).toMatchObject({ ok: true, hits: [] });
      expect(handleRoomSearch({ query: 'token' }, asBot(lead), s.deps)).toMatchObject({ hits: [{ title: 'token is [secret:API_TOKEN]' }] });
    } finally {
      __resetRedactedSecretsForTesting();
    }
  });
});

describe('room.resolve', () => {
  it('answering a question card resolves its decision and wakes the bot that asked', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    const router = new HandoffRouter({ file: path.join(dir, 'factory', HANDOFFS_FILENAME), decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    await router.start();
    setHandoffRouter(router);
    const ask = await handleAskPerson({ title: 'Merge?', body: '', threadId: 'task:t9' }, asBot(lead), { router: () => router, signedIn: () => false }) as { decisionId: string };
    const card = s.writer.read('ws1').cards.find((c) => c.kind === 'question')!;
    expect(await handleRoomResolve({ workspaceId: 'ws1', cardId: card.id, resolution: 'Yes' }, asBot(lead), s.deps)).toMatchObject({ ok: false, code: 'operator_only' });
    const r = await handleRoomResolve({ workspaceId: 'ws1', cardId: card.id, resolution: 'Yes' }, OPERATOR, s.deps);
    expect(r).toMatchObject({ ok: true, card: { state: 'resolved' } });
    expect(loadThreadDecision('ws1', 'task:t9', dir)).toBeNull();
    expect(ask.decisionId).toBeTruthy();
    expect(s.wakes.at(-1)).toMatchObject({ botId: lead.id, reason: { kind: 'handoff' }, priority: 1 });
    expect(await handleRoomResolve({ workspaceId: 'ws1', cardId: card.id, resolution: 'Yes' }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'not_pending' });
    router.dispose();
  });

  it('closing a proposal tells the listeners and records the resolution', async () => {
    const moa = bot('hq', 'moa');
    const s = setup([moa]);
    const posted = await handleRoomPost({ kind: 'proposal', title: 'Add a lint rule' }, asBot(moa), s.deps) as { card: { id: string; state: string } };
    expect(posted.card.state).toBe('open');
    const seen: string[] = [];
    const off = onRoomCardResolved((ev) => seen.push(ev.resolution));
    expect(await handleRoomResolve({ workspaceId: 'hq', cardId: posted.card.id, resolution: 'Approve' }, OPERATOR, s.deps)).toMatchObject({ ok: true, card: { state: 'resolved' } });
    off();
    expect(seen).toEqual(['Approve']);
    expect(s.writer.read('hq').cards.at(-1)).toMatchObject({ kind: 'fact', title: 'Resolved: Add a lint rule', body: 'Approve' });
    expect(await handleRoomResolve({ workspaceId: 'hq', cardId: 'c-none', resolution: 'x' }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('the resolution of a guest-sourced card is guest-sourced too, across a reload', async () => {
    const moa = bot('hq', 'moa');
    const s = setup([moa]);
    const source = s.writer.append({ workspaceId: 'hq', kind: 'proposal', actor: { kind: 'bot', workspaceId: 'hq', botId: moa.id }, title: 'GUEST-PLAN', state: 'open', origin: 'guest' });
    expect(await handleRoomResolve({ workspaceId: 'hq', cardId: source!.id, resolution: 'Approve' }, OPERATOR, s.deps)).toMatchObject({ ok: true });
    expect(JSON.stringify(s.writer.read('hq').cards)).not.toContain('GUEST-PLAN');
    expect(s.writer.read('hq', { guests: true }).cards.at(-1)).toMatchObject({ actor: { kind: 'human' }, title: 'Resolved: GUEST-PLAN', origin: 'guest' });
    const reloaded = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), log: () => undefined });
    expect(JSON.stringify(reloaded.read('hq').cards)).not.toContain('GUEST-PLAN');
  });
});

describe('human.correction from the owner\'s answers', () => {
  const corrections = (facts: Fact[]) => facts.filter((f) => f.kind === 'human.correction');

  it('declining a bot\'s plan records a plan-declined correction for that bot and card', async () => {
    const moa = bot('hq', 'moa');
    const s = setup([moa]);
    const posted = await handleRoomPost({ kind: 'plan', title: 'Today', threadId: 'plan:p1' }, asBot(moa), s.deps) as { card: { id: string } };
    expect(await handleRoomResolve({ workspaceId: 'hq', cardId: posted.card.id, resolution: 'decline' }, OPERATOR, s.deps)).toMatchObject({ ok: true });
    expect(corrections(s.facts)).toEqual([expect.objectContaining({
      kind: 'human.correction',
      workspaceId: 'hq',
      actor: { kind: 'human' },
      ref: { botId: moa.id, messageId: posted.card.id },
      payload: { category: 'plan-declined', cardKind: 'plan', botRole: 'moa', threadId: 'plan:p1' },
    })]);
  });

  it('an edited plan is plan-edited with the revision as its note; an approval records nothing', async () => {
    const moa = bot('hq', 'moa');
    const s = setup([moa]);
    const a = await handleRoomPost({ kind: 'plan', title: 'A', threadId: 'plan:a' }, asBot(moa), s.deps) as { card: { id: string } };
    const b = await handleRoomPost({ kind: 'plan', title: 'B', threadId: 'plan:b' }, asBot(moa), s.deps) as { card: { id: string } };
    await handleRoomResolve({ workspaceId: 'hq', cardId: a.card.id, resolution: 'edit:\n1. Lead only\n2. Skip the phone' }, OPERATOR, s.deps);
    await handleRoomResolve({ workspaceId: 'hq', cardId: b.card.id, resolution: 'approve' }, OPERATOR, s.deps);
    const c = corrections(s.facts);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ ref: { messageId: a.card.id }, payload: { category: 'plan-edited', note: '1. Lead only 2. Skip the phone' } });
  });

  it('a declined proposal is proposal-declined', async () => {
    const moa = bot('hq', 'moa');
    const s = setup([moa]);
    const p = await handleRoomPost({ kind: 'proposal', title: 'Lint rule' }, asBot(moa), s.deps) as { card: { id: string } };
    await handleRoomResolve({ workspaceId: 'hq', cardId: p.card.id, resolution: 'Decline' }, OPERATOR, s.deps);
    expect(corrections(s.facts)[0]).toMatchObject({ payload: { category: 'proposal-declined', cardKind: 'proposal' } });
  });

  it('without a fact log, or when it throws, the resolve still succeeds', async () => {
    const moa = bot('hq', 'moa');
    const s = setup([moa]);
    const a = await handleRoomPost({ kind: 'plan', title: 'A' }, asBot(moa), s.deps) as { card: { id: string } };
    const b = await handleRoomPost({ kind: 'plan', title: 'B' }, asBot(moa), s.deps) as { card: { id: string } };
    const noLog: RoomHandlerDeps = { ...s.deps, ports: () => ({ ...s.ports, factLog: undefined }) };
    expect(await handleRoomResolve({ workspaceId: 'hq', cardId: a.card.id, resolution: 'decline' }, OPERATOR, noLog)).toMatchObject({ ok: true, card: { state: 'resolved' } });
    const throwing: RoomHandlerDeps = { ...s.deps, ports: () => ({ ...s.ports, factLog: { ...s.ports.factLog!, append: () => { throw new Error('disk full'); } } }) };
    expect(await handleRoomResolve({ workspaceId: 'hq', cardId: b.card.id, resolution: 'decline' }, OPERATOR, throwing)).toMatchObject({ ok: true, card: { state: 'resolved' } });
    expect(corrections(s.facts)).toEqual([]);
  });

  it('resolutionCorrection: only a bot\'s plan or proposal, never an approval', () => {
    const base = { version: 1 as const, id: 'c1', seq: 1, workspaceId: 'hq', threadId: 'general' as const, at: 1, title: 't' };
    const botActor = { kind: 'bot' as const, workspaceId: 'hq', botId: 'bot-1' };
    expect(resolutionCorrection({ ...base, kind: 'plan', actor: { kind: 'human' } }, 'decline')).toBeNull();
    expect(resolutionCorrection({ ...base, kind: 'status', actor: botActor }, 'decline')).toBeNull();
    expect(resolutionCorrection({ ...base, kind: 'plan', actor: botActor }, 'Approve')).toBeNull();
    expect(resolutionCorrection({ ...base, kind: 'proposal', actor: botActor }, 'please narrow it')).toMatchObject({ category: 'proposal-edited', note: 'please narrow it' });
  });

  it('answering a bot question with any offered option records nothing; an answer outside the options is a question-override', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    const router = new HandoffRouter({ file: path.join(dir, 'factory', HANDOFFS_FILENAME), decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    await router.start();
    setHandoffRouter(router);
    await handleAskPerson({ title: 'Merge?', body: '', threadId: 'task:a', options: ['Merge now', 'Wait'] }, asBot(lead), { router: () => router, signedIn: () => false });
    await handleAskPerson({ title: 'Ship?', body: '', threadId: 'task:b', options: ['Ship', 'Hold'] }, asBot(lead), { router: () => router, signedIn: () => false });
    await handleAskPerson({ title: 'Which?', body: '', threadId: 'task:d', options: ['A', 'B'] }, asBot(lead), { router: () => router, signedIn: () => false });
    await handleAskPerson({ title: 'Name?', body: '', threadId: 'task:c' }, asBot(lead), { router: () => router, signedIn: () => false });
    const q = (thread: string) => s.writer.read('ws1').cards.find((c) => c.kind === 'question' && c.threadId === thread)!;
    await handleRoomResolve({ workspaceId: 'ws1', cardId: q('task:a').id, resolution: ' merge  NOW ' }, OPERATOR, s.deps);
    await handleRoomResolve({ workspaceId: 'ws1', cardId: q('task:b').id, resolution: 'Hold until Monday' }, OPERATOR, s.deps);
    await handleRoomResolve({ workspaceId: 'ws1', cardId: q('task:c').id, resolution: 'wmux' }, OPERATOR, s.deps);
    // The second option is a choice the bot offered, not an override.
    await handleRoomResolve({ workspaceId: 'ws1', cardId: q('task:d').id, resolution: 'B' }, OPERATOR, s.deps);
    expect(corrections(s.facts)).toEqual([expect.objectContaining({
      workspaceId: 'ws1',
      ref: { botId: lead.id, messageId: q('task:b').id },
      payload: { category: 'question-override', cardKind: 'question', botRole: 'lead', threadId: 'task:b', note: 'Hold until Monday' },
    })]);
    router.dispose();
  });

  it('words outside the options answer a question that invites them: the greeting, an "own words" option or wording; no override', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    const router = new HandoffRouter({ file: path.join(dir, 'factory', HANDOFFS_FILENAME), decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    await router.start();
    setHandoffRouter(router);
    // The greeting, asked in the bot's first (intro) wake.
    s.wake.id = { wakeId: 'w-intro', attempt: 1, reasonKind: 'intro' } as never;
    await handleAskPerson({ title: 'Hi, I\'m Lead. What should I do?', body: '', threadId: `dm:${lead.id}`, options: ['Review PRs', 'Triage issues'] }, asBot(lead), { router: () => router, signedIn: () => false });
    s.wake.id = { wakeId: 'w-2', attempt: 1 };
    await handleAskPerson({ title: 'Which branch?', body: '', threadId: 'task:a', options: ['main', 'Something else (tell me)'] }, asBot(lead), { router: () => router, signedIn: () => false });
    await handleAskPerson({ title: 'Where next?', body: 'Pick one, or tell me in your own words.', threadId: 'task:b', options: ['Docs', 'Tests'] }, asBot(lead), { router: () => router, signedIn: () => false });
    await handleAskPerson({ title: 'Ship?', body: '', threadId: 'task:c', options: ['Ship', 'Hold'] }, asBot(lead), { router: () => router, signedIn: () => false });
    const q = (thread: string) => s.writer.read('ws1').cards.find((c) => c.kind === 'question' && c.threadId === thread)!;
    expect(q(`dm:${lead.id}`).greeting).toBe(true);
    await handleRoomResolve({ workspaceId: 'ws1', cardId: q(`dm:${lead.id}`).id, resolution: 'lead this repo' }, OPERATOR, s.deps);
    await handleRoomResolve({ workspaceId: 'ws1', cardId: q('task:a').id, resolution: 'release/4.7' }, OPERATOR, s.deps);
    await handleRoomResolve({ workspaceId: 'ws1', cardId: q('task:b').id, resolution: 'wait for requests' }, OPERATOR, s.deps);
    // Replacing the options of a question that offered only choices is still an override.
    await handleRoomResolve({ workspaceId: 'ws1', cardId: q('task:c').id, resolution: 'Neither, revert it' }, OPERATOR, s.deps);
    expect(corrections(s.facts).map((f) => f.payload)).toEqual([expect.objectContaining({ category: 'question-override', threadId: 'task:c', note: 'Neither, revert it' })]);
    router.dispose();
  });

  it('invitesFreeText: the greeting, a free-text option, or wording that asks for the owner\'s words', () => {
    const ask = (title: string, options: string[], body = '', intro = false) => ({ payload: { title, body, options }, ...(intro ? { intro: true as const } : {}) });
    expect(invitesFreeText(ask('무엇을 할까요?', ['리뷰', '이슈 정리'], '', true))).toBe(true);
    expect(invitesFreeText(ask('Which?', ['A', 'Other']))).toBe(true);
    expect(invitesFreeText(ask('Which?', ['A', 'B', 'Tell me in your own words']))).toBe(true);
    expect(invitesFreeText(ask('Which? Or tell me what you want.', ['A', 'B']))).toBe(true);
    expect(invitesFreeText(ask('Merge?', ['Merge now', 'Wait']))).toBe(false);
    expect(invitesFreeText(ask('Which branch?', ['main', 'the other branch']))).toBe(false);
    expect(invitesFreeText(ask('Which branch?', ['Current branch', 'Other branch']))).toBe(false);
    expect(invitesFreeText(ask('Which approach?', ['Keep it in TypeScript', 'Rewrite it in Rust']))).toBe(false);
    expect(invitesFreeText(ask('Which?', ['A', 'Something else (tell me)']))).toBe(true);
    // Negated wording is no invitation; an affirmative clause beside it still is.
    expect(invitesFreeText(ask('Which?', ['A', 'B'], 'Pick one; do not answer in your own words.'))).toBe(false);
    expect(invitesFreeText(ask('Which? Don\'t tell me what you want, pick one.', ['A', 'B']))).toBe(false);
    expect(invitesFreeText(ask('Which?', ['A', 'Not in your own words']))).toBe(false);
    expect(invitesFreeText(ask('Which?', ['A', 'B'], 'No need for anything else. Or tell me in your own words.'))).toBe(true);
    expect(invitesFreeText(ask('Pick only one, or tell me what you want.', ['A', 'B']))).toBe(true);
  });

  it('an override answered through handoff.answer (the phone path) is recorded too; a dismissal is not', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    const router = new HandoffRouter({ file: path.join(dir, 'factory', HANDOFFS_FILENAME), decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    await router.start();
    setHandoffRouter(router);
    const ask = await handleAskPerson({ title: 'Merge?', body: '', threadId: 'task:a', options: ['Merge now', 'Wait'] }, asBot(lead), { router: () => router, signedIn: () => false }) as { handoffId: string };
    expect(await handleHandoffAnswer({ handoffId: ask.handoffId, answer: 'Wait for CI' }, OPERATOR, { router: () => router, signedIn: () => false })).toMatchObject({ ok: true });
    // 'Wait for CI' is none of the offered options.
    expect(corrections(s.facts)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ category: 'question-override', note: 'Wait for CI' }) })]);
    router.dispose();
  });
});

describe('handoff.* / ask.person auth', () => {
  it('send and ask are a bot\'s; answer and list are the operator\'s; nobody else', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    const router = new HandoffRouter({ file: path.join(dir, 'factory', HANDOFFS_FILENAME), decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    const deps = { router: () => router, signedIn: () => false };
    for (const ctx of [WIRE, undefined]) {
      expect(handleHandoffSend({ kind: 'result', title: 'x', body: '' }, ctx, deps)).toMatchObject({ code: 'not_bot' });
      expect(await handleAskPerson({ title: 'x' }, ctx, deps)).toMatchObject({ code: 'not_bot' });
      expect(await handleHandoffAnswer({ handoffId: 'h', answer: 'a' }, ctx, deps)).toMatchObject({ code: 'not_bot' });
      expect(handleHandoffList({}, ctx, deps)).toMatchObject({ code: 'not_bot' });
    }
    expect(handleHandoffSend({ kind: 'result', title: 'x', body: '' }, OPERATOR, deps)).toMatchObject({ code: 'bot_only' });
    expect(await handleAskPerson({ title: 'x' }, OPERATOR, deps)).toMatchObject({ code: 'bot_only' });
    expect(await handleHandoffAnswer({ handoffId: 'h', answer: 'a' }, asBot(lead), deps)).toMatchObject({ code: 'operator_only' });
    expect(handleHandoffList({}, asBot(lead), deps)).toMatchObject({ code: 'operator_only' });
    expect(handleHandoffList({}, OPERATOR, deps)).toMatchObject({ ok: true, handoffs: [] });
    expect(handleHandoffSend({ kind: 'result', title: 'x', body: '' }, asBot(lead), { router: () => null, signedIn: () => false })).toMatchObject({ code: 'not_started' });
    // ask_person is on every role's surface.
    for (const role of ['lead', 'triage', 'verifier', 'maintainer', 'moa'] as BotRole[]) {
      const b = bot(`ws-${role}`, role);
      expect(await handleAskPerson({ title: `from ${role}` }, asBot(b), deps), role).toMatchObject({ ok: true });
    }
  });
});

describe('the room module closes questions whose subject ended (A5)', () => {
  it('a card that closes its thread closes that thread\'s open questions', () => {
    const lead = bot('ws1', 'lead', { repo: { repoKey: 'github.com/acme/app', repoPath: '/repo' } });
    const subs: Array<(f: Fact) => void> = [];
    const closeThreadQuestions = vi.fn(async () => []);
    setHandoffRouter({ closeThreadQuestions } as unknown as HandoffRouter);
    const mod = createRoomModule({ wmuxDir: () => dir, getMainWindow: () => null }, () => ({
      factLog: { append: () => null, subscribe: (fn: (f: Fact) => void) => { subs.push(fn); return () => undefined; }, readSince: () => ({ facts: [], cursor: null }) },
      bots: { listEnabled: () => [lead], get: (id: string) => (id === lead.id ? lead : null) },
    }) as Partial<FactoryRoomPorts>);
    mod.start?.();
    try {
      const fact = (kind: Fact['kind'], pr: number): Fact => ({ id: `f-${kind}-${pr}`, seq: pr, kind, at: 1, dedupeKey: `${kind}:${pr}`, repoKey: 'github.com/acme/app', ref: { pr, headSha: 'abcdef1' }, payload: {} });
      for (const fn of subs) fn(fact('pr.merged', 3));
      expect(closeThreadQuestions).toHaveBeenCalledWith('ws1', 'pr:github.com/acme/app#3');
      closeThreadQuestions.mockClear();
      // A card that does not close its thread closes nothing.
      for (const fn of subs) fn(fact('verdict.recorded', 4));
      expect(closeThreadQuestions).not.toHaveBeenCalled();
    } finally {
      void mod.dispose?.();
      setHandoffRouter(null);
    }
  });
});

describe('long room card text is shortened as the last step', () => {
  const VALUE = 'zQ9vT2mW8rL4nX6pB1cY3hJ5kD7fG0sE9uA2wR4t';
  const MARK = '[secret:K]';
  beforeEach(() => setRedactedSecrets([{ name: 'K', value: VALUE }]));
  afterEach(() => __resetRedactedSecretsForTesting());

  /** A first line with VALUE across char 200, then a body with VALUE across char 8192. */
  const across = (): { title: string; text: string } => {
    const title = 'a'.repeat(ROOM_TITLE_MAX - 20) + VALUE + 'b'.repeat(30);
    const lead = `${title}\n`;
    return { title, text: lead + 'c'.repeat(ROOM_BODY_MAX - 22 - lead.length) + VALUE + 'd'.repeat(100) };
  };
  const onDisk = (): string => (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile())
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const clean = (x: string): void => {
    expect(x).not.toContain(VALUE.slice(0, 20));
    expect(x).not.toContain(VALUE.slice(20));
  };

  it('a turn\'s long words: processed whole, then shortened, in the card and its file', async () => {
    const dev = bot('ws1', 'maintainer');
    const s = setup([dev]);
    s.wake.thread = `dm:${dev.id}` as ThreadId;
    s.wake.id = { wakeId: 'w-1', attempt: 1 };
    const { text } = across();
    expect(text.indexOf(VALUE)).toBe(ROOM_TITLE_MAX - 20);
    expect(text.lastIndexOf(VALUE)).toBe(ROOM_BODY_MAX - 22);
    await postTurnText(dev, { id: 'w-1' }, text, Date.now() - 1, s.deps);
    const [card] = s.writer.read('ws1', { threadId: `dm:${dev.id}` as ThreadId }).cards;
    expect(card.title).toBe('a'.repeat(ROOM_TITLE_MAX - 20) + MARK + 'b'.repeat(10));
    expect(card.body?.split(MARK)).toHaveLength(3);
    clean(JSON.stringify(card));
    clean(onDisk());
  });

  it('a long question a bot asks: processed whole, then shortened, in the card and the stores', async () => {
    const lead = bot('ws1', 'lead');
    const s = setup([lead]);
    s.ports.currentWakeThread = () => 'general' as never;
    const router = new HandoffRouter({ file: path.join(dir, 'factory', HANDOFFS_FILENAME), decisions: deckDecisionPort(dir), ports: () => s.ports, rooms: () => s.writer, log: () => undefined });
    await router.start();
    try {
      const { title, text } = across();
      const body = text.slice(title.length + 1);
      const asked = await handleAskPerson({ title, body: 'c'.repeat(title.length + 1) + body }, asBot(lead), { router: () => router, signedIn: () => false }) as { ok: boolean };
      expect(asked.ok).toBe(true);
      const [card] = s.writer.read('ws1').cards.filter((c) => c.kind === 'question');
      expect(card.title).toBe('a'.repeat(ROOM_TITLE_MAX - 20) + MARK + 'b'.repeat(10));
      expect(card.body).toContain(MARK);
      clean(JSON.stringify(card));
      clean(onDisk());
    } finally {
      router.dispose();
    }
  });
});

describe('settleMentions', () => {
  it('a post from a wake not known clean names only bots of the poster\'s workspace; a clean post names any', () => {
    const poster = bot('ws1', 'lead');
    const same = bot('ws1', 'triage');
    const far = bot('ws2', 'lead');
    const bots = [poster, same, far];
    const ports = { bots: { listEnabled: () => bots, get: (id: string) => bots.find((b) => b.id === id) ?? null } } as unknown as Partial<FactoryRoomPorts>;
    const binding = { workspaceId: 'ws1', botId: poster.id, role: 'lead' as const };
    expect(settleMentions(ports, binding, [same.id, far.id], true)).toEqual({ valid: [same.id], dropped: [{ botId: far.id, reason: 'other_workspace' }] });
    expect(settleMentions(ports, binding, [same.id, far.id])).toEqual({ valid: [same.id, far.id], dropped: [] });
  });
});

describe('a guest workspace is an island (the owner\'s messages, mentions, fact cards)', () => {
  afterEach(() => __resetGuestWorkspacesForTesting());
  async function island(): Promise<void> {
    const store = new GuestWorkspaceStore({ file: path.join(dir, 'factory', 'guest-workspaces.json'), log: () => undefined });
    store.load();
    await store.add('wsg');
    setGuestWorkspaceStore(store);
  }

  it('the owner naming a bot across the boundary is refused, from the window (room.post), the phone and the operator\'s RPC', async () => {
    await island();
    const g = bot('wsg', 'lead');
    const clean = bot('ws1', 'lead');
    const moa = bot('ws1', 'moa', { template: 'coordinator' });
    const s = setup([g, clean, moa]);
    // From a guest room: a clean bot by mention, by id, by the moa role.
    expect(await handleRoomPost({ workspaceId: 'wsg', kind: 'human', title: 'hi', mentions: [clean.id] }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(postHumanMessage(s.writer, s.ports, { workspaceId: 'wsg', title: 'hi', toBotId: clean.id, source: 'phone' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(postHumanMessage(s.writer, s.ports, { workspaceId: 'wsg', title: 'hi', to: 'moa', source: 'desktop' })).toMatchObject({ ok: false, code: 'invalid' });
    // Into a guest room from elsewhere.
    expect(await handleRoomPost({ workspaceId: 'ws1', kind: 'human', title: 'hi', mentions: [g.id] }, OPERATOR, s.deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(s.wakes).toEqual([]);
    expect(s.writer.read('wsg', { guests: true }).cards).toEqual([]);
    // Inside the guest room the owner reaches its bot.
    expect(await handleRoomPost({ workspaceId: 'wsg', kind: 'human', title: 'hi', mentions: [g.id] }, OPERATOR, s.deps)).toMatchObject({ ok: true });
    expect(s.wakes.map((w) => w.botId)).toEqual([g.id]);
  });

  it('a bot\'s card names no bot across the boundary, whatever its wake', async () => {
    await island();
    const g = bot('wsg', 'lead');
    const clean = bot('ws1', 'lead');
    const s = setup([g, clean]);
    expect(settleMentions(s.ports, { workspaceId: 'ws1', botId: clean.id, role: 'lead' }, [g.id]).dropped).toEqual([{ botId: g.id, reason: 'other_workspace' }]);
    expect(settleMentions(s.ports, { workspaceId: 'wsg', botId: g.id, role: 'lead' }, [clean.id]).dropped).toEqual([{ botId: clean.id, reason: 'other_workspace' }]);
  });

  it('a fact\'s cards across the boundary stay in the fact\'s own room; a repository\'s rooms skip a guest workspace', async () => {
    await island();
    expect(islandRooms(['ws1', 'ws2'], 'ws1')).toEqual(['ws1', 'ws2']);
    expect(islandRooms(['ws1', 'wsg'], 'wsg')).toEqual(['wsg']);
    expect(islandRooms(['wsg', 'ws1'], 'ws1')).toEqual(['ws1']);
    expect(islandRooms(['wsg', 'ws1'], undefined)).toEqual([]);
    const s = setup([]);
    const refused: Fact = {
      id: 'f-r', seq: 1, dedupeKey: 'r', kind: 'handoff.refused', at: 1, workspaceId: 'wsg', ref: { handoffId: 'h-1' }, actor: { kind: 'system' },
      payload: { title: 'guest words', fromWorkspaceId: 'wsg', toWorkspaceId: 'ws1', code: 'no_addressee', detail: 'x' },
    };
    writeFactCards(s.writer, refused);
    expect(s.writer.read('wsg', { guests: true }).cards).toHaveLength(1);
    expect(s.writer.read('ws1', { guests: true }).cards).toHaveLength(0);
  });

  it('a plan answered in a room wakes no author across the boundary', async () => {
    await island();
    const clean = bot('ws1', 'moa', { template: 'coordinator' });
    const wake = vi.fn();
    const card = { version: 1, id: 'c-p', seq: 1, workspaceId: 'wsg', threadId: 'plan:p-1', kind: 'plan', at: 1, actor: { kind: 'bot', workspaceId: 'ws1', botId: clean.id }, title: 'Plan' } as RoomCard;
    expect(routePlanAnswer({ workspaceId: 'wsg', card, resolution: 'approve' }, { bots: () => ({ listEnabled: () => [clean], get: () => clean }), wake })).toBe('ignored');
    expect(wake).not.toHaveBeenCalled();
  });
});

