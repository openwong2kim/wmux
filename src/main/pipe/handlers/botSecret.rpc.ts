// botSecret.* / botLogin.request — a bot asks the owner for a named secret
// or a login (shared/botSecret.ts), and the owner's side of both, registered
// with registerFactoryRpcModule (main/factory/factoryHost.ts).
//
// Who may call what (the handler is the gate):
//   botSecret.request  a bot: posts a `secret_request` card in its own room
//                      (refs.secretName, open) — the name and the bot's
//                      words, never a value.
//   botSecret.list     a bot or the operator: names and use, never values.
//   botLogin.request   a bot: posts a `login_request` card (refs.label = the
//                      service; refs.url = a website's https login page).
// The owner's writes are main-window IPC only (BOT_SECRET_IPC, the main
// window's top frame), never a pipe RPC: storing or deleting a value, and
// completing a login card. Storing answers names and use only; the value
// goes from the modal to the store and nowhere else.

import os from 'node:os';
import path from 'node:path';
import { ipcMain, type BrowserWindow } from 'electron';
import { BOT_EVENT } from '../../../shared/bot';
import { botSurfaceOf, type BotToolName, type FactoryRefusal } from '../../../shared/botSurface';
import type { BotBinding } from '../../../shared/bot';
import {
  BOT_SECRET_IPC,
  BOT_SECRET_LIMITS,
  BOT_SECRET_RPC,
  isBotSecretName,
  type BotSecretEntry,
  type LoginService,
} from '../../../shared/botSecret';
import { GENERAL_THREAD, dmThreadId, parseThreadId, type RoomCard, type ThreadId } from '../../../shared/room';
import type { RpcContext } from '../../../shared/rpc';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryModuleHandle, type FactoryRouter } from '../../factory/factoryHost';
import {
  getRoomWriter,
  isClientId,
  isRoomWorkspaceId,
  namesOthersGroup,
  oneLine,
  resolveRoomPorts,
  runningWake,
  runningWakeThread,
  wakeOrdinals,
  wakeReplyTo,
  type FactoryRoomPorts,
  type RoomWriter,
} from '../../factory/roomWriter';
import { SecretStore, electronSecretCrypto, getSecretStore, setSecretStore, type SecretCrypto } from '../../factory/secretStore';
import { setSecretGrantSource } from '../../factory/secretGrants';
import { isMainWindowSender } from '../../ipc/mainWindowSender';
import { getConnectorStore, isConnectionKey } from '../../factory/connectorStore';

export const SECRETS_FILENAME = 'secrets.json';
const URL_MAX = 500;
const LOGIN_SERVICES: readonly LoginService[] = ['github', 'claude', 'website'];

// The caller rules of room.rpc.ts, restated here so this module registers
// before the rooms module (importing room.rpc.ts would register it first).
type Caller = { kind: 'bot'; bot: BotBinding } | { kind: 'operator' };

function refusal<C extends string>(code: C, message: string): FactoryRefusal<C> {
  return { ok: false, code, message };
}

function factoryCaller(ctx: RpcContext | undefined): Caller | FactoryRefusal<'not_bot'> {
  if (ctx?.bot) return { kind: 'bot', bot: ctx.bot };
  if (ctx?.operator === true) return { kind: 'operator' };
  return refusal('not_bot', 'this call needs a bot identity or the operator');
}

function botHasTool(_bot: BotBinding, tool: BotToolName): boolean {
  return botSurfaceOf().tools.has(tool);
}

function params(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export interface SecretHandlerDeps {
  store: () => SecretStore | null;
  writer: () => RoomWriter | null;
  ports: () => Partial<FactoryRoomPorts>;
  /** Is this key a connection's (default: the running library and store)? */
  isConnectionKey?: (name: string) => boolean;
}

function notStarted(): FactoryRefusal<'not_started'> {
  return refusal('not_started', 'the key store is not running yet');
}

/** The thread, idempotency key and default parent (the owner message the
 *  running wake answers: wakeReplyTo) of a card a bot's call posts. */
function botCardPlace(
  p: Record<string, unknown>,
  ports: Partial<FactoryRoomPorts>,
  bot: BotBinding,
  writer: Pick<RoomWriter, 'get'>,
): { threadId: ThreadId; clientPostId?: string; replyTo?: string } | FactoryRefusal<'invalid'> {
  const named = p.threadId === undefined ? undefined : parseThreadId(p.threadId);
  if (named === null) return refusal('invalid', 'threadId is not a thread id');
  if (namesOthersGroup(ports, bot, named)) return refusal('invalid', 'a bot posts in a group chat it is in');
  if (p.clientRequestId !== undefined && !isClientId(p.clientRequestId)) return refusal('invalid', 'clientRequestId is not a valid key');
  const threadId = named ?? runningWakeThread(ports, bot.botId) ?? GENERAL_THREAD;
  const wake = runningWake(ports, bot.botId);
  const clientPostId = (p.clientRequestId as string | undefined) ?? wakeOrdinals.next(wake, 'post');
  const replyTo = wakeReplyTo(writer, wake, bot.workspaceId, threadId);
  return { threadId, ...(clientPostId ? { clientPostId } : {}), ...(replyTo ? { replyTo } : {}) };
}

/** `botSecret.request`: a `secret_request` card in the bot's own room. */
export function handleSecretRequest(raw: unknown, ctx: RpcContext | undefined, deps: SecretHandlerDeps): unknown {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  if (caller.kind !== 'bot') return refusal('bot_only', 'secret_request is a bot\'s');
  const bot = caller.bot;
  if (!botHasTool(bot, 'secret_request')) return refusal('surface', 'this bot has no secret_request');
  const writer = deps.writer();
  const store = deps.store();
  if (!writer || !store) return notStarted();
  const p = params(raw);
  if (!isBotSecretName(p.name)) {
    return refusal('invalid_name', 'name must be an upper-case env name that reads as a credential, e.g. NPM_TOKEN, OPENAI_API_KEY or DEPLOY_SECRET (not WMUX_*)');
  }
  const label = oneLine(p.label, BOT_SECRET_LIMITS.LABEL_MAX);
  if (!label) return refusal('invalid', `label is required (at most ${BOT_SECRET_LIMITS.LABEL_MAX} characters)`);
  if (typeof p.why !== 'string' || !p.why.trim() || p.why.length > BOT_SECRET_LIMITS.WHY_MAX) {
    return refusal('invalid', `why is required (at most ${BOT_SECRET_LIMITS.WHY_MAX} characters)`);
  }
  const ports = deps.ports();
  const place = botCardPlace(p, ports, bot, writer);
  if ('ok' in place) return place;
  const r = writer.post({
    workspaceId: bot.workspaceId,
    threadId: place.threadId,
    kind: 'secret_request',
    actor: { kind: 'bot', workspaceId: bot.workspaceId, botId: bot.botId },
    title: label,
    body: p.why.trim(),
    refs: { secretName: p.name },
    state: 'open',
    ...(place.replyTo ? { replyTo: place.replyTo } : {}),
    ...(place.clientPostId ? { clientPostId: place.clientPostId } : {}),
  });
  if (!r.ok) return refusal('invalid', r.message);
  return { ok: true, cardId: r.card.id, threadId: r.card.threadId, name: p.name, stored: store.has(p.name), ...(r.duplicate ? { duplicate: true } : {}) };
}

/** `botSecret.list`: names and use, never values. */
export function handleSecretList(_raw: unknown, ctx: RpcContext | undefined, deps: SecretHandlerDeps): unknown {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  if (caller.kind === 'bot' && !botHasTool(caller.bot, 'secret_list')) return refusal('surface', 'this bot has no secret_list');
  const store = deps.store();
  if (!store) return notStarted();
  // A connection's keys are not a bot's to hand out: a bot's list leaves them out.
  const owned = deps.isConnectionKey ?? ((n: string) => isConnectionKey(n));
  const secrets = store.list()
    .filter((e) => caller.kind !== 'bot' || !owned(e.name))
    .map((e) => ({ ...e, usable: store.has(e.name) }));
  return { ok: true, secrets };
}

/** A website login page a card may open: https, no credentials in it. */
export function loginPageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > URL_MAX || /\s/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return u.toString();
}

/** What a login is to, in words: the service's name, a website's host. */
const SERVICE_NAMES: Readonly<Record<Exclude<LoginService, 'website'>, string>> = { github: 'GitHub', claude: 'Claude' };

function loginTarget(service: LoginService, url: string | null | undefined): string {
  if (service !== 'website') return SERVICE_NAMES[service];
  return url ? new URL(url).hostname : 'the website';
}

function loginTitle(service: LoginService, url: string | null): string {
  return `Log in to ${loginTarget(service, url)}`;
}

/** `botLogin.request`: a `login_request` card in the bot's own room. */
export function handleLoginRequest(raw: unknown, ctx: RpcContext | undefined, deps: SecretHandlerDeps): unknown {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  if (caller.kind !== 'bot') return refusal('bot_only', 'login_request is a bot\'s');
  const bot = caller.bot;
  if (!botHasTool(bot, 'login_request')) return refusal('surface', 'this bot has no login_request');
  const writer = deps.writer();
  if (!writer) return notStarted();
  const p = params(raw);
  if (!(LOGIN_SERVICES as readonly unknown[]).includes(p.service)) return refusal('invalid', 'service is github, claude or website');
  const service = p.service as LoginService;
  let url: string | null = null;
  if (service === 'website') {
    url = loginPageUrl(p.url);
    if (!url) return refusal('invalid', `url must be an https login page (at most ${URL_MAX} characters, no user name or password in it)`);
  } else if (p.url !== undefined) {
    return refusal('invalid', 'url is for a website login only');
  }
  if (typeof p.why !== 'string' || !p.why.trim() || p.why.length > BOT_SECRET_LIMITS.WHY_MAX) {
    return refusal('invalid', `why is required (at most ${BOT_SECRET_LIMITS.WHY_MAX} characters)`);
  }
  const ports = deps.ports();
  const place = botCardPlace(p, ports, bot, writer);
  if ('ok' in place) return place;
  const r = writer.post({
    workspaceId: bot.workspaceId,
    threadId: place.threadId,
    kind: 'login_request',
    actor: { kind: 'bot', workspaceId: bot.workspaceId, botId: bot.botId },
    title: loginTitle(service, url),
    body: p.why.trim(),
    refs: { label: service, ...(url ? { url } : {}) },
    state: 'open',
    ...(place.replyTo ? { replyTo: place.replyTo } : {}),
    ...(place.clientPostId ? { clientPostId: place.clientPostId } : {}),
  });
  if (!r.ok) return refusal('invalid', r.message);
  return { ok: true, cardId: r.card.id, threadId: r.card.threadId, ...(r.duplicate ? { duplicate: true } : {}) };
}

export function registerSecretHandlers(router: Pick<FactoryRouter, 'register'>, deps: SecretHandlerDeps): void {
  router.register(BOT_SECRET_RPC.request, async (raw, ctx) => handleSecretRequest(raw, ctx, deps));
  router.register(BOT_SECRET_RPC.list, async (raw, ctx) => handleSecretList(raw, ctx, deps));
  router.register(BOT_SECRET_RPC.loginRequest, async (raw, ctx) => handleLoginRequest(raw, ctx, deps));
}

// ── The owner's side (main-window IPC) ────────────────────────────────────

export type OwnerSecretResult =
  | { ok: true; entry: BotSecretEntry }
  | { ok: false; code: string; message: string };

export interface OwnerSecretDeps extends SecretHandlerDeps {
  now?: () => number;
  /** The owner deleted a key a bot asked for or last used: one system card
   *  in that bot's conversation. Best effort. */
  noteDeleted?: (botId: string, name: string) => void;
}

/** The card a deleted key posts in a bot's conversation thread: its name
 *  only, never its value, worded from its notice code (`secret.deleted`) in
 *  the reader's language. */
export function postSecretDeletedCard(writer: Pick<RoomWriter, 'append'> | null, workspaceId: string, threadId: ThreadId, name: string): boolean {
  if (!writer) return false;
  const card = writer.append({
    workspaceId,
    threadId,
    kind: 'fact',
    actor: { kind: 'system' },
    title: `Key deleted: ${name}`,
    body: 'The owner deleted it from the keys in Settings. Workers already running keep it until they stop, and the bot\'s next wake is told it is gone.',
    notice: { code: 'secret.deleted', args: { name } },
  });
  return !!card;
}

/** An open request card of `kind` in `workspaceId`, or a refusal text. */
function openRequestCard(writer: RoomWriter, workspaceId: unknown, cardId: unknown, kind: 'secret_request' | 'login_request'): RoomCard | string {
  if (!isRoomWorkspaceId(workspaceId) || typeof cardId !== 'string' || !cardId) return 'the request card is not named';
  const card = writer.get(workspaceId, cardId);
  if (!card || card.kind !== kind || card.actor.kind !== 'bot') return 'no such request card';
  if (card.state !== 'open') return 'the request was answered already';
  return card;
}

/** Close a request card and wake the bot that asked, with the owner's
 *  words (a name and a service, never a value). */
function settleRequest(writer: RoomWriter, ports: Partial<FactoryRoomPorts>, card: RoomCard, done: string, wakeText: string): void {
  if (!writer.setState(card.workspaceId, card.id, 'resolved')) return;
  writer.append({ workspaceId: card.workspaceId, threadId: card.threadId, kind: 'fact', actor: { kind: 'human' }, title: done });
  if (card.actor.kind !== 'bot') return;
  try {
    ports.wakes?.enqueue({
      botId: card.actor.botId,
      workspaceId: card.actor.workspaceId,
      reason: { kind: 'human', text: wakeText, source: 'desktop', clientMessageId: `settle:${card.id}` },
      priority: 0,
      ...(card.threadId !== GENERAL_THREAD ? { threadId: card.threadId } : {}),
    });
  } catch (err) {
    console.warn('[factory] secrets: the asking bot was not woken', err instanceof Error ? err.message : '');
  }
}

/** FACTORY secret set: store one value from the modal. The answer never
 *  carries the value. */
export function ownerSetSecret(raw: unknown, deps: OwnerSecretDeps): OwnerSecretResult {
  const store = deps.store();
  if (!store) return { ok: false, code: 'not_started', message: 'The key store is not running yet.' };
  const p = params(raw);
  const writer = deps.writer();
  let card: RoomCard | null = null;
  if (p.cardId !== undefined) {
    if (!writer) return { ok: false, code: 'not_started', message: 'Rooms are not running yet.' };
    const found = openRequestCard(writer, p.workspaceId, p.cardId, 'secret_request');
    if (typeof found === 'string') return { ok: false, code: 'invalid_card', message: found };
    if (found.refs?.secretName !== p.name) return { ok: false, code: 'invalid_card', message: 'the card asks for another name' };
    card = found;
  }
  // A connection's key is replaced in its connection, never from a bot's card.
  if (typeof p.name === 'string' && (deps.isConnectionKey ?? ((n: string) => isConnectionKey(n)))(p.name)) {
    return { ok: false, code: 'connection_key', message: `${p.name} is a connection's key. Replace it in Settings › Bots › Connections.` };
  }
  const r = store.set(p.name, p.value, {
    ...(card ? { label: card.title } : {}),
    ...(card && card.actor.kind === 'bot' ? { requestedBy: card.actor.botId } : {}),
  });
  if (!r.ok) return { ok: false, code: r.code, message: r.message };
  if (card && writer) {
    settleRequest(
      writer,
      deps.ports(),
      card,
      `Key saved: ${r.entry.name}`,
      `The owner saved the secret ${r.entry.name} you asked for. A worker you start with fanout_start secret_names ["${r.entry.name}"] gets it as that env var; you never see the value.`,
    );
  }
  return { ok: true, entry: r.entry };
}

export function ownerDeleteSecret(raw: unknown, deps: OwnerSecretDeps): { ok: boolean } {
  const store = deps.store();
  const name = params(raw).name;
  if (!store || typeof name !== 'string') return { ok: false };
  // Read before the delete: the bots that asked for it or used it last.
  const bots = store.botsOf(name);
  if (!store.delete(name)) return { ok: false };
  for (const botId of bots) {
    try {
      deps.noteDeleted?.(botId, name);
    } catch {
      /* the bot's wake still says it is deleted */
    }
  }
  return { ok: true };
}

export interface LoginCheckPorts {
  github: () => Promise<boolean>;
  claude: () => Promise<boolean>;
}

/** FACTORY login: is the owner signed in to the card's service now? When
 *  they are (or, for a website, when the owner says so with `done`), the
 *  card closes and the bot that asked is woken. */
export async function ownerLogin(raw: unknown, deps: OwnerSecretDeps, checks: LoginCheckPorts): Promise<{ ok: true; service: LoginService; signedIn: boolean } | { ok: false; code: string; message: string }> {
  const writer = deps.writer();
  if (!writer) return { ok: false, code: 'not_started', message: 'Rooms are not running yet.' };
  const p = params(raw);
  const card = openRequestCard(writer, p.workspaceId, p.cardId, 'login_request');
  if (typeof card === 'string') return { ok: false, code: 'invalid_card', message: card };
  const service = card.refs?.label as LoginService | undefined;
  if (!service || !(LOGIN_SERVICES as readonly string[]).includes(service)) return { ok: false, code: 'invalid_card', message: 'the card names no service' };
  let signedIn = false;
  if (service === 'website') signedIn = p.done === true;
  else {
    try {
      signedIn = await checks[service]();
    } catch {
      signedIn = false;
    }
  }
  if (signedIn) {
    const what = loginTarget(service, card.refs?.url);
    settleRequest(writer, deps.ports(), card, `Logged in: ${what}`, `The owner finished the ${what} login you asked for.`);
  }
  return { ok: true, service, signedIn };
}

function defaultLoginChecks(): LoginCheckPorts {
  return {
    github: async () => {
      const { ghPrService } = await import('../../github/GhPrService');
      return (await ghPrService.gate(os.homedir(), 'github.com', true)).ok;
    },
    claude: async () => {
      const { loadClaudeCredential } = await import('../../claude/claudeCredential');
      return (await loadClaudeCredential()).ok;
    },
  };
}

/** The four main-window IPC handlers. Each answers only the main window's
 *  top frame and never throws (nothing reaches the IPC error log). */
export function registerSecretIpc(getWindow: () => BrowserWindow | null, deps: OwnerSecretDeps, checks: LoginCheckPorts = defaultLoginChecks()): () => void {
  const channels = Object.values(BOT_SECRET_IPC);
  for (const c of channels) ipcMain.removeHandler(c);
  const denied = { ok: false, code: 'not_authorized', message: 'only the wmux window may do this' } as const;
  const guard = <R>(fn: (req: unknown) => R | Promise<R>) =>
    async (e: Electron.IpcMainInvokeEvent, req: unknown): Promise<R | typeof denied | { ok: false; code: 'error'; message: string }> => {
      if (!isMainWindowSender(e, getWindow())) return denied;
      try {
        return await fn(req);
      } catch {
        return { ok: false, code: 'error', message: 'The request failed.' };
      }
    };
  ipcMain.handle(BOT_SECRET_IPC.list, guard(() => {
    const store = deps.store();
    if (!store) return { ok: false as const, code: 'not_started', message: 'The key store is not running yet.' };
    const refusalNow = store.storeRefusal();
    const lib = getConnectorStore()?.list() ?? [];
    return {
      ok: true as const,
      secrets: store.list().map((e) => {
        const connections = lib.filter((c) => c.secrets.some((s) => s.secret === e.name)).map((c) => c.name);
        return { ...e, usable: store.has(e.name), ...(connections.length > 0 ? { connections } : {}) };
      }),
      ...(refusalNow ? { cannotStore: { code: refusalNow.code, message: refusalNow.message } } : {}),
    };
  }));
  ipcMain.handle(BOT_SECRET_IPC.set, guard((req) => ownerSetSecret(req, deps)));
  ipcMain.handle(BOT_SECRET_IPC.delete, guard((req) => ownerDeleteSecret(req, deps)));
  ipcMain.handle(BOT_SECRET_IPC.login, guard((req) => ownerLogin(req, deps, checks)));
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}

/** The deleted-key card, in the thread the owner last woke the bot in (its
 *  1:1 otherwise), as an archived skill's (skill.rpc.ts). Best effort: a
 *  failure is logged. */
function noteDeletedInRoom(botId: string, name: string): void {
  void (async () => {
    const [{ getBotDirectory }, { latestOwnerWakeThread }] = await Promise.all([
      import('../../factory/botStore'),
      import('../../factory/wakeQueue'),
    ]);
    const bot = getBotDirectory()?.get(botId);
    if (!bot) return;
    postSecretDeletedCard(getRoomWriter(), bot.workspaceId, latestOwnerWakeThread(botId) ?? dmThreadId(botId), name);
  })().catch((err) => console.warn(`[factory] key deleted card not posted: ${String(err)}`));
}

// ── Module ─────────────────────────────────────────────────────────────────

export function createSecretModule(
  deps: Pick<FactoryHostDeps, 'wmuxDir' | 'getMainWindow'>,
  crypto: () => SecretCrypto = electronSecretCrypto,
): FactoryModuleHandle {
  let offIpc: (() => void) | null = null;
  const handlerDeps: OwnerSecretDeps = { store: getSecretStore, writer: getRoomWriter, ports: resolveRoomPorts, noteDeleted: noteDeletedInRoom };
  return {
    start() {
      if (getSecretStore()) return;
      const store = new SecretStore({
        file: path.join(deps.wmuxDir(), 'factory', SECRETS_FILENAME),
        crypto: crypto(),
        onChange: () => {
          const win = deps.getMainWindow();
          if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, { type: 'secrets-changed' });
        },
      });
      store.load();
      setSecretStore(store);
      setSecretGrantSource(getSecretStore);
      offIpc = registerSecretIpc(deps.getMainWindow, handlerDeps);
    },
    dispose() {
      offIpc?.();
      offIpc = null;
      setSecretGrantSource(null);
      setSecretStore(null);
    },
  };
}

registerFactoryRpcModule('secrets', (router, deps) => {
  registerSecretHandlers(router, { store: getSecretStore, writer: getRoomWriter, ports: resolveRoomPorts });
  return createSecretModule(deps);
});
