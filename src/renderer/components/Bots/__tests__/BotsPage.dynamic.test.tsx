// @vitest-environment jsdom
// The Bots rail page: the first screen, the conversation list (by latest
// activity, no pinned HQ; needs-you on the bot rows), adding a bot, a 1:1 and a group chat, the thread chip,
// sending to one bot, a worker's Open, the rail item's route and badge (the
// sum of the page's own rows) and the Toggle Company View shortcut.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { ALL_THREADS, timelineKey } from '../../../stores/slices/roomSlice';
import { setRoomsApiForTests, type RoomsApi } from '../../../hooks/useRoomSync';
import { setFactoryBotPort, type FactoryBotPort, type FactoryBotRow } from '../../Room/factoryPorts';
import type { RoomCard } from '../../../../shared/room';
import type { BotProfile, BotRole } from '../../../../shared/bot';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import type { Pane, Workspace } from '../../../../shared/types';
import BotsPage, { isStillStarting } from '../BotsPage';
import type { EnginePort } from '../botsEngine';
import MiniSidebar from '../../Sidebar/MiniSidebar';
import { focusNotificationTarget } from '../../../hooks/useNotificationListener';
import { chatCards, composerHint, fitSideSplit, oneToOneRefusal } from '../BotsChat';
import type { Conversation } from '../botsModel';
import { refreshApprovals, setApprovalsApiForTests, type ApprovalsApi } from '../../Room/approvalsStore';
import { setBotGroupPort, type BotGroupPort } from '../../Room/botGroups';
import type { BotGroup } from '../../../../shared/botGroup';
import { botHueIndex } from '../../Room/BotAvatar';

// A worker's panel mounts its pane; these tests check the panel, not the
// terminal in it. A real xterm here needs a canvas and the pty bridge, and
// without them it only threw into the pane's ErrorBoundary on every mount.
vi.mock('../../Terminal/Terminal', () => ({ default: () => null }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEAD = 'bot-0000000a';
const VERIFIER = 'bot-0000000b';
const MOA = 'bot-0000000c';

function botRow(id: string, role: BotRole, workspaceId: string, createdAt: number, name: string, enabled = true): FactoryBotRow {
  const bot: BotProfile = {
    version: 1, id, workspaceId, role, name, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS[role], enabled, createdAt, updatedAt: createdAt,
    repo: { repoKey: 'github.com/acme/api', repoPath: '/r/api' },
  };
  return { bot, status: { botId: id, presence: 'idle', queueDepth: 0, budgetLeft: { turnsHour: 5, turnsDay: 30, workerHoursDay: 4 } } };
}

let seq = 0;
function card(p: Partial<RoomCard> & Pick<RoomCard, 'workspaceId' | 'actor'>): RoomCard {
  seq += 1;
  return { version: 1, id: `c${seq}`, seq, threadId: 'general', kind: 'status', at: 1_000 + seq, title: `card ${seq}`, ...p };
}
const by = (workspaceId: string, botId: string) => ({ kind: 'bot' as const, workspaceId, botId });

const leaf = (id: string): Pane => ({ id: `${id}-p`, type: 'leaf', ordinal: 1, surfaces: [], activeSurfaceId: '' }) as unknown as Pane;
const ws = (id: string, name: string): Workspace => ({ id, name, wsOrdinal: 1, rootPane: leaf(id), activePaneId: `${id}-p` }) as Workspace;

let bots: FactoryBotRow[];
let cards: RoomCard[];
/** The owner's group chats: w1's room made into a group (it had the owner's messages). */
let groups: BotGroup[];
let groupCalls: Array<{ op: string; req: unknown }>;
const groupPort: BotGroupPort = {
  available: true,
  list: async () => ({ ok: true, groups }),
  create: async (req) => {
    groupCalls.push({ op: 'create', req });
    const g: BotGroup = { id: `grp-${(0xb0 + groups.length).toString(16).padStart(8, '0')}`, workspaceId: req.workspaceId, name: req.name, memberIds: [...req.memberIds], threadId: `group:grp-${(0xb0 + groups.length).toString(16).padStart(8, '0')}`, createdAt: 5_000, updatedAt: 5_000 };
    groups = [...groups, g];
    return { ok: true, group: g };
  },
  update: async (req) => {
    groupCalls.push({ op: 'update', req });
    const g = groups.find((x) => x.id === req.id)!;
    const next = { ...g, ...(req.name !== undefined ? { name: req.name } : {}), ...(req.memberIds ? { memberIds: [...req.memberIds] } : {}) };
    groups = groups.map((x) => (x.id === g.id ? next : x));
    return { ok: true, group: next };
  },
  remove: async (id) => {
    groupCalls.push({ op: 'remove', req: id });
    groups = groups.filter((x) => x.id !== id);
    return { ok: true };
  },
};
let posted: Parameters<RoomsApi['post']>[0][];
let container: HTMLDivElement;
let root: Root;

const port: FactoryBotPort = {
  available: true,
  list: async () => bots,
  subscribe: () => () => undefined,
  act: async () => ({ ok: true }),
};

function api(): RoomsApi {
  return {
    status: vi.fn(async () => ({ running: true, enabled: true, hqWorkspaceId: 'hq' })),
    read: vi.fn(async (p: { workspaceId: string }) => {
      const mine = cards.filter((c) => c.workspaceId === p.workspaceId);
      return { ok: true as const, workspaceId: p.workspaceId, threadId: null, cards: mine, nextSinceSeq: mine.at(-1)?.seq ?? 0, hasMore: false };
    }),
    threads: vi.fn(async (workspaceId: string) => ({ ok: true as const, workspaceId, threads: [] })),
    post: vi.fn(async (p: Parameters<RoomsApi['post']>[0]) => {
      posted.push(p);
      const c = card({ workspaceId: p.workspaceId, actor: { kind: 'human' }, kind: 'human', title: p.title, refs: { botId: LEAD } });
      return { ok: true as const, card: c, addressee: { botId: LEAD, role: 'lead' as BotRole } };
    }),
    resolve: vi.fn(async () => ({ ok: false as const, code: 'x', message: 'x' })),
    decision: vi.fn(async () => ({ decision: null })),
    actors: vi.fn(async () => ({ actors: {} })),
    onEvent: vi.fn(() => () => undefined),
  } as unknown as RoomsApi;
}

function seedRooms(on = true) {
  const byWs = (id: string) => cards.filter((c) => c.workspaceId === id);
  act(() => useStore.setState({
    roomStatus: { running: true, enabled: on, hqWorkspaceId: 'hq' },
    workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api'), ws('t1', 'wtask: fix login')],
    activeWorkspaceId: 'hq',
    activeRemoteKey: null,
    appRoute: 'bots',
    roomThreads: { hq: [], w1: [] },
    roomTimelines: {
      [timelineKey('hq', ALL_THREADS)]: { cards: byWs('hq'), nextSinceSeq: 0, hasMore: false },
      [timelineKey('w1', ALL_THREADS)]: { cards: byWs('w1'), nextSinceSeq: 0, hasMore: false },
    },
    roomActors: {},
    fanoutOrigin: { t1: { kind: 'bot', botId: LEAD } },
    surfaceAgentStatus: {},
  } as never));
}

beforeEach(() => {
  seq = 0;
  posted = [];
  bots = [botRow(MOA, 'moa', 'hq', 1, 'Moa'), botRow(LEAD, 'lead', 'w1', 2, 'Lead'), botRow(VERIFIER, 'verifier', 'w1', 3, 'Verifier')];
  cards = [
    card({ workspaceId: 'hq', actor: by('hq', MOA), title: 'Morning, all quiet', at: 100 }),
    card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Started a worker on login', at: 200 }),
    card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', title: 'Thanks lead', refs: { botId: LEAD }, at: 210 }),
    card({ workspaceId: 'w1', actor: by('w1', VERIFIER), title: 'PR #1 passes', kind: 'verdict', threadId: 'pr:github.com/acme/api#1', at: 300 }),
    card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Merge #1 now?', kind: 'question', state: 'open', threadId: 'pr:github.com/acme/api#1', at: 400 }),
    card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', title: 'CI green on #1', at: 410 }),
  ];
  groups = [{ id: 'grp-000000a1', workspaceId: 'w1', name: '', memberIds: [LEAD, VERIFIER], threadId: 'general', createdAt: 1, updatedAt: 1 }];
  groupCalls = [];
  setFactoryBotPort(port);
  setBotGroupPort(groupPort);
  setRoomsApiForTests(api());
  vi.stubGlobal('electronAPI', { web: { status: vi.fn(async () => ({ running: false })) } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setFactoryBotPort(null);
  setBotGroupPort(null);
  setRoomsApiForTests(undefined);
  vi.unstubAllGlobals();
});

const q = <E extends Element = HTMLElement>(sel: string) => container.querySelector<E & HTMLElement>(sel);
/** "+" is a menu: Add bot, New group chat. */
function openAddBot() {
  act(() => q('[data-bots-add]')!.click());
  act(() => q('[data-bots-add-bot]')!.click());
}
const rowIds = () => [...container.querySelectorAll('[data-bots-row]')].map((el) => el.getAttribute('data-bots-row'));
/** Answers the plan consent dialog that turning the bots on asks first. */
async function acceptPlanConsent() {
  for (let i = 0; i < 5 && !document.querySelector('[data-testid="bots-plan-consent"]'); i++) await act(async () => { await Promise.resolve(); });
  const ok = document.querySelector<HTMLButtonElement>('[data-testid="bots-plan-consent-confirm"]');
  expect(ok?.textContent).toBe('Turn on bots');
  await act(async () => { ok!.click(); });
}
const ON_WITH_CONSENT = { enabled: true, planConsent: expect.objectContaining({ version: 1 }) };

async function render(node: React.ReactNode) {
  await act(async () => { root.render(node); });
  await act(async () => { await Promise.resolve(); });
}

describe('Bots page', () => {
  it('a deleted bot\'s 1:1 sits under Archive at the bottom, folded, muted and marked (removed), read-only with no composer', async () => {
    const GONE = 'bot-0000000d';
    const gone = { role: 'lead' as BotRole, name: 'Old', removed: true as const, workspaceId: 'w1', hue: 2 };
    cards.push(
      card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', title: 'Old, are you there?', threadId: `dm:${GONE}`, refs: { botId: GONE }, at: 500 }),
      card({ workspaceId: 'w1', actor: by('w1', GONE), title: 'Here, wrapping up', threadId: `dm:${GONE}`, at: 510 }),
    );
    const withActors = api();
    withActors.actors = vi.fn(async () => ({ actors: { [GONE]: gone } })) as unknown as RoomsApi['actors'];
    setRoomsApiForTests(withActors);
    const clearRemoved = vi.fn(async () => ({ ok: true as const }));
    setFactoryBotPort({ ...port, clearRemoved } as unknown as FactoryBotPort);
    seedRooms(true);
    act(() => useStore.setState({ roomActors: { [GONE]: gone } } as never));
    await render(<BotsPage />);
    // Folded: the live list ends on a live conversation, then Archive with its count.
    expect(rowIds()).not.toContain(`bot:${GONE}`);
    const toggle = q('[data-bots-archive-toggle]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Archive1');
    act(() => toggle.click());
    expect(rowIds().at(-1)).toBe(`bot:${GONE}`);
    const row = q(`[data-bots-row="bot:${GONE}"]`)!;
    expect(row.getAttribute('data-bots-removed')).toBe('true');
    expect(row.textContent).toContain('Old (removed)');
    act(() => row.click());
    expect(q('[data-bots-chat]')?.getAttribute('data-bots-chat')).toBe(`bot:${GONE}`);
    expect(q('[data-bots-messages]')?.textContent).toContain('Here, wrapping up');
    // Nothing to send or change: no composer, no profile.
    expect(q('[data-testid="bots-composer-send"]')).toBeNull();
    expect(q('[data-bots-removed-note]')?.textContent).toContain('This bot was deleted');
    expect(q<HTMLButtonElement>('[data-bots-pill]')!.disabled).toBe(true);
    // Remove from Archive asks in place, then the chat leaves the list for good.
    act(() => q<HTMLButtonElement>('[data-testid="bots-archive-clear"]')!.click());
    expect(q('[data-testid="bots-archive-clear-confirm-row"]')?.textContent).toContain('Remove Old from the Archive?');
    withActors.actors = vi.fn(async () => ({ actors: { [GONE]: { ...gone, cleared: true as const } } })) as unknown as RoomsApi['actors'];
    await act(async () => { q<HTMLButtonElement>('[data-testid="bots-archive-clear-confirm"]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(clearRemoved).toHaveBeenCalledWith(GONE);
    expect(rowIds()).not.toContain(`bot:${GONE}`);
    expect(q('[data-bots-archive-toggle]')).toBeNull();
  });

  it('Archive opens by itself while searching and while one of its chats is open, toggled or not', async () => {
    const GONE = 'bot-0000000d';
    const gone = { role: 'lead' as BotRole, name: 'Old', removed: true as const, workspaceId: 'w1', hue: 2 };
    cards.push(card({ workspaceId: 'w1', actor: by('w1', GONE), title: 'Here, wrapping up', threadId: `dm:${GONE}`, at: 510 }));
    const withActors = api();
    withActors.actors = vi.fn(async () => ({ actors: { [GONE]: gone } })) as unknown as RoomsApi['actors'];
    setRoomsApiForTests(withActors);
    seedRooms(true);
    act(() => useStore.setState({ roomActors: { [GONE]: gone } } as never));
    await render(<BotsPage />);
    const expanded = () => q('[data-bots-archive-toggle]')!.getAttribute('aria-expanded');
    expect(expanded()).toBe('false');
    // Searching: the matching archived chat shows.
    act(() => q('[data-bots-search-toggle]')!.click());
    const search = q<HTMLInputElement>('[data-bots-search]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Old');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(expanded()).toBe('true');
    expect(rowIds()).toEqual([`bot:${GONE}`]);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(expanded()).toBe('false');
    // Its chat open: folding it does not hide the open chat's row.
    act(() => q('[data-bots-archive-toggle]')!.click());
    act(() => q<HTMLElement>(`[data-bots-row="bot:${GONE}"]`)!.click());
    act(() => q('[data-bots-archive-toggle]')!.click());
    expect(expanded()).toBe('true');
    expect(rowIds()).toContain(`bot:${GONE}`);
  });

  it('with every bot deleted, a kept 1:1 still lists (no first-bot screen), its room read from the actors', async () => {
    const GONE = 'bot-0000000d';
    const gone = { role: 'lead' as BotRole, name: 'Old', removed: true as const, workspaceId: 'w1', hue: 2 };
    bots = [];
    cards.push(card({ workspaceId: 'w1', actor: by('w1', GONE), title: 'Last words', threadId: `dm:${GONE}`, at: 510 }));
    const withActors = api();
    withActors.actors = vi.fn(async () => ({ actors: { [GONE]: gone } })) as unknown as RoomsApi['actors'];
    setRoomsApiForTests(withActors);
    seedRooms(true);
    await render(<BotsPage />);
    for (let i = 0; i < 5 && !q('[data-bots-archive-toggle]'); i++) await act(async () => { await Promise.resolve(); });
    expect(withActors.actors).toHaveBeenCalled();
    act(() => q('[data-bots-archive-toggle]')!.click());
    expect(rowIds()).toContain(`bot:${GONE}`);
    expect(q('[data-bots-chat]')).not.toBeNull();
  });

  it('bots off: the conversations and live workers stay, read-only, under a banner whose Turn bots on turns them on', async () => {
    // Opening the page asks main for the factory's state again.
    const off = api();
    off.status = vi.fn(async () => ({ running: true, enabled: false, hqWorkspaceId: 'hq' })) as unknown as RoomsApi['status'];
    setRoomsApiForTests(off);
    seedRooms(true);
    act(() => useStore.setState({
      workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api'), {
        ...ws('t1', 'wtask: fix login'),
        rootPane: { id: 't1-p', type: 'leaf', ordinal: 1, surfaces: [{ id: 's', ptyId: 'pty-t1', title: '', shell: 'zsh', cwd: '/', surfaceType: 'terminal' }], activeSurfaceId: 's' },
      } as Workspace],
      surfaceAgent: { 'pty-t1': { name: 'Claude Code', status: 'running' } },
      surfaceAgentStatus: { 'pty-t1': 'running' },
    } as never));
    const settings = { available: true, get: vi.fn(async () => null), set: vi.fn(async () => ({ enabled: true }) as never) };
    await render(<BotsPage settings={settings} />);
    expect(q('[data-bots-paused]')?.textContent).toContain('Bots are off');
    expect(q('[data-bots-run]')?.textContent).toBe('Turn bots on');
    // The list is all there, "+" too, and nothing is counted.
    expect(rowIds()).toEqual(['group:grp-000000a1', `bot:${LEAD}`, `bot:${VERIFIER}`, `bot:${MOA}`]);
    expect(q('[data-bots-add]')).not.toBeNull();
    expect(container.querySelectorAll('[data-bots-needs]')).toHaveLength(0);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    // The worker shows; the question shows without answers; nothing can be sent.
    expect(q('[data-bots-worker="t1"]')?.textContent).toContain('fix login');
    expect(q('[data-bots-worker="t1"]')?.textContent).not.toContain('wtask:');
    expect(container.querySelector('[data-testid="room-card"]')).toBeNull();
    expect(q('[data-room-card-id="c5"]')?.textContent).toContain('Merge #1 now?');
    expect(q<HTMLButtonElement>('[data-testid="bots-composer-send"]')!.disabled).toBe(true);
    expect(q('[data-testid="bots-composer-status"]')?.textContent).toBe('Bots are off. Turn bots on to message them.');
    await act(async () => { q('[data-bots-run]')!.click(); });
    await acceptPlanConsent();
    expect(settings.set).toHaveBeenCalledWith(ON_WITH_CONSENT);
  });

  it('with no bot yet: one centred panel, a name and Start, which turns the bots on, adds the bot here and opens its chat', async () => {
    bots = [];
    const off = api();
    off.status = vi.fn(async () => ({ running: true, enabled: false, hqWorkspaceId: 'hq' })) as unknown as RoomsApi['status'];
    setRoomsApiForTests(off);
    seedRooms(false);
    act(() => useStore.setState({ activeWorkspaceId: 'w1' } as never));
    const created = botRow('bot-0000000e', 'lead', 'w1', 9, 'Ada').bot;
    const create = vi.fn(async () => ({ ok: true as const, bot: created }));
    const notify: Array<() => void> = [];
    setFactoryBotPort({ ...port, create, subscribe: (fn: () => void) => { notify.push(fn); return () => undefined; } } as unknown as FactoryBotPort);
    const settings = { available: true, get: vi.fn(async () => null), set: vi.fn(async () => ({ enabled: true }) as never) };
    const engine: EnginePort = { readiness: vi.fn(async () => ({ ready: true })) };
    await render(<BotsPage settings={settings} engine={engine} />);
    // No list, no banner: the one panel, for the current workspace.
    expect(q('[data-bots-first-run]')?.textContent).toContain('Name your first bot');
    expect(q('[data-bots-first-run]')?.textContent).toContain('api');
    expect(q('[data-bots-paused]')).toBeNull();
    expect(q('[data-bots-row]')).toBeNull();
    const start = q<HTMLButtonElement>('[data-bots-first-start]')!;
    expect(start.disabled).toBe(true);
    const input = q<HTMLInputElement>('[data-bots-first-name]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ada');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(start.disabled).toBe(false);
    await act(async () => { start.click(); });
    await acceptPlanConsent();
    await act(async () => { await Promise.resolve(); });
    expect(settings.set).toHaveBeenCalledWith(ON_WITH_CONSENT);
    expect(create).toHaveBeenCalledWith({ workspaceId: 'w1', name: 'Ada' });
    // Its chat opens at once, starting, before the list shows the bot.
    expect(q('[data-bots-chat]')?.getAttribute('data-bots-chat')).toBe('bot:bot-0000000e');
    expect(q('[data-bots-starting]')?.textContent).toContain('Starting Ada');
    // Listed but not greeted yet: still starting.
    bots = [{ ...botRow('bot-0000000e', 'lead', 'w1', 9, 'Ada'), bot: created }];
    await act(async () => { for (const fn of notify) fn(); });
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-bots-starting]')).not.toBeNull();
    // The greeting arrives: the bot's chat replaces the placeholder.
    act(() => useStore.setState({
      roomStatus: { running: true, enabled: true, hqWorkspaceId: 'hq' },
      roomTimelines: {
        [timelineKey('w1', ALL_THREADS)]: { cards: [card({ workspaceId: 'w1', actor: by('w1', 'bot-0000000e'), kind: 'question', title: 'Hi, what should I do?', greeting: true, state: 'open' })], nextSinceSeq: 0, hasMore: false },
      },
    } as never));
    expect(q('[data-bots-starting]')).toBeNull();
    expect(q('[data-bots-chat]')?.getAttribute('data-bots-chat')).toBe('bot:bot-0000000e');
  });

  it('first screen: Add a team turns the bots on, adds the five here with no name typed, and opens the lead\'s chat', async () => {
    bots = [];
    const off = api();
    off.status = vi.fn(async () => ({ running: true, enabled: false, hqWorkspaceId: 'hq' })) as unknown as RoomsApi['status'];
    setRoomsApiForTests(off);
    seedRooms(false);
    act(() => useStore.setState({ activeWorkspaceId: 'w1' } as never));
    const lead = { ...botRow('bot-0000000e', 'lead', 'w1', 9, 'Lead').bot, template: 'coordinator' as const };
    const createTeam = vi.fn(async () => ({ ok: true as const, bots: [lead] }));
    setFactoryBotPort({ ...port, create: vi.fn(), createTeam } as unknown as FactoryBotPort);
    const settings = { available: true, get: vi.fn(async () => null), set: vi.fn(async () => ({ enabled: true }) as never) };
    let answer: (r: { ready: boolean }) => void = () => undefined;
    const engine: EnginePort = { readiness: () => new Promise((r) => { answer = r; }) };
    await render(<BotsPage settings={settings} engine={engine} />);
    const team = q<HTMLButtonElement>('[data-bots-first-team]')!;
    expect(team.textContent).toBe('Add a team (lead + 4 roles)');
    // The same readiness as Start: it waits for the engine's first answer.
    expect(team.disabled).toBe(true);
    await act(async () => { answer({ ready: true }); });
    expect(team.disabled).toBe(false);
    await act(async () => { team.click(); });
    await acceptPlanConsent();
    await act(async () => { await Promise.resolve(); });
    expect(settings.set).toHaveBeenCalledWith(ON_WITH_CONSENT);
    expect(createTeam).toHaveBeenCalledWith({ workspaceId: 'w1', names: { coordinator: 'Lead', researcher: 'Research', developer: 'Developer', issue: 'Issues', reviewer: 'Reviewer' } });
    expect(q('[data-bots-chat]')?.getAttribute('data-bots-chat')).toBe('bot:bot-0000000e');
  });

  it('first screen: a team answer with nothing made says so and opens nothing; the lead opens wherever it is in the answer', async () => {
    bots = [];
    seedRooms();
    act(() => useStore.setState({ activeWorkspaceId: 'w1' } as never));
    const lead = { ...botRow('bot-0000000e', 'lead', 'w1', 9, 'Lead').bot, template: 'coordinator' as const };
    const dev = { ...botRow('bot-0000000f', 'lead', 'w1', 10, 'Developer').bot, template: 'developer' as const };
    const createTeam = vi.fn()
      .mockResolvedValueOnce({ ok: true, bots: [], skipped: ['coordinator', 'researcher', 'developer', 'issue', 'reviewer'] })
      .mockResolvedValueOnce({ ok: true, bots: [dev, lead] });
    setFactoryBotPort({ ...port, create: vi.fn(), createTeam } as unknown as FactoryBotPort);
    await render(<BotsPage engine={{}} />);
    const team = q<HTMLButtonElement>('[data-bots-first-team]')!;
    await act(async () => { team.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-bots-first-error]')?.textContent).toBe('This workspace already has the whole team.');
    expect(q('[data-bots-chat]')).toBeNull();
    await act(async () => { team.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-bots-chat]')?.getAttribute('data-bots-chat')).toBe('bot:bot-0000000e');
  });

  it('Add team makes the bots only, no group; then one action makes a group chat with the team, filled in', async () => {
    seedRooms();
    const lead = { ...botRow('bot-0000000e', 'lead', 'w1', 9, 'Team Lead').bot, template: 'coordinator' as const };
    const dev = { ...botRow('bot-0000000f', 'lead', 'w1', 10, 'Team Dev').bot, template: 'developer' as const };
    const createTeam = vi.fn(async () => {
      bots.push({ bot: lead, status: null }, { bot: dev, status: null });
      return { ok: true as const, bots: [lead, dev] };
    });
    setFactoryBotPort({ ...port, create: vi.fn(), createTeam } as unknown as FactoryBotPort);
    await render(<BotsPage groupPort={groupPort} />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    openAddBot();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="bots-add-bot"] [data-testid="factory-add-team"]')!.click(); });
    expect(createTeam).toHaveBeenCalled();
    // No group was made; the list offers one.
    expect(groupCalls).toEqual([]);
    expect(q('[data-bots-team-notice]')!.textContent).toContain('Make a group chat with this team');
    // The narrow column: the line and × share a row, the action has its own
    // and never shrinks the line to a word per row.
    const notice = q('[data-bots-team-notice]')!;
    const line = q('[data-bots-team-text]')!;
    expect(line.parentElement!.contains(q('[data-bots-team-dismiss]'))).toBe(true);
    expect(line.parentElement!.contains(q('[data-bots-team-group]'))).toBe(false);
    expect(q('[data-bots-team-group]')!.parentElement).toBe(notice);
    expect(q('[data-bots-team-group]')!.className).toContain('shrink-0');
    expect(notice.className).toContain('flex-col');
    act(() => q('[data-bots-team-group]')!.click());
    const dialog = document.querySelector('[data-testid="bots-group-dialog"]')!;
    expect(dialog.querySelector<HTMLInputElement>('[data-bots-group-name]')!.value).toBe('api');
    expect(dialog.querySelector<HTMLInputElement>(`[data-bots-group-member="${lead.id}"]`)!.checked).toBe(true);
    expect(dialog.querySelector<HTMLInputElement>(`[data-bots-group-member="${dev.id}"]`)!.checked).toBe(true);
    expect(dialog.querySelector<HTMLInputElement>(`[data-bots-group-member="${LEAD}"]`)!.checked).toBe(false);
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-bots-group-save]')!.click(); });
    expect(groupCalls).toEqual([{ op: 'create', req: { workspaceId: 'w1', name: 'api', memberIds: [lead.id, dev.id] } }]);
    expect(q('[data-bots-team-notice]')).toBeNull();
  });

  it('"+" › Add team opens the team form; a workspace with a coordinator is offered its missing roles', async () => {
    seedRooms();
    setFactoryBotPort({ ...port, create: vi.fn(), createTeam: vi.fn() } as unknown as FactoryBotPort);
    await render(<BotsPage />);
    act(() => q('[data-bots-add]')!.click());
    act(() => q('[data-bots-add-team]')!.click());
    await act(async () => { await Promise.resolve(); });
    const form = document.querySelector('[data-testid="bots-add-bot"] [data-testid="factory-add-bot"]')!;
    expect(form.getAttribute('data-mode')).toBe('team');
    expect(form.querySelector('[data-testid="factory-add-bot-name"]')).toBeNull();
    expect(form.querySelector('[data-testid="factory-add-team"]')).not.toBeNull();
    // A workspace with a coordinator already: Add team fills the rest in.
    act(() => root.unmount());
    root = createRoot(container);
    bots = [...bots, { ...botRow('bot-0000000f', 'lead', 'w1', 4, 'Boss'), bot: { ...botRow('bot-0000000f', 'lead', 'w1', 4, 'Boss').bot, template: 'coordinator' } }];
    act(() => useStore.setState({ activeWorkspaceId: 'w1' } as never));
    await render(<BotsPage />);
    openAddBot();
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-testid="bots-add-bot"] [data-testid="factory-add-team"]')).not.toBeNull();
  });

  it('first screen: an engine that cannot sign in says why, offers Log in to Claude, and Start waits until it can', async () => {
    bots = [];
    seedRooms();
    const create = vi.fn(async () => ({ ok: false as const, code: 'invalid_argument' as const, message: 'x' }));
    setFactoryBotPort({ ...port, create } as unknown as FactoryBotPort);
    let ready = false;
    const engine: EnginePort = {
      readiness: vi.fn(async () => (ready ? { ready: true } : { ready: false, reason: 'claude-not-logged-in' as const })),
      login: vi.fn(async () => { ready = true; }),
    };
    await render(<BotsPage engine={engine} />);
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-bots-engine="claude-not-logged-in"]')?.textContent).toContain('Claude isn\'t signed in');
    const input = q<HTMLInputElement>('[data-bots-first-name]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ada');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(q<HTMLButtonElement>('[data-bots-first-start]')!.disabled).toBe(true);
    // One primary: Log in while Start waits.
    expect(q('[data-bots-engine-login]')?.className).toContain('ui-btn-primary');
    expect(q('[data-bots-first-start]')?.className).not.toContain('ui-btn-primary');
    await act(async () => { q('[data-bots-engine-login]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(engine.login).toHaveBeenCalledTimes(1);
    expect(q('[data-bots-engine]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-bots-first-start]')!.disabled).toBe(false);
  });

  it('first screen: Claude not installed offers Install Claude Code and Check again', async () => {
    bots = [];
    seedRooms();
    setFactoryBotPort({ ...port, create: vi.fn() } as unknown as FactoryBotPort);
    const openExternal = vi.fn(async () => undefined);
    (window as unknown as { electronAPI: { shell: { openExternal: typeof openExternal } } }).electronAPI = {
      ...(window as unknown as { electronAPI?: object }).electronAPI,
      shell: { openExternal },
    };
    const engine: EnginePort = {
      readiness: vi.fn(async () => ({ ready: false, reason: 'claude-not-installed' as const })),
    };
    await render(<BotsPage engine={engine} />);
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-bots-engine="claude-not-installed"]')?.textContent).toContain('isn\'t installed');
    expect(q('[data-bots-engine-install]')?.className).toContain('ui-btn-primary');
    expect(q('[data-bots-engine-login]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-bots-first-start]')!.disabled).toBe(true);
    await act(async () => { q('[data-bots-engine-install]')!.click(); });
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('claude-code'));
    expect(q('[data-bots-engine-recheck]')).not.toBeNull();
  });

  it('first screen: Start waits for the engine\'s first answer', async () => {
    bots = [];
    seedRooms();
    setFactoryBotPort({ ...port, create: vi.fn() } as unknown as FactoryBotPort);
    let answer: (r: { ready: boolean }) => void = () => undefined;
    const engine: EnginePort = { readiness: () => new Promise((r) => { answer = r; }) };
    await render(<BotsPage engine={engine} />);
    const input = q<HTMLInputElement>('[data-bots-first-name]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ada');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(q<HTMLButtonElement>('[data-bots-first-start]')!.disabled).toBe(true);
    await act(async () => { answer({ ready: true }); });
    expect(q<HTMLButtonElement>('[data-bots-first-start]')!.disabled).toBe(false);
  });

  it('"+" while off: a job made invalid after the confirm opened closes it, and nothing is turned on', async () => {
    const off = api();
    off.status = vi.fn(async () => ({ running: true, enabled: false, hqWorkspaceId: 'hq' })) as unknown as RoomsApi['status'];
    setRoomsApiForTests(off);
    seedRooms(false);
    const create = vi.fn();
    setFactoryBotPort({ ...port, create } as unknown as FactoryBotPort);
    const settings = { available: true, get: vi.fn(async () => null), set: vi.fn(async () => ({ enabled: true }) as never) };
    await render(<BotsPage settings={settings} />);
    openAddBot();
    const dialog = document.querySelector('[data-testid="bots-add-bot"]')!;
    const name = dialog.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Triage');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => dialog.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!.click());
    expect(dialog.querySelector('[data-testid="factory-add-bot-on-confirm"]')).not.toBeNull();
    const job = dialog.querySelector<HTMLTextAreaElement>('[data-testid="factory-add-bot-job"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(job, 'bad\u0007job');
      job.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dialog.querySelector('[data-testid="factory-add-bot-on-confirm"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="factory-add-bot-blocked"]')).not.toBeNull();
    expect(settings.set).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('first screen: a build that cannot tell the engine\'s state never blocks Start', async () => {
    bots = [];
    seedRooms();
    setFactoryBotPort({ ...port, create: vi.fn() } as unknown as FactoryBotPort);
    await render(<BotsPage engine={{}} />);
    const input = q<HTMLInputElement>('[data-bots-first-name]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ada');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(q('[data-bots-engine]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-bots-first-start]')!.disabled).toBe(false);
  });

  it('composerHint: a Lead\'s empty 1:1 asks for its first task; otherwise "Message <name>"', () => {
    const tt = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`;
    const conv = (role: BotRole): Conversation => ({
      kind: 'bot', id: 'bot:x', workspaceId: 'w1', row: botRow(LEAD, role, 'w1', 1, 'Lead'), last: null, lastAt: 0, needsYou: 0, openQuestions: 0, openApprovals: 0, workers: [], tree: [], lone: false,
    });
    expect(composerHint(conv('lead'), 0, 'Lead', tt)).toBe('botsPage.leadHint{"name":"Lead"}');
    expect(composerHint(conv('lead'), 2, 'Lead', tt)).toBe('botsPage.messageTo{"name":"Lead"}');
    expect(composerHint(conv('verifier'), 0, 'Lead', tt)).toBe('botsPage.messageTo{"name":"Lead"}');
  });

  it('a plan is answered on the Bots page with the room dock\'s own answers, naming workspaces', async () => {
    // The HQ's room was made a group chat (it had the owner's words).
    bots.push(botRow('bot-0000000e', 'verifier', 'hq', 4, 'HQ Helper'));
    groups.push({ id: 'grp-000000a2', workspaceId: 'hq', name: '', memberIds: [MOA, 'bot-0000000e'], threadId: 'general', createdAt: 1, updatedAt: 1 });
    const resolve = vi.fn(async () => ({ ok: true as const, card: cards[0] }));
    const plan = card({
      workspaceId: 'hq', actor: by('hq', MOA), kind: 'plan', state: 'open', threadId: 'plan:p-1', at: 500,
      title: 'Plan for today', body: '1. **Fix login** — workspace `w1`, size S. it breaks',
    });
    cards.push(plan);
    const a = api();
    a.resolve = resolve as unknown as RoomsApi['resolve'];
    setRoomsApiForTests(a);
    seedRooms();
    await render(<BotsPage api={a} />);
    // It waits on the owner: Moa's row counts it, and the rail sum with it.
    expect(q(`[data-bots-row="bot:${MOA}"] [data-bots-needs]`)?.textContent).toBe('1');
    act(() => q(`[data-bots-row="bot:${MOA}"]`)!.click());
    const bubble = q(`[data-room-card-id="${plan.id}"]`)!;
    expect(bubble.getAttribute('data-waits-on-owner')).toBe('true');
    expect(bubble.querySelector('[data-card-answers="plan"]')).not.toBeNull();
    expect(bubble.textContent).toContain('Fix login — api, size S');
    expect(bubble.textContent).not.toContain('`w1`');
    await act(async () => { bubble.querySelector<HTMLButtonElement>('[data-testid="hq-plan-approve"]')!.click(); });
    expect(resolve).toHaveBeenCalledWith({ workspaceId: 'hq', cardId: plan.id, resolution: 'approve' });
    // The HQ group shows the same answers.
    act(() => q('[data-bots-row="group:grp-000000a2"]')!.click());
    expect(q(`[data-room-card-id="${plan.id}"] [data-card-answers="plan"]`)).not.toBeNull();
    // Editing, then the bots pause: the answers leave and the body is back.
    act(() => q<HTMLButtonElement>(`[data-room-card-id="${plan.id}"] [data-testid="hq-plan-edit"]`)!.click());
    expect(q(`[data-room-card-id="${plan.id}"] [data-card-body]`)).toBeNull();
    act(() => useStore.setState({ roomStatus: { running: true, enabled: false, hqWorkspaceId: 'hq' } } as never));
    expect(q(`[data-room-card-id="${plan.id}"] [data-testid="hq-plan-edit-input"]`)).toBeNull();
    expect(q(`[data-room-card-id="${plan.id}"] [data-card-body]`)?.textContent).toContain('Fix login');
  });

  it('system cards show their body (folded) in a group, and the ones about a bot\'s work in its 1:1', async () => {
    const reasons = 'The lane refused the merge:\n- no required checks\n- the file list was empty\n- the author is not trusted';
    cards.push(card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'refusal', threadId: 'pr:github.com/acme/api#1', title: 'Merge refused for #1 at abc1234', body: reasons, at: 420 }));
    const refusalId = cards[cards.length - 1].id;
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    // It is a reply in the PR's thread: the thread's root says so, and the
    // thread opens beside the chat.
    expect(q(`[data-bots-messages] [data-room-card-id="${refusalId}"]`)).toBeNull();
    act(() => q('[data-bots-thread-summary="pr:github.com/acme/api#1"]')!.click());
    const line = q(`[data-bots-thread-panel] [data-room-card-id="${refusalId}"]`)!;
    expect(line.getAttribute('data-bots-bubble')).toBe('system');
    expect(line.textContent).toContain('Merge refused for #1');
    const body = line.querySelector('[data-card-body]')!;
    expect(body.textContent).toContain('no required checks');
    expect(body.getAttribute('data-clamped')).toBe('true');
    act(() => line.querySelector<HTMLButtonElement>('[data-card-more]')!.click());
    expect(line.querySelector('[data-card-body]')?.getAttribute('data-clamped')).toBeNull();
    // Lead asked in that PR's thread: the refusal is in Lead's 1:1 too; the
    // room-wide CI fact is not.
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-thread-summary="pr:github.com/acme/api#1"]')!.click());
    expect(q(`[data-bots-thread-panel] [data-room-card-id="${refusalId}"] [data-card-body]`)?.textContent).toContain('the author is not trusted');
    expect(q('[data-bots-messages] [data-room-card-id="c6"]')).toBeNull();
  });

  it('Stop in a bot\'s profile asks in place, then stops its turn and workers and says so', async () => {
    seedRooms();
    const stop = { stopBot: vi.fn(async () => ({ ok: true, workersStopped: 2 })) };
    act(() => useStore.setState({ toasts: [] } as never));
    await render(<BotsPage stop={stop} />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    act(() => q('[data-testid="bots-stop-bot"]')!.click());
    expect(stop.stopBot).not.toHaveBeenCalled();
    expect(q('[data-testid="bots-stop-bot-confirm-row"]')?.textContent).toContain("Stop Lead's turn and its workers?");
    // Cancel keeps it running.
    act(() => q('[data-testid="bots-stop-bot-cancel"]')!.click());
    expect(q('[data-testid="bots-stop-bot-confirm-row"]')).toBeNull();
    act(() => q('[data-testid="bots-stop-bot"]')!.click());
    await act(async () => { q('[data-testid="bots-stop-bot-confirm"]')!.click(); });
    expect(stop.stopBot).toHaveBeenCalledWith(LEAD);
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Stopped Lead and 2 of its workers.');
  });

  it('Pause in a bot\'s profile parks it at once (no confirm), and the profile then shows Paused with Resume', async () => {
    const act$ = vi.fn(async (action: string, botId: string) => {
      if (action === 'park') {
        bots = bots.map((b) => (b.bot.id === botId ? { ...b, bot: { ...b.bot, parked: { reason: 'human' as const, at: 1 } }, status: { ...b.status!, presence: 'parked' as const } } : b));
        for (const fn of notify) fn();
      }
      return { ok: true };
    });
    const notify: Array<() => void> = [];
    setFactoryBotPort({ ...port, act: act$, subscribe: (fn) => { notify.push(fn); return () => undefined; } });
    seedRooms();
    await render(<BotsPage stop={{ stopBot: vi.fn(async () => ({ ok: true, workersStopped: 0 })) }} />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    expect(q('[data-bots-profile-parked]')).toBeNull();
    expect(q('[data-testid="bots-stop-bot"]')).not.toBeNull();
    await act(async () => { q<HTMLButtonElement>('[data-testid="bots-pause-bot"]')!.click(); });
    expect(act$).toHaveBeenCalledWith('park', LEAD);
    for (let i = 0; i < 5 && !q('[data-bots-profile-parked="human"]'); i++) await act(async () => { await Promise.resolve(); });
    expect(q('[data-bots-profile-parked="human"]')?.textContent).toContain('Paused by you.');
    expect(q('[data-testid="bots-resume-bot"]')).not.toBeNull();
    expect(q('[data-testid="bots-pause-bot"]')).toBeNull();
  });

  it('right after Resume the profile reads Resuming… until the runtime reports, not Not reported yet', async () => {
    const notify: Array<() => void> = [];
    const setLead = (over: Partial<FactoryBotRow['bot']>, presence: 'parked' | 'unknown' | 'idle') => {
      bots = bots.map((b) => (b.bot.id === LEAD ? { ...b, bot: { ...b.bot, ...over }, status: { ...b.status!, presence } } : b));
    };
    setLead({ parked: { reason: 'human', at: 1 } }, 'parked');
    const act$ = vi.fn(async () => {
      bots = bots.map((b) => (b.bot.id === LEAD ? { ...b, bot: { ...b.bot, parked: undefined } } : b));
      setLead({}, 'unknown');
      for (const fn of notify) fn();
      return { ok: true };
    });
    setFactoryBotPort({ ...port, act: act$, subscribe: (fn) => { notify.push(fn); return () => undefined; } });
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    expect(q('[data-bots-profile-state]')?.textContent).toBe('On · Parked');
    await act(async () => { q<HTMLButtonElement>('[data-testid="bots-resume-bot"]')!.click(); });
    for (let i = 0; i < 5 && q('[data-bots-profile-state]')?.textContent !== 'On · Resuming…'; i++) await act(async () => { await Promise.resolve(); });
    expect(q('[data-bots-profile-state]')?.textContent).toBe('On · Resuming…');
    setLead({}, 'idle');
    await act(async () => { for (const fn of notify) fn(); });
    for (let i = 0; i < 5 && q('[data-bots-profile-state]')?.textContent !== 'On · Idle'; i++) await act(async () => { await Promise.resolve(); });
    expect(q('[data-bots-profile-state]')?.textContent).toBe('On · Idle');
  });

  it('Resuming… lasts at most 10 s while the runtime reports nothing, then reads as a bot with no turn yet', async () => {
    const notify: Array<() => void> = [];
    bots = bots.map((b) => (b.bot.id === VERIFIER ? { ...b, bot: { ...b.bot, parked: { reason: 'human' as const, at: 1 } }, status: { ...b.status!, presence: 'parked' as const } } : b));
    const act$ = vi.fn(async () => {
      bots = bots.map((b) => (b.bot.id === VERIFIER ? { ...b, bot: { ...b.bot, parked: undefined }, status: { ...b.status!, presence: 'unknown' as const } } : b));
      for (const fn of notify) fn();
      return { ok: true };
    });
    setFactoryBotPort({ ...port, act: act$, subscribe: (fn) => { notify.push(fn); return () => undefined; } });
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    expect(q('[data-bots-profile-state]')?.textContent).toBe('On · Parked');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await act(async () => { q<HTMLButtonElement>('[data-testid="bots-resume-bot"]')!.click(); });
      for (let i = 0; i < 5 && q('[data-bots-profile-state]')?.textContent !== 'On · Resuming…'; i++) await act(async () => { await Promise.resolve(); });
      expect(q('[data-bots-profile-state]')?.textContent).toBe('On · Resuming…');
      await act(async () => { vi.advanceTimersByTime(9_000); });
      expect(q('[data-bots-profile-state]')?.textContent).toBe('On · Resuming…');
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(q('[data-bots-profile-state]')?.textContent).toBe('On · Not reported yet');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a parked bot\'s profile says why and offers Resume (budget or errors); a bot that is not parked shows none', async () => {
    const act$ = vi.fn(async () => ({ ok: true }));
    bots[1] = { ...bots[1], bot: { ...bots[1].bot, parked: { reason: 'budget', at: 1 } }, status: { ...bots[1].status!, presence: 'parked' } };
    bots[2] = { ...bots[2], bot: { ...bots[2].bot, parked: { reason: 'error', at: 1 } }, status: { ...bots[2].status!, presence: 'parked' } };
    setFactoryBotPort({ ...port, act: act$ });
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    expect(q('[data-bots-profile-parked="budget"]')?.textContent).toContain('Out of turns');
    await act(async () => { q<HTMLButtonElement>('[data-testid="bots-resume-bot"]')!.click(); });
    expect(act$).toHaveBeenCalledWith('resume', LEAD);
    act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    expect(q('[data-bots-profile-parked="error"]')?.textContent).toContain('Stopped after errors');
    await act(async () => { q<HTMLButtonElement>('[data-testid="bots-resume-bot"]')!.click(); });
    expect(act$).toHaveBeenLastCalledWith('resume', VERIFIER);
    act(() => q(`[data-bots-row="bot:${MOA}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    expect(q('[data-bots-profile-parked]')).toBeNull();
    expect(q('[data-testid="bots-resume-bot"]')).toBeNull();
  });

  it('a bot parked signed out: Log in opens the sign-in of that bot\'s account and steps aside to its terminal', async () => {
    const factoryEngineLogin = vi.fn(async () => undefined);
    vi.stubGlobal('electronAPI', { web: { status: vi.fn(async () => ({ running: false })) }, factory: { factoryEngineLogin } });
    bots[2] = {
      ...bots[2],
      bot: { ...bots[2].bot, parked: { reason: 'error', at: 1 } },
      status: { ...bots[2].status!, presence: 'parked', lastError: { message: 'Not logged in · Please run /login', at: 1, code: 'not_logged_in', account: 'Work' } },
    };
    seedRooms();
    await render(<BotsPage />);
    act(() => useStore.getState().setAppRoute('bots'));
    act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    expect(q('[data-bots-engine-error="not_logged_in"]')?.textContent).toContain('not signed in for the account Work');
    // In the narrow profile popover the buttons wrap below the text, which
    // keeps a readable width instead of shrinking to nothing.
    const row = q('[data-bots-engine-error-row]')!;
    expect(row.className).toContain('flex-wrap');
    expect(row.firstElementChild?.className).toMatch(/min-w-\[10rem\]/);
    await act(async () => { q<HTMLButtonElement>('[data-bots-engine-error-fix]')!.click(); });
    expect(factoryEngineLogin).toHaveBeenCalledWith({ botId: VERIFIER });
    expect(useStore.getState().appRoute).toBe('workspaces');
  });

  it('Delete bot asks in place, saying what happens, then removes it with its colour slot', async () => {
    const remove = vi.fn(async () => ({ ok: true }));
    setFactoryBotPort({ ...port, remove });
    seedRooms();
    act(() => useStore.setState({ toasts: [] } as never));
    await render(<BotsPage />);
    const slot = botHueIndex(LEAD);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    act(() => q('[data-testid="bots-delete-bot"]')!.click());
    expect(remove).not.toHaveBeenCalled();
    const text = q('[data-testid="bots-delete-bot-confirm-row"]')?.textContent ?? '';
    expect(text).toContain('Delete Lead?');
    expect(text).toContain('messages stay');
    expect(text).toContain('running workers are stopped');
    expect(text).toContain('routines are removed');
    act(() => q('[data-testid="bots-delete-bot-cancel"]')!.click());
    expect(q('[data-testid="bots-delete-bot-confirm-row"]')).toBeNull();
    act(() => q('[data-testid="bots-delete-bot"]')!.click());
    await act(async () => { q('[data-testid="bots-delete-bot-confirm"]')!.click(); });
    expect(remove).toHaveBeenCalledWith(LEAD, slot);
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Lead was deleted.');
  });

  it('a removed bot\'s messages keep its name, marked removed, never its legacy role', async () => {
    const GONE = 'bot-0000000d';
    cards.push(card({ workspaceId: 'w1', actor: by('w1', GONE), title: 'I built the login page', at: 500 }));
    const withGone = api();
    withGone.actors = vi.fn(async () => ({ actors: { [GONE]: { role: 'lead' as BotRole, name: 'Developer', removed: true as const, hue: 2 } } }));
    setRoomsApiForTests(withGone);
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    const chat = q('[data-bots-chat]')?.textContent ?? '';
    expect(chat).toContain('Developer (removed)');
    // Its face keeps the colour slot its tombstone carries.
    expect(botHueIndex(GONE)).toBe(2);
    expect(chat).not.toMatch(/\bLead\b.*I built the login page/);
  });

  it('Stop all bots: the header menu, an inline confirm, then the counts that are not zero', async () => {
    seedRooms();
    const stop = { stopAll: vi.fn(async () => ({ ok: true, botsInterrupted: 1, workersStopped: 3, gatesCancelled: 0 })) };
    act(() => useStore.setState({ toasts: [] } as never));
    await render(<BotsPage stop={stop} />);
    act(() => q('[data-bots-menu]')!.click());
    act(() => q('[data-bots-stop-all]')!.click());
    expect(stop.stopAll).not.toHaveBeenCalled();
    expect(q('[data-testid="bots-stop-all-confirm-row"]')).not.toBeNull();
    await act(async () => { q('[data-testid="bots-stop-all-confirm"]')!.click(); });
    expect(stop.stopAll).toHaveBeenCalledTimes(1);
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Stopped: bot turns 1, workers 3');
    expect(q('[data-testid="bots-stop-all-confirm-row"]')).toBeNull();
  });

  it('without the stop verbs there is no menu and no Stop', async () => {
    seedRooms();
    await render(<BotsPage stop={{}} />);
    expect(q('[data-bots-menu]')).toBeNull();
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    expect(q('[data-testid="bots-stop-bot"]')).toBeNull();
  });

  it('lists rooms and bots by latest activity (the HQ room is not pinned), with needs-you on the bot that asked', async () => {
    seedRooms();
    await render(<BotsPage />);
    expect(rowIds()).toEqual(['group:grp-000000a1', `bot:${LEAD}`, `bot:${VERIFIER}`, `bot:${MOA}`]);
    expect(container.textContent).not.toContain('HQ');
    // Lead: one open question and its worker t1 (status not reported: not live).
    expect(q(`[data-bots-row="bot:${LEAD}"] [data-bots-needs]`)?.textContent).toBe('1');
    expect(q(`[data-bots-row="bot:${VERIFIER}"] [data-bots-needs]`)).toBeNull();
    expect(q('[data-bots-row="group:grp-000000a1"] [data-bots-needs]')).toBeNull();
    // Previews: the newest message, the owner's as "You: …" — never wmux's
    // own line, though it still orders the list (room w1 is first).
    expect(q(`[data-bots-row="bot:${VERIFIER}"]`)?.textContent).toContain('PR #1 passes');
    expect(q('[data-bots-row="group:grp-000000a1"]')?.textContent).toContain('Lead: Merge #1 now?');
    expect(q('[data-bots-row="group:grp-000000a1"]')?.textContent).not.toContain('CI green on #1');
  });

  it('a 1:1 shows only that bot\'s cards and the owner\'s messages to it; a group shows the room', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(q('[data-bots-page]')?.getAttribute('data-view')).toBe('chat');
    const shown = () => [...container.querySelectorAll('[data-bots-messages] [data-room-card-id]')].map((el) => el.getAttribute('data-room-card-id'));
    expect(shown()).toEqual(['c2', 'c3', 'c5']);
    expect(q('[data-bots-bubble="owner"]')?.textContent).toContain('Thanks lead');
    expect(q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')?.placeholder).toBe('Message Lead');
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    expect(shown()).toEqual(['c2', 'c3', 'c4', 'c5', 'c6']);
    expect(q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')?.placeholder).toBe('Message api');
    // Back (the narrow layout's list) and the profile under the pill.
    act(() => q('[data-bots-back]')!.click());
    expect(q('[data-bots-page]')?.getAttribute('data-view')).toBe('list');
  });

  it('a hidden window does not pin the chat or its thread to the bottom (Blink would hold the scroll event and the chat); shown again, they do', async () => {
    let state: DocumentVisibilityState = 'hidden';
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    const writes: number[] = [];
    const proto = HTMLDivElement.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(proto, 'scrollTop', { configurable: true, get: () => writes.at(-1) ?? 0, set: (v: number) => { writes.push(v); } });
    try {
      seedRooms();
      await render(<BotsPage />);
      act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
      act(() => q('[data-room-card-id="c4"] [data-bots-thread-chip="pr:github.com/acme/api#1"]')!.click());
      expect(q('[data-bots-messages]')).not.toBeNull();
      expect(q('[data-bots-thread-panel]')).not.toBeNull();
      expect(writes).toEqual([]);
      // Shown again: the chat and the open thread each pin once.
      state = 'visible';
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(writes).toEqual([500, 500]);
    } finally {
      delete proto.scrollHeight;
      delete proto.scrollTop;
      visibility.mockRestore();
    }
  });

  it('a thread chip opens the thread beside the chat; the main timeline stays as it was', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    const shown = (scope: string) => [...container.querySelectorAll(`${scope} [data-room-card-id]`)].map((el) => el.getAttribute('data-room-card-id'));
    // The thread's root (the verdict) and its open question (it waits on the
    // owner) both stay in the main timeline; the root says how many replies.
    expect(shown('[data-bots-messages]')).toEqual(['c2', 'c3', 'c4', 'c5', 'c6']);
    expect(q('[data-bots-thread-summary="pr:github.com/acme/api#1"]')?.textContent).toContain('1 reply');
    act(() => q('[data-room-card-id="c4"] [data-bots-thread-chip="pr:github.com/acme/api#1"]')!.click());
    expect(q('[data-bots-thread-panel]')?.getAttribute('data-bots-thread-panel')).toBe('pr:github.com/acme/api#1');
    expect(shown('[data-bots-thread-panel]')).toEqual(['c4', 'c5']);
    expect(shown('[data-bots-messages]')).toHaveLength(5);
    // Its composer posts into the thread.
    const reply = q<HTMLTextAreaElement>('[data-bots-thread-panel] [data-testid="bots-composer-input"]')!;
    expect(reply.placeholder).toBe('Reply in thread');
    // With no bot picked the reply names none: main settles who gets it (the
    // coordinator as lead, any bot waiting there, else every bot).
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(reply, 'Looks good');
      reply.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q('[data-bots-thread-panel] [data-testid="bots-composer-send"]')!.click(); });
    expect(posted.at(-1)).toMatchObject({ workspaceId: 'w1', threadId: 'pr:github.com/acme/api#1', title: 'Looks good' });
    expect(posted.at(-1)?.mentions).toBeUndefined();
    act(() => q('[data-bots-thread-close]')!.click());
    expect(q('[data-bots-thread-panel]')).toBeNull();
  });

  it('sends a 1:1 message to that bot (it is the one mention) and says who got it', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const input = q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(input, 'Please rebase');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q('[data-testid="bots-composer-send"]')!.click(); });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ workspaceId: 'w1', threadId: `dm:${LEAD}`, title: 'Please rebase', mentions: [LEAD] });
    expect(posted[0].to).toBeUndefined();
    // The posted card arrives by push; its delivery line names the bot.
    const sentCard = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', title: 'Please rebase', refs: { botId: LEAD } });
    act(() => useStore.getState().applyRoomEvent({ workspaceId: 'w1', card: { ...sentCard, id: `c${seq - 1}` }, threadSummary: { threadId: 'general', title: 'General', lastAt: 1, lastSeq: 1, cardCount: 1, openQuestions: 0, lastKind: 'human', status: 'open', unread: null } }));
    expect(q('[data-bots-delivery]')?.textContent).toBe('Sent to Lead');
  });

  it('a bot reply whose body repeats its title, or starts with it, prints once', async () => {
    cards.push(
      card({ workspaceId: 'w1', actor: by('w1', LEAD), threadId: `dm:${LEAD}`, title: 'Rebased onto main', body: 'Rebased onto main', at: 700 }),
      card({ workspaceId: 'w1', actor: by('w1', LEAD), threadId: `dm:${LEAD}`, title: 'Checked the build', body: 'Checked the build, and the tests pass.', at: 710 }),
    );
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const chat = q('[data-bots-messages]')?.textContent ?? '';
    expect(chat.split('Rebased onto main').length - 1).toBe(1);
    expect(chat.split('Checked the build').length - 1).toBe(1);
    expect(chat).toContain('Checked the build, and the tests pass.');
  });

  it('a 1:1 and the room are separate: a 1:1 thread shows only in its bot\'s chat, never as a thread chip in the room', async () => {
    cards.push(
      card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', threadId: `dm:${LEAD}`, refs: { botId: LEAD }, title: 'Private ask', at: 700 }),
      card({ workspaceId: 'w1', actor: by('w1', LEAD), threadId: `dm:${LEAD}`, title: 'Private answer', at: 710 }),
      card({ workspaceId: 'w1', actor: by('w1', VERIFIER), threadId: `dm:${LEAD}`, title: 'Private check', at: 715 }),
      card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Team, hello', at: 720 }),
    );
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    const chat = () => q('[data-bots-messages]')?.textContent ?? '';
    expect(chat()).toContain('Team, hello');
    expect(chat()).not.toContain('Private');
    expect(q(`[data-bots-thread-chip="dm:${LEAD}"]`)).toBeNull();
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(chat()).toContain('Private ask');
    expect(chat()).toContain('Private answer');
    expect(chat()).not.toContain('Team, hello');
    expect(container.querySelector('[data-bots-thread-chip^="dm:"]')).toBeNull();
    // Another bot speaking in this 1:1 is named; the 1:1's own bot is not.
    const heads = [...container.querySelectorAll('[data-bots-messages] [data-bots-msg-head]')].map((el) => el.textContent);
    expect(heads).toContain('Verifier');
    expect(heads).not.toContain('Lead');
  });

  it('photos: the picker stages chips (× and Backspace take them off), the send carries their paths, and a photo-only send has no words', async () => {
    const withPhotos = api();
    withPhotos.pickAttachments = vi.fn(async () => ['/Users/me/shot.png', '/Users/me/notes.txt']) as unknown as RoomsApi['pickAttachments'];
    setRoomsApiForTests(withPhotos);
    vi.stubGlobal('electronAPI', {
      web: { status: vi.fn(async () => ({ running: false })) },
      chat: { attachment: vi.fn(async ({ path }: { path: string }) => ({ ok: true, path, name: path.split('/').pop(), bytes: 10, thumbnail: 'data:image/png;base64,AAAA' })) },
    });
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const send = () => q<HTMLButtonElement>('[data-testid="bots-composer-send"]')!;
    expect(send().disabled).toBe(true);
    await act(async () => { q('[data-bots-composer-attach]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    // The PNG is staged; the text file is refused with one line.
    expect([...container.querySelectorAll('[data-bots-composer-photos] .wmux-chat-attachment-name')].map((el) => el.textContent)).toEqual(['shot.png']);
    expect(q('[data-testid="bots-composer-status"]')?.textContent).toBe('Only PNG and JPEG photos can be sent.');
    // A photo alone may be sent.
    expect(send().disabled).toBe(false);
    await act(async () => { send().click(); });
    expect(posted.at(-1)).toMatchObject({ workspaceId: 'w1', threadId: `dm:${LEAD}`, title: 'Photo', attachmentPaths: ['/Users/me/shot.png'] });
    expect(posted.at(-1)?.body).toBeUndefined();
    expect(container.querySelector('[data-bots-composer-photos]')).toBeNull();
    // Backspace at the start of the box takes the last chip off.
    await act(async () => { q('[data-bots-composer-attach]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    const input = q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')!;
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })); });
    expect(container.querySelector('[data-bots-composer-photos]')).toBeNull();
  });

  it("an owner card's photos show as thumbnails that open full size; a photo-only card draws no words", async () => {
    const id = 'a'.repeat(32);
    cards.push(card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', title: 'Photo', threadId: `dm:${LEAD}`, refs: { botId: LEAD }, at: 500, attachments: [{ id, mediaType: 'image/jpeg', bytes: 4 }] }));
    const withPhotos = api();
    withPhotos.attachment = vi.fn(async () => ({ ok: true, dataUrl: 'data:image/jpeg;base64,/9j/' })) as unknown as RoomsApi['attachment'];
    setRoomsApiForTests(withPhotos);
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    await act(async () => { await Promise.resolve(); });
    const owner = () => container.querySelector(`[data-room-card-id="${cards.at(-1)!.id}"]`)!;
    await vi.waitFor(() => expect(owner().querySelector(`[data-bots-photo="${id}"] img`)?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/'), { timeout: 10_000 });
    expect(owner().querySelector('.wmux-bots-bubble-owner')).toBeNull();
    const thumb = owner().querySelector<HTMLButtonElement>(`[data-bots-photo="${id}"]`)!;
    thumb.focus();
    act(() => thumb.click());
    expect(document.querySelector('[data-testid="bots-photo-viewer"] img')?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/');
    // A visible ×, Escape and the backdrop each close it; focus goes back to the thumbnail.
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="bots-photo-viewer-close"]')!.click());
    expect(document.querySelector('[data-testid="bots-photo-viewer"]')).toBeNull();
    expect(document.activeElement).toBe(thumb);
    act(() => thumb.click());
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[data-testid="bots-photo-viewer"]')).toBeNull();
  });

  it("a bot card's files show as chips that open in the side panel; Escape and another conversation close it", async () => {
    const id = 'd'.repeat(32);
    const file = { id, name: 'report.md', mediaType: 'text/markdown', bytes: 2048 };
    cards.push(card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Here is the report', threadId: `dm:${LEAD}`, at: 500, files: [file] }));
    const withFiles = api();
    withFiles.fileRead = vi.fn(async () => ({ ok: true as const, file, text: '# Report' })) as unknown as RoomsApi['fileRead'];
    withFiles.fileSave = vi.fn(async () => ({ ok: true as const, savedTo: '/tmp/report.md' })) as unknown as RoomsApi['fileSave'];
    setRoomsApiForTests(withFiles);
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    await act(async () => { await Promise.resolve(); });
    const withChip = container.querySelector(`[data-room-card-id="${cards.at(-1)!.id}"]`)!;
    const chip = withChip.querySelector<HTMLButtonElement>(`[data-bots-file="${id}"]`)!;
    expect(chip.getAttribute('aria-label')).toBe('Open report.md (2.0 KB)');
    // A card without files draws no file row.
    expect(container.querySelector(`[data-room-card-id="${cards[1].id}"] [data-bots-files]`)).toBeNull();
    chip.focus();
    await act(async () => { chip.click(); });
    expect(withFiles.fileRead).toHaveBeenCalledWith({ workspaceId: 'w1', fileId: id });
    await vi.waitFor(() => expect(q('[data-bots-file-panel] [data-bots-file-view="markdown"]')?.textContent).toBe('Report'), { timeout: 5_000 });
    expect(q('.wmux-bots-chat-area')?.getAttribute('data-worker-open')).toBe('true');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(q('[data-bots-file-panel]')).toBeNull();
    // Another conversation closes it.
    await act(async () => { q<HTMLButtonElement>(`[data-room-card-id="${cards.at(-1)!.id}"] [data-bots-file]`)!.click(); });
    expect(q('[data-bots-file-panel]')).not.toBeNull();
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(q('[data-bots-file-panel]')).toBeNull();
  });

  it('a group message goes to every bot of the group unless some are picked: "To: everyone ▾", a ticked box or a typed @name; picks reset after send', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    const input = q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')!;
    const typeText = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const to = () => q('[data-bots-recipients]')!.textContent;
    expect(to()).toBe('To: everyone');
    await typeText('Status?');
    await act(async () => { q('[data-testid="bots-composer-send"]')!.click(); });
    // A group made from the room lives in General; main sends it to every member.
    expect(posted[0]).toMatchObject({ workspaceId: 'w1', threadId: 'general', title: 'Status?' });
    expect(posted[0].to).toBeUndefined();
    expect(posted[0].mentions).toBeUndefined();
    // A typed @Name ticks that bot.
    await typeText('@Lead rebase please');
    expect(to()).toBe('To: Lead');
    act(() => q('[data-bots-recipients]')!.click());
    expect(q<HTMLInputElement>(`[data-bots-recipient="${LEAD}"]`)!.checked).toBe(true);
    expect(q<HTMLInputElement>(`[data-bots-recipient="${VERIFIER}"]`)!.checked).toBe(false);
    await act(async () => { q('[data-testid="bots-composer-send"]')!.click(); });
    expect(posted[1]).toMatchObject({ workspaceId: 'w1', mentions: [LEAD] });
    // Reset after the send: everyone again.
    expect(to()).toBe('To: everyone');
    // A ticked box picks that bot alone (the list is still open).
    expect(q('[data-bots-recipients-list]')).not.toBeNull();
    act(() => q<HTMLInputElement>(`[data-bots-recipient="${VERIFIER}"]`)!.click());
    expect(to()).toBe('To: Verifier');
    await typeText('Check #1');
    await act(async () => { q('[data-testid="bots-composer-send"]')!.click(); });
    expect(posted[2]).toMatchObject({ workspaceId: 'w1', mentions: [VERIFIER] });
    expect(to()).toBe('To: everyone');
  });

  it('in a group with a coordinator an unpicked message goes to it alone: "To: <lead>", and the hint says so', async () => {
    bots = bots.map((r) => (r.bot.id === LEAD ? { ...r, bot: { ...r.bot, template: 'coordinator' as const } } : r));
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    const button = q('[data-bots-recipients]')!;
    expect(button.textContent).toBe('To: Lead');
    // The default, not a pick: no selection fill.
    expect(button.className).not.toContain('selection-emphasis');
    act(() => button.click());
    expect(q('[data-bots-recipients-list]')!.textContent).toContain('None ticked: it goes to Lead, who leads and hands the work on.');
    // Main routes the unaddressed message to the coordinator.
    const input = q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Status?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q('[data-testid="bots-composer-send"]')!.click(); });
    expect(posted[0]).toMatchObject({ workspaceId: 'w1', threadId: 'general', title: 'Status?' });
    expect(posted[0].mentions).toBeUndefined();
  });

  it('a group chat the owner made shows only its thread and the work started there; its messages post to that thread', async () => {
    const G = 'group:grp-000000c1' as const;
    groups.push({ id: 'grp-000000c1', workspaceId: 'w1', name: 'Ship it', memberIds: [LEAD, VERIFIER], threadId: G, createdAt: 2_000, updatedAt: 2_000 });
    cards.push(
      card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', threadId: G, title: 'Ship the widget', refs: { botIds: [LEAD, VERIFIER] }, at: 2_100 }),
      card({ workspaceId: 'w1', actor: by('w1', LEAD), threadId: G, title: 'I am Lead; on it', at: 2_110 }),
      // The lead's request thread, opened from the group.
      card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: 'handoff:h-0000000c1', title: 'dispatch → Verifier: Build it', refs: { handoffId: 'h-0000000c1', threadId: G }, at: 2_120 }),
      card({ workspaceId: 'w1', actor: by('w1', VERIFIER), title: 'Room talk elsewhere', at: 2_130 }),
    );
    seedRooms();
    await render(<BotsPage />);
    expect(rowIds()).toContain('group:grp-000000c1');
    expect(q('[data-bots-row="group:grp-000000c1"]')!.textContent).toContain('Ship it');
    act(() => q('[data-bots-row="group:grp-000000c1"]')!.click());
    const chat = () => q('[data-bots-messages]')?.textContent ?? '';
    expect(chat()).toContain('Ship the widget');
    expect(chat()).toContain('I am Lead; on it');
    expect(chat()).toContain('Build it');
    expect(chat()).not.toContain('Room talk elsewhere');
    expect(chat()).not.toContain('Started a worker on login');
    // No "joined" line, no thread chip for the group itself.
    expect(container.querySelector('[data-bots-joined]')).toBeNull();
    expect(q(`[data-bots-thread-chip="${G}"]`)).toBeNull();
    // The room's General (the other group) does not show this group's thread.
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    expect(chat()).not.toContain('Ship the widget');
    expect(chat()).not.toContain('Build it');
    expect(chat()).toContain('Room talk elsewhere');
    act(() => q('[data-bots-row="group:grp-000000c1"]')!.click());
    const input = q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Go');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q('[data-testid="bots-composer-send"]')!.click(); });
    expect(posted.at(-1)).toMatchObject({ workspaceId: 'w1', threadId: G, title: 'Go' });
    expect(posted.at(-1)!.mentions).toBeUndefined();
  });

  it('a bot the owner paused: its 1:1 still takes a message and says, in one muted line, it reads it on resume', async () => {
    bots = bots.map((r) => (r.bot.id === LEAD ? { ...r, bot: { ...r.bot, parked: { reason: 'human' as const, at: 1 } } } : r));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const status = q('[data-testid="bots-composer-status"]')!;
    expect(status.textContent).toBe('Paused. Lead reads this when you resume it.');
    expect(status.className).toContain('text-[var(--text-muted)]');
    expect(status.getAttribute('role')).toBe('status');
    expect(q<HTMLTextAreaElement>('[data-bots-composer] textarea, textarea')!.disabled).toBe(false);
    // Another bot's 1:1, not paused, has no line.
    act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
    expect(q('[data-testid="bots-composer-status"]')).toBeNull();
  });

  it('a group with no bot on takes no message, and says why', async () => {
    bots = bots.map((r) => (r.bot.workspaceId === 'w1' ? { ...r, bot: { ...r.bot, enabled: false } } : r));
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    expect(q('[data-testid="bots-composer-status"]')!.textContent).toBe('No bot of this group is on.');
    expect(q<HTMLButtonElement>('[data-testid="bots-composer-send"]')!.disabled).toBe(true);
  });

  it('"+" New group chat: a name and bots of one workspace; one with fewer than two bots says so; the group made opens', async () => {
    seedRooms();
    await render(<BotsPage groupPort={groupPort} />);
    act(() => q('[data-bots-add]')!.click());
    act(() => q('[data-bots-new-group]')!.click());
    const dialog = () => document.querySelector('[data-testid="bots-group-dialog"]');
    expect(dialog()).not.toBeNull();
    const pick = (sel: string) => document.querySelector<HTMLElement>(sel)!;
    const set = async (sel: string, value: string) => {
      const el = pick(sel) as HTMLInputElement | HTMLSelectElement;
      await act(async () => {
        const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      });
    };
    // The HQ has one bot: it cannot make a group.
    await set('[data-bots-group-workspace]', 'hq');
    expect(pick('[data-bots-group-blocked]').textContent).toContain('fewer than two bots');
    expect((pick('[data-bots-group-save]') as HTMLButtonElement).disabled).toBe(true);
    // w1's bots only.
    await set('[data-bots-group-workspace]', 'w1');
    expect([...document.querySelectorAll('[data-bots-group-member]')].map((el) => el.getAttribute('data-bots-group-member'))).toEqual([LEAD, VERIFIER]);
    await set('[data-bots-group-name]', 'Release crew');
    expect(pick('[data-bots-group-blocked]').textContent).toBe('Pick two or more bots.');
    act(() => pick(`[data-bots-group-member="${LEAD}"]`).click());
    act(() => pick(`[data-bots-group-member="${VERIFIER}"]`).click());
    await act(async () => { pick('[data-bots-group-save]').click(); });
    expect(groupCalls).toEqual([{ op: 'create', req: { workspaceId: 'w1', name: 'Release crew', memberIds: [LEAD, VERIFIER] } }]);
    expect(dialog()).toBeNull();
  });

  it('a group\'s pill opens its settings: rename, change bots, delete (asked in place)', async () => {
    groups.push({ id: 'grp-000000c2', workspaceId: 'w1', name: 'Ship it', memberIds: [LEAD, VERIFIER], threadId: 'group:grp-000000c2', createdAt: 9_000, updatedAt: 9_000 });
    seedRooms();
    await render(<BotsPage groupPort={groupPort} />);
    act(() => q('[data-bots-row="group:grp-000000c2"]')!.click());
    act(() => q('[data-bots-pill]')!.click());
    const pick = (sel: string) => document.querySelector<HTMLElement>(sel)!;
    expect((pick('[data-bots-group-name]') as HTMLInputElement).value).toBe('Ship it');
    expect(document.querySelector('[data-bots-group-workspace]')).toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(pick('[data-bots-group-name]'), 'Release');
      pick('[data-bots-group-name]').dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { pick('[data-bots-group-save]').click(); });
    expect(groupCalls.at(-1)).toEqual({ op: 'update', req: { id: 'grp-000000c2', name: 'Release', memberIds: [LEAD, VERIFIER] } });
    act(() => q('[data-bots-pill]')!.click());
    act(() => pick('[data-bots-group-delete]').click());
    await act(async () => { pick('[data-testid="bots-group-delete-confirm"]').click(); });
    expect(groupCalls.at(-1)).toEqual({ op: 'remove', req: 'grp-000000c2' });
  });

  it('in a room, @ suggests its bots: Enter puts the name in, and a typed @Name anywhere addresses that bot', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    const input = q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')!;
    const typeText = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
        input.setSelectionRange(value.length, value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await typeText('please @V');
    const options = () => [...container.querySelectorAll('[data-bots-mention-option]')].map((el) => el.getAttribute('data-bots-mention-option'));
    expect(options()).toEqual([VERIFIER]);
    // A key pressed while the IME composes is the IME's.
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })); });
    expect(input.value).toBe('please @V');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(input.value).toBe('please @Verifier ');
    expect(options()).toEqual([]);
    expect(posted).toHaveLength(0);
    await typeText('please @Verifier check #1');
    expect(q('[data-bots-recipients]')!.textContent).toBe('To: Verifier');
    await act(async () => { q('[data-testid="bots-composer-send"]')!.click(); });
    expect(posted[0]).toMatchObject({ workspaceId: 'w1', title: 'please @Verifier check #1', mentions: [VERIFIER] });
    // Escape closes the list without touching the text.
    await typeText('@L');
    expect(options()).toEqual([LEAD]);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(options()).toEqual([]);
    expect(input.value).toBe('@L');
    // A new draft suggests again; completing inside a name replaces the whole word.
    await typeText('');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'ask @Ve check');
      input.setSelectionRange(7, 7);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(options()).toEqual([VERIFIER]);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); });
    expect(input.value).toBe('ask @Verifier check');
  });

  it('a live worker is a row under its bot in the list; a click shows its terminal beside the chat, never switching workspace', async () => {
    seedRooms();
    // t1 is running.
    act(() => useStore.setState({
      workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api'), {
        ...ws('t1', 'wtask: fix login'),
        rootPane: { id: 't1-p', type: 'leaf', ordinal: 1, surfaces: [{ id: 's', ptyId: 'pty-t1', title: '', shell: 'zsh', cwd: '/', surfaceType: 'terminal' }], activeSurfaceId: 's' },
      } as Workspace],
      surfaceAgent: { 'pty-t1': { name: 'Claude Code', status: 'awaiting_input' } },
      surfaceAgentStatus: { 'pty-t1': 'awaiting_input' },
    } as never));
    await render(<BotsPage />);
    expect(q(`[data-bots-row="bot:${LEAD}"] [data-bots-needs]`)?.textContent).toBe('2');
    // Folded under a bot whose chat is not open: the toggle says how many.
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    expect(q('[data-bots-worker="t1"]')).toBeNull();
    expect(q(`[data-bots-entry="bot:${LEAD}"] [data-bots-tree-toggle]`)?.getAttribute('aria-expanded')).toBe('false');
    // Open under the bot whose chat is open, its row and tree one group.
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(q(`[data-bots-entry="bot:${LEAD}"]`)?.classList.contains('is-open')).toBe(true);
    expect(q('[data-bots-entry="group:grp-000000a1"]')?.classList.contains('is-open')).toBe(false);
    // Under the bot's row in the list, not in the rail or the history.
    const worker = q(`[data-bots-entry="bot:${LEAD}"] [data-bots-tree] [data-bots-worker="t1"]`);
    expect(worker?.textContent).toContain('fix login');
    expect(worker?.textContent).not.toContain('wtask:');
    expect(worker?.getAttribute('data-worker-state')).toBe('needsYou');
    expect(q('[data-bots-rail] [data-bots-worker]')).toBeNull();
    expect(q('[data-bots-messages] [data-bots-worker]')).toBeNull();
    // The panel never opens on its own.
    expect(useStore.getState().botsWorkerPanel).toBeNull();
    // The toggle folds and unfolds the rows.
    const toggle = q(`[data-bots-entry="bot:${LEAD}"] [data-bots-tree-toggle]`)!;
    expect(toggle.textContent).toContain('1');
    act(() => toggle.click());
    expect(q('[data-bots-worker="t1"]')).toBeNull();
    act(() => q(`[data-bots-entry="bot:${LEAD}"] [data-bots-tree-toggle]`)!.click());
    act(() => q('[data-bots-worker="t1"]')!.click());
    expect(useStore.getState().activeWorkspaceId).toBe('hq');
    expect(useStore.getState().appRoute).toBe('bots');
    expect(useStore.getState().botsWorkerPanel).toEqual({ workspaceId: 't1', conversationId: `bot:${LEAD}` });
    expect(q(`[data-bots-chat="bot:${LEAD}"]`)).not.toBeNull();
    expect(q('[data-bots-worker-panel="t1"]')).not.toBeNull();
    expect(q('[data-bots-worker="t1"]')?.getAttribute('aria-current')).toBe('true');
    expect(q('[data-bots-splitter]')).not.toBeNull();
    // Close closes it; another conversation closes it too.
    act(() => q('[data-bots-worker-panel-close]')!.click());
    expect(q('[data-bots-worker-panel]')).toBeNull();
    act(() => q('[data-bots-worker="t1"]')!.click());
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    expect(useStore.getState().botsWorkerPanel).toBeNull();
    expect(q('[data-bots-worker-panel]')).toBeNull();
  });

  it('the chat header opens the bot\'s worker tree, so the narrow layout reaches a worker without the list (#2231)', async () => {
    seedRooms();
    act(() => useStore.setState({
      workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api'), {
        ...ws('t1', 'wtask: fix login'),
        rootPane: { id: 't1-p', type: 'leaf', ordinal: 1, surfaces: [{ id: 's', ptyId: 'pty-t1', title: '', shell: 'zsh', cwd: '/', surfaceType: 'terminal' }], activeSurfaceId: 's' },
      } as Workspace],
      surfaceAgent: { 'pty-t1': { name: 'Claude Code', status: 'running' } },
      surfaceAgentStatus: { 'pty-t1': 'running' },
    } as never));
    await render(<BotsPage />);
    // A group has no workers button; a bot with workers has one, with the count.
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    expect(q('[data-bots-chat] [data-bots-head-workers]')).toBeNull();
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const button = q(`[data-bots-chat="bot:${LEAD}"] [data-bots-head-workers]`)!;
    expect(button.textContent).toBe('1');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const row = q(`[data-bots-chat="bot:${LEAD}"] [data-bots-tree] [data-bots-worker="t1"]`)!;
    expect(row.textContent).toContain('fix login');
    // A worker picked there shows its terminal beside the chat, and the popover closes.
    act(() => row.click());
    expect(useStore.getState().botsWorkerPanel).toEqual({ workspaceId: 't1', conversationId: `bot:${LEAD}` });
    expect(q('[data-bots-worker-panel="t1"]')).not.toBeNull();
    expect(q(`[data-bots-chat="bot:${LEAD}"] [data-bots-tree]`)).toBeNull();
    expect(useStore.getState().activeWorkspaceId).toBe('hq');
  });

  it('a done task is a tree row while its pane is open (Resume in the panel\'s menu); a cleared one is not in the rail', async () => {
    seedRooms();
    const now = Date.now();
    const task = (taskId: string, taskWorkspaceId: string, extra: Record<string, unknown> = {}) => ({
      taskId, taskWorkspaceId, ownerWorkspaceId: 'w1', botId: LEAD, title: `task ${taskId}`, status: 'completed' as const,
      stage: 'closed' as const, worker: 'resumable' as const, updatedAt: now, ...extra,
    });
    bots[1] = { ...bots[1], tasks: [task('wtask-kept-00000001', 't1'), task('wtask-gone-00000002', 't-gone'), task('wtask-moved-0000003', 't-gone', { workerWorkspaceId: 't1' })] };
    const resumeWorker = vi.fn(async () => ({ ok: true, workspaceId: 't1' }));
    setFactoryBotPort({ ...port, resumeWorker });
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    // Its pane open: a done row in the list (the newest task on t1), none in the rail.
    expect(q('[data-bots-tree] [data-bots-worker="t1"]')?.getAttribute('data-worker-state')).toBe('done');
    expect(q('[data-bots-task="wtask-kept-00000001"]')).toBeNull();
    expect(q('[data-bots-task="wtask-moved-0000003"]')).toBeNull();
    act(() => q('[data-bots-worker="t1"]')!.click());
    act(() => q('[data-bots-worker-panel-menu]')!.click());
    expect(q('[data-bots-worker-panel-resume]')).not.toBeNull();
    expect(q('[data-bots-worker-panel-workspaces]')).not.toBeNull();
    act(() => useStore.getState().setBotsWorkerPanel(null));
    // Its pane cleared: an ended task is no rail row (owner decision
    // 2026-10-16); resuming it is the bot's call, or the card's Resume.
    expect(q('[data-bots-task="wtask-gone-00000002"]')).toBeNull();
    expect(resumeWorker).not.toHaveBeenCalled();
  });

  /** t1 holds a pane whose agent runs; t2 is a plain open workspace. */
  function seedWorkerPanes() {
    act(() => useStore.setState({
      workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api'), {
        ...ws('t1', 'wtask: fix login'),
        rootPane: { id: 't1-p', type: 'leaf', ordinal: 1, surfaces: [{ id: 's', ptyId: 'pty-t1', title: '', shell: 'zsh', cwd: '/', surfaceType: 'terminal' }], activeSurfaceId: 's' },
      } as Workspace, ws('t2', 'wtask: old one')],
      surfaceAgent: { 'pty-t1': { name: 'Claude Code', status: 'running' } },
      surfaceAgentStatus: { 'pty-t1': 'running' },
    } as never));
  }

  it('Stop worker: a running worker\'s panel menu offers it, asks in place, and stops that one task (Cancel sends nothing); its row has no menu', async () => {
    seedRooms();
    seedWorkerPanes();
    const taskId = 'wtask-run-00000001';
    bots[1] = { ...bots[1], tasks: [{
      taskId, taskWorkspaceId: 't1', ownerWorkspaceId: 'w1', botId: LEAD, title: 'fix login',
      status: 'working' as const, stage: 'working' as const, updatedAt: Date.now(),
    }] };
    const stop = {
      stopBot: vi.fn(async () => ({ ok: true, workersStopped: 1 })),
      stopTask: vi.fn(async () => ({ ok: true, workersStopped: 1, tasksCancelled: 1 })),
    };
    act(() => useStore.setState({ toasts: [] } as never));
    await render(<BotsPage stop={stop} />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const row = q('[data-bots-tree] [data-bots-worker="t1"]')!;
    expect(row.getAttribute('data-worker-state')).toBe('running');
    // The list's row stays a plain row: no menu of its own.
    expect(q('[data-bots-tree] [aria-haspopup="menu"]')).toBeNull();
    act(() => row.click());
    expect(q('[data-bots-worker-panel="t1"]')).not.toBeNull();
    act(() => q('[data-bots-worker-panel-menu]')!.click());
    expect(q('[data-bots-worker-panel-menu]')?.getAttribute('aria-label')).toBe('Worker options');
    expect(q('[data-bots-worker-panel-workspaces]')).not.toBeNull();
    expect(q('[data-bots-worker-panel-stop]')?.textContent).toBe('Stop worker');
    act(() => q('[data-bots-worker-panel-stop]')!.click());
    expect(q('[data-bots-worker-panel-stop]')).toBeNull();
    expect(q('[data-testid="bots-stop-worker-confirm-row"]')?.textContent).toContain('Stop the worker for “fix login”?');
    expect(stop.stopTask).not.toHaveBeenCalled();
    act(() => q('[data-testid="bots-stop-worker-cancel"]')!.click());
    expect(q('[data-testid="bots-stop-worker-confirm-row"]')).toBeNull();
    expect(stop.stopTask).not.toHaveBeenCalled();
    // Focus goes back to the menu's ⋯.
    expect(document.activeElement).toBe(q('[data-bots-worker-panel-menu]'));
    // Confirmed: that task's worker only, never the bot-wide stop; a toast says so.
    act(() => q('[data-bots-worker-panel-menu]')!.click());
    act(() => q('[data-bots-worker-panel-stop]')!.click());
    await act(async () => { q('[data-testid="bots-stop-worker-confirm"]')!.click(); });
    expect(stop.stopTask).toHaveBeenCalledTimes(1);
    expect(stop.stopTask).toHaveBeenCalledWith(taskId);
    expect(stop.stopBot).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Stopped the worker for “fix login”.');
    expect(q('[data-testid="bots-stop-worker-confirm-row"]')).toBeNull();
    expect(document.activeElement).toBe(q('[data-bots-worker-panel-menu]'));
    act(() => useStore.getState().setBotsWorkerPanel(null));
  });

  it('a Stop worker that answers after the panel moved to another worker leaves that worker\'s confirm and focus alone', async () => {
    seedRooms();
    const pane = (id: string) => ({
      ...ws(id, `wtask: ${id}`),
      rootPane: { id: `${id}-p`, type: 'leaf', ordinal: 1, surfaces: [{ id: `s-${id}`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/', surfaceType: 'terminal' }], activeSurfaceId: `s-${id}` },
    }) as Workspace;
    act(() => useStore.setState({
      workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api'), pane('t1'), pane('t2')],
      surfaceAgent: { 'pty-t1': { name: 'Claude Code', status: 'running' }, 'pty-t2': { name: 'Claude Code', status: 'running' } },
      surfaceAgentStatus: { 'pty-t1': 'running', 'pty-t2': 'running' },
    } as never));
    const view = (taskId: string, ws: string, title: string) => ({
      taskId, taskWorkspaceId: ws, ownerWorkspaceId: 'w1', botId: LEAD, title, status: 'working' as const, stage: 'working' as const, updatedAt: Date.now(),
    });
    bots[1] = { ...bots[1], tasks: [view('wtask-aaaa-00000001', 't1', 'task A'), view('wtask-bbbb-00000002', 't2', 'task B')] };
    let answerA: (r: { ok: boolean; workersStopped: number; tasksCancelled: number }) => void = () => undefined;
    const stopTask = vi.fn((taskId: string) => (taskId === 'wtask-aaaa-00000001'
      ? new Promise<{ ok: boolean; workersStopped: number; tasksCancelled: number }>((resolve) => { answerA = resolve; })
      : Promise.resolve({ ok: true, workersStopped: 1, tasksCancelled: 1 })));
    act(() => useStore.setState({ toasts: [] } as never));
    await render(<BotsPage stop={{ stopTask }} />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    // Stop A, and while it runs show B and open B's confirm.
    act(() => q('[data-bots-tree] [data-bots-worker="t1"]')!.click());
    act(() => q('[data-bots-worker-panel-menu]')!.click());
    act(() => q('[data-bots-worker-panel-stop]')!.click());
    await act(async () => { q('[data-testid="bots-stop-worker-confirm"]')!.click(); });
    expect(stopTask).toHaveBeenCalledWith('wtask-aaaa-00000001');
    act(() => q('[data-bots-tree] [data-bots-worker="t2"]')!.click());
    expect(q('[data-bots-worker-panel="t2"]')).not.toBeNull();
    act(() => q('[data-bots-worker-panel-menu]')!.click());
    act(() => q('[data-bots-worker-panel-stop]')!.click());
    const bConfirm = q('[data-testid="bots-stop-worker-confirm"]')!;
    expect(q('[data-testid="bots-stop-worker-confirm-row"]')?.textContent).toContain('task B');
    expect(document.activeElement).toBe(bConfirm);
    // A answers: its toast, but B's confirm stays open and keeps the focus.
    await act(async () => { answerA({ ok: true, workersStopped: 1, tasksCancelled: 1 }); });
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Stopped the worker for “task A”.');
    expect(q('[data-testid="bots-stop-worker-confirm-row"]')?.textContent).toContain('task B');
    expect(document.activeElement).toBe(bConfirm);
    expect(stopTask).toHaveBeenCalledTimes(1);
    act(() => q('[data-testid="bots-stop-worker-cancel"]')!.click());
    act(() => useStore.getState().setBotsWorkerPanel(null));
  });

  it('a partial Stop worker says why and keeps Stop worker offered once the task is cancelled, until a stop goes through', async () => {
    seedRooms();
    seedWorkerPanes();
    const taskId = 'wtask-part-00000001';
    const view = (stage: 'working' | 'cancelled') => [{
      taskId, taskWorkspaceId: 't1', ownerWorkspaceId: 'w1', botId: LEAD, title: 'fix login',
      status: stage, stage, updatedAt: Date.now(),
    }];
    bots[1] = { ...bots[1], tasks: view('working') as never };
    const stopTask = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'partial', workersStopped: 0, tasksCancelled: 1, message: 'The worker could not be stopped; stop again to retry.' })
      .mockResolvedValue({ ok: true, workersStopped: 1, tasksCancelled: 0 });
    act(() => useStore.setState({ toasts: [] } as never));
    await render(<BotsPage stop={{ stopTask }} />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-tree] [data-bots-worker="t1"]')!.click());
    act(() => q('[data-bots-worker-panel-menu]')!.click());
    act(() => q('[data-bots-worker-panel-stop]')!.click());
    await act(async () => { q('[data-testid="bots-stop-worker-confirm"]')!.click(); });
    expect(useStore.getState().toasts.at(-1)).toMatchObject({
      level: 'error',
      message: 'Could not stop the worker for “fix login”. The worker could not be stopped; stop again to retry.',
    });
    // The confirm stays for another try.
    expect(q('[data-testid="bots-stop-worker-confirm-row"]')).not.toBeNull();
    // Main cancelled the task meanwhile: the page reads it again, and Stop worker is still offered.
    act(() => root.unmount());
    bots[1] = { ...bots[1], tasks: view('cancelled') as never };
    root = createRoot(container);
    await render(<BotsPage stop={{ stopTask }} />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-tree] [data-bots-worker="t1"]')!.click());
    expect(q('[data-bots-tree] [data-bots-worker="t1"]')?.getAttribute('data-worker-state')).not.toBe('running');
    act(() => q('[data-bots-worker-panel-menu]')!.click());
    act(() => q('[data-bots-worker-panel-stop]')!.click());
    await act(async () => { q('[data-testid="bots-stop-worker-confirm"]')!.click(); });
    expect(stopTask).toHaveBeenCalledTimes(2);
    expect(stopTask).toHaveBeenLastCalledWith(taskId);
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Stopped the worker for “fix login”.');
    // Gone through: a cancelled task is offered no Stop worker again.
    act(() => q('[data-bots-worker-panel-menu]')!.click());
    expect(q('[data-bots-worker-panel-workspaces]')).not.toBeNull();
    expect(q('[data-bots-worker-panel-stop]')).toBeNull();
    act(() => useStore.getState().setBotsWorkerPanel(null));
  });

  it('Stop worker is not offered for a finished task, for a resumed worker of an ended task, or without the stop verb', async () => {
    seedRooms();
    seedWorkerPanes();
    const now = Date.now();
    const ended = (taskId: string, taskWorkspaceId: string, worker: 'resumable' | 'resumed') => ({
      taskId, taskWorkspaceId, ownerWorkspaceId: 'w1', botId: LEAD, title: `task ${taskWorkspaceId}`,
      status: 'completed' as const, stage: 'closed' as const, worker, updatedAt: now,
    });
    bots[1] = { ...bots[1], tasks: [ended('wtask-resd-00000001', 't1', 'resumed'), ended('wtask-done-00000002', 't2', 'resumable')] };
    const stop = { stopTask: vi.fn(async () => ({ ok: true, workersStopped: 1, tasksCancelled: 1 })) };
    await render(<BotsPage stop={stop} />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    // A resumed worker of an ended task runs, but has no task left to cancel.
    expect(q('[data-bots-tree] [data-bots-worker="t1"]')?.getAttribute('data-worker-state')).toBe('running');
    expect(q('[data-bots-tree] [data-bots-worker="t2"]')?.getAttribute('data-worker-state')).toBe('done');
    for (const id of ['t1', 't2']) {
      act(() => q(`[data-bots-tree] [data-bots-worker="${id}"]`)!.click());
      act(() => q('[data-bots-worker-panel-menu]')!.click());
      expect(q('[data-bots-worker-panel-workspaces]')).not.toBeNull();
      expect(q('[data-bots-worker-panel-stop]')).toBeNull();
      act(() => useStore.getState().setBotsWorkerPanel(null));
    }
    act(() => root.unmount());
    // A running worker of an open task, but no stop verb: no Stop worker.
    bots[1] = { ...bots[1], tasks: [{
      taskId: 'wtask-run-00000001', taskWorkspaceId: 't1', ownerWorkspaceId: 'w1', botId: LEAD, title: 'fix login',
      status: 'working' as const, stage: 'working' as const, updatedAt: now,
    }] };
    root = createRoot(container);
    await render(<BotsPage stop={{}} />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-tree] [data-bots-worker="t1"]')!.click());
    act(() => q('[data-bots-worker-panel-menu]')!.click());
    expect(q('[data-bots-worker-panel-workspaces]')).not.toBeNull();
    expect(q('[data-bots-worker-panel-stop]')).toBeNull();
    expect(stop.stopTask).not.toHaveBeenCalled();
    act(() => useStore.getState().setBotsWorkerPanel(null));
  });

  it('an open task whose worker was paused stays in the rail with Resume, which shows the new pane; a refusal for want of a slot is worded', async () => {
    seedRooms();
    const now = Date.now();
    const task = (taskId: string, extra: Record<string, unknown> = {}) => ({
      taskId, taskWorkspaceId: 't-gone', ownerWorkspaceId: 'w1', botId: LEAD, title: `task ${taskId}`, status: 'review_requested' as const,
      stage: 'coded' as const, worker: 'resumable' as const, updatedAt: now, ...extra,
    });
    bots[1] = { ...bots[1], tasks: [task('wtask-open-00000001'), task('wtask-done-00000002', { status: 'completed', stage: 'closed' })] };
    const resumeWorker = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'no_slot', cap: 4, message: 'main words' })
      .mockResolvedValue({ ok: true, workspaceId: 't1' });
    setFactoryBotPort({ ...port, resumeWorker });
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    // The ended one is not in the rail; the open one is.
    expect(q('[data-bots-task="wtask-done-00000002"]')).toBeNull();
    const bubble = q('[data-bots-task="wtask-open-00000001"]')!;
    expect(bubble.querySelector('[data-bots-worker-open]')).toBeNull();
    await act(async () => { (bubble.querySelector('[data-bots-task-resume]') as HTMLButtonElement).click(); });
    expect(q('[data-bots-task="wtask-open-00000001"]')!.textContent).toContain('No free agent slot (the limit is 4)');
    await act(async () => { (q('[data-bots-task="wtask-open-00000001"] [data-bots-task-resume]') as HTMLButtonElement).click(); });
    expect(resumeWorker).toHaveBeenCalledWith('wtask-open-00000001');
    expect(useStore.getState().activeWorkspaceId).toBe('hq');
    expect(useStore.getState().botsWorkerPanel?.workspaceId).toBe('t1');
    expect(q('[data-bots-worker-panel="t1"]')).not.toBeNull();
    act(() => useStore.getState().setBotsWorkerPanel(null));
  });

  it('the "Worker paused (resumable)" card offers Resume while its task\'s worker is resumable', async () => {
    const taskId = 'wtask-paus-00000001';
    cards.push(card({
      workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', title: 'Worker paused (resumable)', body: 'The task is reported for review.',
      refs: { taskId }, notice: { code: 'worker.pausedResumable' }, at: 500,
    }));
    seedRooms();
    bots[1] = { ...bots[1], tasks: [{
      // In review for two days: past what the rail lists, still resumable.
      taskId, taskWorkspaceId: 't1', ownerWorkspaceId: 'w1', botId: LEAD, title: 'Paused one',
      status: 'review_requested' as const, stage: 'coded' as const, worker: 'resumable' as const, updatedAt: Date.now() - 2 * 86_400_000,
    }] };
    const resumeWorker = vi.fn(async () => ({ ok: true, workspaceId: 't1' }));
    setFactoryBotPort({ ...port, resumeWorker });
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    const line = q('[data-bots-bubble="system"] [data-bots-card-resume]')!.closest('[data-bots-bubble="system"]')!;
    expect(line.textContent).toContain('Worker paused (resumable)');
    await act(async () => { (line.querySelector('[data-bots-card-resume]') as HTMLButtonElement).click(); });
    expect(resumeWorker).toHaveBeenCalledWith(taskId);
  });

  it('a cleared open task whose folder was kept for uncommitted changes says so in the rail, with no Resume when its worker cannot resume', async () => {
    seedRooms();
    bots[1] = { ...bots[1], tasks: [{
      taskId: 'wtask-kept-00000001', taskWorkspaceId: 't-gone', ownerWorkspaceId: 'w1', botId: LEAD, title: 'Kept one',
      status: 'review_requested' as const, stage: 'coded' as const, worker: 'stopped' as const, folder: 'kept_dirty' as const, updatedAt: Date.now(),
    }] };
    setFactoryBotPort({ ...port, resumeWorker: vi.fn(async () => ({ ok: true })) });
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const rail = q('[data-bots-task="wtask-kept-00000001"]')!;
    expect(rail.querySelector('[data-bots-task-folder-kept]')?.textContent).toContain('Folder kept: uncommitted changes');
    expect(rail.querySelector('[data-bots-task-resume]')).toBeNull();
    expect(rail.getAttribute('data-task-state')).toBe('done');
  });

  it('a task the owner stopped reads Cancelled with no error mark, not Failed', async () => {
    seedRooms();
    bots[1] = { ...bots[1], tasks: [{
      taskId: 'wtask-stop-00000001', taskWorkspaceId: 't1', ownerWorkspaceId: 'w1', botId: LEAD, title: 'Stopped one',
      status: 'cancelled' as const, stage: 'cancelled' as const, updatedAt: Date.now(),
    }] };
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const row = q('[data-bots-tree] [data-bots-worker="t1"]')!;
    expect(row.getAttribute('data-worker-state')).toBe('cancelled');
    expect(row.getAttribute('aria-label')).toBe('Stopped one, Cancelled');
    // No red cross: the status mark's box is empty.
    const mark = row.querySelector('[role="img"]');
    expect(mark?.getAttribute('aria-label')).toBe('Cancelled');
    expect(mark?.querySelector('svg')).toBeNull();
  });

  it('a stopped task whose folder was kept says so on its tree row and in the worker panel\'s header while its workspace is open', async () => {
    seedRooms();
    bots[1] = { ...bots[1], tasks: [{
      taskId: 'wtask-kept-00000001', taskWorkspaceId: 't1', ownerWorkspaceId: 'w1', botId: LEAD, title: 'Kept one',
      status: 'cancelled' as const, stage: 'cancelled' as const, worker: 'stopped' as const, folder: 'kept_dirty' as const, updatedAt: Date.now(),
    }] };
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    // The rail leaves out a task whose workspace is open: the row carries the note.
    expect(q('[data-bots-task="wtask-kept-00000001"]')).toBeNull();
    const row = q('[data-bots-tree] [data-bots-worker="t1"]')!;
    const note = row.querySelector('[data-bots-worker-folder-kept]')!;
    expect(note.textContent).toBe('Folder kept: uncommitted changes');
    // A neutral note: muted, never the needs-you or error colour.
    expect(note.className).toContain('text-[var(--text-muted)]');
    expect(row.getAttribute('aria-label')).toBe('Kept one, Cancelled · Folder kept: uncommitted changes');
    act(() => row.click());
    expect(q('[data-bots-worker-panel-state]')?.textContent).toBe('· Cancelled · Folder kept: uncommitted changes');
    act(() => useStore.getState().setBotsWorkerPanel(null));
  });

  it('a task reported for review whose worker was paused reads In review on its row and in the panel, never Done', async () => {
    seedRooms();
    bots[1] = { ...bots[1], tasks: [{
      taskId: 'wtask-rev-000000001', taskWorkspaceId: 't1', ownerWorkspaceId: 'w1', botId: LEAD, title: 'Reported one',
      status: 'review_requested' as const, stage: 'coded' as const, worker: 'resumable' as const, updatedAt: Date.now(),
    }] };
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const row = q('[data-bots-tree] [data-bots-worker="t1"]')!;
    expect(row.getAttribute('data-worker-state')).toBe('review');
    expect(row.getAttribute('aria-label')).toBe('Reported one, In review · worker paused');
    // Still open: no done check.
    const mark = row.querySelector('[role="img"]');
    expect(mark?.getAttribute('aria-label')).toBe('In review · worker paused');
    expect(mark?.querySelector('svg')).toBeNull();
    act(() => row.click());
    expect(q('[data-bots-worker-panel-state]')?.textContent).toBe('· In review · worker paused');
    act(() => useStore.getState().setBotsWorkerPanel(null));
  });

  it('a cleared task that ended (stopped, failed, completed) is no rail row, though resumable', async () => {
    seedRooms();
    const ended = (taskId: string, status: 'cancelled' | 'failed' | 'completed', stage: 'cancelled' | 'failed' | 'closed') => ({
      taskId, taskWorkspaceId: 't-gone', ownerWorkspaceId: 'w1', botId: LEAD, title: `Ended ${taskId}`,
      status, stage, worker: 'resumable' as const, updatedAt: Date.now(),
    });
    bots[1] = { ...bots[1], tasks: [ended('wtask-stop-00000002', 'cancelled', 'cancelled'), ended('wtask-fail-00000003', 'failed', 'failed'), ended('wtask-done-00000004', 'completed', 'closed')] };
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(q('[data-bots-task]')).toBeNull();
  });

  it('a worker waiting on input is a tree row with what it asks, though its pane reads idle', async () => {
    seedRooms();
    const now = Date.now();
    const task = (taskId: string, taskWorkspaceId: string, stage: 'working' | 'needs_input', title: string) => ({
      taskId, taskWorkspaceId, ownerWorkspaceId: 'w1', botId: LEAD, title, status: stage === 'working' ? 'working' as const : 'input_required' as const, stage, updatedAt: now,
    });
    // t1 asked for input (its stopped Claude reads idle on Fleet); t-gone's pane is closed.
    bots[1] = { ...bots[1], tasks: [{ ...task('wtask-ask-00000001', 't1', 'needs_input', 'README title'), summary: 'The push was denied; tell me the branch' }, task('wtask-gone-0000002', 't-gone', 'working', 'Gone')] };
    await render(<BotsPage />);
    expect(q(`[data-bots-row="bot:${LEAD}"] [data-bots-needs]`)?.textContent).toBe('2');
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const worker = q('[data-bots-worker="t1"]')!;
    expect(worker.getAttribute('data-worker-needs-input')).toBe('true');
    expect(worker.textContent).toContain('README title');
    expect(worker.getAttribute('aria-label')).toContain('Worker needs input');
    expect(worker.querySelector('[data-bots-worker-summary]')?.textContent).toBe('The push was denied; tell me the branch');
    expect(q('[data-bots-worker="t-gone"]')).toBeNull();
    // From a room (the bot's tree unfolded by hand), the row opens its bot's
    // 1:1 with the terminal beside it.
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    act(() => q(`[data-bots-entry="bot:${LEAD}"] [data-bots-tree-toggle]`)!.click());
    act(() => q('[data-bots-worker="t1"]')!.click());
    expect(useStore.getState().activeWorkspaceId).toBe('hq');
    expect(useStore.getState().appRoute).toBe('bots');
    expect(useStore.getState().botsWorkerPanel).toEqual({ workspaceId: 't1', conversationId: `bot:${LEAD}` });
    expect(q('[data-bots-worker-panel="t1"]')?.textContent).toContain('Worker needs input');
    act(() => useStore.getState().setBotsWorkerPanel(null));
  });

  it('a group shows no greeting and no "joined" line; the greeting is in the bot\'s 1:1', async () => {
    const NEW = 'bot-0000000e';
    bots.push(botRow(NEW, 'lead', 'w1', 500, 'Wmux Dev'));
    groups[0] = { ...groups[0], memberIds: [LEAD, VERIFIER, NEW] };
    cards.push(card({ workspaceId: 'w1', actor: by('w1', NEW), kind: 'question', state: 'open', title: 'Hi, what should I work on?', threadId: 'handoff:h-0000000001', at: 520, greeting: true }));
    cards.push(card({ workspaceId: 'w1', actor: by('w1', NEW), title: 'Later note', at: 900_000 }));
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    const greeting = cards.find((c) => c.title.startsWith('Hi,'))!;
    expect(q(`[data-bots-messages] [data-room-card-id="${greeting.id}"]`)).toBeNull();
    expect(container.querySelector('[data-bots-joined]')).toBeNull();
    expect(q('[data-bots-messages]')!.textContent).not.toContain('joined');
    act(() => q(`[data-bots-row="bot:${NEW}"]`)!.click());
    expect(q(`[data-bots-messages] [data-room-card-id="${greeting.id}"]`)).not.toBeNull();
  });

  it('a thread chip names a task by its title, never its id (the id stays in the tooltip)', async () => {
    seedRooms();
    cards.push(card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', title: 'Answered → Lead (lead): Push?', threadId: 'task:wtask-abc-00000001', refs: { botId: LEAD }, at: 600 }));
    cards.push(card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Asked', threadId: 'handoff:h-0000000002', at: 610 }));
    cards.push(card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Worker started', body: 'Task `wtask-abc-00000001` is running.', at: 620 }));
    bots[1] = { ...bots[1], tasks: [{ taskId: 'wtask-abc-00000001', taskWorkspaceId: 'tx', ownerWorkspaceId: 'w1', botId: LEAD, title: 'README title', status: 'working', stage: 'working', updatedAt: 1 }] };
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    const taskChip = q('[data-bots-thread-chip="task:wtask-abc-00000001"]')!;
    expect(taskChip.textContent).toBe('README title');
    expect(taskChip.getAttribute('title')).toContain('wtask-abc-00000001');
    // A thread's root names no bare "Request": the name leads nowhere.
    expect(q('[data-bots-thread-chip="handoff:h-0000000002"]')).toBeNull();
    // A bot citing the task id shows the task's title instead.
    expect(container.textContent).toContain('Task README title is running.');
    expect(container.textContent).not.toContain('Task wtask-abc-00000001');
    // A system line drops the role tag after a bot's name.
    expect(container.textContent).toContain('Answered → Lead: Push?');
    expect(container.textContent).not.toContain('(lead)');
  });

  it('a request thread is named by the owner\'s words that opened it, in its chip and its panel', async () => {
    const request = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', title: 'Add a --version flag', refs: { botId: LEAD }, at: 600 });
    cards.push(request);
    cards.push(card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', title: 'dispatch → Verifier: Ship it', threadId: 'handoff:h-0000000003', refs: { handoffId: 'h-0000000003', requestCardId: request.id }, at: 610 }));
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    const chip = q('[data-bots-thread-chip="handoff:h-0000000003"]')!;
    expect(chip.textContent).toBe('Add a --version flag');
    act(() => chip.click());
    expect(q('[data-bots-thread-panel="handoff:h-0000000003"]')?.getAttribute('aria-label')).toContain('Add a --version flag');
  });

  it('an open thread is read whole from its first card: a reply older than the cached page is in the panel, the root first', async () => {
    seedRooms();
    // The room's cached page lost the thread's first two cards; main still has them.
    const root = card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Thread root', threadId: 'pr:github.com/acme/api#9', at: 50 });
    const early = card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Early reply', threadId: 'pr:github.com/acme/api#9', at: 60 });
    const late = card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Late reply', threadId: 'pr:github.com/acme/api#9', at: 700 });
    cards.push(late);
    seedRooms();
    const reads: unknown[] = [];
    const a = api();
    (a as { read: unknown }).read = vi.fn(async (p: { workspaceId: string; threadId?: string; sinceSeq?: number }) => {
      reads.push(p);
      if (p.threadId === 'pr:github.com/acme/api#9') {
        const page = (p.sinceSeq ?? 0) === 0 ? [root, early] : [late];
        return { ok: true as const, workspaceId: p.workspaceId, threadId: p.threadId, cards: page, nextSinceSeq: page.at(-1)!.seq, hasMore: (p.sinceSeq ?? 0) === 0 };
      }
      const mine = cards.filter((c) => c.workspaceId === p.workspaceId);
      return { ok: true as const, workspaceId: p.workspaceId, threadId: null, cards: mine, nextSinceSeq: mine.at(-1)?.seq ?? 0, hasMore: false };
    });
    setRoomsApiForTests(a);
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    await act(async () => { q('[data-bots-thread-chip="pr:github.com/acme/api#9"]')!.click(); });
    expect(reads).toEqual(expect.arrayContaining([{ workspaceId: 'w1', threadId: 'pr:github.com/acme/api#9', sinceSeq: 0 }]));
    const panel = q('[data-bots-thread-panel="pr:github.com/acme/api#9"]')!;
    const ids = [...panel.querySelectorAll('[data-room-card-id]')].map((el) => el.getAttribute('data-room-card-id'));
    expect(ids).toEqual([root.id, early.id, late.id]);
  });

  it('the Approve N pending chip shows wherever the approval card is shown, not only in its PR thread', async () => {
    const approval = card({ workspaceId: 'w1', actor: by('w1', LEAD), kind: 'approval', state: 'open', title: 'Merge PR #1 at abc1234?', threadId: 'pr:github.com/acme/api#1', refs: { approvalId: 'apr-0000000001', pr: 1 }, at: 700 });
    // The same request asked where the bot talks with the owner, linking the PR's thread.
    const linked = card({ workspaceId: 'w1', actor: by('w1', LEAD), kind: 'approval', state: 'open', title: 'Merge PR #2 at def5678?', threadId: 'general', refs: { approvalId: 'apr-0000000002', pr: 2, threadId: 'pr:github.com/acme/api#2' }, at: 710 });
    cards.push(linked);
    cards.push(approval);
    seedRooms();
    const request = {
      requestId: 'apr-0000000001', action: 'merge', repoKey: 'github.com/acme/api', prNumber: 1, headSha: 'a'.repeat(40), botId: LEAD, workspaceId: 'w1',
      threadId: 'pr:github.com/acme/api#1', reason: 'green', tainted: false, cardId: approval.id, state: 'pending', createdAt: 1, updatedAt: 1,
    };
    const request2 = { ...request, requestId: 'apr-0000000002', prNumber: 2, threadId: 'general', cardId: linked.id };
    const decide = vi.fn(async () => ({ ok: true as const, request }));
    setApprovalsApiForTests({ list: vi.fn(async () => ({ ok: true as const, requests: [request, request2] })), decide, rules: vi.fn(), revokeRule: vi.fn() } as unknown as ApprovalsApi);
    try {
      await render(<BotsPage />);
      await act(async () => { await refreshApprovals(); });
      // The room's whole view (the owner is talking in General).
      act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
      expect(q('[data-testid="approve-pending-chip"]')?.getAttribute('data-approve-ids')).toBe('apr-0000000001 apr-0000000002');
      // The card in General carries its PR thread's chip; narrowed there, it
      // is shown and counted, the other PR's is not.
      const prChip = q(`[data-room-card-id="${linked.id}"] [data-bots-thread-chip="pr:github.com/acme/api#2"]`)!;
      expect(prChip.textContent).toBe('acme/api#2');
      act(() => prChip.click());
      expect(q(`[data-bots-thread-panel] [data-room-card-id="${linked.id}"]`)).not.toBeNull();
      expect(q('[data-bots-thread-panel] [data-testid="approve-pending-chip"]')?.getAttribute('data-approve-ids')).toBe('apr-0000000002');
      // The asking bot's 1:1 too.
      act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
      expect(q('[data-testid="approve-pending-chip"]')?.getAttribute('data-approve-ids')).toBe('apr-0000000001 apr-0000000002');
      // Another bot's 1:1 does not show it.
      act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
      expect(q('[data-testid="approve-pending-chip"]')).toBeNull();
    } finally {
      setApprovalsApiForTests(undefined);
    }
  });

  it('the profile under the pill says what the bot can do, whom it reports to and its workers now (read-only)', async () => {
    seedRooms();
    act(() => useStore.setState({
      workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api'), {
        ...ws('t1', 'wtask: fix login'),
        rootPane: { id: 't1-p', type: 'leaf', ordinal: 1, surfaces: [{ id: 's', ptyId: 'pty-t1', title: '', shell: 'zsh', cwd: '/', surfaceType: 'terminal' }], activeSurfaceId: 's' },
      } as Workspace],
      surfaceAgent: { 'pty-t1': { name: 'Claude Code', status: 'running' } },
      surfaceAgentStatus: { 'pty-t1': 'running' },
    } as never));
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    const profile = q(`[data-bots-profile="${LEAD}"]`)!;
    const canDo = [...profile.querySelectorAll('[data-can-do]')].map((el) => el.textContent);
    expect(canDo).toContain('Start workers in their own worktrees');
    expect(canDo).toContain('Ask you questions, with choices');
    expect(canDo).toContain('Record review verdicts (evidence, not a merge)');
    expect(canDo).not.toContain('Read every workspace\'s rooms and facts');
    expect(profile.querySelector('[data-bots-profile-reports-to]')?.textContent).toBe('You');
    expect(profile.querySelector('[data-bots-profile-workers]')?.textContent).toBe('1 running');
    // Turns used and left today (no hourly cap is shown).
    expect(profile.querySelector('[data-bots-profile-turns]')?.textContent).toBe(`${DEFAULT_BOT_BUDGETS.lead.maxTurnsPerDay - 30} used · 30 left`);
    // Nothing on it edits the bot's powers: its one control is Pause.
    expect([...profile.querySelectorAll('input, button, select')].map((el) => el.getAttribute('data-testid'))).toEqual(['bots-pause-bot']);

    act(() => q(`[data-bots-row="bot:${MOA}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    const moa = q(`[data-bots-profile="${MOA}"]`)!;
    expect(moa.querySelector('[data-bots-profile-reports-to]')?.textContent).toBe('You');
    const moaCanDo = [...moa.querySelectorAll('[data-can-do]')].map((el) => el.textContent);
    expect(moaCanDo).toContain('Propose plans for your approval');
    expect(moaCanDo).toContain('Start workers in their own worktrees');
    expect(moaCanDo).toContain('Read every workspace\'s rooms and facts');
    expect(moa.querySelector('[data-bots-profile-workers]')?.textContent).toBe('0 running');
  });

  it('the profile changes the repository through the folder picker, as Add bot does, and says why main refused', async () => {
    const update = vi.fn(async (_id: string, patch: { repoFolder?: string }) => (patch.repoFolder === '/src/other'
      ? { ok: false, message: "This workspace's other bots work on github.com/acme/api." }
      : { ok: true }));
    setFactoryBotPort({ ...port, update } as unknown as FactoryBotPort);
    const pickFolder = vi.fn(async () => ['/src/api-2']);
    vi.stubGlobal('electronAPI', { web: { status: vi.fn(async () => ({ running: false })) }, dialog: { pickFolder } });
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    const profile = q(`[data-bots-profile="${LEAD}"]`)!;
    expect(profile.querySelector('[data-bots-profile-repo-key]')?.textContent).toBe('github.com/acme/api');
    // A linked bot needs no hint about what a repository must be.
    expect(profile.querySelector('[data-bots-profile-repo-hint]')).toBeNull();
    const change = profile.querySelector<HTMLButtonElement>('[data-testid="bots-profile-repo-change"]')!;
    expect(change.textContent).toBe('Change…');
    await act(async () => change.click());
    expect(update).toHaveBeenCalledWith(LEAD, { repoFolder: '/src/api-2' });
    expect(profile.querySelector('[data-bots-profile-repo-error]')).toBeNull();
    pickFolder.mockResolvedValueOnce(['/src/other']);
    await act(async () => change.click());
    expect(profile.querySelector('[data-bots-profile-repo-error]')?.textContent).toContain('github.com/acme/api');
    // Cancelling the picker sends nothing.
    pickFolder.mockResolvedValueOnce([]);
    await act(async () => change.click());
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('the profile of a bot with no repository says what a repository must be', async () => {
    setFactoryBotPort({ ...port, update: vi.fn(async () => ({ ok: true })) } as unknown as FactoryBotPort);
    bots = bots.map((r) => (r.bot.id === LEAD ? { ...r, bot: { ...r.bot, repo: undefined } } : r));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    const profile = q(`[data-bots-profile="${LEAD}"]`)!;
    expect(profile.querySelector('[data-bots-profile-repo-key]')?.textContent).toBe('None');
    expect(profile.querySelector('[data-bots-profile-repo-hint]')?.textContent)
      .toBe('A folder whose origin is an owner/repo address on a git host, such as GitHub. A local path cannot be used.');
  });

  it('the profile shows the template and the job, and edits the job through the bot port', async () => {
    const update = vi.fn(async () => ({ ok: true }));
    setFactoryBotPort({ ...port, update } as FactoryBotPort);
    bots = bots.map((r) => (r.bot.id === LEAD ? { ...r, bot: { ...r.bot, template: 'issue', job: 'Fix every open issue.' } } : r));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    const profile = q(`[data-bots-profile="${LEAD}"]`)!;
    expect(profile.querySelector('[data-bots-profile-template]')?.textContent).toBe('Issues');
    expect(profile.querySelector('[data-bots-profile-job-text]')?.textContent).toBe('Fix every open issue.');
    act(() => profile.querySelector<HTMLButtonElement>('[data-testid="bots-profile-job-edit"]')!.click());
    const input = profile.querySelector<HTMLTextAreaElement>('[data-testid="bots-profile-job-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '  Review PRs.  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => profile.querySelector<HTMLButtonElement>('[data-testid="bots-profile-job-save"]')!.click());
    expect(update).toHaveBeenCalledWith(LEAD, { job: 'Review PRs.' });
  });

  it('the profile picks what the workers run on: default or an installed engine, saved through the bot port', async () => {
    const update = vi.fn(async () => ({ ok: true }));
    const workerAgents = vi.fn(async () => [
      { agent: 'claude', label: 'Claude Code', installed: true, supported: true },
      { agent: 'codex', label: 'Codex', installed: true, supported: true },
    ]);
    setFactoryBotPort({ ...port, update, workerAgents } as FactoryBotPort);
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    await act(async () => q('[data-bots-pill]')!.click());
    const profile = q(`[data-bots-profile="${LEAD}"]`)!;
    const select = profile.querySelector<HTMLSelectElement>('[data-testid="bots-profile-workers-engine"]')!;
    expect([...select.options].map((o) => [o.value, o.textContent, o.disabled])).toEqual([['', 'Default (Claude Code)', false], ['codex', 'Codex', false]]);
    expect(select.value).toBe('');
    await act(async () => {
      select.value = 'codex';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(update).toHaveBeenCalledWith(LEAD, { workerAgent: { agent: 'codex' } });
    // The pick shows at once, before the profile is read again.
    expect(select.value).toBe('codex');
  });

  it('keeps a stored pick visible when the engines cannot be listed, and an explicit Claude pick', async () => {
    bots = bots.map((r) => (r.bot.id === LEAD ? { ...r, bot: { ...r.bot, workerAgent: { agent: 'claude', model: 'opus' } } } : r));
    setFactoryBotPort({ ...port, update: vi.fn(async () => ({ ok: true })), workerAgents: async () => { throw new Error('no'); } } as FactoryBotPort);
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    await act(async () => q('[data-bots-pill]')!.click());
    const select = q(`[data-bots-profile="${LEAD}"] [data-testid="bots-profile-workers-engine"]`) as HTMLSelectElement;
    expect(select.value).toBe('claude');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'claude']);
  });

  it('an engine that is not installed is listed but cannot be picked', async () => {
    setFactoryBotPort({ ...port, update: vi.fn(async () => ({ ok: true })), workerAgents: async () => [{ agent: 'codex', label: 'Codex', installed: false, supported: true }] } as FactoryBotPort);
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    await act(async () => q('[data-bots-pill]')!.click());
    const select = q(`[data-bots-profile="${LEAD}"] [data-testid="bots-profile-workers-engine"]`) as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.textContent, o.disabled])).toEqual([['', 'Default (Claude Code)', false], ['codex', 'Codex (not installed)', true]]);
  });

  it('a bot without a job of its own shows its template\'s starting job, in the UI language', async () => {
    bots = bots.map((r) => (r.bot.id === MOA ? { ...r, bot: { ...r.bot, template: 'coordinator', job: undefined } } : r));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${MOA}"]`)!.click());
    act(() => q('[data-bots-pill]')!.click());
    const profile = q(`[data-bots-profile="${MOA}"]`)!;
    expect(profile.querySelector('[data-bots-profile-job-text]')?.textContent).toMatch(/^Coordinate the team/);
    expect(profile.querySelector('[data-bots-profile-job-default]')?.textContent).toBe('Its starting job, until you give it one.');
  });

  it('a bot\'s job_changed card offers Undo, which writes the previous job back', async () => {
    const update = vi.fn(async () => ({ ok: true }));
    setFactoryBotPort({ ...port, update } as FactoryBotPort);
    cards.push(card({
      workspaceId: 'w1', actor: by('w1', LEAD), kind: 'job_changed', title: 'Lead\'s job changed', body: 'Find root causes.',
      refs: { botId: LEAD, botIds: [LEAD] }, jobChange: { botId: LEAD, previous: 'Ship features.', next: 'Find root causes.' }, at: 500,
    }));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const undo = q<HTMLButtonElement>('[data-testid="bots-job-undo"]')!;
    expect(undo).not.toBeNull();
    await act(async () => undo.click());
    expect(update).toHaveBeenCalledWith(LEAD, { job: 'Ship features.' });
  });

  it('"+" opens the add form in a dialog, and the bot it adds is selected at once', async () => {
    seedRooms();
    const added = botRow('bot-0000000e', 'triage', 'w1', 9, 'Triage').bot;
    const create = vi.fn(async () => ({ ok: true as const, bot: added }));
    setFactoryBotPort({ ...port, create } as unknown as FactoryBotPort);
    await render(<BotsPage />);
    openAddBot();
    const dialog = () => document.querySelector('[data-testid="bots-add-bot"]');
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Add bot');
    // A bot belongs to one of the owner's workspaces, never a bot worker's.
    const options = [...document.querySelectorAll('[data-testid="bots-add-bot"] option')].map((o) => o.textContent);
    expect(options).toContain('api');
    expect(options).not.toContain('wtask: fix login');
    // A disabled Add says why.
    const submit = dialog()!.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!;
    expect(submit.disabled).toBe(true);
    expect(dialog()!.querySelector('[data-testid="factory-add-bot-blocked"]')?.textContent).toBe('Give the bot a name to add it.');
    const name = dialog()!.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Triage');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dialog()!.querySelector('[data-testid="factory-add-bot-blocked"]')).toBeNull();
    await act(async () => { submit.click(); });
    await act(async () => { await Promise.resolve(); });
    // The form closes and the new bot's chat opens, starting, with no wait for the list.
    expect(dialog()).toBeNull();
    expect(q('[data-bots-chat]')?.getAttribute('data-bots-chat')).toBe('bot:bot-0000000e');
    expect(q('[data-bots-starting]')).not.toBeNull();
  });

  it('bots on from before the plan consent: the page asks once; Keep bots on records it, Turn bots off turns them off, Cancel on a turn-on changes nothing', async () => {
    seedRooms(true);
    let stored: unknown = { enabled: true };
    const settings = { available: true, get: vi.fn(async () => stored as never), set: vi.fn(async (p: object) => ({ enabled: true, ...p }) as never) };
    await render(<BotsPage settings={settings} />);
    const dialog = () => document.querySelector('[data-testid="bots-plan-consent"]');
    expect(dialog()?.textContent).toContain('Bots run on your Claude account');
    expect(dialog()?.textContent).toContain('Their usage counts toward your Claude plan\'s limits, or is billed to your API key.');
    expect(document.querySelector('[data-testid="bots-plan-consent-cancel"]')?.textContent).toBe('Turn bots off');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="bots-plan-consent-confirm"]')!.click(); });
    expect(settings.set).toHaveBeenCalledWith({ planConsent: expect.objectContaining({ version: 1 }) });
    expect(dialog()).toBeNull();
    // Opened again without consent: Escape decides later (nothing written), Turn bots off turns them off.
    const reopen = async () => {
      act(() => root.unmount());
      root = createRoot(container);
      await render(<BotsPage settings={settings} />);
    };
    settings.set.mockClear();
    await reopen();
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(dialog()).toBeNull();
    expect(settings.set).not.toHaveBeenCalled();
    await reopen();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="bots-plan-consent-cancel"]')!.click(); });
    expect(settings.set).toHaveBeenCalledWith({ enabled: false });
    // Bots off: Turn bots on asks; Cancel leaves them off and writes nothing.
    act(() => root.unmount());
    root = createRoot(container);
    settings.set.mockClear();
    stored = null;
    seedRooms(false);
    const off = api();
    off.status = vi.fn(async () => ({ running: true, enabled: false, hqWorkspaceId: 'hq' })) as unknown as RoomsApi['status'];
    setRoomsApiForTests(off);
    await render(<BotsPage settings={settings} />);
    expect(dialog()).toBeNull();
    await act(async () => { q('[data-bots-run]')!.click(); });
    for (let i = 0; i < 5 && !dialog(); i++) await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-testid="bots-plan-consent-cancel"]')?.textContent).toBe('Cancel');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="bots-plan-consent-cancel"]')!.click(); });
    expect(settings.set).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('"+" while the bots are off: Add asks once, in place, then turns them on and adds', async () => {
    const off = api();
    off.status = vi.fn(async () => ({ running: true, enabled: false, hqWorkspaceId: 'hq' })) as unknown as RoomsApi['status'];
    setRoomsApiForTests(off);
    seedRooms(false);
    const added = botRow('bot-0000000e', 'triage', 'w1', 9, 'Triage').bot;
    const create = vi.fn(async () => ({ ok: true as const, bot: added }));
    setFactoryBotPort({ ...port, create } as unknown as FactoryBotPort);
    const settings = { available: true, get: vi.fn(async () => null), set: vi.fn(async () => ({ enabled: true }) as never) };
    await render(<BotsPage settings={settings} />);
    openAddBot();
    const dialog = document.querySelector('[data-testid="bots-add-bot"]')!;
    const name = dialog.querySelector<HTMLInputElement>('[data-testid="factory-add-bot-name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Triage');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => dialog.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-submit"]')!.click());
    expect(create).not.toHaveBeenCalled();
    expect(dialog.querySelector('[data-testid="factory-add-bot-on-confirm-row"]')?.textContent).toContain('Adding Triage turns bots on');
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-testid="factory-add-bot-on-confirm"]')!.click(); });
    await acceptPlanConsent();
    await act(async () => { await Promise.resolve(); });
    expect(settings.set).toHaveBeenCalledWith(ON_WITH_CONSENT);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('the splitter keeps the panel at 320px or more and the chat at 360px or more', () => {
    expect(fitSideSplit(0.55, 1400)).toBe(0.55);
    // 800px body: the panel can take at most 800 - 360 - 6 = 434px.
    expect(fitSideSplit(0.75, 800)).toBeCloseTo(434 / 800);
    expect(fitSideSplit(0.3, 800)).toBeCloseTo(320 / 800);
    expect(fitSideSplit(0.9, 2000)).toBe(0.75);
  });

  it('isStillStarting: a new bot starts until its first message, unless its turn failed', () => {
    const conv = (last: RoomCard | null, lastError?: { message: string; at: number }): Conversation => {
      const row = botRow(LEAD, 'lead', 'w1', 1, 'Lead');
      return { kind: 'bot', id: `bot:${LEAD}`, workspaceId: 'w1', row: { ...row, status: { ...row.status!, ...(lastError ? { lastError } : {}) } }, last, lastAt: 0, needsYou: 0, openQuestions: 0, openApprovals: 0, workers: [], tree: [], lone: false };
    };
    expect(isStillStarting(undefined)).toBe(true);
    expect(isStillStarting(conv(null))).toBe(true);
    expect(isStillStarting(conv(card({ workspaceId: 'w1', actor: by('w1', LEAD) })))).toBe(false);
    expect(isStillStarting(conv(null, { message: 'no login', at: 1 }))).toBe(false);
  });

  it('"+" without a create port opens the factory settings page', async () => {
    seedRooms();
    await render(<BotsPage />);
    openAddBot();
    expect(useStore.getState().appRoute).toBe('settings');
    expect(useStore.getState().settingsInitialTab).toBe('factory');
  });

  it('"+" runs the add-bot override', async () => {
    seedRooms();
    const onAddBot = vi.fn();
    await render(<BotsPage onAddBot={onAddBot} />);
    openAddBot();
    expect(onAddBot).toHaveBeenCalledTimes(1);
  });

  it('the rail item opens the page and its badge is the sum of the page\'s rows', async () => {
    seedRooms();
    act(() => useStore.setState({ appRoute: 'workspaces', sidebarVisible: true, readOnly: false, schedulesAvailable: true } as never));
    await render(<><MiniSidebar rail collapsed /><BotsPage /></>);
    const item = q('[data-sidebar-nav="bots"]')!;
    const rowsSum = [...container.querySelectorAll('[data-bots-row] [data-bots-needs]')].reduce((n, el) => n + Number(el.textContent), 0);
    expect(rowsSum).toBe(1);
    expect(item.querySelector('.wmux-nav-badge')?.textContent).toBe(String(rowsSum));
    expect(item.getAttribute('aria-label')).toBe('Bots, needs you 1');
    act(() => item.click());
    expect(useStore.getState().appRoute).toBe('bots');
    expect(item.getAttribute('aria-current')).toBe('page');
  });

  it('an open plan joins the rail badge, still the sum of the page\'s rows; off, both are clear and the rail item goes', async () => {
    cards.push(card({ workspaceId: 'hq', actor: by('hq', MOA), kind: 'plan', state: 'open', threadId: 'plan:p-1', at: 500 }));
    seedRooms();
    act(() => useStore.setState({ appRoute: 'workspaces', sidebarVisible: true, readOnly: false, schedulesAvailable: true } as never));
    await render(<><MiniSidebar rail collapsed /><BotsPage /></>);
    const item = q('[data-sidebar-nav="bots"]')!;
    const rowsSum = () => [...container.querySelectorAll('[data-bots-row] [data-bots-needs]')].reduce((n, el) => n + Number(el.textContent), 0);
    expect(rowsSum()).toBe(2);
    expect(item.querySelector('.wmux-nav-badge')?.textContent).toBe('2');
    act(() => useStore.setState({ roomStatus: { running: true, enabled: false, hqWorkspaceId: 'hq' } } as never));
    expect(rowsSum()).toBe(0);
    expect(q('[data-sidebar-nav="bots"]')).toBeNull();
  });

  it('turned off while the page is open, it leaves for Workspaces and the rail item goes', async () => {
    seedRooms();
    act(() => useStore.setState({ sidebarVisible: true, readOnly: false, schedulesAvailable: true } as never));
    await render(<><MiniSidebar rail collapsed /><BotsPage /></>);
    // The mount's status re-read (on) has settled: the page stays.
    expect(useStore.getState().appRoute).toBe('bots');
    expect(q('[data-sidebar-nav="bots"]')?.getAttribute('aria-current')).toBe('page');
    act(() => useStore.setState({ roomStatus: { running: true, enabled: false, hqWorkspaceId: 'hq' } } as never));
    expect(useStore.getState().appRoute).toBe('workspaces');
    expect(q('[data-sidebar-nav="bots"]')).toBeNull();
  });

  it('messages are bubbles in runs: in a room the name tops the run, the avatar sits beside its last bubble', async () => {
    // Right after c2 (seq 2), before the owner's reply.
    cards.splice(2, 0, { ...card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'And the second part, @Verifier please check', at: 205 }), seq: 2.5 });
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    const first = q('[data-room-card-id="c2"]')!;
    const next = q(`[data-room-card-id="${cards[2].id}"]`)!;
    expect(first.querySelector('[data-bots-msg-head]')?.textContent).toBe('Lead');
    // The name is in the bot's identity colour; a mention is the bot's mark and name.
    expect((first.querySelector('[data-bots-msg-head] span') as HTMLElement).style.color).toContain('color-mix');
    expect(first.querySelector('.wmux-bots-bubble-bot')).not.toBeNull();
    expect(first.getAttribute('data-run-end')).toBeNull();
    expect(first.querySelector('[data-bot-avatar]')).toBeNull();
    expect(next.getAttribute('data-continuation')).toBe('true');
    expect(next.querySelector('[data-bots-msg-head]')).toBeNull();
    expect(next.getAttribute('data-run-end')).toBe('true');
    expect(next.querySelector('.wmux-bots-msg-gutter [data-bot-avatar]')).not.toBeNull();
    const mention = next.querySelector(`[data-bots-mention="${VERIFIER}"]`)!;
    expect(mention.textContent).toBe('Verifier');
    expect(mention.querySelector('[data-bot-avatar]')).not.toBeNull();
    // The owner's message is its own bubble on the right, read as markdown.
    const mine = q('[data-bots-bubble="owner"]')!;
    expect(mine.className).toContain('is-owner');
    expect(mine.querySelector('.wmux-bots-bubble-owner')).not.toBeNull();
    // A 1:1 needs no name above the run; the date and time divide.
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(q('[data-room-card-id="c2"] [data-bots-msg-head]')).toBeNull();
    expect(q('[data-bots-day]')?.textContent).toMatch(/\d/);
  });

  it('a PR link in a message is a chip; the composer is one pill with "+" offering first messages', async () => {
    cards.push(card({ workspaceId: 'w1', actor: by('w1', LEAD), title: 'Opened https://github.com/acme/api/pull/1 for review', at: 206 }));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const chip = q('[data-bots-ref-chip="pr:github.com/acme/api#1"]')!;
    expect(chip.textContent).toContain('#1');
    // This conversation holds the PR's thread: the chip opens it beside the chat.
    act(() => chip.click());
    expect(q('[data-bots-thread-panel]')?.getAttribute('data-bots-thread-panel')).toBe('pr:github.com/acme/api#1');
    act(() => q('[data-bots-thread-close]')!.click());
    const form = q('[data-bots-chat] [data-testid="bots-composer"]')!;
    expect(form.className).toContain('wmux-bots-composer-pill');
    act(() => q('[data-bots-chat] [data-bots-composer-plus]')!.click());
    // The menu takes focus on its first item; arrows move through it.
    expect(document.activeElement?.getAttribute('data-bots-composer-suggestion')).toBe('botsPage.chat.suggestDo');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement?.getAttribute('data-bots-composer-suggestion')).toBe('botsPage.chat.suggestStart');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    act(() => q('[data-bots-composer-suggestion="botsPage.chat.suggestDo"]')!.click());
    expect(q<HTMLTextAreaElement>('[data-bots-chat] [data-testid="bots-composer-input"]')?.value).toBe('What can you do?');
    expect(q('[data-bots-composer-menu]')).toBeNull();
  });

  it('the working rail says who is working and for how long, and its Stop interrupts the turn only', async () => {
    const act$ = vi.fn(async () => ({ ok: true }));
    bots[1] = { ...bots[1], status: { ...bots[1].status!, presence: 'running', currentTurn: { wakeId: 'w-1', startedAt: Date.now() - 14_000 }, queueDepth: 2 } };
    setFactoryBotPort({ ...port, act: act$ });
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    const turn = q(`[data-bots-rail] [data-bots-turn="${LEAD}"]`)!;
    expect(turn.textContent).toContain('Lead working');
    expect(turn.textContent).toMatch(/0:1[45]/);
    expect(turn.textContent).toContain('2 queued');
    await act(async () => { q<HTMLButtonElement>(`[data-bots-turn-stop="${LEAD}"]`)!.click(); });
    expect(act$).toHaveBeenCalledWith('interrupt', LEAD);
    // With the bots off there is no turn line and no Stop.
    act(() => useStore.setState({ roomStatus: { running: true, enabled: false, hqWorkspaceId: 'hq' } } as never));
    expect(q('[data-bots-turn-stop]')).toBeNull();
  });

  it('a turn shows as working in the conversation it answers in: a 1:1 turn in that 1:1, a room turn in the room', async () => {
    const running = (threadId?: string) => {
      bots[1] = { ...bots[1], status: { ...bots[1].status!, presence: 'running', currentTurn: { wakeId: 'w-1', startedAt: Date.now(), ...(threadId ? { threadId } : {}) }, queueDepth: 0 } };
    };
    running(`dm:${LEAD}`);
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(q(`[data-bots-rail] [data-bots-turn="${LEAD}"]`)).not.toBeNull();
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    expect(q(`[data-bots-turn="${LEAD}"]`)).toBeNull();
  });

  it('a room turn shows in the room and not in the bot\'s 1:1', async () => {
    bots[1] = { ...bots[1], status: { ...bots[1].status!, presence: 'running', currentTurn: { wakeId: 'w-1', startedAt: Date.now(), threadId: 'general' }, queueDepth: 0 } };
    seedRooms();
    await render(<BotsPage />);
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    expect(q(`[data-bots-turn="${LEAD}"]`)).not.toBeNull();
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(q(`[data-bots-turn="${LEAD}"]`)).toBeNull();
  });

  it('a turn in a group chat\'s thread (or work it started) shows in that group, never in the 1:1s or General', async () => {
    const G = 'group:grp-000000c1';
    groups.push({ id: 'grp-000000c1', workspaceId: 'w1', name: 'Ship it', memberIds: [LEAD, VERIFIER], threadId: G, createdAt: 2_000, updatedAt: 2_000 });
    bots[1] = { ...bots[1], status: { ...bots[1].status!, presence: 'running', currentTurn: { wakeId: 'w-1', startedAt: Date.now(), threadId: G }, queueDepth: 0 } };
    bots[2] = { ...bots[2], status: { ...bots[2].status!, presence: 'running', currentTurn: { wakeId: 'w-2', startedAt: Date.now(), threadId: 'handoff:h-9' }, queueDepth: 0 } };
    seedRooms();
    act(() => useStore.setState({ roomThreads: { hq: [], w1: [{ threadId: 'handoff:h-9', title: 'Build', lastAt: 1, lastSeq: 1, cardCount: 1, openQuestions: 0, lastKind: 'handoff', status: 'open', unread: null, groupId: 'grp-000000c1' }] } } as never));
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="${G}"]`)!.click());
    expect(q(`[data-bots-turn="${LEAD}"]`)).not.toBeNull();
    expect(q(`[data-bots-turn="${VERIFIER}"]`)).not.toBeNull();
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(q(`[data-bots-turn="${LEAD}"]`)).toBeNull();
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    expect(q(`[data-bots-turn="${LEAD}"]`)).toBeNull();
    expect(q(`[data-bots-turn="${VERIFIER}"]`)).toBeNull();
  });

  it('a turn another bot runs on a dispatch sent from a 1:1 shows in that 1:1', async () => {
    bots[2] = { ...bots[2], status: { ...bots[2].status!, presence: 'running', currentTurn: { wakeId: 'w-2', startedAt: Date.now(), threadId: 'handoff:h-1' }, queueDepth: 0 } };
    seedRooms();
    act(() => useStore.setState({ roomThreads: { hq: [], w1: [{ threadId: 'handoff:h-1', title: 'Check', lastAt: 1, lastSeq: 1, cardCount: 1, openQuestions: 0, lastKind: 'handoff', status: 'open', unread: null, dmBotId: LEAD }] } } as never));
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(q(`[data-bots-turn="${VERIFIER}"]`)).not.toBeNull();
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
    expect(q(`[data-bots-turn="${VERIFIER}"]`)).toBeNull();
    act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
    expect(q(`[data-bots-turn="${VERIFIER}"]`)).toBeNull();
    // The page remembers the open conversation across mounts: leave the room open.
    act(() => q('[data-bots-row="group:grp-000000a1"]')!.click());
  });

  it('a list row counts unread bot messages in neutral, and the orange needs-you count wins', async () => {
    cards.push(card({ workspaceId: 'w1', actor: by('w1', VERIFIER), title: 'Fresh news', at: Date.now() + 1000 }));
    seedRooms();
    await render(<BotsPage />);
    expect(q(`[data-bots-row="bot:${VERIFIER}"] [data-bots-unread]`)?.textContent).toBe('1');
    // Lead has a question open: its needs-you badge shows, never an unread one.
    expect(q(`[data-bots-row="bot:${LEAD}"] [data-bots-needs]`)).not.toBeNull();
    expect(q(`[data-bots-row="bot:${LEAD}"] [data-bots-unread]`)).toBeNull();
    // A chat the narrow layout keeps hidden behind the list reads nothing.
    const proto = HTMLElement.prototype as unknown as { checkVisibility?: () => boolean };
    proto.checkVisibility = () => false;
    try {
      act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
      expect(q(`[data-bots-row="bot:${VERIFIER}"] [data-bots-unread]`)?.textContent).toBe('1');
    } finally {
      delete proto.checkVisibility;
    }
    // Reading the 1:1 to its end clears it.
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
    expect(q(`[data-bots-row="bot:${VERIFIER}"] [data-bots-unread]`)).toBeNull();
  });

  it('a message that arrives in the open 1:1 is read even while the chat is scrolled up', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
    // The owner scrolled up to read history.
    const log = q('[data-bots-messages]')!;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 400 });
    log.scrollTop = 0;
    act(() => { log.dispatchEvent(new Event('scroll')); });
    const fresh = card({ workspaceId: 'w1', actor: by('w1', VERIFIER), title: 'Fresh news', at: Date.now() + 1000 });
    act(() => useStore.getState().applyRoomEvent({ workspaceId: 'w1', card: fresh, threadSummary: { threadId: 'general', title: 'General', lastAt: fresh.at, lastSeq: 1, cardCount: 1, openQuestions: 0, lastKind: 'report', status: 'open', unread: null } }));
    expect(q(`[data-bots-row="bot:${VERIFIER}"] [data-bots-unread]`)).toBeNull();
  });

  it('an empty 1:1 opens with the bot, its job and first messages that fill the composer', async () => {
    const NEW = 'bot-0000000f';
    bots.push(botRow(NEW, 'lead', 'w1', 600, 'Quiet'));
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${NEW}"]`)!.click());
    expect(q(`[data-bots-intro="${NEW}"]`)?.textContent).toContain('Quiet');
    act(() => q('[data-bots-suggestion="botsPage.chat.suggestStatus"]')!.click());
    expect(q<HTMLTextAreaElement>('[data-testid="bots-composer-input"]')?.value).toBe('Give me a status update.');
  });

  it('a bot row\'s group-chat preview follows a language change', async () => {
    const G = 'group:grp-000000c1' as const;
    groups = [{ id: 'grp-000000c1', workspaceId: 'w1', name: 'Team', memberIds: [LEAD, VERIFIER], threadId: G, createdAt: 3_000, updatedAt: 3_000 }];
    cards = [cards[0], card({ workspaceId: 'w1', actor: by('w1', LEAD), threadId: G, title: 'Lead here', at: 3_200 })];
    seedRooms();
    await render(<BotsPage groupPort={groupPort} />);
    expect(q(`[data-bots-row="bot:${LEAD}"]`)!.textContent).toContain('In Team: Lead here');
    try {
      act(() => useStore.getState().setLocale('ko'));
      expect(q(`[data-bots-row="bot:${LEAD}"]`)!.textContent).toContain('Team에서: Lead here');
    } finally {
      act(() => useStore.getState().setLocale('en'));
    }
  });

  it('a bot row whose question is only in a group\'s handoff thread opens that group with the thread beside it', async () => {
    const G = 'group:grp-000000c1' as const;
    groups = [{ id: 'grp-000000c1', workspaceId: 'w1', name: 'Ship it', memberIds: [LEAD, VERIFIER], threadId: G, createdAt: 3_000, updatedAt: 3_000 }];
    const ask = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', threadId: G, refs: { botIds: [LEAD] }, title: 'Plan the release', at: 3_100 });
    const open = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: 'handoff:h-1', refs: { handoffId: 'h-1', requestCardId: ask.id }, at: 3_120 });
    const question = card({ workspaceId: 'w1', actor: by('w1', LEAD), kind: 'question', state: 'open', threadId: 'handoff:h-1', title: 'Which branch?', at: 3_200 });
    cards = [cards[0], ask, open, question];
    seedRooms();
    await render(<BotsPage groupPort={groupPort} />);
    const row = q(`[data-bots-row="bot:${LEAD}"]`)!;
    expect(row.querySelector('[data-bots-needs]')?.textContent).toBe('1');
    // Its preview says where it spoke, not "No messages yet".
    expect(row.textContent).toContain('In Ship it: Which branch?');
    await act(async () => row.click());
    expect(q('[data-bots-chat]')!.getAttribute('data-bots-chat')).toBe('group:grp-000000c1');
    expect(q('[data-bots-thread-panel="handoff:h-1"]')!.textContent).toContain('Which branch?');
    // Closed, then the group opened again from its own row: the thread stays closed.
    await act(async () => q('[data-bots-thread-close]')!.click());
    await act(async () => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
    await act(async () => q('[data-bots-row="group:grp-000000c1"]')!.click());
    expect(q('[data-bots-chat]')!.getAttribute('data-bots-chat')).toBe('group:grp-000000c1');
    expect(q('[data-bots-thread-panel]')).toBeNull();
  });

  it('a notification jump to a bot worker keeps the Bots page and shows the worker beside its bot\'s chat', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${VERIFIER}"]`)!.click());
    await act(async () => { focusNotificationTarget(() => useStore.getState(), { workspaceId: 't1' }); });
    expect(useStore.getState().appRoute).toBe('bots');
    expect(useStore.getState().activeWorkspaceId).toBe('hq');
    expect(useStore.getState().botsWorkerPanel).toEqual({ workspaceId: 't1', conversationId: `bot:${LEAD}` });
    expect(q('[data-bots-chat]')!.getAttribute('data-bots-chat')).toBe(`bot:${LEAD}`);
    // Back to the list (the narrow layout), then another jump to the same worker: the chat comes back.
    act(() => q('[data-bots-back]')!.click());
    expect(q('[data-bots-page]')!.getAttribute('data-view')).toBe('list');
    await act(async () => { focusNotificationTarget(() => useStore.getState(), { workspaceId: 't1' }); });
    expect(q('[data-bots-page]')!.getAttribute('data-view')).toBe('chat');
  });

  it('a reply landing in the 1:1 the owner is reading draws no "New" divider above it', async () => {
    seedRooms();
    await render(<BotsPage />);
    act(() => q(`[data-bots-row="bot:${LEAD}"]`)!.click());
    expect(q('[data-bots-new-divider]')).toBeNull();
    const reply = card({ workspaceId: 'w1', actor: by('w1', LEAD), threadId: `dm:${LEAD}`, title: 'Here is the answer', at: Date.now() + 1_000 });
    const key = timelineKey('w1', ALL_THREADS);
    await act(async () => {
      const tl = useStore.getState().roomTimelines[key];
      useStore.setState({ roomTimelines: { ...useStore.getState().roomTimelines, [key]: { ...tl, cards: [...tl.cards, reply] } } } as never);
    });
    expect(q('[data-bots-messages]')!.textContent).toContain('Here is the answer');
    expect(q('[data-bots-new-divider]')).toBeNull();
  });

  it('Toggle Bots opens the Bots page and, pressed there, returns to Workspaces', () => {
    act(() => useStore.setState({ appRoute: 'workspaces' } as never));
    act(() => useStore.getState().toggleBotsView());
    expect(useStore.getState().appRoute).toBe('bots');
    act(() => useStore.getState().toggleBotsView());
    expect(useStore.getState().appRoute).toBe('workspaces');
  });
});

describe('BotsChat helpers', () => {
  it('mentionPattern: the longest name wins, a name ends at a word boundary, no names no pattern', async () => {
    const { mentionPattern } = await import('../BotsChat');
    const re = mentionPattern(['Ada', 'Ada Lovelace', 'Q.A'])!;
    expect([...'hi @Ada Lovelace and @Ada, not @Adam or @Q.A!'.matchAll(re)].map((m) => m[1])).toEqual(['Ada Lovelace', 'Ada', 'Q.A']);
    expect(mentionPattern([' '])).toBeNull();
    // An email address is not a mention.
    expect([...'write to user@Ada.com'.matchAll(re)]).toHaveLength(0);
  });

  it('textMentions: every typed @Name of a room bot, Korean names and particles, the longest name first, unknown names ignored', async () => {
    const { textMentions, mentionQuery, mentionSuggestions } = await import('../BotsChat');
    const lead = botRow('bot-00000011', 'lead', 'w1', 1, '대장');
    const dev = botRow('bot-00000012', 'maintainer', 'w1', 2, '대장 보좌');
    const ada = botRow('bot-00000013', 'verifier', 'w1', 3, 'Ada');
    const room = [lead, dev, ada];
    // Mid-sentence, with a particle glued to a Korean name.
    expect(textMentions('이거 @대장이 봐줘', room)).toEqual([lead.bot.id]);
    expect(textMentions('@대장 해줘', room)).toEqual([lead.bot.id]);
    // Two bots, in the order typed; the longer name wins over the one it starts with.
    expect(textMentions('@Ada 그리고 @대장 보좌 확인', room)).toEqual([ada.bot.id, dev.bot.id]);
    expect(textMentions('@대장 @대장 보좌 @대장', room)).toEqual([lead.bot.id, dev.bot.id]);
    // A Latin name ends at a word boundary; an unknown name and an address are plain text.
    expect(textMentions('@Adam and @foo, mail me@Ada.dev', room)).toEqual([]);
    expect(textMentions('ask @ada.', room)).toEqual([ada.bot.id]);
    // A longer name of a bot elsewhere is that bot's, not a room bot's prefix.
    const far = botRow('bot-00000014', 'verifier', 'w2', 4, 'Ada Lovelace');
    expect(textMentions('@Ada Lovelace check', room, [...room, far])).toEqual([]);
    // The `@` being typed before the caret, and what it suggests.
    expect(mentionQuery('hi @대', 5)).toEqual({ at: 3, query: '대' });
    expect(mentionQuery('me@Ad', 5)).toBeNull();
    expect(mentionQuery('@Ada done', 9)).toBeNull();
    expect(mentionSuggestions(room, '대장').map((r) => r.bot.id)).toEqual([lead.bot.id, dev.bot.id]);
    expect(mentionSuggestions(room, 'a').map((r) => r.bot.id)).toEqual([ada.bot.id]);
  });

  it('githubRef: a PR or issue URL in any case is the canonical repo key', async () => {
    const { githubRef } = await import('../BotsChat');
    expect(githubRef('https://github.com/Acme/API/pull/12')).toEqual({ repoKey: 'github.com/acme/api', kind: 'pr', number: 12 });
    expect(githubRef('https://github.com/acme/api/issues/3#issuecomment-1')).toEqual({ repoKey: 'github.com/acme/api', kind: 'issue', number: 3 });
    expect(githubRef('https://example.com/acme/api/pull/12')).toBeNull();
  });

  const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`;

  it('oneToOneRefusal: only an off bot; a 1:1 mentions its bot, so a second bot of a role is reachable too', () => {
    const lead = botRow(LEAD, 'lead', 'w1', 2, 'Lead');
    expect(oneToOneRefusal(lead, t)).toBeNull();
    const off = botRow(LEAD, 'lead', 'w1', 2, 'Lead', false);
    expect(oneToOneRefusal(off, t)).toContain('botsPage.botOff');
    expect(oneToOneRefusal(botRow('bot-0000000d', 'moa', 'w1', 9, 'Moa 2'), t)).toBeNull();
  });

  it('chatCards narrows to a thread', () => {
    const group = { id: 'grp-000000a1', workspaceId: 'w1', name: '', memberIds: [], threadId: 'general' as const, createdAt: 1, updatedAt: 1 };
    const room: Conversation = { kind: 'room', id: 'group:grp-000000a1', workspaceId: 'w1', group, threadId: 'general', bots: [], workers: [], last: null, lastAt: 0, needsYou: 0 };
    const a = card({ workspaceId: 'w1', actor: by('w1', LEAD) });
    const b = card({ workspaceId: 'w1', actor: by('w1', LEAD), threadId: 'task:t1' });
    expect(chatCards(room, [a, b], null)).toEqual([a, b]);
    expect(chatCards(room, [a, b], 'task:t1')).toEqual([b]);
  });
});
