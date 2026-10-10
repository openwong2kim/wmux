import * as fs from 'fs';
import * as path from 'path';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { getWmuxDir } from '../../daemon/config';
import {
  AUTOMATION_FINAL_RUN_STATES,
  AUTOMATION_RPC,
  type AutomationBrowserIdentity,
  type AutomationIdentityRunsResult,
  type AutomationNoteRunBrowserParams,
  type AutomationRun,
  type AutomationRunIdentityResult,
} from '../../shared/automation';
import type { AutomationRpcTransport } from './AutomationClient';
import type { PanePolicy } from '../../shared/browserPolicy';
import type { ChromePaneBindings } from '../../shared/chromePaneBinding';

// ---------------------------------------------------------------------------
// Scheduled runs that act as a protected pane's browser — main's half.
//
// The daemon stores a run's browser identity and says which runs are live, but
// the daemon pipe's first-party marking is claimed by the client, so nothing
// the daemon holds is trusted on its own: the identity is signed here, with a
// key only main reads, over every field and the automation id, when the
// operator confirms it. A browser call from a run is attested only when
//   - main's own process walk placed the caller under that run's shell,
//   - the daemon answers that the run is live in its current incarnation, and
//   - the identity it launched with carries main's signature for that
//     automation at the revision the run executed.
// Nothing here is cached across calls: a run that ended, or a daemon that
// restarted, answers nothing on the very next call.
// ---------------------------------------------------------------------------

const KEY_FILE = 'browser-identity.key';

let transport: AutomationRpcTransport | null = null;

/** Wired by AutomationBridge on every daemon (re)connect; null on disconnect. */
export function setRunIdentityTransport(next: AutomationRpcTransport | null): void {
  transport = next;
  if (!next) identityRunPtys.clear();
}

// ── Signing ───────────────────────────────────────────────────────────────

let keyDir: string | null = null;
let cachedKey: Buffer | null = null;

/** Tests: sign with a key under `dir`. */
export function __setRunIdentityKeyDirForTest(dir: string | null): void {
  keyDir = dir;
  cachedKey = null;
}

function keyPath(): string {
  return path.join(keyDir ?? getWmuxDir(), KEY_FILE);
}

function readKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  try {
    const hex = fs.readFileSync(keyPath(), 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) cachedKey = Buffer.from(hex, 'hex');
  } catch {
    /* missing: nothing was ever signed */
  }
  return cachedKey;
}

function ensureKey(): Buffer {
  const existing = readKey();
  if (existing) return existing;
  const file = keyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // `wx`: two first signs racing never leave two different keys behind.
  try {
    fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
  }
  cachedKey = null;
  const key = readKey();
  if (!key) throw new Error('browser identity key is unreadable');
  return key;
}

type Unsigned = Omit<AutomationBrowserIdentity, 'mac'>;

function canonical(automationId: string, identity: Unsigned): string {
  return JSON.stringify([
    'wmux-browser-identity-v1',
    automationId,
    identity.workspaceId,
    identity.paneId,
    identity.profileId,
    identity.hosts,
    identity.policyEpoch,
    identity.boundRevision,
  ]);
}

export function signBrowserIdentity(automationId: string, identity: Unsigned): AutomationBrowserIdentity {
  const mac = createHmac('sha256', ensureKey()).update(canonical(automationId, identity)).digest('hex');
  return { ...identity, mac };
}

export function verifyBrowserIdentity(automationId: string, identity: AutomationBrowserIdentity): boolean {
  const key = readKey();
  if (!key || typeof identity?.mac !== 'string' || !/^[0-9a-f]{64}$/.test(identity.mac)) return false;
  const { mac, ...rest } = identity;
  const expected = createHmac('sha256', key).update(canonical(automationId, rest)).digest();
  return timingSafeEqual(expected, Buffer.from(mac, 'hex'));
}

// ── What the operator's grant reads (wired by registerBrowserRpc) ──────────

export interface BrowserIdentitySources {
  epoch(): number;
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
  identity: AutomationBrowserIdentity;
}

/**
 * The verified identity of the live run behind `ptyId`, or null — no daemon,
 * an older daemon, no such live run, or an identity main did not sign for that
 * automation at the revision the run executed.
 */
export async function liveRunIdentity(ptyId: string): Promise<LiveRunIdentity | null> {
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
  const identity = run.browserIdentity;
  if (identity.boundRevision !== run.revision) return null;
  if (!verifyBrowserIdentity(run.automationId, identity)) return null;
  return { runId: run.runId, automationId: run.automationId, identity };
}

/** Live identity runs with their shell pid, for main's process walk. */
export async function liveIdentityRunAnchors(): Promise<AutomationIdentityRunsResult['runs']> {
  const t = transport;
  if (!t) return [];
  try {
    const res = (await t.rpc(AUTOMATION_RPC.identityRuns, {}, { timeoutMs: 2000 })) as AutomationIdentityRunsResult | null;
    return Array.isArray(res?.runs)
      ? res.runs.filter((r) => typeof r?.ptyId === 'string' && Number.isInteger(r.pid) && r.pid > 0 && typeof r.workspaceId === 'string')
      : [];
  } catch {
    return [];
  }
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
