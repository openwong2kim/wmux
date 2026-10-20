// skill.* — a bot's own skills (shared/botSkill.ts BOT_SKILL_RPC), and the
// owner's view of them (BOT_SKILL_IPC), registered as the `skills` factory
// module (main/factory/factoryHost.ts).
//
// Who may call what (the handler is the gate):
//   skill.propose  a bot, for itself only (the binding names it), during a
//                  wake: the store checks the proposal, the approval store
//                  posts its `skill` card with the diff, and only then is
//                  the proposed version written. A proposal that gets no
//                  card writes nothing.
//   skill.read     a bot: one of its own approved skills, or the list of
//                  them (no name). Reading a skill's body records its use.
//   IPC list / archive   the main window only.
// Anyone else is refused. Before the module started every method answers
// `not_started`.
//
// The approval store reaches the skills through skillApprovalHost: the
// owner's Approve moves the proposal on the card into place, Deny (or a card
// left unanswered) archives it. A worker a bot starts gets the approved
// skills through installBotSkillsInWorktree (worktask/FanOutService).

import path from 'node:path';
import { ipcMain, type BrowserWindow } from 'electron';
import { BOT_EVENT, type BotEventPayload } from '../../../shared/bot';
import { dmThreadId, type ThreadId } from '../../../shared/room';
import type { RoomWriter } from '../../factory/roomWriter';
import { BOT_SKILL_IPC, BOT_SKILL_RPC } from '../../../shared/botSkill';
import type { RpcContext } from '../../../shared/rpc';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryModuleHandle, type FactoryRouter } from '../../factory/factoryHost';
import { BotSkillStore, getBotSkillStore, installWorkerSkills, setBotSkillStore } from '../../factory/botSkills';
import { getApprovalService, type ApprovalService, type ApprovalSkillHost } from '../../factory/approvals';
import { isMainWindowSender } from '../../ipc/mainWindowSender';

type Refusal = { ok: false; code: 'not_bot' | 'not_started' | 'invalid'; message: string };

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const NOT_STARTED = refuse('not_started', 'skills are not running yet');

export interface SkillHandlerDeps {
  store: () => BotSkillStore | null;
  approvals: () => Pick<ApprovalService, 'proposeSkill' | 'withdraw' | 'get'> | null;
  emit: (payload: BotEventPayload) => void;
  /** The owner archived a skill: one system card in the bot's conversation.
   *  Best effort. */
  noteArchived?: (botId: string, name: string) => void;
}

/** The card an Archive posts in the bot's conversation thread: worded from
 *  its notice code (`skill.archived`) in the reader's language. */
export function postSkillArchivedCard(writer: Pick<RoomWriter, 'append'> | null, workspaceId: string, threadId: ThreadId, name: string): boolean {
  if (!writer) return false;
  const card = writer.append({
    workspaceId,
    threadId,
    kind: 'fact',
    actor: { kind: 'system' },
    title: `Skill archived: ${name}`,
    body: 'It no longer loads for this bot or its workers; the bot\'s next wake says not to apply it.',
    notice: { code: 'skill.archived', args: { skill: name } },
  });
  return !!card;
}

export function registerSkillHandlers(router: Pick<FactoryRouter, 'register'>, deps: SkillHandlerDeps): void {
  router.register(BOT_SKILL_RPC.propose, async (raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return refuse('not_bot', 'a bot proposes its own skills');
    const store = deps.store();
    const approvals = deps.approvals();
    if (!store || !approvals) return NOT_STARTED;
    const bot = ctx.bot;
    const p = obj(raw);
    const prep = store.prepareProposal(bot.botId, { name: p.name, content: p.content, references: p.references, reason: p.reason });
    if (!prep.ok) return prep;
    // The same proposal with its card still open: that one.
    if (prep.duplicate && prep.approvalId && approvals.get(prep.approvalId)?.state === 'pending') {
      return { ok: true, duplicate: true, skill: prep.skill, approvalId: prep.approvalId, message: 'This proposal already waits for the owner.' };
    }
    // The card first: a refused one writes nothing, so a proposal already
    // waiting keeps its files and its card.
    const req = approvals.proposeSkill(bot, {
      name: prep.skill.name, hash: prep.hash, version: prep.version, update: prep.update, diff: prep.diff,
      reason: typeof p.reason === 'string' ? p.reason : '',
    });
    if (!req.ok) return req;
    const res = store.writeProposal(bot.botId, prep);
    if (!res.ok) {
      approvals.withdraw(req.request.requestId);
      return res;
    }
    if (res.replacedApprovalId) approvals.withdraw(res.replacedApprovalId);
    store.attachApproval(bot.botId, res.skill.name, res.hash, req.request.requestId);
    deps.emit({ type: 'skills-changed', botId: bot.botId });
    const skill = store.list(bot.botId).find((s) => s.name === res.skill.name) ?? res.skill;
    return {
      ok: true, skill, approvalId: req.request.requestId,
      message: 'Proposed. The owner\'s approval card shows the change; nothing loads until they approve it.',
    };
  });

  router.register(BOT_SKILL_RPC.read, async (raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return refuse('not_bot', 'a bot reads its own skills');
    const store = deps.store();
    if (!store) return NOT_STARTED;
    const p = obj(raw);
    const res = store.read(ctx.bot.botId, p.name, p.reference);
    // A skill's body read is its use (the profile's last used and stale); a
    // reference or the list is not. A worker's copy is not either: every
    // approved skill is copied into every worker, used or not.
    // The profile re-reads on the event, so its last used and Stale follow.
    // One event per recorded read: a bot reads a skill before work it covers.
    if (res.ok && typeof p.name === 'string' && p.reference === undefined && store.recordUse(ctx.bot.botId, p.name)) {
      try {
        deps.emit({ type: 'skills-changed', botId: ctx.bot.botId });
      } catch {
        /* the profile re-reads on its next event */
      }
    }
    return res;
  });
}

/** The skills module's start: a waiting proposal whose card was denied or
 *  expired while the skills were not running (the approval store starts
 *  first and expires lapsed requests then) is shelved, as a Deny would; so
 *  is one whose request the approval store no longer keeps (it prunes only
 *  settled requests, never a pending or an approved one, so that one can
 *  no longer be approved). An approved request is never undone here.
 *  Returns how many. */
export function reconcileSkillProposals(
  store: BotSkillStore | null,
  approvals: Pick<ApprovalService, 'get'> | null,
  emit: (payload: BotEventPayload) => void,
): number {
  if (!store || !approvals) return 0;
  let shelved = 0;
  for (const w of store.waitingProposals()) {
    const r = approvals.get(w.approvalId);
    if (r && (r.action !== 'skill' || r.skill?.hash !== w.hash || r.state === 'pending' || r.state === 'approved')) continue;
    if (!store.deny(w.botId, w.name, w.hash).ok) continue;
    shelved += 1;
    try {
      emit({ type: 'skills-changed', botId: w.botId });
    } catch {
      /* the profile re-reads on its next event */
    }
  }
  return shelved;
}

/** The skills of every bot the directory no longer has are removed (a
 *  running directory only). Returns how many bots. */
export function forgetSkillsOfRemovedBots(store: BotSkillStore | null, bots: { get(botId: string): unknown } | null): number {
  if (!store || !bots) return 0;
  let n = 0;
  for (const botId of store.botIds()) {
    if (!bots.get(botId) && store.removeBot(botId)) n += 1;
  }
  return n;
}

/** What the approval store's `skill` decisions do. */
export function skillApprovalHost(store: () => BotSkillStore | null, emit: (payload: BotEventPayload) => void): ApprovalSkillHost {
  return {
    approve(r) {
      const s = store();
      if (!s) return 'skills are not running';
      if (!r.skill) return 'the request names no skill';
      const res = s.approve(r.botId, r.skill.name, r.skill.hash);
      // Telling the window is best effort: it never changes the outcome.
      try {
        emit({ type: 'skills-changed', botId: r.botId });
      } catch {
        /* the profile re-reads on its next event */
      }
      return res.ok ? null : res.message;
    },
    deny(r) {
      const s = store();
      if (!s || !r.skill) return;
      s.deny(r.botId, r.skill.name, r.skill.hash);
      emit({ type: 'skills-changed', botId: r.botId });
    },
  };
}

let approvalHost: ApprovalSkillHost | null = null;

/** The host the approval store calls, once the module started. */
export function getSkillApprovalHost(): ApprovalSkillHost | null {
  return approvalHost;
}

/** The owner's list and Archive, for the main window. Never throws. */
export function registerSkillIpc(getWindow: () => BrowserWindow | null, deps: SkillHandlerDeps): () => void {
  const channels = Object.values(BOT_SKILL_IPC);
  for (const c of channels) ipcMain.removeHandler(c);
  const denied = { ok: false, error: 'only the wmux window may do this' } as const;
  ipcMain.handle(BOT_SKILL_IPC.list, async (e, req: unknown) => {
    if (!isMainWindowSender(e, getWindow())) return denied;
    const store = deps.store();
    if (!store) return { ok: false, error: 'skills are not running yet' };
    const botId = obj(req).botId;
    if (typeof botId !== 'string') return { ok: false, error: 'botId is required' };
    return { ok: true, skills: store.list(botId) };
  });
  ipcMain.handle(BOT_SKILL_IPC.archive, async (e, req: unknown) => {
    if (!isMainWindowSender(e, getWindow())) return denied;
    const store = deps.store();
    if (!store) return { ok: false, error: 'skills are not running yet' };
    const p = obj(req);
    if (typeof p.botId !== 'string') return { ok: false, error: 'botId is required' };
    try {
      const res = store.archive(p.botId, p.name);
      if (!res.ok) return { ok: false, error: res.message };
      if (res.approvalId) deps.approvals()?.withdraw(res.approvalId);
      try {
        deps.noteArchived?.(p.botId, res.skill.name);
      } catch {
        /* the wake still says it is archived */
      }
      deps.emit({ type: 'skills-changed', botId: p.botId });
      return { ok: true, skill: res.skill };
    } catch {
      return { ok: false, error: 'The request failed.' };
    }
  });
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}

/** A worker a bot starts: its approved skills, copied into the worktree and
 *  excluded from git. Best effort — a failure is logged and the worker
 *  starts without them. */
export async function installBotSkillsInWorktree(botId: string, worktree: string): Promise<void> {
  const store = getBotSkillStore();
  if (!store) return;
  try {
    const skills = store.approved(botId);
    if (skills.length === 0) return;
    const [{ git }, { excludeLineOnce }] = await Promise.all([import('../../git/git'), import('../../git/infoExclude')]);
    const copied = await installWorkerSkills(skills, worktree, { git, exclude: excludeLineOnce });
    if (copied.length > 0) console.log(`[factory] skills: ${copied.length} copied into ${path.basename(worktree)}`);
  } catch (err) {
    console.warn(`[factory] skills not copied into ${path.basename(worktree)}: ${String(err)}`);
  }
}

/** The archive card, in the thread the owner last woke the bot in (its 1:1
 *  otherwise). Best effort: a failure is logged. */
function noteArchivedInRoom(botId: string, name: string): void {
  void (async () => {
    const [{ getRoomWriter }, { getBotDirectory }, { latestOwnerWakeThread }] = await Promise.all([
      import('../../factory/roomWriter'),
      import('../../factory/botStore'),
      import('../../factory/wakeQueue'),
    ]);
    const bot = getBotDirectory()?.get(botId);
    if (!bot) return;
    postSkillArchivedCard(getRoomWriter(), bot.workspaceId, latestOwnerWakeThread(botId) ?? dmThreadId(botId), name);
  })().catch((err) => console.warn(`[factory] skill archive card not posted: ${String(err)}`));
}

export function createSkillModule(deps: Pick<FactoryHostDeps, 'wmuxDir' | 'getMainWindow'>): FactoryModuleHandle {
  let offIpc: (() => void) | null = null;
  const emit = (payload: BotEventPayload): void => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, payload);
  };
  return {
    start() {
      if (getBotSkillStore()) return;
      try {
        setBotSkillStore(new BotSkillStore({ wmuxDir: deps.wmuxDir() }));
      } catch (err) {
        // An unreadable record file: skills stay off rather than guess.
        console.warn(`[factory] skills not started: ${String(err)}`);
        return;
      }
      approvalHost = skillApprovalHost(getBotSkillStore, emit);
      const shelved = reconcileSkillProposals(getBotSkillStore(), getApprovalService(), emit);
      if (shelved > 0) console.log(`[factory] skills: ${shelved} proposal(s) whose card closed while skills were off shelved`);
      offIpc = registerSkillIpc(deps.getMainWindow, { store: getBotSkillStore, approvals: getApprovalService, emit, noteArchived: noteArchivedInRoom });
      // A bot deleted while its skills' clean-up did not land: they go now.
      void import('../../factory/botStore').then(({ getBotDirectory }) => {
        const n = forgetSkillsOfRemovedBots(getBotSkillStore(), getBotDirectory());
        if (n > 0) console.log(`[factory] skills: the skills of ${n} deleted bot(s) removed`);
      }).catch((err) => console.warn(`[factory] skills: deleted bots not checked: ${String(err)}`));
    },
    dispose() {
      offIpc?.();
      offIpc = null;
      approvalHost = null;
      setBotSkillStore(null);
    },
  };
}

registerFactoryRpcModule('skills', (router, deps) => {
  const emit = (payload: BotEventPayload): void => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, payload);
  };
  registerSkillHandlers(router, { store: getBotSkillStore, approvals: getApprovalService, emit });
  return createSkillModule(deps);
});
