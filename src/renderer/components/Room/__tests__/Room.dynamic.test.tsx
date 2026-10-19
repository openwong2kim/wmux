// @vitest-environment jsdom
//
// Room pieces the Bots page shares, rendered: the composer's addressing,
// answering a question card, a plan naming its workspaces, the bot chips'
// presence, and the Factory tab without a runtime.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import type { RoomCard as RoomCardData } from '../../../../shared/room';
import type { BotProfile } from '../../../../shared/bot';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import { setRoomsApiForTests, type RoomsApi } from '../../../hooks/useRoomSync';
import { RoomComposer, roomPostParams, typedMentions } from '../RoomComposer';
import { RoomCard } from '../RoomCard';
import { BotChips, CHIP_MENU_SIZE, chipMenuPlace } from '../BotChips';
import { FactoryTab } from '../../Settings/FactoryTab';
import { actorLabel, planTextWithNames } from '../roomFormat';
import type { FactoryBotPort, FactoryBotRow } from '../factoryPorts';

const WS = 'ws-a';
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({ roomStatus: null, roomThreads: {}, roomTimelines: {}, roomSelectedThread: {}, roomReadThrough: {}, roomPushCount: 0, roomPushedAt: {} });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  setRoomsApiForTests(undefined);
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

function fakeApi(over: Record<string, unknown> = {}) {
  const api = {
    status: vi.fn(async () => ({ running: true, enabled: true, hqWorkspaceId: null })),
    threads: vi.fn(async () => ({ ok: true, workspaceId: WS, threads: [] })),
    read: vi.fn(async () => ({ ok: true, workspaceId: WS, threadId: null, cards: [], nextSinceSeq: 0, hasMore: false })),
    post: vi.fn(async (p: { title: string }) => ({ ok: true, card: card(9, { kind: 'human', title: p.title }), addressee: null })),
    resolve: vi.fn(async () => ({ ok: true, card: card(1) })),
    decision: vi.fn(async () => ({ decision: null })),
    onEvent: vi.fn(() => () => undefined),
  };
  return Object.assign(api, over) as typeof api;
}

describe('RoomComposer', () => {
  it('no chip: the whole room; a picked chip or a typed @name becomes the post\'s mentions; deleting the name unpicks it', async () => {
    const api = fakeApi();
    const verifier: FactoryBotRow = { bot: bot('bot-00000003', { role: 'verifier', name: 'Wmux Reviewer' }), status: null };
    const dev: FactoryBotRow = { bot: bot('bot-00000004', { name: 'Wmux Dev', createdAt: 2 }), status: null };
    const far: FactoryBotRow = { bot: bot('bot-00000005', { name: '대장', workspaceId: 'ws-hq' }), status: null };
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [verifier, dev, far], t, api: api as unknown as RoomsApi }));
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]')!;
    const type = async (text: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const send = async () => act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="room-composer-send"]')!.click();
    });
    const chip = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="room-composer-bot"][data-bot-id="${id}"]`);
    // The room's bots are the chips; none picked means everyone here.
    expect([...container.querySelectorAll('[data-testid="room-composer-bot"]')].map((b) => b.getAttribute('data-bot-id'))).toEqual(['bot-00000003', 'bot-00000004']);
    expect(container.querySelector('[data-testid="room-composer-to-room"]')?.textContent).toBe('room.composer.toRoom');

    await type('Hi everyone');
    await send();
    expect(api.post.mock.calls[0][0]).not.toHaveProperty('mentions');
    expect(api.post.mock.calls[0][0]).toMatchObject({ workspaceId: WS, threadId: 'general', title: 'Hi everyone' });

    await act(async () => chip('bot-00000003')!.click());
    expect(chip('bot-00000003')?.getAttribute('aria-pressed')).toBe('true');
    await type('check #12\nwith the gate');
    await send();
    expect(api.post.mock.calls[1][0]).toMatchObject({ mentions: ['bot-00000003'], title: 'check #12', body: 'check #12\nwith the gate' });
    // A send clears the picks with the draft.
    expect(chip('bot-00000003')?.getAttribute('aria-pressed')).toBe('false');

    // A leading name picks its chip — a bot of another room shows as a chip
    // too; deleting the name unpicks it.
    await type('@Wmux Dev @대장님 look');
    expect(chip('bot-00000004')?.getAttribute('aria-pressed')).toBe('true');
    expect(chip('bot-00000005')?.getAttribute('aria-pressed')).toBe('true');
    await type('@Wmux Dev look');
    expect(chip('bot-00000005')).toBeNull();
    // A name inside the sentence is plain text: it picks nothing.
    await type('@Wmux Dev look, then ask @Wmux Reviewer');
    expect(chip('bot-00000003')?.getAttribute('aria-pressed')).toBe('false');
    await send();
    expect(api.post.mock.calls[2][0]).toMatchObject({ mentions: ['bot-00000004'] });
    expect(input.disabled).toBe(false);
  });

  it('typedMentions: only leading names count; the longest name wins, a Latin name ends at a word boundary, this room wins a shared name', () => {
    const row = (id: string, name: string, over: Partial<BotProfile> = {}): FactoryBotRow => ({ bot: bot(id, { name, ...over }), status: null });
    const bots = [
      row('bot-0000000a', 'Wmux'), row('bot-0000000b', 'Wmux Dev'), row('bot-0000000c', 'Lead', { workspaceId: 'ws-x', createdAt: 0 }),
      row('bot-0000000d', 'Lead'), row('bot-0000000e', 'Off', { enabled: false }), row('bot-0000000f', '대장'),
    ];
    expect(typedMentions('  @wmux dev, @Wmux hi', bots, WS)).toEqual(['bot-0000000b', 'bot-0000000a']);
    expect(typedMentions('@Wmuxer @Devs', bots, WS)).toEqual([]);
    expect(typedMentions('@Lead go', bots, WS)).toEqual(['bot-0000000d']);
    expect(typedMentions('@Lead go', bots, 'ws-x')).toEqual(['bot-0000000c']);
    expect(typedMentions('@대장이 해줘', bots, WS)).toEqual(['bot-0000000f']);
    // Inside the sentence a name is plain text; an off bot or a word that is
    // no bot's name ends the leading run.
    expect(typedMentions('hi @wmux dev, and @Wmux', bots, WS)).toEqual([]);
    expect(typedMentions('@Lead 너는 @Wmux Dev 랑 리뷰해', bots, WS)).toEqual(['bot-0000000d']);
    expect(typedMentions('@Off @대장 해줘', bots, WS)).toEqual([]);
    expect(typedMentions('@대장 @대장 해줘', bots, WS)).toEqual(['bot-0000000f']);
    expect(typedMentions('no mention here', bots, WS)).toEqual([]);
  });

  it('says the message is queued when the addressed bot is mid-turn', async () => {
    const busy: FactoryBotRow = {
      bot: bot('bot-00000001', { name: 'Lead' }),
      status: { botId: 'bot-00000001', presence: 'running', currentTurn: { wakeId: 'w', startedAt: 1 }, queueDepth: 1, budgetLeft: { turnsHour: 1, turnsDay: 1, workerHoursDay: 1 } },
    };
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true, card: card(9), addressee: { botId: 'bot-00000001', role: 'lead' } })) });
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [busy], t, api: api as unknown as RoomsApi }));
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'hi');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-composer-send"]')!.click());
    expect(container.querySelector('[data-testid="room-composer-status"]')?.textContent).toBe('room.composer.queuedFor(name=Lead)');
  });

  it('once the bot takes the message up, a later turn does not flip it back to queued', async () => {
    const at = (wakeId: string): FactoryBotRow => ({
      bot: bot('bot-00000001', { name: 'Lead' }),
      status: { botId: 'bot-00000001', presence: 'running', currentTurn: { wakeId, startedAt: 1 }, queueDepth: 1, budgetLeft: { turnsHour: 1, turnsDay: 1, workerHoursDay: 1 } },
    });
    const api = fakeApi({ post: vi.fn(async () => ({ ok: true, card: card(9), addressee: { botId: 'bot-00000001', role: 'lead' }, wakeId: 'w-me' })) });
    const el = (row: FactoryBotRow) => createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [row], t, api: api as unknown as RoomsApi });
    await render(el(at('w-before')));
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'hi');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-composer-send"]')!.click());
    const status = () => container.querySelector('[data-testid="room-composer-status"]')?.textContent;
    expect(status()).toBe('room.composer.queuedFor(name=Lead)');
    await render(el(at('w-me')));
    expect(status()).toBe('room.composer.sentTo(name=Lead)');
    await render(el(at('w-after')));
    expect(status()).toBe('room.composer.sentTo(name=Lead)');
  });

  it('keeps text typed while a send is in flight', async () => {
    let release!: () => void;
    const api = fakeApi({ post: vi.fn(() => new Promise((r) => { release = () => r({ ok: true, card: card(9), addressee: null }); })) });
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [], t, api: api as unknown as RoomsApi }));
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]')!;
    const setValue = async (v: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await setValue('first');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-composer-send"]')!.click());
    await setValue('second, typed meanwhile');
    await act(async () => release());
    expect(input.value).toBe('second, typed meanwhile');
  });

  it('a refused send keeps its clientPostId for the same message; a new message gets a new one', async () => {
    const results = [
      { ok: false, code: 'queue_full', message: 'Lead has too many queued wakes' },
      { ok: true, card: card(9), addressee: null },
      { ok: true, card: card(10), addressee: null },
    ];
    const api = fakeApi({ post: vi.fn(async () => results.shift()) });
    await render(createElement(RoomComposer, { workspaceId: WS, threadId: 'general', bots: [], t, api: api as unknown as RoomsApi }));
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]')!;
    const setValue = async (v: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = async () => act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-composer-send"]')!.click());
    await setValue('ship it');
    await send();
    expect(input.value).toBe('ship it');
    await send();
    await setValue('next one');
    await send();
    const ids = api.post.mock.calls.map((c) => (c[0] as unknown as { clientPostId: string }).clientPostId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('builds no post for an empty message', () => {
    expect(roomPostParams({ workspaceId: WS, threadId: 'general', text: '   ', clientPostId: 'x' })).toBeNull();
    expect(roomPostParams({ workspaceId: WS, threadId: 'general', text: 'x', mentions: [], clientPostId: 'x' })).not.toHaveProperty('mentions');
  });
});

describe('RoomCard', () => {
  it('an open question is answered through room:resolve with its card id', async () => {
    const api = fakeApi({
      decision: vi.fn(async () => ({ decision: { id: 'd-1', question: 'Merge it?', options: ['Yes', 'No'], context: '', status: 'pending', raisedAt: 1 } })),
    });
    setRoomsApiForTests(api as unknown as RoomsApi);
    const q = card(3, { kind: 'question', state: 'open', title: 'Merge it?', refs: { decisionId: 'd-1' } });
    await render(createElement(RoomCard, { card: q, workspaceId: WS, t, bots: [] }));
    expect(api.decision).toHaveBeenCalledWith(WS, 'c3');
    const options = container.querySelectorAll<HTMLButtonElement>('[data-decision-option]');
    expect(options).toHaveLength(2);
    expect(container.querySelector('[data-testid="room-card"]')?.className).toContain('attention-hairline');
    // One boundary: the row draws it, the decision card adds no box.
    expect(container.querySelector('[data-deck-decision]')?.className).not.toMatch(/border/);
    await act(async () => options[0].click());
    expect(api.resolve).toHaveBeenCalledWith({ workspaceId: WS, cardId: 'c3', resolution: 'Yes' });
  });

  it('an open question whose decision is already settled shows the question and that it waits, with no answer controls', async () => {
    const api = fakeApi({
      decision: vi.fn(async () => ({ decision: { id: 'd-1', question: 'Merge it?', options: ['Yes'], context: '', status: 'resolved', resolution: 'Yes', raisedAt: 1 } })),
    });
    setRoomsApiForTests(api as unknown as RoomsApi);
    await render(createElement(RoomCard, { card: card(3, { kind: 'question', state: 'open', title: 'Merge it?', refs: { decisionId: 'd-1' } }), workspaceId: WS, t, bots: [] }));
    expect(container.querySelectorAll('[data-decision-option]')).toHaveLength(0);
    expect(container.textContent).toContain('Merge it?');
    expect(container.querySelector('[data-card-question-waiting]')).not.toBeNull();
    // It no longer waits on the owner: no needs-you boundary.
    expect(container.querySelector('[data-testid="room-card"]')?.className).not.toContain('attention-hairline');
  });

  it('a resolved question has no answer controls; a failed verdict colours its word', async () => {
    setRoomsApiForTests(fakeApi() as unknown as RoomsApi);
    await render(createElement('div', null,
      createElement(RoomCard, { card: card(1, { kind: 'question', state: 'resolved', title: 'Q' }), workspaceId: WS, t, bots: [] }),
      createElement(RoomCard, { card: card(2, { kind: 'verdict', title: 'Verdict fail at abc1234' }), workspaceId: WS, t, bots: [] }),
      createElement(RoomCard, { card: card(4, { kind: 'status', title: 'reply', replyTo: 'c2' }), replyToCard: card(2, { title: 'Verdict fail at abc1234' }), workspaceId: WS, t, bots: [] }),
    ));
    expect(container.querySelector('[data-deck-decision]')).toBeNull();
    expect(container.querySelector('[data-card-verdict="fail"]')?.className).toContain('accent-red');
    expect(container.querySelector('[data-card-reply-to="c2"]')?.textContent).toBe('room.replyTo(title=Verdict fail at abc1234)');
  });
});

describe('RoomCard evidence', () => {
  it('a card about a pane offers a jump to it', async () => {
    await render(createElement(RoomCard, { card: card(5, { kind: 'fact', title: 'Pane needs input', refs: { ptyId: 'pty-7' } }), workspaceId: WS, t, bots: [] }));
    expect(container.querySelector('[data-card-jump="pty-7"]')?.textContent).toBe('room.jumpToPane');
  });
});

describe('card authors', () => {
  it('a card names its bot author by role until the bot runtime lists names', () => {
    const actor = { kind: 'bot' as const, workspaceId: WS, botId: 'bot-00000009' };
    expect(actorLabel(actor, t, [])).toBe('room.actor.bot');
    expect(actorLabel(actor, t, [], { 'bot-00000009': { role: 'verifier' } })).toBe('room.role.verifier');
    expect(actorLabel(actor, t, [{ bot: bot('bot-00000009', { name: 'Vera' }), status: null }], { 'bot-00000009': { role: 'verifier' } })).toBe('Vera');
  });
});

describe('RoomCard plan', () => {
  it('a plan in the timeline names its workspaces too', async () => {
    useStore.setState({ workspaces: [{ id: 'ws-api-1234', name: 'api' }] } as never);
    const plan = card(1, { kind: 'plan', state: 'open', title: 'Plan', body: '1. **Fix** — workspace `ws-api-1234`, size S. why', actor: { kind: 'bot', workspaceId: WS, botId: 'bot-00000001' } });
    await render(createElement(RoomCard, { card: plan, workspaceId: WS, t, bots: [], roomsBridge: null }));
    const text = container.querySelector('[data-testid="room-card"]')?.textContent ?? '';
    expect(text).toContain('Fix — api, size S');
    expect(text).not.toContain('ws-api-1234');
  });
});

describe('planTextWithNames', () => {
  it('replaces each workspace id with its name, an unknown one with "a workspace"', () => {
    const names = (id: string) => (id === 'ws-a1b2c3d4' ? 'api' : null);
    expect(planTextWithNames('1. **X** — workspace `ws-a1b2c3d4`, size S.', names, t)).toBe('1. **X** — api, size S.');
    expect(planTextWithNames('— workspace `w9`, size L.', names, t)).toBe('— room.plan.someWorkspace, size L.');
    // An id in Moa's notes too, backticked or bare.
    expect(planTextWithNames('see `ws-a1b2c3d4` and ws-ffff0000-1111', names, t)).toBe('see api and room.plan.someWorkspace');
    expect(planTextWithNames('no ids here', names, t)).toBe('no ids here');
    // A name that looks like an id is put in once, never read again.
    expect(planTextWithNames('— workspace `ws-a1b2c3d4`, size S.', () => 'ws-client', t)).toBe('— ws-client, size S.');
  });
});

describe('BotChips', () => {
  it('a bot the runtime has not reported on is a hollow ring; a zero queue draws nothing; the menu calls the port', async () => {
    const act$ = vi.fn(async () => ({ ok: true }));
    const port: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: act$ };
    const rows: FactoryBotRow[] = [
      { bot: bot('bot-00000001'), status: null },
      { bot: bot('bot-00000002'), status: { botId: 'bot-00000002', presence: 'running', currentTurn: { wakeId: 'w', startedAt: 1 }, queueDepth: 0, budgetLeft: { turnsHour: 1, turnsDay: 20, workerHoursDay: 1 } } },
    ];
    await render(createElement(BotChips, { rows, t, port }));
    const chips = container.querySelectorAll('[data-testid="room-bot-chip"]');
    expect(chips[0].getAttribute('data-presence')).toBe('unknown');
    expect(chips[0].querySelector('[data-presence="unknown"]')?.className).toContain('border');
    expect(chips[0].getAttribute('aria-label')).toContain('room.presence.unknown');
    expect(chips[0].getAttribute('aria-label')).not.toMatch(/offline|stopped/i);
    expect(chips[1].querySelector('[data-bot-queue]')).toBeNull();
    expect(chips[1].querySelector('[data-bot-budget]')).not.toBeNull();
    await act(async () => (chips[1] as HTMLButtonElement).click());
    // The menu floats out of the strip (portalled), so no chip holds it.
    expect(container.querySelector('[data-testid="room-bot-menu"]')).toBeNull();
    const menu = document.querySelector<HTMLElement>('[data-testid="room-bot-menu"]')!;
    expect(menu.style.position).toBe('fixed');
    const interrupt = document.querySelector<HTMLButtonElement>('[data-bot-action="interrupt"]')!;
    expect(interrupt.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-bot-action="resume"]')!.disabled).toBe(true);
    await act(async () => interrupt.click());
    expect(act$).toHaveBeenCalledWith('interrupt', 'bot-00000002');
    expect(document.querySelector('[data-testid="room-bot-menu"]')).toBeNull();
  });

  it('a bot paused during its running turn offers Resume, not Park', async () => {
    const act$ = vi.fn(async () => ({ ok: true }));
    const port: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: act$ };
    const row: FactoryBotRow = {
      bot: { ...bot('bot-00000002'), parked: { reason: 'human', at: 1 } },
      status: { botId: 'bot-00000002', presence: 'running', currentTurn: { wakeId: 'w', startedAt: 1 }, queueDepth: 0, budgetLeft: { turnsHour: 1, turnsDay: 20, workerHoursDay: 1 } },
    };
    await render(createElement(BotChips, { rows: [row], t, port }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-bot-chip"]')!.click());
    expect(document.querySelector<HTMLButtonElement>('[data-bot-action="park"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-bot-action="interrupt"]')!.disabled).toBe(false);
    const resume = document.querySelector<HTMLButtonElement>('[data-bot-action="resume"]')!;
    expect(resume.disabled).toBe(false);
    await act(async () => resume.click());
    expect(act$).toHaveBeenCalledWith('resume', 'bot-00000002');
  });

  it('the menu stays open while another region scrolls, and closes when the strip under it scrolls', async () => {
    const port: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: vi.fn(async () => ({ ok: true })) };
    await render(createElement('div', null,
      createElement('div', { 'data-testid': 'other-region' }),
      createElement(BotChips, { rows: [{ bot: bot('bot-00000001'), status: null }], t, port })));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="room-bot-chip"]')!.click());
    expect(document.querySelector('[data-testid="room-bot-menu"]')).not.toBeNull();
    await act(async () => { container.querySelector('[data-testid="other-region"]')!.dispatchEvent(new Event('scroll')); });
    expect(document.querySelector('[data-testid="room-bot-menu"]')).not.toBeNull();
    await act(async () => { container.querySelector('[data-testid="room-bot-chips"]')!.dispatchEvent(new Event('scroll')); });
    expect(document.querySelector('[data-testid="room-bot-menu"]')).toBeNull();
  });

  it('keys: opening focuses the first verb that can run, arrows skip disabled ones, Escape returns to the chip; a resize closes it', async () => {
    const port: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: vi.fn(async () => ({ ok: true })) };
    const running: FactoryBotRow = { bot: bot('bot-00000002'), status: { botId: 'bot-00000002', presence: 'running', currentTurn: { wakeId: 'w', startedAt: 1 }, queueDepth: 0, budgetLeft: { turnsHour: 1, turnsDay: 20, workerHoursDay: 1 } } };
    await render(createElement(BotChips, { rows: [running], t, port }));
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="room-bot-chip"]')!;
    await act(async () => chip.click());
    // Running: wake, park and interrupt can run; resume cannot.
    expect(document.activeElement?.getAttribute('data-bot-action')).toBe('wake');
    const menu = document.querySelector<HTMLElement>('[data-testid="room-bot-menu"]')!;
    const key = (k: string) => act(async () => { (document.activeElement ?? menu).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
    await key('ArrowDown');
    expect(document.activeElement?.getAttribute('data-bot-action')).toBe('park');
    await key('ArrowDown');
    expect(document.activeElement?.getAttribute('data-bot-action')).toBe('interrupt');
    await key('ArrowDown');
    expect(document.activeElement?.getAttribute('data-bot-action')).toBe('wake');
    await key('Escape');
    expect(document.querySelector('[data-testid="room-bot-menu"]')).toBeNull();
    expect(document.activeElement).toBe(chip);
    await act(async () => chip.click());
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    expect(document.querySelector('[data-testid="room-bot-menu"]')).toBeNull();
  });

  it('chipMenuPlace: beside the chip and level with it, never over the strip below', () => {
    const view = { width: 1280, height: 800 };
    const chip = { left: 1000, right: 1200, top: 300, bottom: 326 };
    // Left of the chip (the dock is at the window's right edge), level with it.
    expect(chipMenuPlace(chip, CHIP_MENU_SIZE, view)).toEqual({ left: 1000 - 4 - CHIP_MENU_SIZE.width, top: 300 });
    // No room on the left: on the right.
    expect(chipMenuPlace({ left: 20, right: 220, top: 300, bottom: 326 }, CHIP_MENU_SIZE, view)).toEqual({ left: 224, top: 300 });
    // Near the window's foot: lifted to stay inside it, still beside the chip.
    const low = chipMenuPlace({ left: 1000, right: 1200, top: 780, bottom: 806 }, CHIP_MENU_SIZE, view);
    expect(low.top).toBe(800 - CHIP_MENU_SIZE.height - 8);
    expect(low.left + CHIP_MENU_SIZE.width).toBeLessThanOrEqual(1000);
    // Neither side has room: under the chip, inside the window.
    const narrow = { width: 300, height: 800 };
    const under = chipMenuPlace({ left: 50, right: 250, top: 100, bottom: 126 }, CHIP_MENU_SIZE, narrow);
    expect(under).toEqual({ left: 50, top: 130 });
  });
});

describe('FactoryTab', () => {
  it('without a factory in this build, says so and keeps every switch off', async () => {
    const settingsPort = { available: false, get: vi.fn(async () => null), set: vi.fn(async () => null) };
    const botPort: FactoryBotPort = { available: false, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: false }) };
    await render(createElement(FactoryTab, { settingsPort, botPort }));
    expect(container.querySelector('[data-testid="factory-not-installed"]')?.textContent).toBe("Bots aren't installed in this build, so these settings are off.");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="factory-enabled"]')!.disabled).toBe(true);
    expect(settingsPort.get).not.toHaveBeenCalled();
  });

  it('shows the space bot task folders use, and Clean up now says what it did and reads the space again', async () => {
    const view = {
      version: 1 as const, enabled: true, hqWorkspaceId: null, trustedAuthors: [], morning: { hour: 9, weekdays: [1, 2, 3, 4, 5] },
      verifierOnOwnerPrs: true, defaultEngine: { kind: 'claude-sdk' as const }, globalConcurrentBots: 2, laneAutoMerge: false, laneDailyCap: 5,
    };
    const usage = vi.fn()
      .mockResolvedValueOnce({ bytes: 3 * 1024 ** 3, folders: 4, dirty: 1 })
      .mockResolvedValueOnce({ bytes: 512 * 1024 ** 2, folders: 1, dirty: 1 });
    const cleanTaskFolders = vi.fn(async () => ({ ok: true as const, removed: 3, keptDirty: 1, busy: 0, failed: 0 }));
    const settingsPort = { available: true, get: vi.fn(async () => view), set: vi.fn(async () => view), taskFolderUsage: usage, cleanTaskFolders };
    const botPort: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }) };
    await render(createElement(FactoryTab, { settingsPort, botPort }));
    const line = () => container.querySelector('[data-testid="factory-task-folders-usage"]')?.textContent;
    expect(line()).toBe('Folders: 4, 3 GB · kept with uncommitted changes: 1');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-task-folders-clean"]')!.click());
    expect(cleanTaskFolders).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="factory-task-folders-note"]')?.textContent).toBe('Removed 3. Kept 1 with uncommitted changes and 0 still in use.');
    expect(line()).toBe('Folders: 1, 512 MB · kept with uncommitted changes: 1');
  });

  it('with a factory, turning it on writes enabled through the port', async () => {
    const view = {
      version: 1 as const, enabled: false, hqWorkspaceId: null, trustedAuthors: [], morning: { hour: 9, weekdays: [1, 2, 3, 4, 5] },
      verifierOnOwnerPrs: true, defaultEngine: { kind: 'claude-sdk' as const }, globalConcurrentBots: 2, laneAutoMerge: false, laneDailyCap: 5,
    };
    const settingsPort = { available: true, get: vi.fn(async () => view), set: vi.fn(async (p: object) => ({ ...view, ...p })) };
    setRoomsApiForTests(fakeApi() as unknown as RoomsApi);
    const botPort: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }) };
    await render(createElement(FactoryTab, { settingsPort, botPort }));
    const sw = container.querySelector<HTMLButtonElement>('[data-testid="factory-enabled"]')!;
    expect(sw.disabled).toBe(false);
    await act(async () => sw.click());
    // The plan consent comes first; Turn on bots sends it with the switch.
    expect(settingsPort.set).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="bots-plan-consent-confirm"]')!.click());
    expect(settingsPort.set).toHaveBeenCalledWith({ enabled: true, planConsent: expect.objectContaining({ version: 1 }) });
    expect(container.querySelector('[data-testid="factory-not-installed"]')).toBeNull();
  });

  it('turning it off says how many workers main stopped, and offers Try again when the stop failed', async () => {
    const view = {
      version: 1 as const, enabled: true, hqWorkspaceId: null, trustedAuthors: [], morning: { hour: 9, weekdays: [1, 2, 3, 4, 5] },
      verifierOnOwnerPrs: true, defaultEngine: { kind: 'claude-sdk' as const }, globalConcurrentBots: 2, laneAutoMerge: false, laneDailyCap: 5,
    };
    let stoppedWork: { workers: number; tasks: number; ok: boolean } = { workers: 3, tasks: 2, ok: true };
    const settingsPort = { available: true, get: vi.fn(async () => view), set: vi.fn(async (p: object) => ({ ...view, ...p, stoppedWork })) };
    setRoomsApiForTests(fakeApi() as unknown as RoomsApi);
    const stopAll = vi.fn(async () => ({ ok: true, botsInterrupted: 1, workersStopped: 1, gatesCancelled: 0 }));
    const botPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }), stopAll } as FactoryBotPort;
    useStore.setState({ toasts: [] });
    await render(createElement(FactoryTab, { settingsPort, botPort }));
    const sw = container.querySelector<HTMLButtonElement>('[data-testid="factory-enabled"]')!;
    await act(async () => sw.click());
    expect(settingsPort.set).toHaveBeenCalledWith({ enabled: false });
    expect(useStore.getState().toasts.map((x) => x.message)).toEqual(['Stopped 3 workers. Saved work is kept.']);
    // The stop failed (a fresh tab, the bots on again): an error toast whose
    // action runs Stop all.
    act(() => root.unmount());
    root = createRoot(container);
    useStore.setState({ toasts: [] });
    stoppedWork = { workers: 0, tasks: 0, ok: false };
    await render(createElement(FactoryTab, { settingsPort, botPort }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="factory-enabled"]')!.click());
    const failed = useStore.getState().toasts.find((x) => x.level === 'error');
    expect(failed?.message).toBe('Bots are off, but their running work could not be stopped.');
    expect(failed?.action?.label).toBe('Try again');
    await act(async () => { failed!.action!.onClick(); });
    expect(stopAll).toHaveBeenCalledTimes(1);
  });
});

describe('FactoryTab engine', () => {
  it('shows the one engine bots run on in this version, with nothing to pick', async () => {
    const view = {
      version: 1 as const, enabled: true, hqWorkspaceId: null, trustedAuthors: [], morning: { hour: 9, weekdays: [1] },
      verifierOnOwnerPrs: true, defaultEngine: { kind: 'acp' as const, command: 'hermes', args: ['acp'] }, globalConcurrentBots: 2, laneAutoMerge: false, laneDailyCap: 5,
    };
    const settingsPort = { available: true, get: vi.fn(async () => view), set: vi.fn(async (p: object) => ({ ...view, ...p })) };
    const botPort: FactoryBotPort = { available: true, list: async () => [], subscribe: () => () => undefined, act: async () => ({ ok: true }) };
    await render(createElement(FactoryTab, { settingsPort, botPort }));
    const row = container.querySelector('[data-setting-id="factoryengine"]');
    expect(row?.querySelector('select')).toBeNull();
    expect(row?.querySelector('input')).toBeNull();
    expect(row?.querySelector('[data-testid="factory-engine"]')?.textContent).toBe('Claude (SDK)');
  });
});
