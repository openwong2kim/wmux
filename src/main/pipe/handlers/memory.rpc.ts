// memory.update — a bot's own notes and the owner's profile
// (shared/botMemory.ts BOT_MEMORY_RPC), and the owner's view of them
// (BOT_MEMORY_IPC), registered as the `memory` factory module
// (main/factory/factoryHost.ts).
//
// Who may call what (the handler is the gate):
//   memory.update  a bot, for its own notes only (the binding names it),
//                  in a wake known clean: never one an external guest's
//                  message started or derived from (RpcRouter refuses
//                  those first), nor one started from outside text (a PR,
//                  an issue, CI, a tainted handoff). The owner's profile
//                  (`user`) only in a wake on the owner's words: their
//                  message, their button, or their answer to the bot's
//                  question (not one closed without an answer). A wake
//                  that cannot be told is refused.
//                  The conversation counts too (factory/conversationMarks.ts):
//                  the runtime resumes one conversation across wakes, so
//                  nothing is saved from one that ran a tainted or guest
//                  wake, and the owner's profile is not written from one
//                  that read outside text (OUTSIDE_TEXT_RPC), until a fresh
//                  conversation starts. No live conversation: refused.
//   IPC read / remove / clear   the main window only.
// A removed bot's notes are deleted with it (BotRuntime onBotRemoved).
// Anyone else is refused. Before the module started every method answers
// `not_started`.

import { ipcMain, type BrowserWindow } from 'electron';
import { BOT_EVENT, type BotEventPayload } from '../../../shared/bot';
import { BOT_MEMORY_IPC, BOT_MEMORY_RPC, MEMORY_TARGETS, type MemoryTarget, type MemoryUpdateResult } from '../../../shared/botMemory';
import type { RpcContext } from '../../../shared/rpc';
import type { WakeReason } from '../../../shared/wake';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryModuleHandle, type FactoryRouter } from '../../factory/factoryHost';
import { clearMemory, forgetMemoryOfRemovedBots, readMemoryView, removeMemoryEntry, updateMemory } from '../../factory/botMemory';
import { guestOfRunningWake, runningWakeTainted, type GuestProvenance } from '../../factory/wakeTaint';
import { currentWakeItem } from '../../factory/wakeQueue';
import { getBotRuntime, onBotRemoved } from '../../factory/BotRuntime';
import { conversationMarks, type ConversationMarks } from '../../factory/conversationMarks';
import { summarizeHandoff } from '../../factory/handoffRouter';
import { isMainWindowSender } from '../../ipc/mainWindowSender';

type Refusal = Extract<MemoryUpdateResult, { ok: false }>;

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function isTarget(v: unknown): v is MemoryTarget {
  return (MEMORY_TARGETS as readonly unknown[]).includes(v);
}

export const MEMORY_GUEST_REFUSAL = 'this turn comes from an external guest\'s message (or wmux cannot tell where it came from), and such a turn saves no memory; tell the owner what you would remember';
export const MEMORY_TAINT_REFUSAL = 'this turn started from outside text (a pull request, an issue, CI, or work that read them), or wmux cannot tell where it started, and such a turn saves no memory; save it in a turn the owner starts';
export const MEMORY_CONVERSATION_REFUSAL = 'this conversation has run a turn started from outside text or by a guest (or wmux cannot tell), and such a conversation saves no memory until a fresh one starts; tell the owner what you would remember';
export const MEMORY_OUTSIDE_READ_REFUSAL = 'this conversation has read outside text (pull requests, issues, CI, worker panes or reports, facts), so it does not write the owner\'s profile; keep it in your own notes (target memory), or tell the owner';
export const MEMORY_USER_REFUSAL = 'the owner\'s profile is written only in a turn on the owner\'s words (their message, their button, or their answer to your question); save it then, or keep it in your own notes (target memory)';

/** The reason of the wake `botId` is running now, when the queue and the
 *  runtime agree on which wake that is; null otherwise. Never throws. */
export function runningWakeReason(botId: string): WakeReason | null {
  try {
    const item = currentWakeItem(botId);
    const turn = getBotRuntime()?.currentTurn(botId);
    return item && turn && turn.wakeId === item.id ? item.reason : null;
  } catch {
    return null;
  }
}

/** Whether handoff `handoffId` is the owner's answer to the bot's question
 *  with words of their own (an answer handoff is only ever the owner's; one
 *  closed without an answer carries none). Never throws. */
export function ownerAnswered(handoffId: string): boolean {
  try {
    const h = summarizeHandoff(handoffId);
    return h?.ownerWords === true && h.dismissed !== true;
  } catch {
    return false;
  }
}

export interface MemoryHandlerDeps {
  /** The wmux data dir, or null before the module started. */
  wmuxDir: () => string | null;
  emit: (payload: BotEventPayload) => void;
  /** The guest provenance of the bot's running wake. Default: wakeTaint.ts. */
  guestWake?: (botId: string) => GuestProvenance;
  /** Whether the bot's running wake is tainted (true when unknown). Default: wakeTaint.ts. */
  tainted?: (botId: string) => boolean;
  /** The bot's running wake's reason, or null. Default: runningWakeReason. */
  wakeReason?: (botId: string) => WakeReason | null;
  /** Whether a handoff is the owner's answer with words. Default: ownerAnswered. */
  ownerAnswer?: (handoffId: string) => boolean;
  /** The bot's live conversation's marks, or null. Default: conversationMarks.ts. */
  conversation?: (botId: string) => ConversationMarks | null;
}

/** Why the bot's running wake may not write `target`, or null. Fails
 *  closed: anything the gate cannot tell refuses. */
export function memoryWriteRefusal(botId: string, target: MemoryTarget, deps: Pick<MemoryHandlerDeps, 'guestWake' | 'tainted' | 'wakeReason' | 'ownerAnswer' | 'conversation'>): Refusal | null {
  try {
    if ((deps.guestWake ?? guestOfRunningWake)(botId) !== false) return refuse('not_authorized', MEMORY_GUEST_REFUSAL);
    if ((deps.tainted ?? runningWakeTainted)(botId) !== false) return refuse('not_authorized', MEMORY_TAINT_REFUSAL);
    const marks = (deps.conversation ?? conversationMarks)(botId);
    if (!marks || marks.tainted) return refuse('not_authorized', MEMORY_CONVERSATION_REFUSAL);
    if (target === 'user') {
      if (marks.readOutside) return refuse('not_authorized', MEMORY_OUTSIDE_READ_REFUSAL);
      const reason = (deps.wakeReason ?? runningWakeReason)(botId);
      const owners = reason?.kind === 'human' || reason?.kind === 'manual'
        || (reason?.kind === 'handoff' && (deps.ownerAnswer ?? ownerAnswered)(reason.handoffId));
      if (!owners) return refuse('not_authorized', MEMORY_USER_REFUSAL);
    }
    return null;
  } catch {
    return refuse('not_authorized', MEMORY_TAINT_REFUSAL);
  }
}

export function handleMemoryUpdate(raw: unknown, ctx: RpcContext | undefined, deps: MemoryHandlerDeps): MemoryUpdateResult {
  if (!ctx?.bot) return refuse('not_bot', 'a bot updates its own memory');
  const wmuxDir = deps.wmuxDir();
  if (!wmuxDir) return refuse('not_started', 'memory is not running yet');
  const bot = ctx.bot;
  const p = obj(raw);
  if (!isTarget(p.target)) return refuse('invalid', 'target is memory (your notes) or user (the owner\'s profile)');
  const gate = memoryWriteRefusal(bot.botId, p.target, deps);
  if (gate) return gate;
  const res = updateMemory(wmuxDir, p.target, bot.botId, { action: p.action, text: p.text, match: p.match });
  if (res.ok && !res.unchanged) {
    try {
      deps.emit({ type: 'memory-changed', botId: bot.botId });
    } catch {
      /* the profile re-reads on its next event */
    }
  }
  return res;
}

export function registerMemoryHandlers(router: Pick<FactoryRouter, 'register'>, deps: MemoryHandlerDeps): void {
  router.register(BOT_MEMORY_RPC.update, async (raw, ctx?: RpcContext) => handleMemoryUpdate(raw, ctx, deps));
}

/** The owner's read, remove and clear, for the main window. Never throws. */
export function registerMemoryIpc(getWindow: () => BrowserWindow | null, deps: Pick<MemoryHandlerDeps, 'wmuxDir' | 'emit'>): () => void {
  const channels = Object.values(BOT_MEMORY_IPC);
  for (const c of channels) ipcMain.removeHandler(c);
  const denied = { ok: false, error: 'only the wmux window may do this' } as const;
  const notRunning = { ok: false, error: 'memory is not running yet' } as const;
  const changed = (botId: string): void => {
    try {
      deps.emit({ type: 'memory-changed', botId });
    } catch {
      /* the profile re-reads on its next event */
    }
  };
  ipcMain.handle(BOT_MEMORY_IPC.read, async (e, req: unknown) => {
    if (!isMainWindowSender(e, getWindow())) return denied;
    const dir = deps.wmuxDir();
    if (!dir) return notRunning;
    const botId = obj(req).botId;
    if (typeof botId !== 'string') return { ok: false, error: 'botId is required' };
    try {
      return { ok: true, memory: readMemoryView(dir, 'memory', botId), user: readMemoryView(dir, 'user', botId) };
    } catch {
      return { ok: false, error: 'The memory could not be read.' };
    }
  });
  ipcMain.handle(BOT_MEMORY_IPC.remove, async (e, req: unknown) => {
    if (!isMainWindowSender(e, getWindow())) return denied;
    const dir = deps.wmuxDir();
    if (!dir) return notRunning;
    const p = obj(req);
    if (typeof p.botId !== 'string' || !isTarget(p.target)) return { ok: false, error: 'botId and target are required' };
    try {
      const res = removeMemoryEntry(dir, p.target, p.botId, p.index, p.text);
      if (res.ok) changed(p.botId);
      return res;
    } catch {
      return { ok: false, error: 'The entry could not be removed.' };
    }
  });
  ipcMain.handle(BOT_MEMORY_IPC.clear, async (e, req: unknown) => {
    if (!isMainWindowSender(e, getWindow())) return denied;
    const dir = deps.wmuxDir();
    if (!dir) return notRunning;
    const p = obj(req);
    if (typeof p.botId !== 'string' || !isTarget(p.target)) return { ok: false, error: 'botId and target are required' };
    try {
      const res = clearMemory(dir, p.target, p.botId);
      if (res.ok) changed(p.botId);
      return res;
    } catch {
      return { ok: false, error: 'The memory could not be cleared.' };
    }
  });
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}

export function createMemoryModule(deps: Pick<FactoryHostDeps, 'wmuxDir' | 'getMainWindow'>, state: { dir: string | null }, emit: (payload: BotEventPayload) => void): FactoryModuleHandle {
  let offIpc: (() => void) | null = null;
  let offRemoved: (() => void) | null = null;
  return {
    start() {
      state.dir = deps.wmuxDir();
      offIpc = registerMemoryIpc(deps.getMainWindow, { wmuxDir: () => state.dir, emit });
      offRemoved = onBotRemoved((botId) => {
        const dir = state.dir;
        if (!dir) return;
        try {
          clearMemory(dir, 'memory', botId);
        } catch (err) {
          console.warn(`[factory] memory: the notes of removed bot ${botId} not deleted: ${String(err)}`);
        }
      });
      // The notes of a bot deleted since: they go now.
      void import('../../factory/botStore').then(({ getBotDirectory }) => {
        const bots = getBotDirectory();
        const dir = state.dir;
        if (!bots || !dir) return;
        const n = forgetMemoryOfRemovedBots(dir, (id) => !!bots.get(id));
        if (n > 0) console.log(`[factory] memory: the notes of ${n} deleted bot(s) removed`);
      }).catch((err) => console.warn(`[factory] memory: deleted bots not checked: ${String(err)}`));
    },
    dispose() {
      offIpc?.();
      offIpc = null;
      offRemoved?.();
      offRemoved = null;
      state.dir = null;
    },
  };
}

registerFactoryRpcModule('memory', (router, deps) => {
  const emit = (payload: BotEventPayload): void => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, payload);
  };
  const state: { dir: string | null } = { dir: null };
  registerMemoryHandlers(router, { wmuxDir: () => state.dir, emit });
  return createMemoryModule(deps, state, emit);
});
