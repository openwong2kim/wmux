// @vitest-environment jsdom
//
// Room card and composer polish: proposals answered in place, the composer
// naming the real bot it queued for, and the merge lane rows of
// Settings › Factory.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import type { RoomCard as RoomCardData } from '../../../../shared/room';
import type { BotProfile, BotStatus } from '../../../../shared/bot';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import { setRoomsApiForTests, type RoomsApi } from '../../../hooks/useRoomSync';
import { RoomCard, PROPOSAL_RESOLUTION } from '../RoomCard';
import { RoomComposer, deliveryLine, deliveryTaken, predictedAddressees, sentFrom } from '../RoomComposer';
import { FactoryTab, parseDailyCap } from '../../Settings/FactoryTab';
import {
  setFactoryBotPort,
  setFactorySettingsPort,
  type FactoryBotPort,
  type FactoryBotRow,
  type FactorySettingsPort,
  type FactorySettingsView,
} from '../factoryPorts';

const WS = 'ws-a';
const HQ = 'ws-hq';
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({
    roomStatus: null, roomThreads: {}, roomTimelines: {}, roomSelectedThread: {}, roomReadThrough: {}, roomPushCount: 0, roomPushedAt: {},
    activeWorkspaceId: '', settingsInitialTab: null,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  setRoomsApiForTests(undefined);
  setFactorySettingsPort(null);
  setFactoryBotPort(null);
});

async function render(el: React.ReactElement) {
  await act(async () => root.render(el));
}

function card(seq: number, over: Partial<RoomCardData> = {}): RoomCardData {
  return { version: 1, id: `c${seq}`, seq, workspaceId: WS, threadId: 'general', kind: 'status', at: 1, actor: { kind: 'system' }, title: `card ${seq}`, ...over };
}

function bot(id: string, over: Partial<BotProfile> = {}): BotProfile {
  return {
    version: 1, id, workspaceId: WS, role: 'lead', name: `Bot ${id}`, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
}

function running(botId: string, wakeId: string): BotStatus {
  return { botId, presence: 'running', currentTurn: { wakeId, startedAt: 1 }, queueDepth: 0, budgetLeft: { turnsHour: 1, turnsDay: 1, workerHoursDay: 1 } };
}

function fakeApi(over: Record<string, unknown> = {}) {
  const api = {
    status: vi.fn(async () => ({ running: true, enabled: true, hqWorkspaceId: null })),
    threads: vi.fn(async () => ({ ok: true, workspaceId: WS, threads: [] })),
    read: vi.fn(async () => ({ ok: true, workspaceId: WS, threadId: null, cards: [], nextSinceSeq: 0, hasMore: false })),
    post: vi.fn(async () => ({ ok: true, card: card(9), addressee: null })),
    resolve: vi.fn(async () => ({ ok: true, card: card(1) })),
    decision: vi.fn(async () => ({ decision: null })),
    actors: vi.fn(async () => ({ actors: {} })),
    onEvent: vi.fn(() => () => undefined),
  };
  return Object.assign(api, over) as typeof api;
}

const VIEW: FactorySettingsView = {
  version: 1, enabled: true, hqWorkspaceId: null, trustedAuthors: [], morning: { hour: 9, weekdays: [1] },
  verifierOnOwnerPrs: true, defaultEngine: { kind: 'claude-sdk' }, globalConcurrentBots: 2, laneAutoMerge: false, laneDailyCap: 5,
};

function settingsPort(view: FactorySettingsView = VIEW, available = true) {
  const port = {
    available,
    get: vi.fn(async () => view),
    set: vi.fn(async (p: Partial<FactorySettingsView>) => ({ ...view, ...p })),
  };
  return port as typeof port & FactorySettingsPort;
}

const NO_BOTS: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }) };

describe('proposal cards', () => {
  it('an open proposal from a bot is approved or declined in place through room:resolve', async () => {
    const api = fakeApi();
    const proposal = card(4, { kind: 'proposal', state: 'open', title: 'Add a lint rule', actor: { kind: 'bot', workspaceId: HQ, botId: 'bot-1' } });
    await render(createElement(RoomCard, { card: proposal, workspaceId: HQ, t, bots: [], roomsBridge: api as unknown as RoomsApi }));
    const decline = container.querySelector<HTMLButtonElement>('[data-testid="room-proposal-decline"]')!;
    // Both secondary: the room's one primary is the HQ plan's Approve.
    expect(decline.className).not.toContain('ui-btn-primary');
    expect(container.querySelector('[data-testid="room-proposal-approve"]')?.className).not.toContain('ui-btn-primary');
    await act(async () => decline.click());
    expect(api.resolve).toHaveBeenCalledWith({ workspaceId: HQ, cardId: 'c4', resolution: PROPOSAL_RESOLUTION.decline });
  });

  it('a resolved proposal, or one no bot wrote, has no answers', async () => {
    const api = fakeApi();
    await render(createElement('div', null,
      createElement(RoomCard, { card: card(5, { kind: 'proposal', state: 'resolved', actor: { kind: 'bot', workspaceId: HQ, botId: 'bot-1' } }), workspaceId: HQ, t, bots: [], roomsBridge: api as unknown as RoomsApi }),
      createElement(RoomCard, { card: card(6, { kind: 'proposal', state: 'open', actor: { kind: 'system' } }), workspaceId: HQ, t, bots: [], roomsBridge: api as unknown as RoomsApi }),
    ));
    expect(container.querySelector('[data-testid="room-proposal-decline"]')).toBeNull();
  });
});

describe('composer: the real bot it queued for', () => {
  const lead: FactoryBotRow = { bot: bot('bot-lead', { name: 'Ada' }), status: running('bot-lead', 'w-other') };
  const moa: FactoryBotRow = { bot: bot('bot-moa', { name: 'Moa HQ', role: 'moa', workspaceId: HQ }), status: null };

  it('queued only behind a turn other than the one the message woke; several addressees are named or counted', () => {
    expect(deliveryLine([{ botId: 'bot-lead', role: 'lead', wakeId: 'w-mine' }], [lead], t)).toBe('room.composer.queuedFor(name=Ada)');
    const runningMine = { ...lead, status: running('bot-lead', 'w-mine') };
    expect(deliveryLine([{ botId: 'bot-lead', role: 'lead', wakeId: 'w-mine' }], [runningMine], t)).toBe('room.composer.sentTo(name=Ada)');
    // Taken up once, a later turn of the bot does not re-queue the message.
    expect(deliveryLine([{ botId: 'bot-lead', role: 'lead', wakeId: 'w-mine' }], [lead], t, true)).toBe('room.composer.sentTo(name=Ada)');
    // Taken up: running the turn it woke, or idle with nothing queued on a
    // read after the send (a read from before it proves nothing).
    const mine = [{ botId: 'bot-lead', role: 'lead' as const, wakeId: 'w-mine' }];
    expect(deliveryTaken(mine, [runningMine], false)).toBe(true);
    expect(deliveryTaken(mine, [lead], true)).toBe(false);
    const idle = { ...lead, status: { ...lead.status!, currentTurn: undefined, queueDepth: 0 } };
    expect(deliveryTaken(mine, [idle], false)).toBe(false);
    expect(deliveryTaken(mine, [idle], true)).toBe(true);
    expect(deliveryTaken([{ botId: 'bot-lead', role: 'lead' }], [idle], true)).toBe(false);
    expect(deliveryLine([{ botId: 'bot-moa', role: 'moa' }], [lead, moa], t)).toBe('room.composer.sentTo(name=Moa HQ)');
    expect(deliveryLine([{ botId: 'bot-lead', role: 'lead' }, { botId: 'bot-moa', role: 'moa' }], [lead, moa], t)).toBe('room.composer.sentTo(name=Ada, Moa HQ)');
    const four = ['a', 'b', 'c', 'd'].map((x) => ({ botId: `bot-${x}`, role: 'lead' as const }));
    expect(deliveryLine(four, [], t)).toBe('room.composer.sentToBots(count=4)');
    expect(deliveryLine(null, [], t)).toBe('room.composer.noAddressee');
    expect(deliveryLine([], [], t)).toBe('room.composer.noAddressee');
    expect(deliveryLine(undefined, [], t)).toBeNull();
    expect(sentFrom({ addressee: { botId: 'bot-lead', role: 'lead' }, wakeId: 'w-1' })).toEqual([{ botId: 'bot-lead', role: 'lead', wakeId: 'w-1' }]);
    expect(sentFrom({ addressee: null })).toBeNull();
  });

  it('a deleted addressee is named as main keeps it, marked removed; one it never knew by its role', () => {
    const sent = [{ botId: 'bot-rex', role: 'lead' as const }];
    const actors = { 'bot-rex': { role: 'lead' as const, name: 'Rex', removed: true } };
    expect(deliveryLine(sent, [lead], t, false, actors)).toBe('room.composer.sentTo(name=room.actor.removed(name=Rex))');
    expect(deliveryLine(sent, [lead], t, false, { 'bot-rex': { role: 'lead', name: 'Rex' } })).toBe('room.composer.sentTo(name=Rex)');
    expect(deliveryLine(sent, [lead], t)).toBe('room.composer.sentTo(name=room.role.lead)');
    // A running bot's live name wins over the stored one.
    expect(deliveryLine([{ botId: 'bot-lead', role: 'lead', wakeId: 'w-mine' }], [lead], t, true, { 'bot-lead': { role: 'lead', name: 'Old' } })).toBe('room.composer.sentTo(name=Ada)');
  });

  it('predicts main\'s addressees: the mentioned bots that are on, else every bot of the room, oldest first', () => {
    const other: FactoryBotRow = { bot: bot('bot-other', { workspaceId: 'ws-b', name: 'Other lead' }), status: null };
    const late: FactoryBotRow = { bot: bot('bot-late', { name: 'Late', createdAt: 9 }), status: null };
    const rows = [late, other, lead, moa];
    expect(predictedAddressees(rows, WS, []).map((r) => r.bot.id)).toEqual(['bot-lead', 'bot-late']);
    expect(predictedAddressees(rows, WS, ['bot-moa', 'bot-gone']).map((r) => r.bot.id)).toEqual(['bot-moa']);
    expect(predictedAddressees(rows, HQ, []).map((r) => r.bot.id)).toEqual(['bot-moa']);
    expect(predictedAddressees([{ ...lead, bot: { ...lead.bot, enabled: false } }], WS, [])).toEqual([]);
  });

  it('before a send to a lone busy bot, names it as the one the message will wait for', async () => {
    const api = fakeApi();
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [lead, moa], t, api: api as unknown as RoomsApi }));
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'hi');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="room-composer-status"]')?.textContent).toBe('room.composer.willQueue(name=Ada)');
  });

  it('@Moa typed from a workspace room names the HQ bot from the bot list after the send', async () => {
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true, card: card(9), addressee: { botId: 'bot-moa', role: 'moa' }, wakeId: 'w-9' })) });
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [lead, { ...moa, status: running('bot-moa', 'w-1') }], t, api: api as unknown as RoomsApi }));
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '@Moa HQ plan tomorrow');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-composer-send"]')!.click());
    expect((api.post.mock.calls as unknown as Array<[unknown]>)[0][0]).toMatchObject({ mentions: ['bot-moa'] });
    expect(container.querySelector('[data-testid="room-composer-status"]')?.textContent).toBe('room.composer.queuedFor(name=Moa HQ)');
  });
});

describe('Settings › Factory merge lane rows', () => {
  it('parses the daily cap: whole numbers, capped at the maximum', () => {
    expect(parseDailyCap('7')).toBe(7);
    expect(parseDailyCap(' 0 ')).toBe(0);
    expect(parseDailyCap('99')).toBe(50);
    expect(parseDailyCap('')).toBeNull();
    expect(parseDailyCap('-1')).toBeNull();
    expect(parseDailyCap('2.5')).toBeNull();
  });

  it('auto-merge is off by default; the cap can be set before it is turned on, and saves on blur', async () => {
    const port = settingsPort();
    await render(createElement(FactoryTab, { settingsPort: port, botPort: NO_BOTS }));
    const sw = container.querySelector<HTMLButtonElement>('[data-testid="factory-lane-auto-merge"]')!;
    const cap = () => container.querySelector<HTMLInputElement>('[data-testid="factory-lane-daily-cap"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(cap().disabled).toBe(false);
    expect(cap().value).toBe('5');
    expect(container.querySelector('[data-setting-id="factorylaneautomerge"]')?.textContent).toContain('Merges bot pull requests that passed their Verifier and CI, up to the daily cap.');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(cap(), '7');
      cap().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { cap().focus(); cap().blur(); });
    expect(port.set).toHaveBeenLastCalledWith({ laneDailyCap: 7 });
    expect(cap().value).toBe('7');
    // The cap is saved while auto-merge is still off; turning it on is its own write.
    expect(port.set).not.toHaveBeenCalledWith({ laneAutoMerge: true });
    await act(async () => sw.click());
    expect(port.set).toHaveBeenLastCalledWith({ laneAutoMerge: true });
  });

  it('the command reviewer switch is on by default and saves the owner\'s choice', async () => {
    const port = settingsPort();
    await render(createElement(FactoryTab, { settingsPort: port, botPort: NO_BOTS }));
    const sw = container.querySelector<HTMLButtonElement>('[data-testid="factory-command-reviewer"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await act(async () => sw.click());
    expect(port.set).toHaveBeenLastCalledWith({ botCommandReviewer: false });
  });

  it('lists bot names as the bot port reports them', async () => {
    const rows: FactoryBotRow[] = [{ bot: bot('bot-lead', { name: 'Ada' }), status: null }];
    const port: FactoryBotPort = { ...NO_BOTS, list: async () => rows };
    await render(createElement(FactoryTab, { settingsPort: settingsPort(), botPort: port }));
    expect(container.querySelector('[data-testid="factory-bot-row"]')?.textContent).toContain('Ada');
  });
});
