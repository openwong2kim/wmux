// ─── Bot connections — the owner's library (main-window IPC only) ──────────
//
// The `connectors` factory module: it loads the library
// (main/factory/connectorStore.ts) and answers CONNECTOR_IPC from the main
// window's top frame only. Bots have no call here: they cannot add, change or
// read connections other than their own set in the wake prompt.
//
// A save is checked field by field (shared/botConnector.ts), against the
// library (unique name, bots that exist) and against the key store: a stdio
// command is resolved to an absolute path, a literal that holds a stored key
// value (or a value typed in the same save) is refused, and a key name that
// bots already use as a plain secret is refused (a connection's keys reach a
// worker only through the connection). The connection is stored first, then
// the values typed for its keys, marked as the connection's.

import path from 'node:path';
import { ipcMain, type BrowserWindow } from 'electron';
import { BOT_EVENT } from '../../../shared/bot';
import {
  CONNECTOR_ID_RE,
  CONNECTOR_IPC,
  commandRefusal,
  connectorTexts,
  otherConnectorsUsing,
  parseConnectorShape,
  type Connector,
  type ConnectorListResult,
  type ConnectorRemoveResult,
  type ConnectorSaveResult,
  type ConnectorSimpleResult,
  type ConnectorView,
} from '../../../shared/botConnector';
import { BOT_SECRET_LIMITS } from '../../../shared/botSecret';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryModuleHandle } from '../../factory/factoryHost';
import { ConnectorStore, connectorsFilePath, getConnectorStore, holdsStoredKeyValue, setConnectorStore } from '../../factory/connectorStore';
import { resolveConnectorCommand, type ResolveCommandDeps } from '../../factory/connectorCommand';
import { getSecretStore, type SecretStore } from '../../factory/secretStore';
import { secretForms } from '../../factory/secretRedaction';
import { getBotStore } from '../../factory/botStore';
import { isMainWindowSender } from '../../ipc/mainWindowSender';
import { pruneWorkerLaunchFiles } from '../../agents/botWorkerMergeGuard';

export interface ConnectorIpcDeps {
  store: () => ConnectorStore | null;
  secrets: () => SecretStore | null;
  resolveCommand?: (command: string) => Promise<string | null>;
  /** Does `text` hold a stored key value (default: the redaction matcher)? */
  holdsStoredValue?: (text: string) => boolean;
  platform?: NodeJS.Platform;
}

function params(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const NOT_STARTED = { ok: false as const, code: 'not_started', message: 'Connections are not running yet.' };

function viewOf(c: Connector, secrets: SecretStore | null): ConnectorView {
  return { ...c, missingKeys: c.secrets.map((s) => s.secret).filter((n) => !secrets?.has(n)) };
}

export function listConnectors(deps: ConnectorIpcDeps): ConnectorListResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const secrets = deps.secrets();
  const refusal = secrets?.storeRefusal() ?? null;
  return {
    ok: true,
    connectors: store.list().map((c) => viewOf(c, secrets)),
    ...(refusal ? { cannotStore: { code: refusal.code, message: refusal.message } } : {}),
  };
}

export async function saveConnector(raw: unknown, deps: ConnectorIpcDeps): Promise<ConnectorSaveResult> {
  const p = params(raw);
  const shape = parseConnectorShape(p.connector, deps.platform);
  if (!shape.ok) return { ok: false, code: 'invalid', field: shape.field, message: shape.message };
  // The one await of a save comes first: every check after it reads the
  // library and the key store as they are when the save commits.
  let stdio = shape.connector.stdio;
  if (stdio) {
    const resolved = await (deps.resolveCommand ?? ((cmd: string) => resolveConnectorCommand(cmd, { platform: deps.platform } as ResolveCommandDeps)))(stdio.command);
    if (!resolved) return { ok: false, code: 'invalid', field: 'command', message: `${stdio.command} was not found (looked up on your PATH). Use its absolute path.` };
    const why = commandRefusal(resolved, deps.platform);
    if (why) return { ok: false, code: 'invalid', field: 'command', message: `${stdio.command} is ${resolved}, which cannot be used: ${why}` };
    stdio = { ...stdio, command: resolved };
  }
  const c = { ...shape.connector, ...(stdio ? { stdio } : {}) };

  const store = deps.store();
  if (!store) return NOT_STARTED;
  const writeRefusal = store.writeRefusal();
  if (writeRefusal) return { ok: false, code: 'store_unreadable', message: writeRefusal };
  const secrets = deps.secrets();
  const prior = c.id ? store.get(c.id) : null;
  if (c.id && !prior) return { ok: false, code: 'not_found', message: 'That connection no longer exists.' };

  // Values typed in the dialog: only for this connection's own key names.
  const keyValues: Record<string, string> = {};
  const names = new Set(c.secrets.map((s) => s.secret));
  for (const [k, v] of Object.entries(params(p.keyValues))) {
    if (!names.has(k)) return { ok: false, code: 'invalid', field: 'secrets', message: `${k} is not one of this connection's keys.` };
    if (typeof v !== 'string' || v.length < BOT_SECRET_LIMITS.VALUE_MIN || v.length > BOT_SECRET_LIMITS.VALUE_MAX || v.includes('\0')) {
      return { ok: false, code: 'invalid', field: 'secrets', message: `${k}: the value must be ${BOT_SECRET_LIMITS.VALUE_MIN} to ${BOT_SECRET_LIMITS.VALUE_MAX} characters.` };
    }
    keyValues[k] = v;
  }
  if (Object.keys(keyValues).length > 0) {
    if (!secrets) return { ok: false, code: 'not_started', message: 'The key store is not running yet.' };
    const refusal = secrets.storeRefusal();
    if (refusal) return { ok: false, code: refusal.code, field: 'secrets', message: refusal.message };
  }

  // A key name bots already use as a plain secret stays theirs.
  const lib = store.list();
  const ownNames = new Set(prior?.secrets.map((s) => s.secret) ?? []);
  for (const n of names) {
    if (ownNames.has(n) || !secrets?.list().some((e) => e.name === n)) continue;
    if (secrets.isConnectorKey(n) || otherConnectorsUsing(lib, n, c.id ?? '').length > 0) continue;
    return { ok: false, code: 'key_in_use', field: 'secrets', message: `${n} is a key bots use for their own workers. Give this connection its own key name.` };
  }

  // No text the owner wrote may hold a key value (stored, or typed now).
  const typed = Object.values(keyValues).flatMap((v) => secretForms(v));
  const holds = deps.holdsStoredValue ?? holdsStoredKeyValue;
  for (const text of connectorTexts(c)) {
    if (holds(text) || typed.some((f) => text.includes(f))) {
      return { ok: false, code: 'invalid', field: 'connection', message: 'A field holds a key\'s value. Add it under Keys instead, so it is stored encrypted.' };
    }
  }

  const saved = store.save(c);
  if (!saved.ok) return { ok: false, code: saved.field === 'store' ? 'store_unreadable' : 'invalid', field: saved.field, message: saved.message };

  for (const [name, value] of Object.entries(keyValues)) {
    const r = secrets!.set(name, value, { label: `${saved.connector.name} connection`, connectorId: saved.connector.id });
    if (!r.ok) {
      return { ok: false, code: r.code, field: 'secrets', message: `The connection was saved, but ${name} was not: ${r.message}` };
    }
  }
  return { ok: true, connector: viewOf(saved.connector, secrets) };
}

export function removeConnector(raw: unknown, deps: ConnectorIpcDeps): ConnectorRemoveResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  if (typeof p.id !== 'string' || !CONNECTOR_ID_RE.test(p.id)) return { ok: false, code: 'invalid', message: 'No connection is named.' };
  const removed = store.remove(p.id);
  if (!removed) return { ok: false, code: 'not_found', message: store.writeRefusal() ?? 'That connection no longer exists.' };
  const deletedKeys: string[] = [];
  const keptKeys: string[] = [];
  const secrets = deps.secrets();
  const rest = store.list();
  for (const s of removed.secrets) {
    // A key another connection still uses is kept until none does.
    if (p.deleteKeys !== true || otherConnectorsUsing(rest, s.secret, removed.id).length > 0) {
      keptKeys.push(s.secret);
      continue;
    }
    if (secrets?.delete(s.secret)) deletedKeys.push(s.secret);
  }
  return { ok: true, deletedKeys, keptKeys };
}

export function setConnectorOffForBot(raw: unknown, deps: ConnectorIpcDeps): ConnectorSimpleResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  if (typeof p.id !== 'string' || typeof p.botId !== 'string' || typeof p.off !== 'boolean') return { ok: false, code: 'invalid', message: 'The request is malformed.' };
  const r = store.setOffForBot(p.id, p.botId, p.off);
  return r.ok ? { ok: true, connector: viewOf(r.connector, deps.secrets()) } : { ok: false, code: 'invalid', message: r.message };
}

export function setConnectorEnabled(raw: unknown, deps: ConnectorIpcDeps): ConnectorSimpleResult {
  const store = deps.store();
  if (!store) return NOT_STARTED;
  const p = params(raw);
  if (typeof p.id !== 'string' || typeof p.enabled !== 'boolean') return { ok: false, code: 'invalid', message: 'The request is malformed.' };
  const r = store.setEnabled(p.id, p.enabled);
  return r.ok ? { ok: true, connector: viewOf(r.connector, deps.secrets()) } : { ok: false, code: 'invalid', message: r.message };
}

/** The main-window IPC handlers. Each answers only the main window's top
 *  frame and never throws. */
export function registerConnectorIpc(getWindow: () => BrowserWindow | null, deps: ConnectorIpcDeps): () => void {
  const channels = Object.values(CONNECTOR_IPC);
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
  ipcMain.handle(CONNECTOR_IPC.list, guard(() => listConnectors(deps)));
  ipcMain.handle(CONNECTOR_IPC.save, guard((req) => saveConnector(req, deps)));
  ipcMain.handle(CONNECTOR_IPC.remove, guard((req) => removeConnector(req, deps)));
  ipcMain.handle(CONNECTOR_IPC.setOffForBot, guard((req) => setConnectorOffForBot(req, deps)));
  ipcMain.handle(CONNECTOR_IPC.setEnabled, guard((req) => setConnectorEnabled(req, deps)));
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}

function existingBotIds(): ReadonlySet<string> | null {
  const bots = getBotStore();
  return bots ? new Set(bots.list().map((b) => b.id)) : null;
}

export function createConnectorModule(deps: Pick<FactoryHostDeps, 'wmuxDir' | 'getMainWindow'>): FactoryModuleHandle {
  let offIpc: (() => void) | null = null;
  return {
    start() {
      if (getConnectorStore()) return;
      const store = new ConnectorStore(connectorsFilePath(deps.wmuxDir()), {
        botIds: existingBotIds,
        onChange: () => {
          const win = deps.getMainWindow();
          if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, { type: 'connectors-changed' });
        },
      });
      store.load();
      setConnectorStore(store);
      try {
        pruneWorkerLaunchFiles(deps.wmuxDir());
      } catch { /* best effort */ }
      offIpc = registerConnectorIpc(deps.getMainWindow, { store: getConnectorStore, secrets: getSecretStore });
      console.log(`[factory] connectors: ${store.list().length} loaded from ${path.basename(connectorsFilePath(deps.wmuxDir()))}`);
    },
    dispose() {
      offIpc?.();
      offIpc = null;
      setConnectorStore(null);
    },
  };
}

registerFactoryRpcModule('connectors', (_router, deps) => createConnectorModule(deps));
