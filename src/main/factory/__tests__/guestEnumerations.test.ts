// A guest workspace is an island (guestWorkspaces.ts), held at chokepoints
// rather than per path. This file proves it is structural:
//
//   - Every caller in src/main of a bot list (BotDirectoryApi.listEnabled,
//     listEnabledIncludingGuest / enabledBotsIncludingGuest, a bot store's
//     list or listRemoved) and of a room read (RoomWriter read, find, get,
//     threads, summary) is in one of the two tables below, keyed by
//     `file#enclosingFunction`, with why it keeps the island. A new caller,
//     or a table entry no caller has any more, fails here.
//   - One test per derived path a chokepoint closes: the gardener's
//     proposals, the morning report, and reads across threads and
//     workspaces.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotProfile } from '../../../shared/bot';
import type { Fact } from '../../../shared/facts';
import type { RpcContext } from '../../../shared/rpc';
import { GuestWorkspaceStore, __resetGuestWorkspacesForTesting, setGuestWorkspaceStore } from '../guestWorkspaces';
import { BotStore, botsFilePath } from '../botStore';
import { Gardener, correctionGroups } from '../gardener';
import { buildMorningData } from '../morningReport';
import { RoomWriter, type FactoryRoomPorts } from '../roomWriter';
import { WakeTaint } from '../wakeTaint';
import { handleRoomRead } from '../../pipe/handlers/room.rpc';

// ── The tables ─────────────────────────────────────────────────────────────

type Why =
  /** Reads `listEnabled`, which leaves guest workspaces' bots out. */
  | { kind: 'closed'; why?: string }
  /** Skips guest workspaces itself (on top of `listEnabled`, or instead). */
  | { kind: 'guest-skip'; why: string }
  /** Reads one workspace (or one card of it), named by why. */
  | { kind: 'one-workspace'; why: string }
  /** The owner's own surface (the window, the phone): the owner reads all. */
  | { kind: 'owner'; why: string }
  /** Needs guest workspaces' bots: why, and where the boundary is held. */
  | { kind: 'including-guest'; why: string }
  /** Another store's `list` (not a bot list). */
  | { kind: 'not-bots'; why: string };

const BOT_LIST_CALLERS: Record<string, Why> = {
  'src/main/factory/BotRuntime.ts#BotRuntime.prompt': { kind: 'one-workspace', why: 'the roster of the woken bot\'s own workspace' },
  'src/main/factory/BotRuntime.ts#BotRuntime.sweepBudgetParks': { kind: 'one-workspace', why: 'each bot\'s own park; reads nothing of another' },
  'src/main/factory/BotRuntime.ts#BotRuntime.sweepLimitParks': { kind: 'one-workspace', why: 'each bot\'s own park; reads nothing of another' },
  'src/main/factory/approvals.ts#ApprovalService.noRule': { kind: 'closed', why: 'reviewers on a repository; a guest workspace has none' },
  'src/main/factory/approvals.ts#ApprovalService.onMerged': { kind: 'guest-skip', why: 'repo-keyed watchers skip guest workspaces' },
  'src/main/factory/approvals.ts#ApprovalService.onOwnerCard': { kind: 'closed', why: 'the room\'s own bots, of a request no guest wake can make' },
  'src/main/factory/botCreate.ts#botRepoFromFolder': { kind: 'one-workspace', why: 'the repository of the workspace a bot is added to' },
  'src/main/factory/botCreate.ts#missing': { kind: 'one-workspace', why: 'the team roles the workspace a team is added to already has' },
  'src/main/factory/botCreate.ts#refusal':{ kind: 'one-workspace', why: 'names in the workspace a team is added to; BotStore.create holds the rules' },
  'src/main/factory/botCreate.ts#workspaceRepo': { kind: 'one-workspace', why: 'the repository of one workspace' },
  'src/main/factory/botStore.ts#enabledBotsIncludingGuest': { kind: 'including-guest', why: 'the helper itself' },
  'src/main/factory/botWorkflowModule.ts#registerWorkflowRpc': { kind: 'not-bots', why: 'the workflow store, by the bot and its workspace' },
  'src/main/factory/factoryWiring.ts#factoryPhoneMessage': { kind: 'including-guest', why: 'the owner\'s phone message; postHumanMessage holds the boundary' },
  'src/main/factory/factoryWiring.ts#handBackWorkerRuns': { kind: 'not-bots', why: 'bot ids for each bot\'s own worker-time runs, no profile read' },
  'src/main/factory/factoryWiring.ts#refreshLogin': { kind: 'closed', why: 'a repository checkout for the gh login' },
  'src/main/factory/factoryWiring.ts#start': { kind: 'not-bots', why: 'bot ids for the room file store\'s sweep, no profile read' },
  'src/main/factory/gardener.ts#Gardener.maintainerFor': { kind: 'guest-skip', why: 'skips guest workspaces\' maintainers and proposal workspaces' },
  'src/main/factory/guestMessage.ts#conversationBots': { kind: 'including-guest', why: 'the guest\'s own conversation, inside its workspace (the group path checks the workspace)' },
  'src/main/factory/handoffRouter.ts#HandoffRouter.leadOf': { kind: 'including-guest', why: 'one workspace\'s own lead; deliver holds the boundary' },
  'src/main/factory/humanMessage.ts#enabledBots': { kind: 'including-guest', why: 'the owner\'s message; postHumanMessage refuses a crossing addressee' },
  'src/main/factory/mergeLaneHost.ts#MergeLaneHost.botsOn': { kind: 'guest-skip', why: 'repo-keyed; skips guest workspaces' },
  'src/main/factory/mergeLaneHost.ts#productionHost': { kind: 'guest-skip', why: 'repo-keyed busy check skips guest workspaces (store.list is the lane log)' },
  'src/main/factory/morningReport.ts#enabled': { kind: 'guest-skip', why: 'buildMorningData skips guest workspaces\' bots, facts and rooms' },
  'src/main/factory/repoWatch.ts#RepoWatch.reconcile': { kind: 'guest-skip', why: 'repo-keyed; skips guest workspaces' },
  'src/main/factory/roomWriter.ts#factRooms': { kind: 'guest-skip', why: 'a repository\'s rooms skip guest workspaces' },
  'src/main/factory/triggerEngine.ts#TriggerEngine.route': { kind: 'closed', why: 'fact wakes; botSeesFact holds the island too' },
  'src/main/factory/workerLifecycleHost.ts#runningBotNames': { kind: 'owner', why: 'names in the owner\'s quit dialog' },
  'src/main/factory/workerLifecycleHost.ts#startWorkerLifecycle': { kind: 'not-bots', why: 'bot ids for each bot\'s own worker-time runs, no profile read' },
  'src/main/ipc/handlers/factory.handler.ts#factoryBotRows': { kind: 'owner', why: 'the owner\'s Bots page' },
  'src/main/ipc/handlers/guestBots.handler.ts#defaultGuestWorkspacePorts': { kind: 'owner', why: 'the owner flagging one workspace checks its bots' },
  'src/main/ipc/handlers/room.handler.ts#registerRoomIpcHandlers': { kind: 'owner', why: 'the owner\'s room view' },
  'src/main/phone/PhoneFactory.ts#defaultPhoneFactoryPorts': { kind: 'owner', why: 'the owner\'s phone' },
  'src/main/pipe/handlers/bot.rpc.ts#botRuntimeModule': { kind: 'one-workspace', why: 'each bot\'s own queued wakes at start' },
  'src/main/pipe/handlers/bot.rpc.ts#registerBotRpcHandlers': { kind: 'guest-skip', why: 'bot.list: a bot lists only its side of the boundary' },
  'src/main/pipe/handlers/botSecret.rpc.ts#handleSecretList': { kind: 'not-bots', why: 'the secret store' },
  'src/main/pipe/handlers/botSecret.rpc.ts#registerSecretIpc': { kind: 'not-bots', why: 'the secret store' },
  'src/main/pipe/handlers/connector.rpc.ts#existingBotIds': { kind: 'owner', why: 'bot ids for the owner\'s connector grants' },
  'src/main/pipe/handlers/connector.rpc.ts#listConnectors': { kind: 'not-bots', why: 'the connector store' },
  'src/main/pipe/handlers/connector.rpc.ts#removeConnector': { kind: 'not-bots', why: 'the connector store' },
  'src/main/pipe/handlers/connector.rpc.ts#saveConnector': { kind: 'not-bots', why: 'the connector store' },
  'src/main/pipe/handlers/connector.rpc.ts#start': { kind: 'not-bots', why: 'the connector store' },
  'src/main/pipe/handlers/factoryRead.rpc.ts#enabledBots': { kind: 'closed', why: 'plan leads and repositories; plan.propose refuses a crossing item' },
  'src/main/pipe/handlers/group.rpc.ts#botRefs': { kind: 'owner', why: 'bot refs for the owner\'s group chats' },
  'src/main/pipe/handlers/group.rpc.ts#listGroups': { kind: 'not-bots', why: 'the group store' },
  'src/main/pipe/handlers/group.rpc.ts#start': { kind: 'not-bots', why: 'the group store' },
  'src/main/pipe/handlers/routine.rpc.ts#registerRoutineHandlers': { kind: 'not-bots', why: 'the routine store, by one bot' },
  'src/main/pipe/handlers/skill.rpc.ts#registerSkillHandlers': { kind: 'not-bots', why: 'the skill store, by one bot' },
  'src/main/pipe/handlers/skill.rpc.ts#registerSkillIpc': { kind: 'not-bots', why: 'the skill store, by one bot' },
};

const ROOM_READ_CALLERS: Record<string, Why> = {
  'src/main/factory/approvals.ts#ApprovalService.closeCard': { kind: 'one-workspace', why: 'the request\'s own card' },
  'src/main/factory/approvals.ts#ApprovalService.onFact': { kind: 'one-workspace', why: 'the request\'s own card' },
  'src/main/factory/approvals.ts#ApprovalService.onMerged': { kind: 'guest-skip', why: 'the request\'s card; repo watchers skip guest workspaces' },
  'src/main/factory/approvals.ts#ApprovalService.onOwnerCard': { kind: 'one-workspace', why: 'the owner card\'s own room' },
  'src/main/factory/approvals.ts#ApprovalService.ownerTexts': { kind: 'one-workspace', why: 'the request\'s own thread' },
  'src/main/factory/approvals.ts#ApprovalService.reopenCard': { kind: 'one-workspace', why: 'the request\'s own card' },
  'src/main/factory/approvals.ts#ApprovalService.speakersAfter': { kind: 'guest-skip', why: 'a request\'s room or a repo watcher\'s (guest workspaces skipped)' },
  'src/main/factory/approvals.ts#ApprovalService.tellDecided': { kind: 'one-workspace', why: 'the request\'s own card' },
  'src/main/factory/factoryWiring.ts#contextPorts': { kind: 'one-workspace', why: 'the woken bot\'s own room' },
  'src/main/factory/factoryWiring.ts#factoryPhoneMessage': { kind: 'owner', why: 'the owner\'s phone message, in its target room' },
  'src/main/factory/factoryWiring.ts#start': { kind: 'one-workspace', why: 'a bot\'s own card for its turn text' },
  'src/main/factory/factoryWiring.ts#threadTail': { kind: 'one-workspace', why: 'the woken bot\'s own thread; guest cards only for a guest wake' },
  'src/main/factory/factoryWiring.ts#wakeImagesOf': { kind: 'one-workspace', why: 'the woken bot\'s own room' },
  'src/main/factory/guestMessage.ts#postGuestMessage': { kind: 'one-workspace', why: 'the guest\'s own flagged workspace' },
  'src/main/factory/handoffRouter.ts#HandoffRouter.closeOwnQuestion': { kind: 'one-workspace', why: 'the question\'s own room' },
  'src/main/factory/handoffRouter.ts#HandoffRouter.pointToThread': { kind: 'one-workspace', why: 'the coordinator\'s own room (never a guest workspace)' },
  'src/main/factory/handoffRouter.ts#HandoffRouter.questionCardId': { kind: 'one-workspace', why: 'the asking bot\'s own room' },
  'src/main/factory/handoffRouter.ts#HandoffRouter.requestCardOf': { kind: 'one-workspace', why: 'the opening hop\'s own room' },
  'src/main/factory/humanMessage.ts#linkedGroup': { kind: 'one-workspace', why: 'the owner message\'s own thread, in its own room' },
  'src/main/factory/humanMessage.ts#waitingOnOwner': { kind: 'one-workspace', why: 'the owner message\'s own thread: who asked the owner there' },
  'src/main/factory/morningReport.ts#buildMorningData': { kind: 'guest-skip', why: 'skips guest workspaces\' rooms' },
  'src/main/factory/roomWriter.ts#wakeReplyTo': { kind: 'one-workspace', why: 'a card of the poster\'s own room' },
  'src/main/ipc/handlers/guestBots.handler.ts#registerGuestBotHandlers': { kind: 'owner', why: 'the owner adding a guest reads the conversation\'s last seq' },
  'src/main/ipc/handlers/room.handler.ts#cardFile': { kind: 'owner', why: 'the owner\'s room view' },
  'src/main/ipc/handlers/room.handler.ts#registerRoomIpcHandlers': { kind: 'owner', why: 'the owner\'s room view' },
  'src/main/ipc/handlers/room.handler.ts#roomPhoto': { kind: 'owner', why: 'the owner\'s room view' },
  'src/main/ipc/handlers/room.handler.ts#run': { kind: 'owner', why: 'the owner\'s room view' },
  'src/main/phone/PhoneFactory.ts#conversationWork': { kind: 'owner', why: 'the owner\'s phone' },
  'src/main/phone/PhoneFactory.ts#handlePhoneRoomCommand': { kind: 'owner', why: 'the owner\'s phone; a guest\'s read goes through handleGuestCards, flag checked' },
  'src/main/phone/PhoneFactory.ts#newestMessage': { kind: 'owner', why: 'the owner\'s phone' },
  'src/main/phone/PhoneFactory.ts#openQuestionsIn': { kind: 'owner', why: 'the owner\'s phone' },
  'src/main/phone/PhoneFactory.ts#phoneFactoryState': { kind: 'owner', why: 'the owner\'s phone' },
  'src/main/phone/PhoneFactory.ts#phoneRoomAttachment': { kind: 'owner', why: 'the owner\'s phone' },
  'src/main/phone/PhoneFactory.ts#threads': { kind: 'owner', why: 'the owner\'s phone' },
  'src/main/pipe/handlers/botSecret.rpc.ts#openRequestCard': { kind: 'one-workspace', why: 'the request\'s own card' },
  'src/main/pipe/handlers/factoryRead.rpc.ts#handlePlanPropose': { kind: 'one-workspace', why: 'the proposing bot\'s own room' },
  'src/main/pipe/handlers/group.rpc.ts#ownerWroteInRoom': { kind: 'owner', why: 'whether the owner wrote in a room' },
  'src/main/pipe/handlers/room.rpc.ts#handleRoomPost': { kind: 'one-workspace', why: 'the poster\'s own room' },
  'src/main/pipe/handlers/room.rpc.ts#handleRoomRead': { kind: 'guest-skip', why: 'readableWorkspace: a Coordinator never reads a guest workspace\'s room' },
  'src/main/pipe/handlers/room.rpc.ts#handleRoomResolve': { kind: 'owner', why: 'the operator\'s resolve' },
  'src/main/pipe/handlers/room.rpc.ts#handleRoomThreads': { kind: 'owner', why: 'operator only' },
  'src/main/pipe/handlers/room.rpc.ts#postTurnText': { kind: 'one-workspace', why: 'the bot\'s own room' },
};

// ── The scan ───────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../../../..');
const BOT_ALWAYS = new Set(['listEnabled', 'listEnabledIncludingGuest']);
const BOT_LIST = new Set(['list', 'listRemoved']);
const ROOM_READS = new Set(['read', 'find', 'get', 'threads', 'summary']);

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__') sources(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** The nearest named function, method or function-valued variable. */
function enclosing(n: ts.Node): string {
  for (let p = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) {
      const cls = ts.isMethodDeclaration(p) && ts.isClassDeclaration(p.parent) && p.parent.name ? `${p.parent.name.text}.` : '';
      return cls + p.name.getText();
    }
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
  }
  return '<module>';
}

function scan(): { bots: Set<string>; rooms: Set<string> } {
  const bots = new Set<string>();
  const rooms = new Set<string>();
  for (const file of sources(path.join(ROOT, 'src/main'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/listEnabled|enabledBotsIncludingGuest|\.list(Removed)?\(|\.(read|find|get|threads|summary)\(/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const importsBotStore = /botStore'/.test(text);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const key = `${rel}#${enclosing(n)}`;
        if (ts.isIdentifier(n.expression) && n.expression.text === 'enabledBotsIncludingGuest' && !rel.endsWith('/botStore.ts')) bots.add(key);
        if (ts.isPropertyAccessExpression(n.expression)) {
          const name = n.expression.name.text;
          // `x()?.y` and `x?.y` read as `x`.
          const recv = n.expression.expression.getText(sf).replace(/(\(\))?\??$/, '').replace(/(\(\))?\??$/, '');
          if (BOT_ALWAYS.has(name) || (BOT_LIST.has(name) && (/bot/i.test(recv) || (importsBotStore && /(^|\.)store$/.test(recv))))) bots.add(key);
          if (ROOM_READS.has(name) && /(writer|rooms|getRoomWriter)$/i.test(recv) && !(rel.endsWith('/roomWriter.ts') && recv.startsWith('this.'))) rooms.add(key);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { bots, rooms };
}

describe('every bot list and room read in main keeps the island', () => {
  const found = scan();
  it('every bot-list caller is in the table with its reason, and no entry is stale', () => {
    expect([...found.bots].filter((k) => !(k in BOT_LIST_CALLERS)), 'add these to BOT_LIST_CALLERS').toEqual([]);
    expect(Object.keys(BOT_LIST_CALLERS).filter((k) => !found.bots.has(k)), 'no caller any more').toEqual([]);
  });
  it('every room-read caller is in the table with its reason, and no entry is stale', () => {
    expect([...found.rooms].filter((k) => !(k in ROOM_READ_CALLERS)), 'add these to ROOM_READ_CALLERS').toEqual([]);
    expect(Object.keys(ROOM_READ_CALLERS).filter((k) => !found.rooms.has(k)), 'no caller any more').toEqual([]);
  });
  it('each entry says why', () => {
    for (const [k, w] of [...Object.entries(BOT_LIST_CALLERS), ...Object.entries(ROOM_READ_CALLERS)]) {
      if (w.kind !== 'closed') expect(w.why.length, k).toBeGreaterThan(0);
    }
  });
});

// ── The closed paths ───────────────────────────────────────────────────────

let dir = '';
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-island-'));
  const store = new GuestWorkspaceStore({ file: path.join(dir, 'factory', 'guest-workspaces.json'), log: () => undefined });
  store.load();
  await store.add('ws-g');
  setGuestWorkspaceStore(store);
});
afterEach(() => {
  __resetGuestWorkspacesForTesting();
  fs.rmSync(dir, { recursive: true, force: true });
});

function bot(id: string, ws: string, over: Partial<BotProfile> = {}): BotProfile {
  return {
    version: 1, id, workspaceId: ws, role: 'lead', template: 'developer', name: id, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerDay: 1, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 }, enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
}
const fact = (id: string, over: Partial<Fact>): Fact => ({ id, seq: 1, dedupeKey: id, kind: 'human.correction', at: 1, payload: {}, ...over } as Fact);

describe('the bot store lists guest workspaces\' bots only when asked', () => {
  it('listEnabled leaves them out; listEnabledIncludingGuest has them', async () => {
    const s = new BotStore(botsFilePath(dir));
    const g = s.create({ workspaceId: 'ws-g', template: 'developer' });
    const a = s.create({ workspaceId: 'ws-a', template: 'developer' });
    if (!g.ok || !a.ok) throw new Error('not made');
    expect(s.listEnabled().map((b) => b.id)).toEqual([a.bot.id]);
    expect(s.listEnabledIncludingGuest().map((b) => b.id).sort()).toEqual([g.bot.id, a.bot.id].sort());
    // A workspace that cannot be told is left out too.
    const unknown = new BotStore(botsFilePath(dir), { guestWorkspace: () => 'unknown' });
    unknown.create({ workspaceId: 'ws-x', template: 'developer' });
    expect(unknown.listEnabled()).toEqual([]);
    await s.flush();
    await unknown.flush();
  });
});

describe('a gardener proposal never carries a guest workspace\'s words', () => {
  it('its corrections and maintainers skip guest workspaces; an answer in one wakes its own bot as a guest wake', () => {
    const g = bot('bot-0000000a', 'ws-g');
    const directory = { listEnabled: () => [g], get: (id: string) => (id === g.id ? g : null) };
    const facts = [1, 2, 3].map((n) => fact(`f-${n}`, { workspaceId: 'ws-g', ref: { botId: g.id, messageId: `c-${n}` }, payload: { category: 'plan-declined', note: 'guest words' } }));
    expect(correctionGroups(facts, directory, 3)).toEqual([]);
    // Joining a group clean corrections already made, it stays out of it.
    const clean = [1, 2].map((n) => fact(`f-c${n}`, { workspaceId: 'ws-a', ref: { botId: 'bot-0000000b', messageId: `c-c${n}` }, payload: { category: 'plan-declined' } }));
    const mixed = correctionGroups([...clean, facts[0]], { listEnabled: () => [], get: () => null }, 2);
    expect(mixed.flatMap((g) => g.factIds)).toEqual(['f-c1', 'f-c2']);
    expect(JSON.stringify(mixed)).not.toContain('guest words');
    const wake = vi.fn(() => ({ id: 'w' }));
    const gardener = new Gardener({ factLog: () => null, bots: () => ({ listEnabled: () => [bot('bot-0000000m', 'ws-g', { role: 'maintainer' })], get: () => null }), wake, factoryDir: path.join(dir, 'factory') });
    expect(gardener.maintainerFor({ key: 'k', at: 1, factIds: [], workspaceIds: ['ws-g'] }, null)).toBeNull();
    // The answer to a guest workspace bot's proposal, given in its room:
    // the wake is its own, in the island, and runs as a guest wake.
    const answered = new Gardener({ factLog: () => null, bots: () => directory, wake, factoryDir: path.join(dir, 'factory') });
    const card = { version: 1, id: 'c-p', seq: 1, workspaceId: 'ws-g', threadId: 'general', kind: 'proposal', at: 1, actor: { kind: 'bot', workspaceId: 'ws-g', botId: g.id }, title: 'p' } as const;
    expect(answered.onCardResolved({ workspaceId: 'ws-g', card: card as never, resolution: 'approve' })).toBe('moa');
    const queued = (wake.mock.calls.at(-1) as unknown as [{ botId: string; workspaceId: string; reason: never }])[0];
    expect(queued.workspaceId).toBe('ws-g');
    const taint = new WakeTaint({ facts: () => [], handoff: () => null, taskRow: () => null, runningWake: () => null, bot: () => g, log: () => undefined });
    expect(taint.wakeGuest({ botId: queued.botId, workspaceId: queued.workspaceId, reason: queued.reason })).toBe(true);
    // Given from another room, it wakes nobody.
    expect(answered.onCardResolved({ workspaceId: 'ws-a', card: card as never, resolution: 'approve' })).toBe('ignored');
  });
});

describe('the morning report reads no guest workspace', () => {
  it('leaves out guest workspaces\' bots, facts and rooms', async () => {
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), log: () => undefined });
    writer.append({ workspaceId: 'ws-g', threadId: 'task:t-1' as never, kind: 'status', actor: { kind: 'system' }, title: 'guest words' });
    const g = bot('bot-0000000a', 'ws-g');
    const a = bot('bot-0000000b', 'ws-a');
    const facts = [fact('f-1', { kind: 'task.failed', workspaceId: 'ws-g', ref: { taskId: 't-1' } }), fact('f-2', { kind: 'merge.done', workspaceId: 'ws-g', ref: { pr: 1 } })];
    const d = await buildMorningData({
      factLog: () => ({ append: () => null, subscribe: () => () => undefined, readSince: () => ({ facts, cursor: null }) }),
      // A directory that does not leave them out itself.
      bots: () => ({ listEnabled: () => [g, a], get: () => null }),
      rooms: () => writer,
      trust: async () => { throw new Error('no repo'); },
      repoKeyOf: async () => null,
      now: () => 10,
    });
    expect(JSON.stringify(d)).not.toContain('guest words');
    expect(d.rooms.map((r) => r.workspaceId)).toEqual(['ws-a']);
    expect(d.mergedCount).toBe(0);
    expect(d.blocked).toEqual([]);
  });
});

describe('reads across threads and workspaces stop at the boundary', () => {
  it('a Coordinator reads no guest workspace\'s room; a guest workspace\'s bot reads its whole own room', async () => {
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms'), log: () => undefined });
    writer.append({ workspaceId: 'ws-g', threadId: 'general', kind: 'status', actor: { kind: 'system' }, title: 'in the island' });
    writer.append({ workspaceId: 'ws-g', threadId: 'dm:bot-0000000a', kind: 'status', actor: { kind: 'system' }, title: 'another thread' });
    const coord = bot('bot-0000000c', 'ws-hq', { role: 'moa', template: 'coordinator' });
    const g = bot('bot-0000000a', 'ws-g');
    const ports = { bots: { listEnabled: () => [coord, g], get: (id: string) => [coord, g].find((b) => b.id === id) ?? null } } as unknown as Partial<FactoryRoomPorts>;
    const deps = { writer: () => writer, ports: () => ports, wmuxDir: () => dir };
    const as = (b: BotProfile): RpcContext => ({ origin: 'local', bot: { workspaceId: b.workspaceId, botId: b.id, role: b.role } });
    expect(handleRoomRead({ workspaceId: 'ws-g' }, as(coord), deps)).toMatchObject({ ok: false, code: 'cross_workspace' });
    const own = handleRoomRead({}, as(g), deps) as { cards: Array<{ title: string }> };
    expect(own.cards.map((c) => c.title)).toEqual(['in the island', 'another thread']);
    expect(handleRoomRead({ workspaceId: 'ws-a' }, as(g), deps)).toMatchObject({ ok: false, code: 'cross_workspace' });
  });
});
