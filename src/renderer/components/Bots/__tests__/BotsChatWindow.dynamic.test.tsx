// @vitest-environment jsdom
// A long bot chat mounts only its recent messages (the window the chat
// transcript uses too, shared/useTranscriptWindow.ts).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { ALL_THREADS, timelineKey } from '../../../stores/slices/roomSlice';
import { setRoomsApiForTests, type RoomsApi } from '../../../hooks/useRoomSync';
import { setFactoryBotPort, type FactoryBotPort, type FactoryBotRow } from '../../Room/factoryPorts';
import { setBotGroupPort, type BotGroupPort } from '../../Room/botGroups';
import type { RoomCard } from '../../../../shared/room';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../../shared/bot';
import type { Pane, Workspace } from '../../../../shared/types';
import { TRANSCRIPT_WINDOW_SIZE } from '../../shared/transcriptWindow';
import BotsPage from '../BotsPage';

// Neither the worker's terminal nor the PDF preview is under test here.
vi.mock('../../Terminal/Terminal', () => ({ default: () => null }));
vi.mock('../../Preview/PdfView', () => ({ default: () => null, PdfView: () => null }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEAD = 'bot-0000000a';
const leaf = (id: string): Pane => ({ id: `${id}-p`, type: 'leaf', ordinal: 1, surfaces: [], activeSurfaceId: '' }) as unknown as Pane;
const ws = (id: string, name: string): Workspace => ({ id, name, wsOrdinal: 1, rootPane: leaf(id), activePaneId: `${id}-p` }) as Workspace;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  setFactoryBotPort(null);
  setBotGroupPort(null);
  setRoomsApiForTests(undefined);
  vi.unstubAllGlobals();
});

it('a long 1:1 mounts its newest messages, not the whole history', async () => {
  const bot: BotProfile = {
    version: 1, id: LEAD, workspaceId: 'w1', role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 2, updatedAt: 2,
  };
  const bots: FactoryBotRow[] = [{ bot, status: { botId: LEAD, presence: 'idle', queueDepth: 0, budgetLeft: { turnsHour: 5, turnsDay: 30, workerHoursDay: 4 } } }];
  const cards: RoomCard[] = [];
  for (let i = 0; i < 300; i++) {
    const at = 1_000 + i * 100;
    cards.push({ version: 1, id: `q${i}`, seq: 2 * i + 1, workspaceId: 'w1', threadId: 'general', kind: 'human', actor: { kind: 'human' }, title: `question ${i} end`, refs: { botId: LEAD }, at });
    cards.push({ version: 1, id: `a${i}`, seq: 2 * i + 2, workspaceId: 'w1', threadId: 'general', kind: 'status', actor: { kind: 'bot', workspaceId: 'w1', botId: LEAD }, title: `answer ${i} end`, at: at + 50 });
  }
  setFactoryBotPort({ available: true, list: async () => bots, subscribe: () => () => undefined, act: async () => ({ ok: true }) } as FactoryBotPort);
  setBotGroupPort({ available: true, list: async () => ({ ok: true, groups: [] }) } as unknown as BotGroupPort);
  setRoomsApiForTests({
    status: vi.fn(async () => ({ running: true, enabled: true, hqWorkspaceId: 'hq' })),
    read: vi.fn(async (p: { workspaceId: string }) => ({ ok: true as const, workspaceId: p.workspaceId, threadId: null, cards: cards.filter((c) => c.workspaceId === p.workspaceId), nextSinceSeq: cards.length, hasMore: false })),
    threads: vi.fn(async (workspaceId: string) => ({ ok: true as const, workspaceId, threads: [] })),
    decision: vi.fn(async () => ({ decision: null })),
    actors: vi.fn(async () => ({ actors: {} })),
    onEvent: vi.fn(() => () => undefined),
  } as unknown as RoomsApi);
  vi.stubGlobal('electronAPI', { web: { status: vi.fn(async () => ({ running: false })) } });
  act(() => useStore.setState({
    roomStatus: { running: true, enabled: true, hqWorkspaceId: 'hq' },
    workspaces: [ws('hq', 'Headquarters'), ws('w1', 'api')],
    activeWorkspaceId: 'hq',
    activeRemoteKey: null,
    appRoute: 'bots',
    roomThreads: { hq: [], w1: [] },
    roomTimelines: {
      [timelineKey('hq', ALL_THREADS)]: { cards: [], nextSinceSeq: 0, hasMore: false },
      [timelineKey('w1', ALL_THREADS)]: { cards, nextSinceSeq: cards.length, hasMore: false },
    },
    roomActors: {},
    fanoutOrigin: {},
    surfaceAgentStatus: {},
  } as never));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<BotsPage />); });
  await act(async () => { await Promise.resolve(); });
  act(() => container!.querySelector<HTMLElement>(`[data-bots-row="bot:${LEAD}"]`)!.click());
  const shown = [...container.querySelectorAll('[data-bots-messages] [data-room-card-id]')].map((el) => el.getAttribute('data-room-card-id'));
  expect(shown.length).toBeLessThanOrEqual(2 * TRANSCRIPT_WINDOW_SIZE);
  expect(shown.at(-1)).toBe('a299');
  expect(shown).not.toContain('q0');
});
