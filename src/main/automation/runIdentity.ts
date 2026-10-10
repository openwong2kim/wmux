import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { isUnsafeKey } from '../account/accountStore';
import { getWmuxDir } from '../../daemon/config';
import {
  AUTOMATION_FINAL_RUN_STATES,
  AUTOMATION_RPC,
  type AutomationIdentityRunsResult,
  type AutomationNoteRunBrowserParams,
  type AutomationPermissionMode,
  type AutomationRun,
  type AutomationRunIdentityResult,
} from '../../shared/automation';
import type { AutomationRpcTransport } from './AutomationClient';
import type { PanePolicy } from '../../shared/browserPolicy';
import type { ChromePaneBindings } from '../../shared/chromePaneBinding';

// ---------------------------------------------------------------------------
// Scheduled runs that act as a protected pane's browser — main's half.
//
// The daemon pipe's first-party marking is claimed by the client, so nothing
// the daemon holds is trusted on its own. When the operator confirms an
// identity, main records the snapshot in ITS OWN store, keyed by automation id
// and the revision the grant lands at; the daemon keeps only a reference. A
// browser call from a run is attested only when
//   - main's own process walk placed the caller under that run's shell,
//   - the daemon answers that the run is live in its current incarnation, and
//   - main's store holds a snapshot for exactly that automation and revision.
// Nothing here is cached across calls: a run that ended, or a daemon that
// restarted, answers nothing on the very next call.
// ---------------------------------------------------------------------------

const STORE_FILE = 'browser-run-identities.json';
const STORE_VERSION = 1;

let transport: AutomationRpcTransport | null = null;

/** Wired by AutomationBridge on every daemon (re)connect; null on disconnect. */
export function setRunIdentityTransport(next: AutomationRpcTransport | null): void {
  transport = next;
  if (!next) identityRunPtys.clear();
}

// ── Main's snapshot store ────────────────────────────────────────────────

/** What the operator confirmed, as main recorded it. */
export interface RunIdentitySnapshot {
  automationId: string;
  boundRevision: number;
  workspaceId: string;
  paneId: string;
  /** The pane's exclusive Chrome profile at grant time. */
  profileId: string;
  /** The allowed sites shown in the confirm. */
  hosts: string[];
  /** panePolicyFingerprint of the pane at grant time. */
  fingerprint: string;
  /** The permission mode confirmed together with the identity. */
  mode: AutomationPermissionMode;
}

/**
 * The pane's policy and profile binding, reduced to one value: any change to
 * that pane (sites, protection, confirmation, workspace, profile) changes it;
 * a change to another pane does not.
 */
export function panePolicyFingerprint(entry: PanePolicy | null, bindingProfile: string | undefined): string {
  const payload = entry
    ? [
      entry.workspaceId,
      entry.paneId,
      entry.profileId.toLowerCase(),
      entry.protected,
      entry.hosts.mode,
      [...entry.hosts.allow].sort(),
      [...entry.hosts.block].sort(),
      entry.needsConfirm === true,
      (bindingProfile ?? '').toLowerCase(),
    ]
    : null;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

let storeDir: string | null = null;
/** null = not read yet; 'corrupt' = unreadable, every lookup refused. */
let cache: Record<string, RunIdentitySnapshot> | 'corrupt' | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

/** Tests: keep the store under `dir`. */
export function __setRunIdentityStoreDirForTest(dir: string | null): void {
  storeDir = dir;
  cache = null;
}

function storePath(): string {
  return path.join(storeDir ?? getWmuxDir(), STORE_FILE);
}

const keyOf = (automationId: string, revision: number) => `${automationId}@${revision}`;

function validSnapshot(raw: unknown): RunIdentitySnapshot | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  if (
    typeof r.automationId !== 'string' || !r.automationId
    || typeof r.boundRevision !== 'number' || !Number.isSafeInteger(r.boundRevision)
    || typeof r.workspaceId !== 'string' || typeof r.paneId !== 'string'
    || typeof r.profileId !== 'string' || !r.profileId
    || !Array.isArray(r.hosts) || !r.hosts.every((h) => typeof h === 'string')
    || typeof r.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(r.fingerprint)
    || (r.mode !== 'approval' && r.mode !== 'scoped' && r.mode !== 'auto' && r.mode !== 'bypass')
  ) {
    return null;
  }
  return {
    automationId: r.automationId,
    boundRevision: r.boundRevision,
    workspaceId: r.workspaceId,
    paneId: r.paneId,
    profileId: r.profileId,
    hosts: [...(r.hosts as string[])],
    fingerprint: r.fingerprint,
    mode: r.mode,
  };
}

/** Primary file only, fail closed: missing = no identities, unreadable = refuse all. */
function readStore(): Record<string, RunIdentitySnapshot> | 'corrupt' {
  if (cache) return cache;
  let text: string;
  try {
    text = fs.readFileSync(storePath(), 'utf8');
  } catch (err) {
    cache = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? {} : 'corrupt';
    return cache;
  }
  try {
    const raw = JSON.parse(text) as { version?: unknown; entries?: unknown };
    if (raw?.version !== STORE_VERSION || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) {
      cache = 'corrupt';
      return cache;
    }
    const entries: Record<string, RunIdentitySnapshot> = {};
    for (const [key, value] of Object.entries(raw.entries as Record<string, unknown>)) {
      const snap = validSnapshot(value);
      if (!snap || key !== keyOf(snap.automationId, snap.boundRevision) || isUnsafeKey(key)) {
        cache = 'corrupt';
        return cache;
      }
      entries[key] = snap;
    }
    cache = entries;
  } catch {
    cache = 'corrupt';
  }
  return cache;
}

function mutateStore(fn: (entries: Record<string, RunIdentitySnapshot>) => Record<string, RunIdentitySnapshot>): Promise<void> {
  const run = writeChain.then(async () => {
    cache = null; // decide on what is on disk now
    const current = readStore();
    if (current === 'corrupt') throw new Error('the browser identity store is unreadable');
    const next = fn({ ...current });
    await atomicWriteJSON(storePath(), { version: STORE_VERSION, entries: next }, { durable: true });
    try { fs.chmodSync(storePath(), 0o600); } catch { /* best effort (Windows ACLs) */ }
    cache = next;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

/**
 * Record the operator-confirmed snapshot BEFORE the grant is sent. The
 * automation's earlier snapshot stays until the grant has landed
 * (pruneRunIdentities): a refused grant leaves the schedule, and any run of
 * it still going, on the identity it already had.
 */
export function recordRunIdentity(snapshot: RunIdentitySnapshot): Promise<void> {
  return mutateStore((entries) => {
    entries[keyOf(snapshot.automationId, snapshot.boundRevision)] = snapshot;
    return entries;
  });
}

/** After a grant landed at `keepRevision`: drop the automation's older snapshots. */
export function pruneRunIdentities(automationId: string, keepRevision: number): Promise<void> {
  return mutateStore((entries) => {
    for (const key of Object.keys(entries)) {
      const e = entries[key];
      if (e.automationId === automationId && e.boundRevision < keepRevision) delete entries[key];
    }
    return entries;
  });
}

/** Drop an automation's snapshot(s): the identity was removed, or its grant failed. */
export function forgetRunIdentity(automationId: string, boundRevision?: number): Promise<void> {
  return mutateStore((entries) => {
    for (const key of Object.keys(entries)) {
      const e = entries[key];
      if (e.automationId === automationId && (boundRevision === undefined || e.boundRevision === boundRevision)) delete entries[key];
    }
    return entries;
  });
}

function snapshotFor(automationId: string, revision: number): RunIdentitySnapshot | null {
  const entries = readStore();
  if (entries === 'corrupt') return null;
  return entries[keyOf(automationId, revision)] ?? null;
}

// ── What the operator's grant reads (wired by registerBrowserRpc) ──────────

export interface BrowserIdentitySources {
  entryFor(paneId: string): PanePolicy | null;
  /** The profile the pane resolves to now. */
  profileFor(workspaceId: string, paneId: string): string | undefined;
  paneBindings(): ChromePaneBindings;
}

let sources: BrowserIdentitySources | null = null;

export function setBrowserIdentitySources(next: BrowserIdentitySources | null): void {
  sources = next;
}

export function browserIdentitySources(): BrowserIdentitySources | null {
  return sources;
}

// ── Live runs ─────────────────────────────────────────────────────────────

export interface LiveRunIdentity {
  runId: string;
  automationId: string;
  identity: RunIdentitySnapshot;
}

/** A live identity run main has no matching snapshot for: refused, but recorded on the run. */
export interface UnmatchedRun {
  runId: string;
  unmatched: true;
}

/**
 * The identity of the live run behind `ptyId`, or null — no daemon, an older
 * daemon, no such live run, or no snapshot in main's store for exactly that
 * automation at the revision the run executed.
 */
export async function liveRunIdentity(ptyId: string): Promise<LiveRunIdentity | UnmatchedRun | null> {
  const t = transport;
  if (!t) return null;
  let res: AutomationRunIdentityResult | null;
  try {
    res = (await t.rpc(AUTOMATION_RPC.runIdentity, { ptyId }, { timeoutMs: 3000 })) as AutomationRunIdentityResult | null;
  } catch {
    return null;
  }
  const run = res?.run;
  if (!run || run.ptyId !== ptyId || typeof run.automationId !== 'string' || !run.browserIdentity) return null;
  if (typeof run.runId !== 'string') return null;
  const identity = run.browserIdentity.boundRevision === run.revision ? snapshotFor(run.automationId, run.revision) : null;
  // The mode must be the one confirmed with the identity: a grant raced in
  // under the same reference does not inherit it.
  if (!identity || identity.mode !== run.effectiveMode) return { runId: run.runId, unmatched: true };
  return { runId: run.runId, automationId: run.automationId, identity };
}

/** Live identity runs with their shell pid and main's workspace for them (the process walk). */
export async function liveIdentityRunAnchors(): Promise<Array<{ ptyId: string; pid: number; workspaceId: string }>> {
  const t = transport;
  if (!t) return [];
  let res: AutomationIdentityRunsResult | null;
  try {
    res = (await t.rpc(AUTOMATION_RPC.identityRuns, {}, { timeoutMs: 2000 })) as AutomationIdentityRunsResult | null;
  } catch {
    return [];
  }
  const out: Array<{ ptyId: string; pid: number; workspaceId: string }> = [];
  for (const r of Array.isArray(res?.runs) ? res.runs : []) {
    if (typeof r?.ptyId !== 'string' || !Number.isInteger(r.pid) || r.pid <= 0 || typeof r.automationId !== 'string') continue;
    const snap = snapshotFor(r.automationId, r.revision);
    if (snap) out.push({ ptyId: r.ptyId, pid: r.pid, workspaceId: snap.workspaceId });
  }
  return out;
}

/** Record a refused browser call on the run (best effort — the call fails either way). */
export function noteRunBrowserRefusal(runId: string, detail: AutomationNoteRunBrowserParams['detail']): void {
  const t = transport;
  if (!t) return;
  const params: AutomationNoteRunBrowserParams = { runId, detail };
  t.rpc(AUTOMATION_RPC.noteRunBrowser, params as unknown as Record<string, unknown>, { timeoutMs: 3000 }).catch(() => undefined);
}

// ── Which PTYs are identity runs (sync, for the RPC router) ────────────────

/**
 * PTYs of non-final runs that carry a browser identity, kept from the daemon's
 * run events. Only ever NARROWS what a caller may do (main admits browser calls
 * alone from these), so a stale entry costs a refusal, never access.
 */
const identityRunPtys = new Set<string>();

type IdentityRunView = Pick<AutomationRun, 'ptyId' | 'state' | 'browserIdentity' | 'hasBrowserIdentity'>;

export function noteRunForIdentity(run: IdentityRunView): void {
  if (!run?.ptyId) return;
  const hasIdentity = !!run.browserIdentity || run.hasBrowserIdentity === true;
  if (hasIdentity && !AUTOMATION_FINAL_RUN_STATES.includes(run.state)) identityRunPtys.add(run.ptyId);
  else identityRunPtys.delete(run.ptyId);
}

export function resetIdentityRuns(runs: ReadonlyArray<IdentityRunView>): void {
  identityRunPtys.clear();
  for (const run of runs) noteRunForIdentity(run);
}

export function isIdentityRunPty(ptyId: string | undefined): boolean {
  return !!ptyId && identityRunPtys.has(ptyId);
}
