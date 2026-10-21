// ─── Bot commands — the owner's view and control, as a factory module ──────
//
// At start: the decision log (botCommandLog.ts) takes every decision
// botExec.ts makes, a removed bot's log is deleted, and the bot profile's
// Commands section gets its main-window IPC (shared/botCommand.ts
// BOT_COMMAND_IPC):
//   read        whether the bot runs commands here at all, the owner's
//               switch, its log (newest first) and its rules, all masked;
//   setEnabled  the switch (botCommandRules.ts; the adapter reads it every
//               turn and the gate on every call);
//   allow       "Always allow": a rule for exactly the command a logged
//               decision refused as not on the list, checked as any rule;
//               every one needs `confirm`, after the warning;
//   removeRule  one rule, named by index and its text as read.
// Every handler answers only the main window's top frame and never throws.
// No bot RPC is registered here: nothing a bot holds reaches the log, the
// rules or the switch. A change is pushed as BOT_EVENT `commands-changed`
// (decisions coalesced per bot, so a busy turn does not re-read every
// profile section on every call).

import { ipcMain, type BrowserWindow } from 'electron';
import { BOT_EVENT, BOT_ID_RE, type BotEventPayload, type BotProfile } from '../../shared/bot';
import { BOT_COMMAND_IPC, RULE_ALLOWABLE_LAYERS, type BotCommandLogEntry, type BotCommandReadResult, type BotCommandSimpleResult } from '../../shared/botCommand';
import { redactSecrets } from '../../shared/redactSecrets';
import { resolveClaudeExecutable } from '../claude/resolveClaudeExecutable';
import { isMainWindowSender } from '../ipc/mainWindowSender';
import { wrapHandler } from '../ipc/wrapHandler';
import { onBotRemoved } from './BotRuntime';
import { unlistedHeads, type BotCommandRule } from './botCommandAllow';
import { parseCommandLine } from './botCommandFloor';
import { BOT_COMMAND_LOG_TEXT_MAX, BotCommandLog } from './botCommandLog';
import { botCommandRuleRefusal, botCommandRuleText, getBotCommandRulesStore, type BotCommandRulesStore } from './botCommandRules';
import { setBotExecDecisionSink } from './botExec';
import { probeBotExecSupport, type BotExecSupport } from './botExecSandbox';
import { getBotDirectory, getBotStore } from './botStore';
import { registerFactoryRpcModule, type FactoryHostDeps } from './factoryHost';
import { redactStoredSecrets } from './secretRedaction';

/** How long decisions are gathered before one `commands-changed` goes out. */
export const COMMANDS_CHANGED_COALESCE_MS = 300;

export interface BotCommandIpcDeps {
  log: () => BotCommandLog | null;
  rules?: () => BotCommandRulesStore;
  bot?: (botId: string) => BotProfile | null;
  /** Whether a Claude SDK bot's commands run on this machine. */
  support?: () => Promise<BotExecSupport>;
  changed: (botId: string) => void;
}

type Sender = { sender?: unknown; senderFrame?: unknown };

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function mask(text: string): string {
  return redactSecrets(redactStoredSecrets(text));
}

function errorText(err: unknown, fallback: string): string {
  const m = err instanceof Error ? err.message : '';
  return m ? mask(m) : fallback;
}

/** What "Always allow" on one logged decision would save. */
export type RuleForEntry =
  | {
      ok: true;
      rule: BotCommandRule;
      /** Always true: a program that is not on the list may run code from
       *  files in the bot's folder (a script, a file of commands, its config
       *  or plugins), which the bot can change; the owner confirms it. */
      runsCode: true;
    }
  | { ok: false; error: string };

/**
 * The one rule "Always allow" would add for a logged decision: exactly the
 * pipeline head the list refused, or why there is none. None for a decision
 * a rule cannot change, a command kept masked or cut, a line with more than
 * one command needing a rule (each needs its own approval), or a head the
 * store refuses (a built-in command keeps its checks; an interpreter rule is
 * exactly the interpreter and its script).
 */
export function ruleForEntry(entry: BotCommandLogEntry, current: readonly BotCommandRule[]): RuleForEntry {
  if (entry.tool !== 'Bash' || entry.decision !== 'deny' || !RULE_ALLOWABLE_LAYERS.includes(entry.layer) || !entry.target) {
    return { ok: false, error: 'Only a command refused as not on the list can be always allowed.' };
  }
  // A command that held a secret was kept masked: no rule can name it, and
  // none is made from the marker.
  if (/\[secret:|\[redacted\]|%5Bredacted%5D/i.test(entry.target) || mask(entry.target) !== entry.target) {
    return { ok: false, error: 'This command held a secret and was kept masked, so it cannot become a rule.' };
  }
  // A command cut to fit the log is not the command that ran.
  if (entry.target.length >= BOT_COMMAND_LOG_TEXT_MAX) return { ok: false, error: 'This command is too long to become a rule.' };
  const parsed = parseCommandLine(entry.target);
  if (!parsed.ok) return { ok: false, error: `This command cannot become a rule: ${parsed.reason}` };
  const heads = unlistedHeads(parsed.pipelines, current);
  if (heads.length === 0) return { ok: false, error: 'Nothing in this command is left for a rule to allow: it is on the list now, or the part refused reads a pipe.' };
  if (heads.length > 1) return { ok: false, error: 'This line runs more than one command that needs a rule; each one is allowed on its own, when the bot runs it alone.' };
  const rule: BotCommandRule = { argv: heads[0] };
  const refusal = botCommandRuleRefusal(rule);
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, rule, runsCode: true };
}

const DENIED = { ok: false as const, error: 'only the wmux window may do this' };
const NOT_RUNNING = { ok: false as const, error: 'bot commands are not running yet' };
const NO_BOT = { ok: false as const, error: 'botId must be a bot id' };
const NO_SUCH_BOT = { ok: false as const, error: 'no such bot' };
/** Why every rule needs the owner's confirm. */
export const RUNS_CODE_WARNING = 'This lets the bot run code from files in its folder, which the bot can change. It still runs in the sandbox: no network, and no files outside the bot\'s folder. Confirm to allow it.';

/** The four handlers' bodies (registerBotCommandIpc wraps them). */
export function botCommandIpcHandlers(getWindow: () => BrowserWindow | null, deps: BotCommandIpcDeps) {
  const rules = deps.rules ?? getBotCommandRulesStore;
  const bot = deps.bot ?? ((id: string) => getBotStore()?.get(id) ?? null);
  const support = deps.support ?? (() => probeBotExecSupport(resolveClaudeExecutable()));
  const changed = (botId: string): void => {
    try {
      deps.changed(botId);
    } catch {
      /* the profile re-reads on its next event */
    }
  };
  const botIdOf = (req: unknown): string | null => {
    const id = obj(req).botId;
    return typeof id === 'string' && BOT_ID_RE.test(id) ? id : null;
  };
  const known = (botId: string): boolean => {
    try {
      return bot(botId) !== null;
    } catch {
      return false;
    }
  };

  return {
    read: async (e: Sender, req: unknown): Promise<BotCommandReadResult> => {
      if (!isMainWindowSender(e, getWindow())) return DENIED;
      const log = deps.log();
      if (!log) return NOT_RUNNING;
      const botId = botIdOf(req);
      if (!botId) return NO_BOT;
      try {
        const profile = bot(botId);
        if (!profile) return NO_SUCH_BOT;
        let available = false;
        if (profile.engine.kind === 'claude-sdk') {
          try {
            available = (await support()).ok;
          } catch {
            available = false;
          }
        }
        const store = rules();
        const current = store.rulesFor(botId);
        // Always allow is offered only where main would save its rule, each
        // with its warning.
        const offer = (entry: BotCommandLogEntry): BotCommandLogEntry => {
          const plan = ruleForEntry(entry, current);
          return plan.ok ? { ...entry, canAllow: true, ...(plan.runsCode ? { runsCode: true } : {}) } : entry;
        };
        return {
          ok: true,
          available,
          enabled: store.commandsEnabled(botId),
          entries: log.entries(botId).map(offer),
          rules: current.map((r) => ({ text: mask(botCommandRuleText(r)), anyArgs: r.anyArgs === true })),
        };
      } catch {
        return { ok: false, error: 'The bot\'s commands could not be read.' };
      }
    },

    setEnabled: async (e: Sender, req: unknown): Promise<BotCommandSimpleResult> => {
      if (!isMainWindowSender(e, getWindow())) return DENIED;
      const botId = botIdOf(req);
      if (!botId) return NO_BOT;
      const enabled = obj(req).enabled;
      if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
      if (!known(botId)) return NO_SUCH_BOT;
      try {
        await rules().setCommandsEnabled(botId, enabled);
        changed(botId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorText(err, 'The switch could not be saved.') };
      }
    },

    allow: async (e: Sender, req: unknown): Promise<BotCommandSimpleResult> => {
      if (!isMainWindowSender(e, getWindow())) return DENIED;
      const log = deps.log();
      if (!log) return NOT_RUNNING;
      const botId = botIdOf(req);
      if (!botId) return NO_BOT;
      const entryId = obj(req).entryId;
      if (typeof entryId !== 'string') return { ok: false, error: 'entryId is required' };
      if (!known(botId)) return NO_SUCH_BOT;
      try {
        const entry = log.entry(botId, entryId);
        if (!entry) return { ok: false, error: 'That decision is no longer in the log.' };
        const store = rules();
        const current = store.rulesFor(botId);
        const plan = ruleForEntry(entry, current);
        if (!plan.ok) return { ok: false, error: plan.error };
        if (plan.runsCode && obj(req).confirm !== true) return { ok: false, error: RUNS_CODE_WARNING };
        await store.setRules(botId, [...current, plan.rule]);
        changed(botId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorText(err, 'The rule could not be saved.') };
      }
    },

    removeRule: async (e: Sender, req: unknown): Promise<BotCommandSimpleResult> => {
      if (!isMainWindowSender(e, getWindow())) return DENIED;
      const botId = botIdOf(req);
      if (!botId) return NO_BOT;
      const { index, text } = obj(req);
      if (typeof index !== 'number' || !Number.isInteger(index) || typeof text !== 'string') return { ok: false, error: 'index and text are required' };
      if (!known(botId)) return NO_SUCH_BOT;
      try {
        const store = rules();
        const current = store.rulesFor(botId);
        const rule = current[index];
        if (!rule || mask(botCommandRuleText(rule)) !== text) return { ok: false, error: 'That rule changed since it was shown; nothing was removed.' };
        await store.setRules(botId, current.filter((_, k) => k !== index));
        changed(botId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorText(err, 'The rule could not be removed.') };
      }
    },
  };
}

/** Register the four handlers on ipcMain; returns their removal. */
export function registerBotCommandIpc(getWindow: () => BrowserWindow | null, deps: BotCommandIpcDeps): () => void {
  const channels = Object.values(BOT_COMMAND_IPC);
  for (const c of channels) ipcMain.removeHandler(c);
  const h = botCommandIpcHandlers(getWindow, deps);
  ipcMain.handle(BOT_COMMAND_IPC.read, wrapHandler(BOT_COMMAND_IPC.read, (e: Electron.IpcMainInvokeEvent, req: unknown) => h.read(e, req)));
  ipcMain.handle(BOT_COMMAND_IPC.setEnabled, wrapHandler(BOT_COMMAND_IPC.setEnabled, (e: Electron.IpcMainInvokeEvent, req: unknown) => h.setEnabled(e, req)));
  ipcMain.handle(BOT_COMMAND_IPC.allow, wrapHandler(BOT_COMMAND_IPC.allow, (e: Electron.IpcMainInvokeEvent, req: unknown) => h.allow(e, req)));
  ipcMain.handle(BOT_COMMAND_IPC.removeRule, wrapHandler(BOT_COMMAND_IPC.removeRule, (e: Electron.IpcMainInvokeEvent, req: unknown) => h.removeRule(e, req)));
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}

registerFactoryRpcModule('bot-commands', (_router, deps: FactoryHostDeps) => {
  const emit = (payload: BotEventPayload): void => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, payload);
  };
  const changed = (botId: string): void => emit({ type: 'commands-changed', botId });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const soon = (botId: string): void => {
    if (timers.has(botId)) return;
    const t = setTimeout(() => {
      timers.delete(botId);
      try {
        changed(botId);
      } catch {
        /* the profile re-reads on its next event */
      }
    }, COMMANDS_CHANGED_COALESCE_MS);
    t.unref?.();
    timers.set(botId, t);
  };
  let log: BotCommandLog | null = null;
  let offIpc: (() => void) | null = null;
  let offRemoved: (() => void) | null = null;
  return {
    start() {
      const current = new BotCommandLog(deps.wmuxDir());
      log = current;
      setBotExecDecisionSink((botId, rec) => {
        if (current.record(botId, rec)) soon(botId);
      });
      offIpc = registerBotCommandIpc(deps.getMainWindow, { log: () => log, changed });
      offRemoved = onBotRemoved((botId) => {
        current.remove(botId).catch((err) => console.warn(`[factory] bot command log of removed bot ${botId} not deleted: ${String(err)}`));
        getBotCommandRulesStore().forgetBot(botId).catch((err) => console.warn(`[factory] bot command rules of removed bot ${botId} not deleted: ${String(err)}`));
      });
      // The logs of bots deleted while wmux was not running go now.
      const bots = getBotDirectory();
      if (bots) {
        try {
          const n = current.forgetRemoved((id) => !!bots.get(id));
          if (n > 0) console.log(`[factory] bot command logs of ${n} deleted bot(s) removed`);
        } catch (err) {
          console.warn(`[factory] bot command logs: deleted bots not checked: ${String(err)}`);
        }
      }
    },
    dispose() {
      setBotExecDecisionSink(null);
      offIpc?.();
      offIpc = null;
      offRemoved?.();
      offRemoved = null;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      log = null;
    },
  };
});
