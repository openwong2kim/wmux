// Who may resume a stopped worker: the owner from the main window, or the bot
// that started the task while a slot is free; nobody else. Plus the views and
// the setting the resume and the agent budget show through.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { persisterWritesSettled } from '../versionedFile';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, dialog: {}, nativeImage: {} }));

import type { LedgerEntry } from '../../../shared/ledger';
import type { RpcContext } from '../../../shared/rpc';
import { BOT_RPC } from '../../../shared/bot';
import { DEFAULT_FACTORY_SETTINGS } from '../../../shared/factorySettings';
import { ReclaimedWorkers, ownerResumeWorker, reclaimedWorkerState, type WorkerResumePorts } from '../workerReclaim';
import { phoneRoomCard } from '../../../shared/phoneRooms';
import { AgentSlots } from '../agentSlots';
import { registerWorkerResumeRpc } from '../../pipe/handlers/workerResume.rpc';
import { factoryTaskFoldersCleanHandler, factoryTaskFoldersUsageHandler, factoryWorkerResumeHandler } from '../../ipc/handlers/factory.handler';
import { TaskFolders } from '../taskFolderCleanup';
import { botTaskViews } from '../botTasks';
import { mergeFactorySettings } from '../factorySettings';
import { clearPhoneWorkerResumeReceipts, handlePhoneWorkerResumeCommand } from '../../phone/PhoneWorkerResume';

/** The slots granted and held by `s`: live workers include them, as the
 *  holder set's count does. */
const ownSlots = (s: AgentSlots): number => {
  const p = s.pendingSlots();
  return p.grants.length + p.held.length;
};

const BOT = 'bot-0000000a';
const TASK = 'wtask-abc-12345678';
const UUID = '2eca904b-b4cc-4243-81d3-67a121351892';

let dir: string;
let store: ReclaimedWorkers;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-resume-gates-'));
  store = ReclaimedWorkers.at(dir);
  await store.put({
    taskId: TASK, botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 'A', threadId: `task:${TASK}` as never,
    ended: 'completed', state: 'stopped', at: 1, sessions: [{ sessionId: 'daemon-1', cwd: dir, resumeSessionId: UUID }],
  });
});
afterEach(async () => {
  // A store's fire-and-forget save can still be on its way: let it land
  // before its folder goes, or the removal races it.
  await persisterWritesSettled();
  fs.rmSync(dir, { recursive: true, force: true });
});

function ports(): WorkerResumePorts & { typeLine: ReturnType<typeof vi.fn> } {
  const typeLine = vi.fn(() => true);
  return { store, listSessions: async () => [{ id: 'daemon-1', spawnCwd: dir, agentProcessAlive: false }], typeLine, senderSignedIn: () => false };
}

describe('bot.resumeWorker', () => {
  function rig(inUse: number, enabled = true, refusal: string | null = null) {
    const handlers = new Map<string, (p: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>>();
    const p = ports();
    const slots: AgentSlots = new AgentSlots({ cap: () => 3, runningBots: () => inUse, liveWorkers: () => ownSlots(slots), pollMs: 60_000 });
    registerWorkerResumeRpc({ register: (m: string, h: never) => handlers.set(m, h), onBotRefused: () => undefined } as never, {
      ports: () => p, slots: () => slots, factoryEnabled: () => enabled, launchRefusal: () => refusal,
    });
    const call = (params: Record<string, unknown>, ctx?: RpcContext) => handlers.get(BOT_RPC.resumeWorker)!(params, ctx);
    return { call, p, slots };
  }
  const botCtx = (botId: string) => ({ bot: { botId, workspaceId: 'ws-owner' } }) as unknown as RpcContext;

  it('the bot that started the task resumes it while a slot is free, and the slot is given back', async () => {
    const { call, p, slots } = rig(1);
    expect(await call({ taskId: TASK }, botCtx(BOT))).toMatchObject({ ok: true, resumeSessionId: UUID });
    expect(p.typeLine).toHaveBeenCalledWith('daemon-1', `claude --resume ${UUID}`);
    expect(slots.inUse()).toBe(1);
  });

  it('refuses a non-bot caller, another bot, a bad id, the factory off, and a full budget', async () => {
    expect(await rig(0).call({ taskId: TASK })).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(await rig(0).call({ taskId: TASK }, botCtx('bot-0000000b'))).toMatchObject({ ok: false, code: 'not_found' });
    expect(await rig(0).call({ taskId: '../x' }, botCtx(BOT))).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await rig(0).call({ taskId: TASK, message: 'x'.repeat(5000) }, botCtx(BOT))).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await rig(0, false).call({ taskId: TASK }, botCtx(BOT))).toMatchObject({ ok: false, code: 'factory_off' });
    // A bot that stopped its own work (or was stopped) in this turn starts nothing.
    expect(await rig(0, true, 'your work was stopped in this turn').call({ taskId: TASK }, botCtx(BOT))).toMatchObject({ ok: false, code: 'not_now' });
    const full = rig(3);
    expect(await full.call({ taskId: TASK }, botCtx(BOT))).toMatchObject({ ok: false, code: 'no_slot' });
    expect(full.p.typeLine).not.toHaveBeenCalled();
  });

  it('types nothing into a worker pane at a folder-trust prompt, and says why', async () => {
    const { call, p, slots } = rig(1);
    const asked: string[] = [];
    p.folderTrustRefusal = async (sessionId) => { asked.push(sessionId); return 'the pane is on a folder-trust prompt; answer it in the pane'; };
    expect(await call({ taskId: TASK }, botCtx(BOT))).toEqual({ ok: false, code: 'not_typed', message: 'the resume was not typed: the pane is on a folder-trust prompt; answer it in the pane' });
    expect(asked).toEqual(['daemon-1']);
    expect(p.typeLine).not.toHaveBeenCalled();
    expect(slots.inUse()).toBe(1);
    // Asked before the task moves and before the last stop checks.
    const reclaim = fs.readFileSync(path.resolve(process.cwd(), 'src/main/factory/workerReclaim.ts'), 'utf8');
    const ask = reclaim.indexOf('await ports.folderTrustRefusal?.(pane.sessionId)');
    expect(ask).toBeLessThan(reclaim.indexOf('await rebindTaskTo(ports, rec.taskId, workerWorkspaceOf(rec))'));
    expect(ask).toBeLessThan(reclaim.lastIndexOf("if (stopped()) return refuse('not_now', 'the bot\\'s work was stopped while this resume was under way');"));
    // main's resume asks the daemon, an unreadable screen stopping it too (a bot types it).
    expect(fs.readFileSync(path.resolve(process.cwd(), 'src/main/factory/workerLifecycleHost.ts'), 'utf8'))
      .toContain("folderTrustRefusal: (sessionId) => folderTrustLaunchRefusal(daemon(), sessionId, 'bot worker resume line', { refuseUnknown: true, budgetMs: FOLDER_TRUST_DELIVERY_BUDGET_MS })");
  });

  it('is judged again, by the wake it was asked in, right before the line is typed: a wake no longer known clean types nothing', async () => {
    const handlers = new Map<string, (p: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>>();
    let refusal: string | null = null;
    const asked: Array<string | undefined> = [];
    const p = ports();
    p.listSessions = async () => {
      // Its record gone meanwhile: the wake's provenance is no longer known.
      refusal = 'this turn comes from an external guest\'s message';
      return [{ id: 'daemon-1', spawnCwd: dir, agentProcessAlive: false }];
    };
    registerWorkerResumeRpc({ register: (m: string, h: never) => handlers.set(m, h), onBotRefused: () => undefined } as never, {
      ports: () => p, slots: () => null, factoryEnabled: () => true, wakeId: () => 'w-1',
      launchRefusal: (_botId, wakeId) => { asked.push(wakeId); return refusal; },
    });
    expect(await handlers.get(BOT_RPC.resumeWorker)!({ taskId: TASK }, botCtx(BOT))).toMatchObject({ ok: false, code: 'not_now' });
    expect(p.typeLine).not.toHaveBeenCalled();
    expect(asked).toEqual(['w-1', 'w-1']);
  });
});

describe('bot.resumeWorker message', () => {
  it('is judged again after the wait for the agent, right before the message is sent', async () => {
    const handlers = new Map<string, (p: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>>();
    let refusal: string | null = null;
    const p = ports();
    const submit = vi.fn(async () => true);
    p.submit = submit;
    p.sleep = async () => undefined;
    p.agentAlive = async () => {
      refusal = 'this turn comes from an external guest\'s message';
      return true;
    };
    registerWorkerResumeRpc({ register: (m: string, h: never) => handlers.set(m, h), onBotRefused: () => undefined } as never, {
      ports: () => p, slots: () => null, factoryEnabled: () => true, wakeId: () => 'w-1', launchRefusal: () => refusal,
    });
    const ctx = { bot: { botId: BOT, workspaceId: 'ws-owner' } } as unknown as RpcContext;
    expect(await handlers.get(BOT_RPC.resumeWorker)!({ taskId: TASK, message: 'go on' }, ctx)).toMatchObject({ ok: true, messageDelivered: false });
    expect(p.typeLine).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    // Still clean after the wait: the message goes with the guard for the paste and the Enter.
    refusal = null;
    p.agentAlive = async () => true;
    await store.setState(TASK, 'stopped', 2);
    expect(await handlers.get(BOT_RPC.resumeWorker)!({ taskId: TASK, message: 'go on' }, ctx)).toMatchObject({ ok: true, messageDelivered: true });
    const guard = (submit.mock.calls[0] as unknown[])[2] as () => string | null;
    expect(guard()).toBeNull();
    refusal = 'no longer';
    expect(guard()).toBe('no longer');
  });
});

describe('FACTORY_WORKER_RESUME (IPC guard)', () => {
  const mainFrame = { id: 'top' };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;

  it('answers only the main window\'s top frame, with a task id, once the factory runs', async () => {
    const p = ports();
    const handler = factoryWorkerResumeHandler(() => win, () => p);
    const ok = { sender: webContents, senderFrame: mainFrame };
    expect(await handler({ sender: {}, senderFrame: mainFrame }, { taskId: TASK })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(await handler(ok, { taskId: 'nope' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await factoryWorkerResumeHandler(() => win, () => null)(ok, { taskId: TASK })).toMatchObject({ ok: false, code: 'not_started' });
    expect(p.typeLine).not.toHaveBeenCalled();
    expect(await handler(ok, { taskId: TASK })).toMatchObject({ ok: true });
  });

  it('the owner\'s Resume takes an agent slot: refused with the cap when none is free, started once when one is', async () => {
    const ok = { sender: webContents, senderFrame: mainFrame };
    const full = ports();
    const busy: AgentSlots = new AgentSlots({ cap: () => 3, runningBots: () => 3, liveWorkers: () => ownSlots(busy), pollMs: 60_000 });
    const refused = await factoryWorkerResumeHandler(() => win, () => full, () => busy)(ok, { taskId: TASK });
    expect(refused).toMatchObject({ ok: false, code: 'no_slot', cap: 3 });
    expect((refused as { message: string }).message).toContain('No free agent slot (the limit is 3)');
    expect(full.typeLine).not.toHaveBeenCalled();
    expect(store.get(TASK)?.state).toBe('stopped');
    const p = ports();
    const free: AgentSlots = new AgentSlots({ cap: () => 3, runningBots: () => 1, liveWorkers: () => ownSlots(free), pollMs: 60_000 });
    const handler = factoryWorkerResumeHandler(() => win, () => p, () => free);
    expect(await handler(ok, { taskId: TASK })).toMatchObject({ ok: true, resumeSessionId: UUID });
    // The launch slot was handed over to the resumed-worker count.
    expect(free.inUse()).toBe(1);
    // A second click on the resumed worker starts nothing and takes no slot.
    expect(await handler(ok, { taskId: TASK })).toMatchObject({ ok: false, code: 'already_running' });
    expect(p.typeLine).toHaveBeenCalledTimes(1);
    expect(free.inUse()).toBe(1);
  });
});

describe('the phone\'s Resume (workspaces.workerResume)', () => {
  it('runs the owner\'s resume the desktop button runs: the same slot, once per request id', async () => {
    clearPhoneWorkerResumeReceipts();
    const now = Date.now();
    const rid = (n: number): string => `${now}-0a9b8c7d-6e5f-4a3b-8c2d-${String(n).padStart(12, '0')}`;
    const p = ports();
    const free: AgentSlots = new AgentSlots({ cap: () => 3, runningBots: () => 1, liveWorkers: () => ownSlots(free), pollMs: 60_000 });
    const acquire = vi.spyOn(free, 'tryAcquire');
    const deps = { resume: (taskId: string) => ownerResumeWorker(taskId, () => p, () => free), taskKnown: () => true, now: () => now, log: () => undefined };
    const phone = (n: number) => handlePhoneWorkerResumeCommand('workspaces.workerResume', { taskId: TASK, clientRequestId: rid(n), deviceId: 'd1' }, deps);
    // The paused card offers Resume until the worker is resumed.
    const card = {
      id: 'c-1', seq: 1, workspaceId: 'ws-owner', threadId: `task:${TASK}` as never, kind: 'fact' as const, at: 1, actor: { kind: 'system' as const },
      title: 'Worker paused (resumable): A', refs: { taskId: TASK }, notice: { code: 'worker.pausedResumable', args: { title: 'A' } },
    };
    const offered = (): boolean => phoneRoomCard(card as never, () => null, undefined, (id) => reclaimedWorkerState(store.get(id)) === 'resumable')?.resumable === true;
    expect(offered()).toBe(true);
    expect(await phone(1)).toEqual({ resumed: { taskId: TASK, workspaceId: 'ws-task', sessionId: 'daemon-1' } });
    expect(offered()).toBe(false);
    expect(acquire).toHaveBeenCalledWith({ taskId: TASK, botId: BOT, byOwner: true });
    expect(free.inUse()).toBe(1);
    expect(store.get(TASK)?.state).toBe('resumed');
    // The same request again: replayed, nothing typed again.
    expect(await phone(1)).toMatchObject({ replayed: true });
    // Another request for the resumed worker: refused as the desktop's second click is.
    expect(await phone(2)).toEqual({ refused: { code: 'already_running', message: 'this worker was resumed already' } });
    expect(p.typeLine).toHaveBeenCalledTimes(1);
    expect(free.inUse()).toBe(1);
  });

  it('two resumes of one task at once, with different ids: one runs, the other is busy (never no_slot)', async () => {
    clearPhoneWorkerResumeReceipts();
    const now = Date.now();
    const p = ports();
    // One slot free: the second request must not read as a full cap.
    const one: AgentSlots = new AgentSlots({ cap: () => 3, runningBots: () => 2, liveWorkers: () => ownSlots(one), pollMs: 60_000 });
    const deps = { resume: (taskId: string) => ownerResumeWorker(taskId, () => p, () => one), taskKnown: () => true, now: () => now, log: () => undefined };
    const phone = (n: number) => handlePhoneWorkerResumeCommand('workspaces.workerResume', { taskId: TASK, clientRequestId: `${now}-0a9b8c7d-6e5f-4a3b-8c2d-00000000000${n}` }, deps);
    const [a, b] = await Promise.all([phone(1), phone(2)]);
    expect(a).toMatchObject({ resumed: { taskId: TASK } });
    expect(b).toEqual({ refused: { code: 'busy', message: 'this worker is being resumed already' } });
    expect(p.typeLine).toHaveBeenCalledTimes(1);
    // No slot is left held by the refused one.
    expect(one.inUse()).toBe(2);
  });

  it('refuses with the cap when no slot is free, and starts nothing', async () => {
    clearPhoneWorkerResumeReceipts();
    const now = Date.now();
    const p = ports();
    const busy: AgentSlots = new AgentSlots({ cap: () => 3, runningBots: () => 3, liveWorkers: () => ownSlots(busy), pollMs: 60_000 });
    const r = await handlePhoneWorkerResumeCommand('workspaces.workerResume', { taskId: TASK, clientRequestId: `${now}-0a9b8c7d-6e5f-4a3b-8c2d-000000000009` }, {
      resume: (taskId) => ownerResumeWorker(taskId, () => p, () => busy), taskKnown: () => true, now: () => now, log: () => undefined,
    });
    expect(r).toMatchObject({ refused: { code: 'no_slot', cap: 3 } });
    expect(p.typeLine).not.toHaveBeenCalled();
    expect(store.get(TASK)?.state).toBe('stopped');
  });
});

describe('FACTORY_TASK_FOLDERS_* (IPC guard)', () => {
  const mainFrame = { id: 'top' };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;

  it('the space and Clean up now answer only the main window, once the factory runs', async () => {
    const p = {
      store: TaskFolders.at(dir), roots: { worktrees: path.join(dir, 'wt'), wmuxDir: dir },
      missions: async () => new Map(), listSessions: async () => [], workerState: () => null,
      worktrees: { removeWorktree: vi.fn(), restoreWorktree: vi.fn() }, repoInfo: async () => null, allRows: () => [],
    };
    const ok = { sender: webContents, senderFrame: mainFrame };
    const other = { sender: {}, senderFrame: mainFrame };
    expect(await factoryTaskFoldersUsageHandler(() => win, () => p)(other)).toBeNull();
    expect(await factoryTaskFoldersUsageHandler(() => win, () => null)(ok)).toBeNull();
    expect(await factoryTaskFoldersUsageHandler(() => win, () => p)(ok)).toEqual({ bytes: 0, folders: 0, dirty: 0 });
    expect(await factoryTaskFoldersCleanHandler(() => win, () => p)(other)).toMatchObject({ ok: false, code: 'operator_only' });
    expect(await factoryTaskFoldersCleanHandler(() => win, () => null)(ok)).toMatchObject({ ok: false, code: 'not_started' });
    expect(await factoryTaskFoldersCleanHandler(() => win, () => p)(ok)).toEqual({ ok: true, removed: 0, keptDirty: 0, busy: 0, failed: 0 });
  });
});

describe('task views and the budget setting', () => {
  it('a bot\'s views list its waiting workers first and mark a stopped worker resumable', async () => {
    const row: LedgerEntry = {
      schemaVersion: 1, id: TASK, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'A', status: 'completed', rev: 4, updatedAt: 5,
      updatedBy: { kind: 'brain', workspaceId: 'ws-owner' }, dispatch: { origin: { kind: 'bot', botId: BOT } },
    };
    const views = await botTaskViews([{ id: BOT }], {
      rows: () => [row],
      branches: async () => new Map(),
      prFacts: () => [],
      workerState: (id) => (id === TASK ? 'resumable' : null),
      workerWorkspace: (id) => (id === TASK ? 'ws-new' : null),
      waiting: () => [{ taskId: 'wtask-wait-00000001', title: 'W', botId: BOT, ownerWorkspaceId: 'ws-owner', since: 9 }],
    });
    expect(views.get(BOT)?.map((v) => [v.taskId, v.stage, v.worker, v.workerWorkspaceId])).toEqual([
      ['wtask-wait-00000001', 'waiting_slot', undefined, undefined],
      [TASK, 'closed', 'resumable', 'ws-new'],
    ]);
  });

  it('maxConcurrentAgents keeps only an integer in 2..16', () => {
    const base = { ...DEFAULT_FACTORY_SETTINGS, trustedAuthors: [], morning: { hour: 9, weekdays: [] } };
    expect(base.maxConcurrentAgents).toBe(6);
    expect(mergeFactorySettings(base, { maxConcurrentAgents: 10 }).maxConcurrentAgents).toBe(10);
    for (const bad of [1, 17, 2.5, '8', null]) expect(mergeFactorySettings(base, { maxConcurrentAgents: bad }).maxConcurrentAgents).toBe(6);
  });
});
