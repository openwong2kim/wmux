import { describe, expect, it, vi } from 'vitest';
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: vi.fn() }));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handlePhoneBotsCommand, handlePhoneRoomCommand, phoneBotsReply, withPhoneFactory, type PhoneBotsPorts, type PhoneFactoryPorts } from '../PhoneFactory';
import { RoomWriter } from '../../factory/roomWriter';
import type { BotProfile } from '../../../shared/bot';
import type { BotTaskView } from '../../../shared/botTask';
import type { PhoneBotsReply } from '../../../shared/phoneBots';
import type { PhoneRoomCardsReply } from '../../../shared/phoneRooms';
import { fitSidebarToBudget } from '../PhoneWorkspaces';
import type { PhoneSidebarSnapshot } from '../../../shared/phoneFleetSidebar';

const sidebar: PhoneSidebarSnapshot = {
  activeWorkspaceId: null,
  workspaces: [{ id: 'ws-1', order: 0, pinned: false }],
  panes: [],
  moa: true,
};

const ports = (over: Partial<PhoneFactoryPorts> = {}): PhoneFactoryPorts => ({
  settings: () => ({ enabled: true, hqWorkspaceId: null }),
  bots: () => [],
  status: () => null,
  rooms: () => null,
  handoffs: () => null,
  roomFileExists: () => false,
  roomReadable: () => true,
  now: () => 1,
  ...over,
});

describe('withPhoneFactory', () => {
  it('leaves the snapshot as the renderer made it when the factory has not started or a store throws', () => {
    expect(withPhoneFactory(sidebar, ports({ bots: () => null }))).toBe(sidebar);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(withPhoneFactory(sidebar, ports({ bots: () => { throw new Error('boom'); } }))).toBe(sidebar);
    warn.mockRestore();
  });

  it('factory on with no bots: no moa, no-hq-bot; rooms down leaves counts out, not zero', () => {
    const out = withPhoneFactory(sidebar, ports());
    expect(out).toMatchObject({ factory: { enabled: true }, moaWakeBlocked: 'no-hq-bot' });
    expect(out).not.toHaveProperty('moa');
    expect(out.workspaces[0]).not.toHaveProperty('openQuestions');
  });
});

describe('withPhoneFactory — the bot the phone talks to', () => {
  const mk = (id: string, workspaceId: string, over: Record<string, unknown> = {}) => ({
    version: 1 as const, id, workspaceId, role: 'lead' as const, name: id, engine: { kind: 'claude-sdk' as const },
    triggers: [], budget: {}, enabled: true, createdAt: 1, updatedAt: 1, ...over,
  }) as unknown as NonNullable<ReturnType<PhoneFactoryPorts['bots']>>[number];
  const lead = mk('bot-0000000b', 'ws-1', { createdAt: 1 });
  const coord = mk('bot-0000000c', 'ws-1', { template: 'coordinator', role: 'moa', createdAt: 2 });

  it('serves the pinned bot as hqBotId, else the oldest Coordinator; its role stays a legacy label', () => {
    const pinned = withPhoneFactory(sidebar, ports({ bots: () => [lead, coord], settings: () => ({ enabled: true, hqWorkspaceId: null, phoneBotId: lead.id }) }));
    expect(pinned).toMatchObject({ moa: true, factory: { enabled: true, hqBotId: lead.id, hqWorkspaceId: 'ws-1' } });
    const auto = withPhoneFactory(sidebar, ports({ bots: () => [lead, coord] }));
    expect(auto.factory).toMatchObject({ hqBotId: coord.id });
    expect(auto.workspaces[0].bots?.map((b) => b.role)).toEqual(['lead', 'moa']);
  });
});

describe('handlePhoneRoomCommand', () => {
  it('answers only its two commands, and fails closed', () => {
    expect(handlePhoneRoomCommand('workspaces.list', {}, ports())).toBeNull();
    expect(handlePhoneRoomCommand('workspaces.roomThreads', { workspaceId: '../x' }, ports())).toEqual({ invalid: true });
    expect(handlePhoneRoomCommand('workspaces.roomThreads', { workspaceId: 'ws-1' }, ports())).toEqual({ unavailable: true });
    expect(handlePhoneRoomCommand('workspaces.roomCards', { workspaceId: 'ws-1', limit: 5 }, ports({ bots: () => null }))).toEqual({ unavailable: true });
  });

  it('a room file that exists but cannot be read is unavailable, never an empty room', () => {
    const rooms = { read: vi.fn(), summary: vi.fn(), threads: vi.fn(() => []) };
    const p = ports({ rooms: () => rooms, roomFileExists: () => true, roomReadable: () => false });
    expect(handlePhoneRoomCommand('workspaces.roomThreads', { workspaceId: 'ws-1' }, p)).toEqual({ unavailable: true });
    expect(handlePhoneRoomCommand('workspaces.roomCards', { workspaceId: 'ws-1', limit: 5 }, p)).toEqual({ unavailable: true });
    expect(rooms.threads).not.toHaveBeenCalled();
    expect(rooms.read).not.toHaveBeenCalled();
  });
});

describe('fitSidebarToBudget — factory rows', () => {
  it('drops per-workspace bots and question counts first, keeping the factory block', () => {
    const bots = Array.from({ length: 16 }, (_, i) => ({ id: `bot-${String(i).padStart(8, '0')}`, role: 'lead' as const, presence: 'idle' as const, queueDepth: 0 }));
    const big: PhoneSidebarSnapshot = {
      ...sidebar,
      factory: { enabled: true },
      workspaces: Array.from({ length: 50 }, (_, i) => ({ id: `ws-${i}`, order: i, pinned: false, bots, openQuestions: 1 })),
    };
    const drops: string[] = [];
    const fitted = fitSidebarToBudget({ workspaces: [] }, big, 20_000, (r) => drops.push(r));
    expect(drops[0]).toBe('budget.factoryRows');
    expect(fitted?.factory).toEqual({ enabled: true });
    expect(fitted?.workspaces.every((w) => w.bots === undefined && w.openQuestions === undefined)).toBe(true);
  });
});

describe('withPhoneFactory — bot pictures', () => {
  it('never puts a bot\'s picture into the phone snapshot', () => {
    const avatar = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(64, 'A')}`;
    const bot = {
      version: 1 as const, id: 'bot-0000000a', workspaceId: 'ws-1', role: 'moa' as const, name: 'Moa', engine: { kind: 'claude-sdk' as const },
      triggers: [], budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 0, maxWorkerHoursPerDay: 0, turnTimeoutMs: 60_000 },
      avatar, enabled: true, createdAt: 1, updatedAt: 1,
    };
    const out = withPhoneFactory(sidebar, ports({ bots: () => [bot] }));
    expect(out.workspaces[0]).toMatchObject({ bots: [{ id: 'bot-0000000a', role: 'moa' }] });
    expect(JSON.stringify(out)).not.toContain('data:image');
  });
});

describe('the phone wire — work cards and approval actions over a real room', () => {
  const LEAD = { version: 1, id: 'bot-1111bbbb', workspaceId: 'ws-1', role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' }, triggers: [], enabled: true, createdAt: 1, updatedAt: 1, hue: 1, template: 'coordinator', budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 0, maxWorkerHoursPerDay: 0, turnTimeoutMs: 1 } } as BotProfile;
  const DEV = { ...LEAD, id: 'bot-2222cccc', role: 'triage', name: 'Dev', template: undefined, createdAt: 2 } as BotProfile;
  const DM = 'dm:bot-1111bbbb' as const;

  function room() {
    let clock = 1_000;
    const writer = new RoomWriter({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-work-')), log: () => undefined, now: () => (clock += 1_000) });
    const bot = (botId: string) => ({ kind: 'bot' as const, workspaceId: 'ws-1', botId });
    const ask = writer.append({ workspaceId: 'ws-1', threadId: DM, kind: 'human', actor: { kind: 'human' }, title: 'Fix the login' })!;
    writer.append({ workspaceId: 'ws-1', threadId: 'handoff:h-1', kind: 'fact', actor: { kind: 'system' }, title: 'dispatch → Dev: Fix the login', refs: { handoffId: 'h-1', botId: DEV.id, threadId: DM, requestCardId: ask.id } });
    const reply = writer.append({ workspaceId: 'ws-1', threadId: DM, kind: 'opinion', actor: bot(LEAD.id), title: 'Handing this to Dev.' })!;
    const latest = writer.append({ workspaceId: 'ws-1', threadId: 'handoff:h-1', kind: 'status', actor: bot(DEV.id), title: 'On it', refs: { taskId: 't1' } })!;
    const approval = writer.append({ workspaceId: 'ws-1', threadId: DM, kind: 'approval', actor: bot(LEAD.id), title: 'Merge #12?', refs: { approvalId: 'apr-aaaaaaaa1' } })!;
    writer.append({ workspaceId: 'ws-1', threadId: DM, kind: 'fact', actor: { kind: 'system' }, title: 'Task done: x', notice: { code: 'task.done', args: { title: 'x', extra: 'dropped' } } });
    return { writer, reply, latest, approval };
  }

  const botsPorts = (writer: RoomWriter, over: Partial<PhoneBotsPorts> = {}): PhoneBotsPorts => ({
    ...ports({ bots: () => [LEAD, DEV], rooms: () => writer, roomFileExists: () => true }),
    groups: () => [],
    workspaceName: () => 'wmux',
    approvalAction: (id) => (id === 'apr-aaaaaaaa1' ? 'skill' : null),
    ...over,
  });

  it('lists a 1:1\'s hand-off as one work card, with the task\'s stage', async () => {
    const { writer, reply, latest } = room();
    const task: BotTaskView = { taskId: 't1', taskWorkspaceId: 'tw', ownerWorkspaceId: 'ws-1', botId: LEAD.id, title: 'login', status: 'working', stage: 'working', updatedAt: 1 };
    const reply1 = await handlePhoneBotsCommand('workspaces.bots', () => botsPorts(writer, { taskViews: async () => new Map([[LEAD.id, [task]]]) })) as PhoneBotsReply;
    const lead = reply1.conversations.find((c) => c.threadId === DM);
    expect(lead?.work).toEqual([{
      threadId: 'handoff:h-1', rootCardId: reply.id, delegateBotId: DEV.id, state: 'working', title: 'Fix the login',
      latestCardId: latest.id, latestPreview: 'On it', steps: 2, lastAt: latest.at,
    }]);
    // A conversation that handed nothing off has no work field at all.
    expect(reply1.conversations.find((c) => c.threadId === `dm:${DEV.id}`)).not.toHaveProperty('work');
    // Old fields keep their meaning.
    expect(lead).toMatchObject({ kind: 'dm', botId: LEAD.id, memberBotIds: [LEAD.id], lastPreview: 'Merge #12?' });
    // Tasks that cannot be read leave the state to the cards.
    const failed = await handlePhoneBotsCommand('workspaces.bots', () => botsPorts(writer, { taskViews: async () => { throw new Error('down'); } })) as PhoneBotsReply;
    expect(failed.conversations.find((c) => c.threadId === DM)?.work?.[0].state).toBe('working');
    expect(phoneBotsReply(botsPorts(writer))?.conversations.find((c) => c.threadId === DM)?.work).toHaveLength(1);
  });

  it('serves an approval card its action and a system card its published notice', () => {
    const { writer, approval } = room();
    const page = handlePhoneRoomCommand('workspaces.roomCards', { workspaceId: 'ws-1', threadId: DM, limit: 50 }, botsPorts(writer)) as PhoneRoomCardsReply;
    expect(page.cards.find((c) => c.id === approval.id)?.approvalAction).toBe('skill');
    expect(page.cards.filter((c) => c.approvalAction !== undefined)).toHaveLength(1);
    expect(page.cards.find((c) => c.kind === 'fact')?.notice).toEqual({ code: 'task.done', args: { title: 'x' } });
    // A desktop that cannot say keeps the card as before.
    const plain = handlePhoneRoomCommand('workspaces.roomCards', { workspaceId: 'ws-1', threadId: DM, limit: 50 }, botsPorts(writer, { approvalAction: () => { throw new Error('x'); } })) as PhoneRoomCardsReply;
    expect(plain.cards.find((c) => c.id === approval.id)).not.toHaveProperty('approvalAction');
  });
});
