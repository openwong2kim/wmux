import * as fs from 'fs';
import * as path from 'path';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { isUnsafeKey } from '../account/accountStore';
import { compileHostPolicy, parseHostRules, type HostMatcher, type HostPolicy } from '../../shared/browserHostPolicy';
import {
  BROWSER_POLICY_FILE,
  BROWSER_POLICY_HISTORY_FILE,
  BROWSER_POLICY_VERSION,
  resolvePanePolicy,
  type BrowserPolicyFile,
  type BrowserPolicyFileState,
  type BrowserPolicyWritePayload,
  type PanePolicy,
  type PanePolicyDecision,
} from '../../shared/browserPolicy';
import type { WorkspaceMirror } from '../workspace/WorkspaceMirror';

// ---------------------------------------------------------------------------
// Protected browser panes: the main-owned policy file.
//
//   <wmuxDir>/browser-policy.json          the policies (version, epoch, panes)
//   <wmuxDir>/browser-policy-history.json  paneId → workspaceId, every pane
//                                          that was EVER protected
//
// Fail-closed reads, unlike ChromeProfileStore.load (which fails open so a torn
// store never bricks automation). The primary file is read on its own — never
// the `.bak` fallback, never quarantined — and a read never creates it:
//
//   primary ok                → it is authoritative
//   primary missing / corrupt / unsupported version
//     pane never protected    → legacy (exactly today's behaviour)
//     pane in the history     → refused (policy_denied), never silently legacy
//   history unreadable        → treated as "every pane may have been protected"
//                               whenever the primary cannot answer
//
// The history is written durably BEFORE a policy turns protection on, so a
// crash between the two leaves the pane refused rather than unprotected.
// With neither file present nothing here does any work: `hasAnyHistory()` is
// false and every gate returns before it resolves a pane.
// ---------------------------------------------------------------------------

export class BrowserPolicyWriteError extends Error {
  constructor(
    readonly code: 'invalid' | 'stale' | 'not-exclusive' | 'io',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserPolicyWriteError';
  }
}

interface History {
  /** paneId → workspaceId it was last seen in. */
  panes: Record<string, string>;
}

function emptyFile(): BrowserPolicyFile {
  return { version: BROWSER_POLICY_VERSION, epoch: 0, panes: {} };
}

function validHosts(raw: unknown): HostPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.mode !== 'off' && r.mode !== 'allowlist') return null;
  const allow = Array.isArray(r.allow) ? r.allow : null;
  const block = Array.isArray(r.block) ? r.block : null;
  if (!allow || !block) return null;
  if ('error' in parseHostRules(allow) || 'error' in parseHostRules(block)) return null;
  return { mode: r.mode, allow: allow as string[], block: block as string[] };
}

/** Parse a whole primary file. Any malformed entry makes the FILE corrupt:
 *  dropping one entry would silently unprotect that pane. */
function parsePrimary(raw: unknown): { state: BrowserPolicyFileState; file: BrowserPolicyFile } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'corrupt', file: emptyFile() };
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'number') return { state: 'corrupt', file: emptyFile() };
  if (r.version !== BROWSER_POLICY_VERSION) return { state: 'unsupported-version', file: emptyFile() };
  if (typeof r.epoch !== 'number' || !Number.isSafeInteger(r.epoch) || r.epoch < 0) {
    return { state: 'corrupt', file: emptyFile() };
  }
  if (!r.panes || typeof r.panes !== 'object' || Array.isArray(r.panes)) {
    return { state: 'corrupt', file: emptyFile() };
  }
  const panes: Record<string, PanePolicy> = {};
  for (const [paneId, entry] of Object.entries(r.panes as Record<string, unknown>)) {
    if (!paneId || isUnsafeKey(paneId) || !entry || typeof entry !== 'object') {
      return { state: 'corrupt', file: emptyFile() };
    }
    const e = entry as Record<string, unknown>;
    const hosts = validHosts(e.hosts);
    if (
      typeof e.workspaceId !== 'string' || !e.workspaceId || isUnsafeKey(e.workspaceId)
      || e.paneId !== paneId
      || typeof e.profileId !== 'string' || !e.profileId
      || typeof e.protected !== 'boolean'
      || !hosts
      || (e.needsConfirm !== undefined && typeof e.needsConfirm !== 'boolean')
    ) {
      return { state: 'corrupt', file: emptyFile() };
    }
    panes[paneId] = {
      workspaceId: e.workspaceId,
      paneId,
      profileId: e.profileId,
      protected: e.protected,
      hosts,
      ...(e.needsConfirm === true && { needsConfirm: true }),
    };
  }
  return { state: 'ok', file: { version: BROWSER_POLICY_VERSION, epoch: r.epoch, panes } };
}

function readJson(filePath: string): { kind: 'missing' } | { kind: 'ok'; raw: unknown } | { kind: 'corrupt' } {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'corrupt' };
  }
  try {
    return { kind: 'ok', raw: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'corrupt' };
  }
}

/** Where a pane is now, for the store's resolution (injected from main). */
export interface PaneBindingLookup {
  /** paneId → { workspaceId, profile } for every pane-bound profile. */
  paneBindings(): Record<string, { workspaceId: string; profile: string }>;
}

export class BrowserPolicyStore {
  private readonly primaryPath: string;
  private readonly historyPath: string;
  private state: BrowserPolicyFileState = 'missing';
  private file: BrowserPolicyFile = emptyFile();
  private history: History = { panes: {} };
  private historyCorrupt = false;
  private loaded = false;
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(dir: string = getWmuxDir()) {
    this.primaryPath = path.join(dir, BROWSER_POLICY_FILE);
    this.historyPath = path.join(dir, BROWSER_POLICY_HISTORY_FILE);
  }

  /** (Re)read both files. Never creates either. */
  load(): void {
    const primary = readJson(this.primaryPath);
    if (primary.kind === 'missing') {
      this.state = 'missing';
      this.file = emptyFile();
    } else if (primary.kind === 'corrupt') {
      this.state = 'corrupt';
      this.file = emptyFile();
    } else {
      const parsed = parsePrimary(primary.raw);
      this.state = parsed.state;
      this.file = parsed.file;
    }
    const hist = readJson(this.historyPath);
    this.historyCorrupt = false;
    this.history = { panes: {} };
    if (hist.kind === 'corrupt') {
      this.historyCorrupt = true;
    } else if (hist.kind === 'ok') {
      const h = hist.raw as { panes?: unknown } | null;
      if (!h || typeof h !== 'object' || !h.panes || typeof h.panes !== 'object' || Array.isArray(h.panes)) {
        this.historyCorrupt = true;
      } else {
        for (const [paneId, ws] of Object.entries(h.panes as Record<string, unknown>)) {
          if (!paneId || isUnsafeKey(paneId) || typeof ws !== 'string' || isUnsafeKey(ws)) {
            this.historyCorrupt = true;
            this.history = { panes: {} };
            break;
          }
          this.history.panes[paneId] = ws;
        }
      }
    }
    this.loaded = true;
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.warn('[browser-policy] change listener failed:', err);
      }
    }
  }

  // ── Sync reads (gate hot path) ───────────────────────────────────────────

  fileState(): BrowserPolicyFileState {
    this.ensureLoaded();
    return this.state;
  }

  epoch(): number {
    this.ensureLoaded();
    return this.file.epoch;
  }

  /**
   * Whether ANY pane could be protected. False ⇒ every gate is a no-op, which
   * is what keeps an unconfigured install byte-identical to before.
   */
  hasAnyHistory(): boolean {
    this.ensureLoaded();
    if (this.historyCorrupt) return true;
    if (Object.keys(this.history.panes).length > 0) return true;
    return this.state === 'ok' && Object.values(this.file.panes).some((p) => p.protected);
  }

  /** Whether a pane of `workspaceId` was ever protected (or that is unknowable). */
  workspaceHasHistory(workspaceId: string | undefined): boolean {
    this.ensureLoaded();
    if (!workspaceId) return false;
    if (this.historyCorrupt) return true;
    if (Object.values(this.history.panes).includes(workspaceId)) return true;
    return (
      this.state === 'ok'
      && Object.values(this.file.panes).some((p) => p.protected && p.workspaceId === workspaceId)
    );
  }

  /** The stored entry, for the editor. */
  entryFor(paneId: string): PanePolicy | null {
    this.ensureLoaded();
    const e = this.state === 'ok' ? this.file.panes[paneId] : undefined;
    return e ? { ...e, hosts: { ...e.hosts, allow: [...e.hosts.allow], block: [...e.hosts.block] } } : null;
  }

  /**
   * What `paneId`'s policy means, now that it lives in `workspaceId` and
   * resolves to `currentProfile`.
   */
  decisionFor(paneId: string, workspaceId: string, currentProfile: string | undefined): PanePolicyDecision {
    this.ensureLoaded();
    if (!paneId || isUnsafeKey(paneId)) return { kind: 'denied', why: 'the calling pane could not be identified' };
    const everProtected = this.historyCorrupt || Object.prototype.hasOwnProperty.call(this.history.panes, paneId);
    if (this.state !== 'ok') {
      return everProtected
        ? { kind: 'denied', why: `the browser policy file is ${this.state === 'missing' ? 'missing' : 'unreadable'}` }
        : { kind: 'legacy' };
    }
    const entry = this.file.panes[paneId];
    if (!entry) {
      // Entries leave the file only together with their history (pane closed).
      // A pane in the history with no entry means the file lost it.
      return !this.historyCorrupt && everProtected
        ? { kind: 'denied', why: "this pane's browser policy is missing" }
        : { kind: 'legacy' };
    }
    return resolvePanePolicy(entry, { workspaceId, currentProfile }, this.file.epoch);
  }

  /**
   * The protection a PROFILE runs under (the proxy and the Chrome launch).
   * A profile is protected when the pane bound to it is; a pane that is
   * refused outright still gets a proxy — a deny-all one.
   */
  profileDecision(
    profile: string,
    lookup: PaneBindingLookup,
  ): { kind: 'legacy' } | { kind: 'protected'; hosts: HostPolicy; confirmed: boolean } {
    if (!this.hasAnyHistory()) return { kind: 'legacy' };
    const wanted = profile.toLowerCase();
    for (const [paneId, b] of Object.entries(lookup.paneBindings())) {
      if (b.profile.toLowerCase() !== wanted) continue;
      const d = this.decisionFor(paneId, b.workspaceId, b.profile);
      if (d.kind === 'legacy') return d;
      if (d.kind === 'denied') return { kind: 'protected', hosts: { mode: 'allowlist', allow: [], block: [] }, confirmed: false };
      return { kind: 'protected', hosts: d.hosts, confirmed: d.confirmed };
    }
    return { kind: 'legacy' };
  }

  private readonly matcherCache = new Map<string, { key: string; matcher: HostMatcher }>();

  /**
   * The enforcement plan for a profile's Chrome, or null when it runs legacy.
   * The matcher re-reads the policy on every call (the proxy asks per
   * request), compiling only when the hosts actually changed.
   */
  protectionPlanFor(profile: string, lookup: PaneBindingLookup): { matcher: () => HostMatcher } | null {
    if (this.profileDecision(profile, lookup).kind === 'legacy') return null;
    return { matcher: () => this.currentMatcher(profile, lookup) };
  }

  private currentMatcher(profile: string, lookup: PaneBindingLookup): HostMatcher {
    const d = this.profileDecision(profile, lookup);
    if (d.kind !== 'protected') return compileHostPolicy(null); // no longer protected: deny until restarted
    const key = JSON.stringify(d.hosts);
    const hit = this.matcherCache.get(profile);
    if (hit && hit.key === key) return hit.matcher;
    const matcher = compileHostPolicy(d.hosts);
    this.matcherCache.set(profile, { key, matcher });
    return matcher;
  }

  // ── Mutations (serialized) ───────────────────────────────────────────────

  private mutate<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.writeChain.then(async () => {
      this.load(); // detached reload: decide on what is on disk now
      return fn();
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async commitHistory(next: History): Promise<void> {
    await atomicWriteJSON(this.historyPath, next, { durable: true });
    this.history = next;
    this.historyCorrupt = false;
  }

  private async commitPrimary(next: BrowserPolicyFile): Promise<void> {
    await atomicWriteJSON(this.primaryPath, next, { durable: true });
    this.file = next;
    this.state = 'ok';
  }

  /** The epoch a write must name, whatever the file's state. */
  private baseEpoch(): number {
    return this.state === 'ok' ? this.file.epoch : 0;
  }

  /**
   * The operator's write (IPC only — agents have no path here). `isExclusive`
   * is the caller's check that `profileId` is the pane's own pane-bound
   * profile right now.
   */
  async write(payload: BrowserPolicyWritePayload, currentProfile: string | undefined, isExclusive: boolean): Promise<number> {
    const { workspaceId, paneId, profileId } = payload;
    if (!workspaceId || isUnsafeKey(workspaceId) || !paneId || isUnsafeKey(paneId) || !profileId) {
      throw new BrowserPolicyWriteError('invalid', 'invalid workspaceId, paneId or profileId');
    }
    if (typeof payload.protected !== 'boolean') throw new BrowserPolicyWriteError('invalid', 'protected must be a boolean');
    const hosts = validHosts(payload.hosts);
    if (!hosts) throw new BrowserPolicyWriteError('invalid', 'invalid host rules');
    if (!Number.isSafeInteger(payload.expectedEpoch)) {
      throw new BrowserPolicyWriteError('invalid', 'expectedEpoch is required');
    }
    if (currentProfile === undefined || profileId !== currentProfile) {
      throw new BrowserPolicyWriteError('stale', "the pane's Chrome profile changed; re-read and confirm again");
    }
    if (payload.protected && !isExclusive) {
      throw new BrowserPolicyWriteError(
        'not-exclusive',
        'protection needs a Chrome profile bound to this pane alone; bind one in the pane menu first',
      );
    }
    return this.mutate(async () => {
      if (payload.expectedEpoch !== this.baseEpoch()) {
        throw new BrowserPolicyWriteError('stale', 'the browser policy changed since it was read; re-read and try again');
      }
      // A corrupt / unsupported file is replaced, not merged: its entries are
      // unknowable. Every pane it may have held stays refused through the
      // history until the operator writes that pane again.
      const base = this.state === 'ok' ? this.file : emptyFile();
      if (payload.protected && this.history.panes[paneId] !== workspaceId) {
        await this.commitHistory({ panes: { ...this.history.panes, [paneId]: workspaceId } });
      }
      const next: BrowserPolicyFile = {
        version: BROWSER_POLICY_VERSION,
        epoch: Math.max(base.epoch, payload.expectedEpoch) + 1,
        panes: {
          ...base.panes,
          [paneId]: { workspaceId, paneId, profileId, protected: payload.protected, hosts },
        },
      };
      await this.commitPrimary(next);
      this.emit();
      return next.epoch;
    });
  }

  /** Bump the epoch for a profile-binding or backend change. A no-op on an
   *  install that never protected anything (no file is created). */
  async bumpEpoch(): Promise<void> {
    if (!this.hasAnyHistory() || this.fileState() !== 'ok') return;
    await this.mutate(async () => {
      if (this.state !== 'ok') return;
      await this.commitPrimary({ ...this.file, epoch: this.file.epoch + 1 });
      this.emit();
    });
  }

  /**
   * The pane was bound to another profile (or unbound). Protection stays on;
   * every host is refused until the operator confirms again.
   */
  async onPaneRebind(paneId: string): Promise<void> {
    if (!this.hasAnyHistory()) return;
    await this.mutate(async () => {
      if (this.state !== 'ok') return;
      const entry = this.file.panes[paneId];
      const panes = { ...this.file.panes };
      if (entry?.protected) panes[paneId] = { ...entry, needsConfirm: true };
      await this.commitPrimary({ ...this.file, panes, epoch: this.file.epoch + 1 });
      this.emit();
    });
  }

  /**
   * Bring the policies in line with the layout (same trigger and same rule as
   * ChromeProfileStore.reconcilePanes: only a restored, complete pane list).
   * A closed pane's policy and history go; a moved pane keeps protection and
   * its history moves with it, but it is deny-all until re-confirmed.
   * Workspace duplication mints new pane ids, so it never copies a policy.
   */
  async reconcilePanes(
    knownPaneIds: ReadonlySet<string>,
    paneWorkspaces: ReadonlyMap<string, string>,
  ): Promise<{ pruned: number; moved: number }> {
    if (!this.hasAnyHistory()) return { pruned: 0, moved: 0 };
    const plan = () => {
      const gone = new Set<string>();
      const moved = new Map<string, string>();
      const ids = new Set([...Object.keys(this.history.panes), ...Object.keys(this.state === 'ok' ? this.file.panes : {})]);
      for (const paneId of ids) {
        if (!knownPaneIds.has(paneId)) {
          gone.add(paneId);
          continue;
        }
        const now = paneWorkspaces.get(paneId);
        const was = this.history.panes[paneId] ?? (this.state === 'ok' ? this.file.panes[paneId]?.workspaceId : undefined);
        if (now && was && now !== was && !isUnsafeKey(now)) moved.set(paneId, now);
      }
      return { gone, moved };
    };
    const preview = plan();
    if (preview.gone.size === 0 && preview.moved.size === 0) return { pruned: 0, moved: 0 };
    return this.mutate(async () => {
      const { gone, moved } = plan();
      if (gone.size === 0 && moved.size === 0) return { pruned: 0, moved: 0 };
      if (!this.historyCorrupt) {
        const panes: Record<string, string> = {};
        for (const [paneId, ws] of Object.entries(this.history.panes)) {
          if (gone.has(paneId)) continue;
          panes[paneId] = moved.get(paneId) ?? ws;
        }
        // History first: a moved pane must never be found protected nowhere.
        await this.commitHistory({ panes });
      }
      if (this.state === 'ok') {
        const panes: Record<string, PanePolicy> = {};
        for (const [paneId, entry] of Object.entries(this.file.panes)) {
          if (gone.has(paneId)) continue;
          panes[paneId] = moved.has(paneId) && entry.protected ? { ...entry, needsConfirm: true } : entry;
        }
        await this.commitPrimary({ ...this.file, panes, epoch: this.file.epoch + 1 });
      }
      this.emit();
      return { pruned: gone.size, moved: moved.size };
    });
  }
}

/** ChromeProfileStore.reconcilePaneBindingsFromMirror's twin, same guards. */
export function reconcileBrowserPoliciesFromMirror(
  store: Pick<BrowserPolicyStore, 'reconcilePanes'>,
  mirror: Pick<WorkspaceMirror, 'isSessionRestored' | 'getKnownPaneIds' | 'getPaneWorkspaces'>,
): Promise<{ pruned: number; moved: number }> {
  const none = Promise.resolve({ pruned: 0, moved: 0 });
  if (!mirror.isSessionRestored()) return none;
  const known = mirror.getKnownPaneIds();
  if (known === null || known.size === 0) return none;
  return store.reconcilePanes(known, mirror.getPaneWorkspaces() ?? new Map());
}
