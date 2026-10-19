// The connection library: its store, the owner's main-window IPC, and how
// a connection's keys stay the connection's (never a bot's plain secret).
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

import { ConnectorStore, isConnectionKey, parseStoredConnector } from '../../../factory/connectorStore';
import { resolveConnectorCommand } from '../../../factory/connectorCommand';
import { SecretStore, type SecretCrypto } from '../../../factory/secretStore';
import { __resetRedactedSecretsForTesting } from '../../../factory/secretRedaction';
import { listConnectors, registerConnectorIpc, removeConnector, saveConnector, setConnectorOffForBot, type ConnectorIpcDeps } from '../connector.rpc';
import { handleSecretList, ownerSetSecret } from '../botSecret.rpc';
import { CONNECTOR_IPC, type ConnectorDraft } from '../../../../shared/botConnector';
import type { RpcContext } from '../../../../shared/rpc';
import { BotStore } from '../../../factory/botStore';

const crypto: SecretCrypto = {
  state: () => 'ok',
  encrypt: (p) => Buffer.from(`enc:${Buffer.from(p).toString('hex')}`),
  decrypt: (c) => Buffer.from(c.toString().slice(4), 'hex').toString(),
};
const A = 'bot-0000000a';
const B = 'bot-0000000b';
const TOKEN = 'ghp_ConnectionValue0123456789abcdef';

let dir = '';
let secrets: SecretStore;
let store: ConnectorStore;
let bots: Set<string>;
let deps: ConnectorIpcDeps;
let ids = 0;

function draft(over: Partial<ConnectorDraft> = {}): ConnectorDraft {
  return {
    name: 'gh',
    transport: 'http',
    remote: { url: 'https://api.example.com/mcp/', headers: {} },
    secrets: [{ secret: 'GH_MCP_TOKEN', as: 'header', header: 'Authorization', scheme: 'bearer' }],
    tools: { mode: 'all', blocked: ['merge_pull_request'] },
    scope: { kind: 'all' },
    enabled: true,
    ...over,
  };
}

function newStore(): ConnectorStore {
  const s = new ConnectorStore(path.join(dir, 'factory', 'connectors.json'), { botIds: () => bots, newId: () => `con-0000000${++ids}` });
  s.load();
  return s;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-conn-'));
  ids = 0;
  bots = new Set([A, B]);
  __resetRedactedSecretsForTesting();
  secrets = new SecretStore({ file: path.join(dir, 'factory', 'secrets.json'), crypto });
  secrets.load();
  store = newStore();
  deps = { store: () => store, secrets: () => secrets, platform: 'darwin', resolveCommand: async (c) => (c.startsWith('/') ? c : `/usr/bin/${c}`) };
});
afterEach(async () => {
  __resetRedactedSecretsForTesting();
  await store.flush().catch(() => undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('connector store', () => {
  it('round-trips through the file (0600) and drops a malformed record on read', async () => {
    const r = await saveConnector({ connector: draft() }, deps);
    expect(r.ok).toBe(true);
    await store.flush();
    const file = path.join(dir, 'factory', 'connectors.json');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.connectors.push({ ...raw.connectors[0], id: 'con-ffffffff', name: 'bad name' });
    // A stdio record with a bare command was not written by main.
    raw.connectors.push({ ...raw.connectors[0], id: 'con-eeeeeeee', name: 'bare', transport: 'stdio', remote: undefined, secrets: [], stdio: { command: 'npx', args: [], env: {} } });
    fs.writeFileSync(file, JSON.stringify(raw));
    const again = newStore();
    expect(again.list().map((c) => c.name)).toEqual(['gh']);
  });

  it('a file of another version loads as no connections and is never written over', async () => {
    const file = path.join(dir, 'factory', 'connectors.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2, connectors: [] }));
    store = newStore();
    expect(store.list()).toEqual([]);
    expect(await saveConnector({ connector: draft() }, deps)).toMatchObject({ ok: false, code: 'store_unreadable' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(2);
  });

  it('a removed bot drops out of scopes and off-switches; moving to picked bots clears off-switches', async () => {
    const saved = await saveConnector({ connector: draft() }, deps);
    const id = saved.ok ? saved.connector.id : '';
    expect(setConnectorOffForBot({ id, botId: B, off: true }, deps)).toMatchObject({ ok: true, connector: { offFor: [B] } });
    expect(store.forBot(B)).toEqual([]);
    bots.delete(B);
    expect(store.get(id)?.offFor).toEqual([]);
    bots.add(B);
    await saveConnector({ connector: draft() }, deps).then(() => undefined);
    setConnectorOffForBot({ id, botId: A, off: true }, deps);
    const moved = await saveConnector({ connector: { ...draft({ scope: { kind: 'bots', botIds: [A, B] } }), id } }, deps);
    expect(moved.ok && moved.connector.offFor).toEqual([]);
    bots.delete(B);
    expect(store.get(id)?.scope).toEqual({ kind: 'bots', botIds: [A] });
  });

  it('off-switch is for an every-bot connection only, and for a bot that exists', async () => {
    const picked = await saveConnector({ connector: draft({ scope: { kind: 'bots', botIds: [A] } }) }, deps);
    const id = picked.ok ? picked.connector.id : '';
    expect(setConnectorOffForBot({ id, botId: A, off: true }, deps).ok).toBe(false);
    expect((await saveConnector({ connector: draft({ name: 'x', scope: { kind: 'bots', botIds: ['bot-0000000c'] } }) }, deps)).ok).toBe(false);
  });

  it('parseStoredConnector needs an id and timestamps', () => {
    expect(parseStoredConnector({ ...draft(), offFor: [] })).toBeNull();
  });
});

describe('saving a connection', () => {
  it('stores the connection, then its typed key marked as the connection\'s; the answer never carries the value', async () => {
    const r = await saveConnector({ connector: draft(), keyValues: { GH_MCP_TOKEN: TOKEN } }, deps);
    expect(r).toMatchObject({ ok: true, connector: { name: 'gh', missingKeys: [] } });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(secrets.isConnectorKey('GH_MCP_TOKEN')).toBe(true);
    expect(isConnectionKey('GH_MCP_TOKEN', { connectors: () => store, secretMarked: (n) => secrets.isConnectorKey(n) })).toBe(true);
  });

  it('a connection without its key saved yet reads Key missing', async () => {
    const r = await saveConnector({ connector: draft() }, deps);
    expect(r.ok && r.connector.missingKeys).toEqual(['GH_MCP_TOKEN']);
  });

  it('refuses a key name bots already use as a plain secret, and accepts one another connection owns', async () => {
    expect(secrets.set('NPM_TOKEN', 'npm_plain_value_123456').ok).toBe(true);
    const r = await saveConnector({ connector: draft({ secrets: [{ secret: 'NPM_TOKEN', as: 'header', header: 'Authorization', scheme: 'bearer' }] }) }, deps);
    expect(r).toMatchObject({ ok: false, code: 'key_in_use' });
    await saveConnector({ connector: draft(), keyValues: { GH_MCP_TOKEN: TOKEN } }, deps);
    expect((await saveConnector({ connector: draft({ name: 'gh2' }) }, deps)).ok).toBe(true);
  });

  it('refuses a literal holding a stored value or the value typed in the same save', async () => {
    expect(secrets.set('OTHER_TOKEN', 'other_secret_value_0987').ok).toBe(true);
    const stored = await saveConnector({ connector: draft({ remote: { url: 'https://api.example.com/mcp/', headers: { 'X-Note': 'other_secret_value_0987' } } }) }, deps);
    expect(stored).toMatchObject({ ok: false, field: 'connection' });
    const typed = await saveConnector({ connector: draft({ purpose: `uses ${TOKEN}` }), keyValues: { GH_MCP_TOKEN: TOKEN } }, deps);
    expect(typed).toMatchObject({ ok: false, field: 'connection' });
    expect(secrets.has('GH_MCP_TOKEN')).toBe(false);
  });

  it('refuses a stored value anywhere the owner wrote: the name, a field name, a tool name', async () => {
    expect(secrets.set('OTHER_TOKEN', 'zzqqvalue12345').ok).toBe(true);
    for (const d of [
      draft({ name: 'zzqqvalue12345' }),
      draft({ remote: { url: 'https://api.example.com/mcp/', headers: { 'zzqqvalue12345': 'x' } } }),
      draft({ tools: { mode: 'listed', allowed: ['zzqqvalue12345'] } }),
    ]) {
      expect(await saveConnector({ connector: d }, deps)).toMatchObject({ ok: false, field: 'connection' });
    }
  });

  it('a record on disk holding a stored value is dropped on read', async () => {
    await saveConnector({ connector: draft({ remote: { url: 'https://api.example.com/mcp/', headers: { 'X-Note': 'later_stored_value_1' } } }) }, deps);
    await store.flush();
    expect(newStore().list()).toHaveLength(1);
    expect(secrets.set('LATER_TOKEN', 'later_stored_value_1').ok).toBe(true);
    expect(newStore().list()).toEqual([]);
  });

  it('checks key ownership after the command lookup: a key bots got meanwhile is not adopted', async () => {
    const local: ConnectorDraft = { name: 'files', transport: 'stdio', stdio: { command: 'srv', args: [], env: {} }, secrets: [{ secret: 'RACE_TOKEN', as: 'env' }], tools: { mode: 'listed', allowed: ['x'] }, scope: { kind: 'all' }, enabled: true };
    const r = await saveConnector({ connector: local }, { ...deps, resolveCommand: async () => { secrets.set('RACE_TOKEN', 'race_plain_value_1'); return '/usr/bin/srv'; } });
    expect(r).toMatchObject({ ok: false, code: 'key_in_use' });
  });

  it('a resolved command that read validation would refuse is refused at save', async () => {
    const local: ConnectorDraft = { name: 'files', transport: 'stdio', stdio: { command: 'srv', args: [], env: {} }, secrets: [], tools: { mode: 'listed', allowed: ['x'] }, scope: { kind: 'all' }, enabled: true };
    const r = await saveConnector({ connector: local }, { ...deps, resolveCommand: async () => '/opt/odd (x86)/srv' });
    expect(r).toMatchObject({ ok: false, field: 'command' });
  });

  it('a value for a name the connection does not hold is refused', async () => {
    expect(await saveConnector({ connector: draft(), keyValues: { NPM_TOKEN: TOKEN } }, deps)).toMatchObject({ ok: false, field: 'secrets' });
  });

  it('resolves a bare command to an absolute path and refuses one that is not found', async () => {
    const local: ConnectorDraft = { name: 'files', transport: 'stdio', stdio: { command: 'npx', args: ['-y', 'x@1.0.0'], env: {} }, secrets: [], tools: { mode: 'listed', allowed: ['read_file'] }, scope: { kind: 'all' }, enabled: true };
    const r = await saveConnector({ connector: local }, deps);
    expect(r.ok && r.connector.stdio?.command).toBe('/usr/bin/npx');
    const missing = await saveConnector({ connector: { ...local, name: 'other' } }, { ...deps, resolveCommand: async () => null });
    expect(missing).toMatchObject({ ok: false, field: 'command' });
  });

  it('resolveConnectorCommand: absolute PATH entries only, an absolute path as given', async () => {
    const isExecutable = (p: string) => p === '/home/u/.local/bin/srv' || p === '/opt/srv';
    expect(await resolveConnectorCommand('srv', { platform: 'linux', pathVar: async () => 'bin:./x:/home/u/.local/bin', isExecutable })).toBe('/home/u/.local/bin/srv');
    expect(await resolveConnectorCommand('srv', { platform: 'linux', pathVar: async () => 'bin:.', isExecutable: () => true })).toBeNull();
    expect(await resolveConnectorCommand('/opt/srv', { platform: 'linux', isExecutable })).toBe('/opt/srv');
    expect(await resolveConnectorCommand('/opt/none', { platform: 'linux', isExecutable })).toBeNull();
  });
});

describe('removing a connection', () => {
  it('keeps its keys unless asked; a key another connection uses is kept either way', async () => {
    const one = await saveConnector({ connector: draft(), keyValues: { GH_MCP_TOKEN: TOKEN } }, deps);
    const two = await saveConnector({ connector: draft({ name: 'gh2' }) }, deps);
    const oneId = one.ok ? one.connector.id : '';
    const twoId = two.ok ? two.connector.id : '';
    expect(removeConnector({ id: oneId, deleteKeys: true }, deps)).toEqual({ ok: true, deletedKeys: [], keptKeys: ['GH_MCP_TOKEN'] });
    expect(secrets.has('GH_MCP_TOKEN')).toBe(true);
    expect(removeConnector({ id: twoId, deleteKeys: true }, deps)).toEqual({ ok: true, deletedKeys: ['GH_MCP_TOKEN'], keptKeys: [] });
    expect(secrets.has('GH_MCP_TOKEN')).toBe(false);
  });

  it('a kept key stays the connection\'s: still not a bot\'s plain secret', async () => {
    const one = await saveConnector({ connector: draft(), keyValues: { GH_MCP_TOKEN: TOKEN } }, deps);
    removeConnector({ id: one.ok ? one.connector.id : '', deleteKeys: false }, deps);
    expect(store.list()).toEqual([]);
    expect(isConnectionKey('GH_MCP_TOKEN', { connectors: () => store, secretMarked: (n) => secrets.isConnectorKey(n) })).toBe(true);
  });
});

describe('a connection\'s keys are not a bot\'s', () => {
  const secretDeps = () => ({ store: () => secrets, writer: () => null, ports: () => ({}), isConnectionKey: (n: string) => isConnectionKey(n, { connectors: () => store, secretMarked: (x) => secrets.isConnectorKey(x) }) });

  it('a bot\'s secret_list leaves them out; the operator sees them', async () => {
    await saveConnector({ connector: draft(), keyValues: { GH_MCP_TOKEN: TOKEN } }, deps);
    secrets.set('NPM_TOKEN', 'npm_plain_value_123456');
    const bot = { origin: 'local', bot: { workspaceId: 'ws-1', botId: A, role: 'lead' } } as unknown as RpcContext;
    const op = { origin: 'local', operator: true } as unknown as RpcContext;
    const names = (r: unknown) => (r as { secrets: Array<{ name: string }> }).secrets.map((s) => s.name);
    expect(names(handleSecretList({}, bot, secretDeps()))).toEqual(['NPM_TOKEN']);
    expect(names(handleSecretList({}, op, secretDeps())).sort()).toEqual(['GH_MCP_TOKEN', 'NPM_TOKEN']);
  });

  it('the owner\'s key modal cannot overwrite a connection\'s key', async () => {
    await saveConnector({ connector: draft() }, deps);
    expect(ownerSetSecret({ name: 'GH_MCP_TOKEN', value: 'another_value_123456' }, secretDeps())).toMatchObject({ ok: false, code: 'connection_key' });
    expect(secrets.has('GH_MCP_TOKEN')).toBe(false);
  });
});

describe('IPC', () => {
  it('answers only the main window\'s top frame and never throws', async () => {
    const mainFrame = {};
    const webContents = { mainFrame };
    const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;
    const off = registerConnectorIpc(() => win, { ...deps, store: () => { throw new Error('boom'); } });
    const list = ipcHandlers.get(CONNECTOR_IPC.list)!;
    expect(await list({ sender: {}, senderFrame: mainFrame }, {})).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(await list({ sender: webContents, senderFrame: {} }, {})).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(await list({ sender: webContents, senderFrame: mainFrame }, {})).toMatchObject({ ok: false, code: 'error' });
    off();
    expect(ipcHandlers.size).toBe(0);
  });

  it('list: views with missing keys and why storing is refused', async () => {
    await saveConnector({ connector: draft() }, deps);
    expect(listConnectors(deps)).toMatchObject({ ok: true, connectors: [{ name: 'gh', missingKeys: ['GH_MCP_TOKEN'] }] });
  });
});

describe('bot.update', () => {
  it('refuses connection fields: bots never write the library', async () => {
    const s = new BotStore(path.join(dir, 'factory', 'bots.json'));
    s.load();
    const made = s.create({ workspaceId: 'ws-1', role: 'lead', name: 'Dev' } as never);
    expect(made.ok).toBe(true);
    const r = s.update(made.ok ? made.bot.id : '', { connectors: ['gh'] });
    expect(r).toMatchObject({ ok: false, code: 'invalid_argument' });
    await s.flush();
  });
});

describe('plain secret grants', () => {
  it('a grant naming a key that became a connection\'s is not minted, and does not resolve', async () => {
    const { mintSecretGrant, resolveSecretGrant, setSecretGrantSource, __resetSecretGrantsForTesting } = await import('../../../factory/secretGrants');
    const { setConnectorStore } = await import('../../../factory/connectorStore');
    const { setSecretStore } = await import('../../../factory/secretStore');
    const { beginBotWorkerSpawn } = await import('../../../agents/botWorkerMergeGuard');
    __resetSecretGrantsForTesting();
    setSecretStore(secrets);
    setConnectorStore(store);
    setSecretGrantSource(() => secrets);
    try {
      secrets.set('PLAIN_TOKEN', 'plain_value_1234567');
      const cwd = path.join(dir, 'wt');
      const grant = mintSecretGrant({ botId: A, taskId: 't-1', ownerWorkspaceId: 'ws-1', cwd, names: ['PLAIN_TOKEN'] });
      expect(grant).not.toBeNull();
      // The key is deleted and its name is taken by a connection meanwhile.
      secrets.delete('PLAIN_TOKEN');
      await saveConnector({ connector: draft({ secrets: [{ secret: 'PLAIN_TOKEN', as: 'header', header: 'Authorization', scheme: 'bearer' }] }), keyValues: { PLAIN_TOKEN: 'connection_value_1' } }, deps);
      const release = beginBotWorkerSpawn('ws-1', cwd, { botId: A, taskId: 't-1' });
      const r = resolveSecretGrant(grant, { strictBotWorker: true, fanoutTaskOf: 'ws-1', cwd, spawns: [{ botId: A, taskId: 't-1' }] });
      release();
      expect(r.ok).toBe(false);
      expect(mintSecretGrant({ botId: A, taskId: 't-2', ownerWorkspaceId: 'ws-1', cwd, names: ['PLAIN_TOKEN'] })).toBeNull();
    } finally {
      setSecretGrantSource(null);
      setConnectorStore(null);
      setSecretStore(null);
    }
  });
});
