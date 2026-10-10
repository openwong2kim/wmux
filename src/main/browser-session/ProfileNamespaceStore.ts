import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { isUnsafeKey } from '../account/accountStore';
import {
  LEGACY_MEMORY_KEY_RE,
  MEMORY_GENERATION_RE,
  memoryNamespaceKey,
  normalizeMemoryProfile,
} from '../../shared/browserMemoryNamespace';

// ---------------------------------------------------------------------------
// Profile namespace generations for protected panes' browser memory.
//
//   <wmuxDir>/browser-memory-namespaces.json
//     { version: 1, panes: { <paneId>: { workspaceId, profile, generation } } }
//
// A protected pane's memory key is workspace + profile + generation. The
// generation is a random id, assigned and written durably here BEFORE the key
// is ever used, whenever the pane is found in a (workspace, profile) it was
// not recorded in — i.e. after a rebind or a move. Random, so it is never
// reused: a lost file means fresh, empty namespaces, never an old one coming
// back for a different account.
//
// Fail closed: an unreadable file or a failed write answers null, and the
// caller refuses protected memory access. Nothing is ever written for an
// unprotected pane, so an install that never protects a pane never has this
// file.
// ---------------------------------------------------------------------------

const FILE = 'browser-memory-namespaces.json';
const VERSION = 1;

interface Entry {
  workspaceId: string;
  profile: string;
  generation: string;
}

interface NamespaceFile {
  version: number;
  panes: Record<string, Entry>;
}

type Loaded = { kind: 'ok'; file: NamespaceFile } | { kind: 'corrupt' };

function parse(raw: unknown): Loaded {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'corrupt' };
  const r = raw as Record<string, unknown>;
  if (r.version !== VERSION || !r.panes || typeof r.panes !== 'object' || Array.isArray(r.panes)) {
    return { kind: 'corrupt' };
  }
  const panes: Record<string, Entry> = {};
  for (const [paneId, value] of Object.entries(r.panes as Record<string, unknown>)) {
    const e = value as Record<string, unknown> | null;
    if (
      !paneId || isUnsafeKey(paneId) || !e || typeof e !== 'object'
      || typeof e.workspaceId !== 'string' || !LEGACY_MEMORY_KEY_RE.test(e.workspaceId)
      || typeof e.profile !== 'string' || !e.profile
      || typeof e.generation !== 'string' || !MEMORY_GENERATION_RE.test(e.generation)
    ) {
      // One bad entry makes the whole file uncertain: guessing which pane it
      // belonged to could hand that pane another pane's namespace.
      return { kind: 'corrupt' };
    }
    panes[paneId] = { workspaceId: e.workspaceId, profile: e.profile, generation: e.generation };
  }
  return { kind: 'ok', file: { version: VERSION, panes } };
}

export class ProfileNamespaceStore {
  private readonly filePath: string;
  private loaded: Loaded | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Panes whose retirement is not on disk yet: refused until it is. */
  private readonly retiring = new Set<string>();

  constructor(dir: string = getWmuxDir()) {
    this.filePath = path.join(dir, FILE);
  }

  private load(): Loaded {
    if (this.loaded) return this.loaded;
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      this.loaded = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
        ? { kind: 'ok', file: { version: VERSION, panes: {} } }
        : { kind: 'corrupt' };
      return this.loaded;
    }
    try {
      this.loaded = parse(JSON.parse(text) as unknown);
    } catch {
      this.loaded = { kind: 'corrupt' };
    }
    return this.loaded;
  }

  /**
   * The memory key of `paneId` bound to `profile` in `workspaceId`, assigning
   * (and durably recording) a fresh generation when the pane is not recorded
   * in exactly that place. Null = protected memory must be refused.
   */
  namespaceFor(workspaceId: string, paneId: string, profile: string): Promise<string | null> {
    const run = this.chain.then(async () => {
      if (!paneId || isUnsafeKey(paneId) || !LEGACY_MEMORY_KEY_RE.test(workspaceId)) return null;
      const wanted = normalizeMemoryProfile(profile);
      if (!wanted) return null;
      if (this.retiring.has(paneId)) return null;
      const loaded = this.load();
      if (loaded.kind !== 'ok') return null;
      const hit = loaded.file.panes[paneId];
      if (hit && hit.workspaceId === workspaceId && hit.profile === wanted) {
        return memoryNamespaceKey(workspaceId, wanted, hit.generation);
      }
      const generation = randomBytes(8).toString('hex');
      const next: NamespaceFile = {
        version: VERSION,
        panes: { ...loaded.file.panes, [paneId]: { workspaceId, profile: wanted, generation } },
      };
      try {
        await atomicWriteJSON(this.filePath, next, { durable: true });
      } catch (err) {
        console.warn('[browser-memory] namespace write failed:', err);
        return null;
      }
      this.loaded = { kind: 'ok', file: next };
      return memoryNamespaceKey(workspaceId, wanted, generation);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * The pane was rebound or moved: its generation is dropped (durably), so
   * its next protected memory access gets a fresh one — even back in the same
   * workspace with the same profile. Until the drop is on disk, the pane's
   * protected memory is refused.
   */
  retire(paneId: string): Promise<void> {
    if (!paneId || isUnsafeKey(paneId)) return Promise.resolve();
    this.retiring.add(paneId);
    const run = this.chain.then(async () => {
      const loaded = this.load();
      if (loaded.kind !== 'ok') return; // stays refused: the file cannot be trusted anyway
      if (!loaded.file.panes[paneId]) {
        this.retiring.delete(paneId);
        return;
      }
      const panes = { ...loaded.file.panes };
      delete panes[paneId];
      try {
        await atomicWriteJSON(this.filePath, { version: VERSION, panes }, { durable: true });
      } catch (err) {
        console.warn('[browser-memory] namespace retire failed:', err);
        return; // stays refused for this process
      }
      this.loaded = { kind: 'ok', file: { version: VERSION, panes } };
      this.retiring.delete(paneId);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

let shared: ProfileNamespaceStore | null = null;

export function getProfileNamespaceStore(): ProfileNamespaceStore {
  if (!shared) shared = new ProfileNamespaceStore();
  return shared;
}

/** Tests: point the shared store at `dir` (fresh namespaces). */
export function __resetProfileNamespaceStoreForTest(dir?: string): void {
  shared = dir === undefined ? null : new ProfileNamespaceStore(dir);
}
