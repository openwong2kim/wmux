// ─── The connection library — `<wmuxDir>/factory/connectors.json` ───────────
//
// `{version:1, connectors: Connector[]}` (shared/botConnector.ts), 0600,
// written whole. Only the owner's main-window IPC changes it
// (pipe/handlers/connector.rpc.ts); bots read their own set in the wake
// prompt. Every record is checked again on read and a malformed one is
// dropped. A file that exists but cannot be read, or carries another
// version, loads as no connections (fewer tools, never more) and is not
// written over until the owner fixes or removes it.

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  CONNECTOR_ID_RE,
  connectorSecretNames,
  connectorTexts,
  connectorsForBot,
  libraryRefusal,
  parseConnectorShape,
  type Connector,
  type ConnectorRefusal,
} from '../../shared/botConnector';
import { getSecretStore } from './secretStore';
import { redactStoredSecrets } from './secretRedaction';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';

export const CONNECTORS_FILE_VERSION = 1 as const;

export function connectorsFilePath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', 'connectors.json');
}

export interface ConnectorStoreOptions {
  now?: () => number;
  newId?: () => string;
  log?: (msg: string) => void;
  /** The bots that exist now (a scope or off-switch naming another is pruned). */
  botIds?: () => ReadonlySet<string> | null;
  /** Told after every change. */
  onChange?: () => void;
}

export type ConnectorStoreResult = { ok: true; connector: Connector } | ConnectorRefusal | { ok: false; field: 'store'; message: string };

/** Does `text` hold a stored key value (the redaction matcher)? */
export function holdsStoredKeyValue(text: string): boolean {
  return redactStoredSecrets(text) !== text;
}

/** One record read from disk, or null when it is malformed or a text in it
 *  holds a stored key value. */
export function parseStoredConnector(raw: unknown, holds: (text: string) => boolean = holdsStoredKeyValue): Connector | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !CONNECTOR_ID_RE.test(r.id)) return null;
  if (typeof r.createdAt !== 'number' || typeof r.updatedAt !== 'number') return null;
  // A command was resolved to an absolute path when it was saved; a bare one
  // on disk was not written by main.
  const shape = parseConnectorShape(raw);
  if (!shape.ok) return null;
  const c = shape.connector;
  if (c.stdio && !path.isAbsolute(c.stdio.command)) return null;
  if (connectorTexts(c).some(holds)) return null;
  return { ...c, id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt };
}

export class ConnectorStore {
  private connectors: Connector[] = [];
  private unreadable: string | null = null;
  private readonly persister: FilePersister;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (msg: string) => void;

  constructor(private readonly file: string, private readonly opts: ConnectorStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `con-${randomBytes(4).toString('hex')}`);
    this.log = opts.log ?? ((m) => console.warn(`[factory] connectors: ${m}`));
    this.persister = createFilePersister(file, () => ({ version: CONNECTORS_FILE_VERSION, connectors: this.connectors }));
  }

  load(): void {
    this.connectors = [];
    this.unreadable = null;
    let raw: Record<string, unknown> | null;
    try {
      raw = readVersionedFile(this.file, CONNECTORS_FILE_VERSION);
    } catch (err) {
      this.unreadable = String(err);
      this.log(`${path.basename(this.file)} is unreadable or of another version; no connections are loaded and none are saved until it is fixed`);
      return;
    }
    if (!raw) return;
    const names = new Set<string>();
    for (const entry of Array.isArray(raw.connectors) ? raw.connectors : []) {
      const c = parseStoredConnector(entry);
      if (!c || names.has(c.name) || this.connectors.some((o) => o.id === c.id)) {
        this.log('dropped a malformed or duplicate connection');
        continue;
      }
      names.add(c.name);
      this.connectors.push(c);
    }
  }

  /** Why nothing can be saved now, or null. */
  writeRefusal(): string | null {
    return this.unreadable ? 'The connections file cannot be read, so nothing is saved over it. Fix or remove factory/connectors.json.' : null;
  }

  /** Every connection, in library order, with scopes naming only bots that exist. */
  list(): Connector[] {
    return this.pruned().map(cloneConnector);
  }

  get(id: string): Connector | null {
    const c = this.pruned().find((x) => x.id === id);
    return c ? cloneConnector(c) : null;
  }

  /** What one bot gets (connectorsForBot). */
  forBot(botId: string): Connector[] {
    return connectorsForBot(this.pruned(), botId).map(cloneConnector);
  }

  /** Every key name a connection uses. */
  secretNames(): Set<string> {
    return connectorSecretNames(this.connectors);
  }

  /** Create or replace one connection (already checked field by field and
   *  with its command resolved). A save that moves an every-bot connection
   *  to picked bots clears its off-switches. */
  save(c: Omit<Connector, 'id' | 'createdAt' | 'updatedAt' | 'offFor'> & { id?: string; offFor?: string[] }): ConnectorStoreResult {
    const why = this.writeRefusal();
    if (why) return { ok: false, field: 'store', message: why };
    const botIds = this.opts.botIds?.() ?? null;
    const lib = this.pruned();
    const prior = c.id ? lib.find((x) => x.id === c.id) : undefined;
    if (c.id && !prior) return { ok: false, field: 'connection', message: 'That connection no longer exists.' };
    const refusal = libraryRefusal(c, { library: lib, botIds: botIds ?? new Set(c.scope.kind === 'bots' ? c.scope.botIds : []) });
    if (refusal) return refusal;
    const at = this.now();
    const offFor = c.scope.kind === 'all' ? (prior && prior.scope.kind === 'all' ? prior.offFor : []) : [];
    const next: Connector = {
      ...c,
      id: prior?.id ?? this.mintId(),
      offFor: [...offFor],
      createdAt: prior?.createdAt ?? at,
      updatedAt: at,
    };
    this.connectors = prior ? lib.map((x) => (x.id === next.id ? next : x)) : [...lib, next];
    this.changed();
    return { ok: true, connector: cloneConnector(next) };
  }

  /** Delete one. The removed record, or null. */
  remove(id: string): Connector | null {
    if (this.writeRefusal()) return null;
    const c = this.connectors.find((x) => x.id === id);
    if (!c) return null;
    this.connectors = this.connectors.filter((x) => x.id !== id);
    this.changed();
    return cloneConnector(c);
  }

  /** Switch an every-bot connection off (or back on) for one bot. */
  setOffForBot(id: string, botId: string, off: boolean): ConnectorStoreResult {
    const why = this.writeRefusal();
    if (why) return { ok: false, field: 'store', message: why };
    const c = this.pruned().find((x) => x.id === id);
    if (!c) return { ok: false, field: 'connection', message: 'That connection no longer exists.' };
    if (c.scope.kind !== 'all') return { ok: false, field: 'scope', message: 'Only a connection for every bot is switched off per bot; take the bot out of its picked bots instead.' };
    const botIds = this.opts.botIds?.() ?? null;
    if (off && botIds && !botIds.has(botId)) return { ok: false, field: 'scope', message: 'That bot no longer exists.' };
    const has = c.offFor.includes(botId);
    if (has === off) return { ok: true, connector: cloneConnector(c) };
    const next = { ...c, offFor: off ? [...c.offFor, botId] : c.offFor.filter((b) => b !== botId), updatedAt: this.now() };
    this.connectors = this.connectors.map((x) => (x.id === id ? next : x));
    this.changed();
    return { ok: true, connector: cloneConnector(next) };
  }

  /** Library-wide on/off. */
  setEnabled(id: string, enabled: boolean): ConnectorStoreResult {
    const why = this.writeRefusal();
    if (why) return { ok: false, field: 'store', message: why };
    const c = this.connectors.find((x) => x.id === id);
    if (!c) return { ok: false, field: 'connection', message: 'That connection no longer exists.' };
    if (c.enabled === enabled) return { ok: true, connector: cloneConnector(c) };
    const next = { ...c, enabled, updatedAt: this.now() };
    this.connectors = this.connectors.map((x) => (x.id === id ? next : x));
    this.changed();
    return { ok: true, connector: cloneConnector(next) };
  }

  /** Resolves once the current state is on disk. */
  flush(): Promise<void> {
    return this.persister.schedule();
  }

  /** The library with bots that no longer exist left out of scopes and
   *  off-switches (kept in memory; written with the next change). */
  private pruned(): Connector[] {
    const botIds = this.opts.botIds?.() ?? null;
    if (!botIds) return this.connectors;
    let changed = false;
    const out = this.connectors.map((c) => {
      const offFor = c.offFor.filter((b) => botIds.has(b));
      const scope = c.scope.kind === 'bots' ? { kind: 'bots' as const, botIds: c.scope.botIds.filter((b) => botIds.has(b)) } : c.scope;
      if (offFor.length === c.offFor.length && (c.scope.kind !== 'bots' || scope.kind !== 'bots' || scope.botIds.length === c.scope.botIds.length)) return c;
      changed = true;
      return { ...c, offFor, scope };
    });
    if (changed) this.connectors = out;
    return this.connectors;
  }

  private mintId(): string {
    for (;;) {
      const id = this.newId();
      if (!this.connectors.some((c) => c.id === id)) return id;
    }
  }

  private changed(): void {
    void this.persister.schedule().catch((err) => this.log(`${path.basename(this.file)} not written: ${String(err)}`));
    try {
      this.opts.onChange?.();
    } catch { /* a listener never fails a store write */ }
  }
}

function cloneConnector(c: Connector): Connector {
  return JSON.parse(JSON.stringify(c)) as Connector;
}

let current: ConnectorStore | null = null;

/** The running app's library (set by the connectors module), or null. */
export function getConnectorStore(): ConnectorStore | null {
  return current;
}

export function setConnectorStore(next: ConnectorStore | null): void {
  current = next;
}

/** A key name a connection owns: one a connection in the library uses, or
 *  one entered for a connection. Such a key reaches a worker only through
 *  its connection, never as a plain `secretNames` entry. */
/** The given connections as the library holds them now for `botId`: each
 *  one still on, still in its scope and not switched off for it (its current
 *  version); the rest are left out. No library → none. */
export function connectorsStillForBot(botId: string, connectors: readonly Pick<Connector, 'name'>[], store: () => ConnectorStore | null = getConnectorStore): Connector[] {
  const names = connectors.map((c) => c.name);
  if (names.length === 0) return [];
  return (store()?.forBot(botId) ?? []).filter((c) => names.includes(c.name));
}

export function isConnectionKey(name: string, deps: { connectors?: () => ConnectorStore | null; secretMarked?: (name: string) => boolean } = {}): boolean {
  if ((deps.connectors ?? getConnectorStore)()?.secretNames().has(name)) return true;
  return (deps.secretMarked ?? ((n: string) => getSecretStore()?.isConnectorKey(n) ?? false))(name);
}
