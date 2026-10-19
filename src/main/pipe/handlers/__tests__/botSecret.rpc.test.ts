// botSecret.* / botLogin.request and the owner's main-window side.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ipcHandlers } = vi.hoisted(() => ({ ipcHandlers: new Map<string, (e: unknown, req: unknown) => Promise<unknown>>() }));
vi.mock('electron', () => ({
  safeStorage: {},
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, req: unknown) => Promise<unknown>) => { ipcHandlers.set(ch, fn); },
    removeHandler: (ch: string) => { ipcHandlers.delete(ch); },
  },
}));

import { RoomWriter } from '../../../factory/roomWriter';
import { SecretStore, type SecretCrypto } from '../../../factory/secretStore';
import { __resetRedactedSecretsForTesting } from '../../../factory/secretRedaction';
import {
  handleLoginRequest,
  handleSecretList,
  handleSecretRequest,
  loginPageUrl,
  ownerDeleteSecret,
  ownerLogin,
  ownerSetSecret,
  postSecretDeletedCard,
  registerSecretIpc,
} from '../botSecret.rpc';
import { dmThreadId } from '../../../../shared/room';
import type { BotProfile } from '../../../../shared/bot';
import { wakeDeletedKeys } from '../../../factory/wakeContext';
import { buildWakePrompt } from '../../../factory/wakePrompt';
import { noticeText } from '../../../../renderer/components/Room/roomFormat';
import { en } from '../../../../renderer/i18n/locales/en';
import { ko } from '../../../../renderer/i18n/locales/ko';
import { BOT_SECRET_IPC } from '../../../../shared/botSecret';
import type { RpcContext } from '../../../../shared/rpc';
import { phoneRoomCard } from '../../../../shared/phoneRooms';
import type { WakeEnqueueInput } from '../../../factory/wakeQueue';

const crypto: SecretCrypto = {
  state: () => 'ok',
  encrypt: (p) => Buffer.from(`enc:${Buffer.from(p).toString('hex')}`),
  decrypt: (c) => Buffer.from(c.toString().slice(4), 'hex').toString(),
};
const BOT = { workspaceId: 'ws-1', botId: 'bot-0000abcd', role: 'lead' as const };
const botCtx = { origin: 'local', bot: BOT } as unknown as RpcContext;
const operatorCtx = { origin: 'local', operator: true } as unknown as RpcContext;
const paneCtx = { origin: 'local' } as unknown as RpcContext;

let dir = '';
let writer: RoomWriter;
let store: SecretStore;
let wakes: WakeEnqueueInput[];
let deps: Parameters<typeof handleSecretRequest>[2];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-w4-rpc-'));
  writer = new RoomWriter({ dir: path.join(dir, 'rooms') });
  store = new SecretStore({ file: path.join(dir, 'secrets.json'), crypto });
  store.load();
  wakes = [];
  deps = { store: () => store, writer: () => writer, ports: () => ({ wakes: { enqueue: (w: WakeEnqueueInput) => { wakes.push(w); return null; } } }) };
  __resetRedactedSecretsForTesting();
});
afterEach(() => {
  __resetRedactedSecretsForTesting();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('secret_request', () => {
  it('is a bot\'s: an operator or a pane caller is refused', () => {
    expect(handleSecretRequest({ name: 'NPM_TOKEN', label: 'l', why: 'w' }, operatorCtx, deps)).toMatchObject({ ok: false, code: 'bot_only' });
    expect(handleSecretRequest({ name: 'NPM_TOKEN', label: 'l', why: 'w' }, paneCtx, deps)).toMatchObject({ ok: false, code: 'not_bot' });
  });

  it('refuses a name that does not read as a credential, and a missing label or why', () => {
    for (const name of ['MY_NAME', 'PATH', 'npm_token', 'WMUX_AUTH_TOKEN']) {
      expect(handleSecretRequest({ name, label: 'l', why: 'w' }, botCtx, deps)).toMatchObject({ ok: false, code: 'invalid_name' });
    }
    expect(handleSecretRequest({ name: 'NPM_TOKEN', label: '', why: 'w' }, botCtx, deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(handleSecretRequest({ name: 'NPM_TOKEN', label: 'l', why: '' }, botCtx, deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(writer.read('ws-1', {}).cards).toEqual([]);
  });

  it('posts one open card per request id in the bot\'s own room', () => {
    const a = handleSecretRequest({ name: 'NPM_TOKEN', label: 'npm token', why: 'publish', clientRequestId: 'r-1' }, botCtx, deps) as { cardId: string };
    const b = handleSecretRequest({ name: 'NPM_TOKEN', label: 'npm token', why: 'publish', clientRequestId: 'r-1' }, botCtx, deps) as { cardId: string; duplicate?: boolean };
    expect(b).toMatchObject({ duplicate: true, cardId: a.cardId });
    expect(writer.read('ws-1', {}).cards).toHaveLength(1);
  });

  it('a request made in an owner-message wake answers that message, in its thread only', () => {
    const owner = writer.post({ workspaceId: 'ws-1', kind: 'human', actor: { kind: 'human' }, title: 'publish it' });
    if (!owner.ok) throw new Error('post failed');
    const wake = { wakeId: 'w-1', attempt: 1, ownerCardId: owner.card.id };
    deps = { ...deps, ports: () => ({ currentWake: () => wake }) };
    const a = handleSecretRequest({ name: 'NPM_TOKEN', label: 'npm token', why: 'publish' }, botCtx, deps) as { cardId: string };
    expect(writer.get('ws-1', a.cardId)).toMatchObject({ kind: 'secret_request', replyTo: owner.card.id, refs: { secretName: 'NPM_TOKEN' } });
    const b = handleLoginRequest({ service: 'github', why: 'push', threadId: 'task:t-1' }, botCtx, deps) as { cardId: string };
    expect(writer.get('ws-1', b.cardId)?.replyTo).toBeUndefined();
  });

  it('a key or login request names a group chat\'s thread only when the bot is in that group (or its wake runs there)', () => {
    const G = 'group:grp-0000aaaa';
    const group = (members: string[]) => ({ byThread: (ws: string, t: unknown) => (ws === 'ws-1' && t === G ? { id: 'grp-0000aaaa', workspaceId: 'ws-1', name: 'x', memberIds: members, threadId: G, createdAt: 1, updatedAt: 1 } as never : null) });
    deps = { ...deps, ports: () => ({ groups: group(['bot-0000ffff', 'bot-0000eeee']) }) };
    expect(handleSecretRequest({ name: 'NPM_TOKEN', label: 'l', why: 'w', threadId: G }, botCtx, deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(handleLoginRequest({ service: 'github', why: 'push', threadId: G }, botCtx, deps)).toMatchObject({ ok: false, code: 'invalid' });
    deps = { ...deps, ports: () => ({ groups: group([BOT.botId, 'bot-0000eeee']) }) };
    expect(handleSecretRequest({ name: 'NPM_TOKEN', label: 'l', why: 'w', threadId: G }, botCtx, deps)).toMatchObject({ ok: true, threadId: G });
  });

  it('reaches the phone as a name: a stored value in the bot\'s words is redacted, and refs carry the name only', () => {
    store.set('NPM_TOKEN', 'abcdefgh12345678');
    const a = handleSecretRequest({ name: 'NPM_TOKEN', label: 'npm token abcdefgh12345678', why: 'publish with abcdefgh12345678', refs: { value: 'abcdefgh12345678' } }, botCtx, deps) as { cardId: string };
    const card = writer.get('ws-1', a.cardId);
    const phone = card ? phoneRoomCard(card, () => null) : null;
    expect(phone).toMatchObject({ kind: 'secret_request', refs: { secretName: 'NPM_TOKEN' } });
    expect(Object.keys(phone?.refs ?? {})).toEqual(['secretName']);
    expect(JSON.stringify(phone)).not.toContain('abcdefgh12345678');
  });

  it('secret_list: names and use for a bot or the operator, never values', () => {
    store.set('NPM_TOKEN', 'abcdefgh12345678');
    for (const ctx of [botCtx, operatorCtx]) {
      const r = handleSecretList({}, ctx, deps);
      expect(r).toMatchObject({ ok: true, secrets: [{ name: 'NPM_TOKEN', usable: true }] });
      expect(JSON.stringify(r)).not.toContain('abcdefgh12345678');
    }
    expect(handleSecretList({}, paneCtx, deps)).toMatchObject({ ok: false });
  });
});

describe('the owner stores a value', () => {
  it('only for an open card asking for that name; the answer never carries the value', () => {
    const asked = handleSecretRequest({ name: 'NPM_TOKEN', label: 'npm token', why: 'publish' }, botCtx, deps) as { cardId: string };
    expect(ownerSetSecret({ name: 'GH_TOKEN', value: 'abcdefgh12345678', workspaceId: 'ws-1', cardId: asked.cardId }, deps)).toMatchObject({ ok: false, code: 'invalid_card' });
    expect(ownerSetSecret({ name: 'NPM_TOKEN', value: 'abcdefgh12345678', workspaceId: 'ws-1', cardId: 'c-nope' }, deps)).toMatchObject({ ok: false, code: 'invalid_card' });
    const r = ownerSetSecret({ name: 'NPM_TOKEN', value: 'abcdefgh12345678', workspaceId: 'ws-1', cardId: asked.cardId }, deps);
    expect(r).toMatchObject({ ok: true, entry: { name: 'NPM_TOKEN', label: 'npm token', requestedBy: BOT.botId } });
    expect(JSON.stringify(r)).not.toContain('abcdefgh12345678');
    expect(writer.get('ws-1', asked.cardId)?.state).toBe('resolved');
    expect(wakes).toHaveLength(1);
    expect(wakes[0].reason).toMatchObject({ kind: 'human', text: expect.stringContaining('NPM_TOKEN') });
    // Answered once.
    expect(ownerSetSecret({ name: 'NPM_TOKEN', value: 'abcdefgh12345678', workspaceId: 'ws-1', cardId: asked.cardId }, deps)).toMatchObject({ ok: false, code: 'invalid_card' });
    expect(ownerDeleteSecret({ name: 'NPM_TOKEN' }, deps)).toEqual({ ok: true });
    expect(store.list()).toEqual([]);
  });

  it('IPC answers only the main window\'s top frame and never throws', async () => {
    const mainFrame = {};
    const wc = { mainFrame };
    const win = { isDestroyed: () => false, webContents: wc } as unknown as Electron.BrowserWindow;
    const off = registerSecretIpc(() => win, deps, { github: async () => true, claude: async () => false });
    for (const ch of Object.values(BOT_SECRET_IPC)) {
      expect(await ipcHandlers.get(ch)!({ sender: wc, senderFrame: {} }, { name: 'NPM_TOKEN', value: 'abcdefgh12345678' })).toMatchObject({ ok: false, code: 'not_authorized' });
      expect(await ipcHandlers.get(ch)!({ sender: {}, senderFrame: mainFrame }, {})).toMatchObject({ ok: false, code: 'not_authorized' });
    }
    expect(store.list()).toEqual([]);
    expect(await ipcHandlers.get(BOT_SECRET_IPC.set)!({ sender: wc, senderFrame: mainFrame }, { name: 'NPM_TOKEN', value: 'abcdefgh12345678' })).toMatchObject({ ok: true });
    expect(await ipcHandlers.get(BOT_SECRET_IPC.list)!({ sender: wc, senderFrame: mainFrame }, {})).toMatchObject({ ok: true, secrets: [{ name: 'NPM_TOKEN' }] });
    off();
    expect(ipcHandlers.size).toBe(0);
  });

  it('the list says why storing is refused when there is no keyring', async () => {
    const plain = new SecretStore({ file: path.join(dir, 's2.json'), crypto: { ...crypto, state: () => 'basic_text' } });
    plain.load();
    const mainFrame = {};
    const wc = { mainFrame };
    registerSecretIpc(() => ({ isDestroyed: () => false, webContents: wc }) as unknown as Electron.BrowserWindow, { ...deps, store: () => plain });
    const listed = await ipcHandlers.get(BOT_SECRET_IPC.list)!({ sender: wc, senderFrame: mainFrame }, {});
    expect(listed).toMatchObject({ ok: true, cannotStore: { code: 'basic_text' } });
    expect(await ipcHandlers.get(BOT_SECRET_IPC.set)!({ sender: wc, senderFrame: mainFrame }, { name: 'NPM_TOKEN', value: 'abcdefgh12345678' })).toMatchObject({ ok: false, code: 'basic_text' });
  });
});

describe('login_request', () => {
  it('takes github, claude, or an https website login page without credentials in it', () => {
    expect(loginPageUrl('https://example.com/login')).toBe('https://example.com/login');
    for (const bad of ['http://example.com/login', 'javascript:alert(1)', 'https://user:pw@example.com/', 'file:///etc/passwd', 'https://exa mple.com', 42]) {
      expect(loginPageUrl(bad)).toBeNull();
    }
    expect(handleLoginRequest({ service: 'website', url: 'http://example.com', why: 'w' }, botCtx, deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(handleLoginRequest({ service: 'github', url: 'https://example.com', why: 'w' }, botCtx, deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(handleLoginRequest({ service: 'ftp', why: 'w' }, botCtx, deps)).toMatchObject({ ok: false, code: 'invalid' });
    expect(handleLoginRequest({ service: 'github', why: 'w' }, operatorCtx, deps)).toMatchObject({ ok: false, code: 'bot_only' });
    const r = handleLoginRequest({ service: 'website', url: 'https://example.com/login', why: 'read the dashboard' }, botCtx, deps) as { cardId: string };
    expect(writer.get('ws-1', r.cardId)).toMatchObject({ kind: 'login_request', state: 'open', title: 'Log in to example.com', refs: { label: 'website', url: 'https://example.com/login' } });
  });

  it('closes the card when the owner is signed in (a website: when the owner says done) and wakes the bot', async () => {
    const gh = handleLoginRequest({ service: 'github', why: 'open the PR' }, botCtx, deps) as { cardId: string };
    let signedIn = false;
    const checks = { github: async () => signedIn, claude: async () => true };
    expect(await ownerLogin({ workspaceId: 'ws-1', cardId: gh.cardId }, deps, checks)).toEqual({ ok: true, service: 'github', signedIn: false });
    expect(writer.get('ws-1', gh.cardId)?.state).toBe('open');
    signedIn = true;
    expect(await ownerLogin({ workspaceId: 'ws-1', cardId: gh.cardId }, deps, checks)).toEqual({ ok: true, service: 'github', signedIn: true });
    expect(writer.get('ws-1', gh.cardId)?.state).toBe('resolved');
    expect(wakes.at(-1)?.reason).toMatchObject({ kind: 'human', text: expect.stringContaining('GitHub') });
    const site = handleLoginRequest({ service: 'website', url: 'https://example.com/login', why: 'w' }, botCtx, deps) as { cardId: string };
    expect(await ownerLogin({ workspaceId: 'ws-1', cardId: site.cardId }, deps, checks)).toMatchObject({ signedIn: false });
    expect(await ownerLogin({ workspaceId: 'ws-1', cardId: site.cardId, done: true }, deps, checks)).toMatchObject({ signedIn: true });
    expect(await ownerLogin({ workspaceId: 'ws-1', cardId: site.cardId, done: true }, deps, checks)).toMatchObject({ ok: false, code: 'invalid_card' });
  });
});

describe('the owner deletes a key a bot used', () => {
  const OTHER = 'bot-0000beef';
  const VALUE = 'abcdefgh12345678';
  const profile = (id: string): BotProfile => ({
    version: 1, id, workspaceId: 'ws-1', role: 'lead', name: 'Dev', engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerDay: 9, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 } as BotProfile['budget'],
    enabled: true, createdAt: 0, updatedAt: 0,
  });

  function stored(): void {
    const asked = handleSecretRequest({ name: 'NPM_TOKEN', label: 'npm token', why: 'publish' }, botCtx, deps) as { cardId: string };
    expect(asked.cardId).toBeTruthy();
    expect(ownerSetSecret({ name: 'NPM_TOKEN', value: VALUE, workspaceId: 'ws-1', cardId: asked.cardId }, deps)).toMatchObject({ ok: true });
    store.markUsed(['NPM_TOKEN'], OTHER);
  }

  it('tells each bot that asked for it or used it last, by name only, and its next wake says to ask again', () => {
    stored();
    const noteDeleted = vi.fn();
    expect(ownerDeleteSecret({ name: 'NPM_TOKEN' }, { ...deps, noteDeleted })).toEqual({ ok: true });
    expect(noteDeleted.mock.calls).toEqual([[BOT.botId, 'NPM_TOKEN'], [OTHER, 'NPM_TOKEN']]);
    // Nothing to tell for a key that is not stored.
    expect(ownerDeleteSecret({ name: 'NPM_TOKEN' }, { ...deps, noteDeleted })).toEqual({ ok: false });
    expect(noteDeleted).toHaveBeenCalledTimes(2);

    for (const id of [BOT.botId, OTHER]) {
      const keys = wakeDeletedKeys({ secrets: () => store } as never, profile(id));
      expect(keys).toEqual([{ name: 'NPM_TOKEN' }]);
      const item = { id: 'w-1', botId: id, workspaceId: 'ws-1', reason: { kind: 'human' }, priority: 1, attempts: 1 } as never;
      expect(buildWakePrompt({ item, profile: profile(id), deletedKeys: keys }))
        .toContain('The owner deleted the key NPM_TOKEN; ask with secret_request if you still need it.');
    }
    expect(wakeDeletedKeys({ secrets: () => store } as never, profile('bot-00000000'))).toEqual([]);

    // Remembered across a restart, and forgotten once the key is stored again.
    const again = new SecretStore({ file: path.join(dir, 'secrets.json'), crypto });
    again.load();
    expect(again.deletedFor(OTHER)).toEqual([{ name: 'NPM_TOKEN' }]);
    expect(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).not.toContain(VALUE);
    expect(again.set('NPM_TOKEN', VALUE).ok).toBe(true);
    expect(again.deletedFor(OTHER)).toEqual([]);
  });

  it('remembers only keys a bot used, until stored again, however many other keys go or however long the bot sleeps', () => {
    stored();
    expect(ownerDeleteSecret({ name: 'NPM_TOKEN' }, deps)).toEqual({ ok: true });
    // Keys no bot used are not remembered, so they never push a bot's out.
    for (let i = 0; i < 40; i++) {
      const name = `K${i}_TOKEN`;
      expect(store.set(name, VALUE).ok).toBe(true);
      expect(ownerDeleteSecret({ name }, deps)).toEqual({ ok: true });
    }
    const later = new SecretStore({ file: path.join(dir, 'secrets.json'), crypto, now: () => Date.now() + 90 * 24 * 3600_000 });
    later.load();
    expect(later.deletedFor(BOT.botId)).toEqual([{ name: 'NPM_TOKEN' }]);
  });

  it('a connection\'s key: the wake says to have the owner enter it in its connection, not to use secret_request', () => {
    expect(store.set('GH_MCP_TOKEN', VALUE, { connectorId: 'con-0000abcd' }).ok).toBe(true);
    store.markUsed(['GH_MCP_TOKEN'], OTHER);
    expect(ownerDeleteSecret({ name: 'GH_MCP_TOKEN' }, deps)).toEqual({ ok: true });
    const keys = wakeDeletedKeys({ secrets: () => store } as never, profile(OTHER));
    expect(keys).toEqual([{ name: 'GH_MCP_TOKEN', connector: true }]);
    const item = { id: 'w-1', botId: OTHER, workspaceId: 'ws-1', reason: { kind: 'human' }, priority: 1, attempts: 1 } as never;
    const text = buildWakePrompt({ item, profile: profile(OTHER), deletedKeys: keys });
    expect(text).toContain('The owner deleted the key GH_MCP_TOKEN of a connection');
    expect(text).toContain('Settings › Bots › Connections');
    expect(text).not.toContain('ask with secret_request');
  });

  it('the card names the key, never its value, worded in the reader\'s language', () => {
    expect(postSecretDeletedCard(writer, 'ws-1', dmThreadId(BOT.botId), 'NPM_TOKEN')).toBe(true);
    const card = writer.read('ws-1', { threadId: dmThreadId(BOT.botId) }).cards.at(-1);
    expect(card).toMatchObject({ kind: 'fact', actor: { kind: 'system' }, title: 'Key deleted: NPM_TOKEN', notice: { code: 'secret.deleted', args: { name: 'NPM_TOKEN' } } });
    const word = (dict: Record<string, string>) => (key: string, vars?: Record<string, string | number>) =>
      (dict[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? ''));
    expect(noticeText(card as never, word(en as Record<string, string>))?.title).toBe('Key deleted: NPM_TOKEN');
    expect(noticeText(card as never, word(ko as Record<string, string>))?.title).toBe('키 삭제됨: NPM_TOKEN');
    // The phone receives the code and the name.
    expect(phoneRoomCard(card as never, () => null)).toMatchObject({ notice: { code: 'secret.deleted', args: { name: 'NPM_TOKEN' } } });
  });
});
