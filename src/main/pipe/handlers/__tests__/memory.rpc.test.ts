// memory.update: a bot writes its own notes only in a wake known clean (no
// guest's words, no outside text), and the owner's profile only in a wake
// the owner started; anything the gate cannot tell is refused.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() }, BrowserWindow: class {} }));

import type { BotBinding, BotEventPayload } from '../../../../shared/bot';
import type { RpcContext } from '../../../../shared/rpc';
import type { WakeReason } from '../../../../shared/wake';
import { memoryFile, readMemoryView, updateMemory } from '../../../factory/botMemory';
import { notifyBotRemoved } from '../../../factory/BotRuntime';
import type { ConversationMarks } from '../../../factory/conversationMarks';
import {
  MEMORY_CONVERSATION_REFUSAL,
  MEMORY_GUEST_REFUSAL,
  MEMORY_OUTSIDE_READ_REFUSAL,
  MEMORY_TAINT_REFUSAL,
  MEMORY_USER_REFUSAL,
  createMemoryModule,
  handleMemoryUpdate,
  memoryWriteRefusal,
  registerMemoryHandlers,
  type MemoryHandlerDeps,
} from '../memory.rpc';

const BOT = 'bot-0000000a';
const asBot: RpcContext = { origin: 'local', bot: { workspaceId: 'ws-1', botId: BOT, role: 'lead' } as BotBinding };
const OPERATOR: RpcContext = { origin: 'local', operator: true, firstParty: true };

const HUMAN: WakeReason = { kind: 'human', text: 'call me Kim', source: 'desktop' };
const MANUAL: WakeReason = { kind: 'manual', by: 'human' };
const ROUTINE: WakeReason = { kind: 'routine', routineId: 'r1', dueAt: 1 };
const FACTS: WakeReason = { kind: 'facts', factIds: ['f1'], trigger: { kind: 'fact', on: ['ci.failed'] } as never };

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-memory-rpc-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const CLEAN: ConversationMarks = { tainted: false, readOutside: false };

function rig(wake: { guest?: boolean | 'unknown'; tainted?: boolean; reason?: WakeReason | null; answers?: Record<string, boolean>; conversation?: ConversationMarks | null } = {}) {
  return {
    wmuxDir: () => dir,
    emit: vi.fn<(payload: BotEventPayload) => void>(),
    guestWake: () => wake.guest ?? false,
    tainted: () => wake.tainted ?? false,
    wakeReason: () => (wake.reason === undefined ? HUMAN : wake.reason),
    ownerAnswer: (id: string) => wake.answers?.[id] === true,
    conversation: () => (wake.conversation === undefined ? CLEAN : wake.conversation),
  } satisfies MemoryHandlerDeps;
}

const update = (params: Record<string, unknown>, deps: MemoryHandlerDeps, ctx: RpcContext = asBot) => handleMemoryUpdate(params, ctx, deps);

describe('memory.update', () => {
  it('a bot saves to its own notes in a clean wake, and the window is told', () => {
    const deps = rig({ reason: FACTS });
    expect(update({ target: 'memory', action: 'add', text: 'Gate is npm run verify' }, deps)).toMatchObject({ ok: true, entries: ['Gate is npm run verify'] });
    expect(deps.emit).toHaveBeenCalledWith({ type: 'memory-changed', botId: BOT });
    deps.emit.mockClear();
    expect(update({ target: 'memory', action: 'add', text: 'Gate is npm run verify' }, deps)).toMatchObject({ ok: true, unchanged: true });
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it('refuses a caller that is not a bot, before the module started, and a bad target', () => {
    expect(update({ target: 'memory', action: 'add', text: 'x' }, rig(), OPERATOR)).toMatchObject({ ok: false, code: 'not_bot' });
    expect(update({ target: 'memory', action: 'add', text: 'x' }, { ...rig(), wmuxDir: () => null })).toMatchObject({ ok: false, code: 'not_started' });
    expect(update({ target: 'everyone', action: 'add', text: 'x' }, rig())).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('a guest-sourced wake, or one of unknown provenance, saves nothing', () => {
    for (const guest of [true, 'unknown'] as const) {
      for (const target of ['memory', 'user']) {
        expect(update({ target, action: 'add', text: 'x' }, rig({ guest }))).toEqual({ ok: false, code: 'not_authorized', message: MEMORY_GUEST_REFUSAL });
      }
    }
    expect(readMemoryView(dir, 'memory', BOT).entries).toEqual([]);
  });

  it('a wake started from outside text saves nothing', () => {
    for (const target of ['memory', 'user']) {
      expect(update({ target, action: 'add', text: 'x' }, rig({ tainted: true }))).toEqual({ ok: false, code: 'not_authorized', message: MEMORY_TAINT_REFUSAL });
    }
    expect(readMemoryView(dir, 'memory', BOT).entries).toEqual([]);
  });

  it('the owner\'s profile only in a wake the owner started (their message or button)', () => {
    for (const reason of [FACTS, ROUTINE, null]) {
      expect(update({ target: 'user', action: 'add', text: 'The owner is Kim' }, rig({ reason }))).toEqual({ ok: false, code: 'not_authorized', message: MEMORY_USER_REFUSAL });
    }
    expect(readMemoryView(dir, 'user', BOT).entries).toEqual([]);
    expect(update({ target: 'user', action: 'add', text: 'The owner is Kim' }, rig({ reason: HUMAN }))).toMatchObject({ ok: true, entries: ['The owner is Kim'] });
    expect(update({ target: 'user', action: 'add', text: 'Prefers Korean' }, rig({ reason: MANUAL }))).toMatchObject({ ok: true, entries: ['The owner is Kim', 'Prefers Korean'] });
  });

  it('the owner\'s answer to the bot\'s question counts as their words; another handoff, or a tainted answer, does not', () => {
    const answer: WakeReason = { kind: 'handoff', handoffId: 'h-answer' };
    const dismissed: WakeReason = { kind: 'handoff', handoffId: 'h-dismissed' };
    const answers = { 'h-answer': true, 'h-dismissed': false };
    expect(update({ target: 'user', action: 'add', text: 'Call the owner Kim' }, rig({ reason: answer, answers }))).toMatchObject({ ok: true, entries: ['Call the owner Kim'] });
    expect(update({ target: 'user', action: 'add', text: 'x' }, rig({ reason: dismissed, answers }))).toEqual({ ok: false, code: 'not_authorized', message: MEMORY_USER_REFUSAL });
    expect(update({ target: 'user', action: 'add', text: 'x' }, rig({ reason: answer, answers, tainted: true }))).toEqual({ ok: false, code: 'not_authorized', message: MEMORY_TAINT_REFUSAL });
    // The default lookup: no handoff router running, so no answer is known.
    expect(memoryWriteRefusal(BOT, 'user', { guestWake: () => false, tainted: () => false, wakeReason: () => answer, conversation: () => CLEAN })).toMatchObject({ code: 'not_authorized', message: MEMORY_USER_REFUSAL });
    expect(readMemoryView(dir, 'user', BOT).entries).toEqual(['Call the owner Kim']);
  });

  it('a conversation that ran a tainted or guest wake saves nothing, even in a clean wake; none at all is refused too', () => {
    for (const conversation of [{ tainted: true, readOutside: false }, null]) {
      for (const target of ['memory', 'user']) {
        expect(update({ target, action: 'add', text: 'x' }, rig({ reason: HUMAN, conversation }))).toEqual({ ok: false, code: 'not_authorized', message: MEMORY_CONVERSATION_REFUSAL });
      }
    }
    expect(readMemoryView(dir, 'memory', BOT).entries).toEqual([]);
  });

  it('a conversation that read outside text keeps its own notes but does not write the owner\'s profile', () => {
    const conversation = { tainted: false, readOutside: true };
    expect(update({ target: 'user', action: 'add', text: 'The owner skips release checks' }, rig({ reason: HUMAN, conversation })))
      .toEqual({ ok: false, code: 'not_authorized', message: MEMORY_OUTSIDE_READ_REFUSAL });
    expect(readMemoryView(dir, 'user', BOT).entries).toEqual([]);
    expect(update({ target: 'memory', action: 'add', text: 'Gate is npm run verify' }, rig({ reason: HUMAN, conversation }))).toMatchObject({ ok: true });
  });

  it('removing a bot deletes its notes while the module runs, and leaves the owner\'s profile', () => {
    const mod = createMemoryModule({ wmuxDir: () => dir, getMainWindow: () => null }, { dir: null }, () => undefined);
    mod.start?.();
    try {
      updateMemory(dir, 'memory', BOT, { action: 'add', text: 'mine' });
      updateMemory(dir, 'user', BOT, { action: 'add', text: 'The owner is Kim' });
      notifyBotRemoved(BOT);
      expect(fs.existsSync(memoryFile(dir, 'memory', BOT) as string)).toBe(false);
      expect(readMemoryView(dir, 'user', BOT).entries).toEqual(['The owner is Kim']);
    } finally {
      void mod.dispose?.();
    }
    updateMemory(dir, 'memory', BOT, { action: 'add', text: 'again' });
    notifyBotRemoved(BOT);
    expect(readMemoryView(dir, 'memory', BOT).entries).toEqual(['again']);
  });

  it('fails closed: a gate that throws, or no taint tracker at all, refuses', () => {
    const throwing = { ...rig(), tainted: () => { throw new Error('boom'); } };
    expect(memoryWriteRefusal(BOT, 'memory', throwing)).toMatchObject({ ok: false, code: 'not_authorized' });
    // The real defaults with no tracker running: provenance unknown.
    expect(memoryWriteRefusal(BOT, 'memory', {})).toMatchObject({ ok: false, code: 'not_authorized' });
  });

  it('is registered under memory.update', async () => {
    const handlers = new Map<string, (raw: unknown, ctx?: RpcContext) => Promise<unknown>>();
    registerMemoryHandlers({ register: (m, h) => { handlers.set(m, h as never); } }, rig());
    expect(await handlers.get('memory.update')?.({ target: 'memory', action: 'add', text: 'one' }, asBot)).toMatchObject({ ok: true });
  });
});
