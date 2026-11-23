// ─── Fan-out account pool (desktop) ─────────────────────────────────────────
//
// With "Spread fan-out workers over accounts" on, each Claude fan-out worker
// launches on one account of a pool instead of all of them on the default
// login (a task workspace is bound to no account). The pick is the shared
// pickPoolAccount (src/shared/fanoutAccountPool.ts); this module feeds it:
//
//   - which accounts may run a worker (preparePool, async, before the
//     launches): Claude accounts of the caller's group whose folder exists,
//     is local (not UNC), has wmux hooks that are not out of date, and holds
//     a sign-in of its own. A sign-in is checked by its presence only — a
//     stat of `.credentials.json`, or on macOS a keychain lookup that prints
//     no secret — never by reading it. A task pane gets no vault value, so an
//     account that signs in only through its vault is left out. The default
//     login joins when the settings include it (poolIncludesDefaultLogin).
//   - the pick itself (pickFromPool, sync, so it and the booking in the
//     launch record are one step): the cached quota readings (no network),
//     the usage reserve's holds, and the open workers on each account.
//   - the create of the worker's pane (poolAccountForCreate): main reads the
//     account from the launch record; the renderer never names it.
//
// Off by default, and off reads nothing: no settings beyond the file's
// `enabled`, no account folders, no keychain, and no launch record gets an
// account. Daemon mode only (a pane's account folder and its spawn env are
// the daemon's).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { accountGroupOf } from '../../shared/accountGroup';
import { evaluateQuota } from '../../shared/accountQuota';
import { namesClaude } from '../../shared/botWorkerGuard';
import { namesCodex } from '../../shared/codexWorkerGuard';
import { splitModelEnvMarker } from '../../shared/workerLaunch';
import {
  DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS,
  FANOUT_ACCOUNT_POOL_FILENAME,
  POOL_DEFAULT_ACCOUNT,
  normalizeFanoutAccountPoolSettings,
  pickPoolAccount,
  poolGroupFor,
  poolIncludesDefaultLogin,
  type FanoutAccountPoolSettings,
  type PoolCandidate,
  type PoolPick,
} from '../../shared/fanoutAccountPool';
import { getAccountStore, isAccessibleDir, type Account } from '../account/accountStore';
import { appAccountVault, holdsClaudeSignIn } from '../account/accountVault';
import { claudeReading } from '../account/AccountRotationService';
import type { AccountUsageEntry } from '../account/AccountUsageService';
import type { UsageSnapshot } from '../claude/UsageApi';
import { macKeychainServiceName } from '../claude/claudeCredential';
import { usageReserveHoldForAccount } from '../usage/usageReserve';
import { getWorkerSlots, parseLaunchToken, type WorkerSlots } from '../factory/workerSlots';
import { liveHolders } from '../factory/workerHolders';

/** What the running app hands the pool (index.ts): none of it is read while the pool is off. */
export interface FanoutAccountPoolHost {
  daemonConnected: () => boolean;
  /** The per-account usage readings main holds (AccountUsageService). */
  claudeUsage: () => readonly AccountUsageEntry[];
  /** The default login's reading (the usage poller). */
  defaultSnapshot: () => UsageSnapshot | null;
  /** The accounts whose settings.json does not hold the current wmux hooks:
   *  none installed, out of date, or unreadable
   *  (hooksBridge.handler accountsWithoutCurrentHooks). */
  hookDriftIds: (accounts: readonly Account[]) => Promise<ReadonlySet<string>>;
  /** Ask for a usage reading of an account, under the usage service's own
   *  rate limit and switches (AccountUsageService.maybeProbe). Optional. */
  probeUsage?: (accountId: string) => void;
  /** A UNC folder (hooksBridge.handler isUncPath). */
  isUnc: (dir: string) => boolean;
}

let host: FanoutAccountPoolHost | null = null;

export function setFanoutAccountPoolHost(next: FanoutAccountPoolHost | null): void {
  host = next;
}

// ── Settings ────────────────────────────────────────────────────────────────

let cached: { file: string; settings: FanoutAccountPoolSettings } | null = null;
let writes: Promise<unknown> = Promise.resolve();

function settingsFile(wmuxDir = getWmuxDir()): string {
  return path.join(wmuxDir, FANOUT_ACCOUNT_POOL_FILENAME);
}

/** The pool's settings (defaults when the file is missing or unreadable). */
export function loadFanoutAccountPoolSettings(wmuxDir?: string): FanoutAccountPoolSettings {
  const file = settingsFile(wmuxDir);
  if (cached?.file === file) return { ...cached.settings };
  let raw: unknown = null;
  try {
    raw = atomicReadJSONSync<unknown>(file);
  } catch {
    raw = null;
  }
  const settings = normalizeFanoutAccountPoolSettings(raw);
  cached = { file, settings };
  return { ...settings };
}

/** Write the fields of `patch` over the stored settings; resolves the stored result. */
export function setFanoutAccountPoolSettings(patch: unknown, wmuxDir?: string): Promise<FanoutAccountPoolSettings> {
  const run = writes.then(async () => {
    const file = settingsFile(wmuxDir);
    const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch as Record<string, unknown> : {};
    const current = loadFanoutAccountPoolSettings(wmuxDir);
    const merged: Record<string, unknown> = { ...current };
    for (const k of ['enabled', 'includeDefaultLogin', 'group', 'quotaBandPct', 'maxWorkersPerAccount'] as const) {
      if (Object.hasOwn(p, k)) merged[k] = p[k];
    }
    const next = normalizeFanoutAccountPoolSettings(merged);
    await atomicWriteJSON(file, next);
    cached = { file, settings: next };
    return { ...next };
  });
  writes = run.catch(() => undefined);
  return run;
}

/** Tests only. */
export function resetFanoutAccountPoolForTests(): void {
  cached = null;
  writes = Promise.resolve();
  host = null;
}

// ── Eligibility (async, before the launches) ────────────────────────────────

export interface PoolMember {
  /** An account id, or POOL_DEFAULT_ACCOUNT. */
  id: string;
  /** The account's folder; null for the default login. */
  configDir: string | null;
}

export interface PreparedPool {
  settings: FanoutAccountPoolSettings;
  group: string;
  members: PoolMember[];
}

export type PoolExclusion = 'missing-folder' | 'unc' | 'hook-drift' | 'vault-only' | 'signed-out';

export interface PreparePoolDeps {
  settings?: () => FanoutAccountPoolSettings;
  host?: FanoutAccountPoolHost | null;
  accounts?: () => Account[];
  binding?: (workspaceId: string) => string | undefined;
  dirOk?: (dir: string) => boolean;
  /** Whether the folder holds a Claude sign-in of its own (presence only). */
  signedIn?: (configDir: string) => Promise<boolean>;
  /** Whether the account's vault holds a Claude sign-in (metadata only). */
  vaultSignIn?: (accountId: string) => boolean;
  log?: (line: string) => void;
}

const SIGN_IN_PROBE_TIMEOUT_MS = 5000;

/**
 * Whether a Claude account folder holds a sign-in of its own, by presence
 * only: a non-empty `.credentials.json` (Linux, Windows, and macOS without a
 * keychain item), else on macOS the keychain item Claude Code keeps for that
 * folder, looked up without `-w`/`-g` so no secret is printed or read.
 * False on any failure or timeout (fail closed: the account is left out).
 */
export async function claudeFolderSignedIn(configDir: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    const st = fs.statSync(path.join(configDir, '.credentials.json'));
    if (st.isFile() && st.size > 0) return true;
  } catch {
    // no file: the keychain below, on macOS
  }
  if (platform !== 'darwin') return false;
  return new Promise<boolean>((resolve) => {
    execFile('security', ['find-generic-password', '-s', macKeychainServiceName(configDir), '-a', os.userInfo().username],
      { timeout: SIGN_IN_PROBE_TIMEOUT_MS, windowsHide: true },
      (err) => resolve(!err));
  });
}

/**
 * The pool a fan-out of `callerWorkspaceId` picks from, or null when the
 * pool is off (or there is no daemon): then nothing is read and no launch is
 * given an account. The group is the caller's bound account's, else the
 * setting's; accounts of other groups are never members.
 */
export async function preparePool(callerWorkspaceId: string, deps: PreparePoolDeps = {}): Promise<PreparedPool | null> {
  // No host (tests, or before the app wired it): nothing is read at all.
  const h = deps.host === undefined ? host : deps.host;
  if (!h) return null;
  const settings = (deps.settings ?? loadFanoutAccountPoolSettings)();
  if (!settings.enabled || !h.daemonConnected()) return null;
  const log = deps.log ?? ((line: string) => console.log(line));
  const all = (deps.accounts ?? (() => getAccountStore().listAccounts()))().filter((a) => a.vendor === 'claude');
  const boundId = (deps.binding ?? ((ws: string) => getAccountStore().getBinding(ws, 'claude')))(callerWorkspaceId);
  const bound = boundId ? all.find((a) => a.id === boundId) : undefined;
  const group = poolGroupFor(bound ? accountGroupOf(bound) : null, settings);
  const inGroup = all.filter((a) => accountGroupOf(a) === group);
  const dirOk = deps.dirOk ?? isAccessibleDir;
  const signedIn = deps.signedIn ?? ((dir: string) => claudeFolderSignedIn(dir));
  const vaultSignIn = deps.vaultSignIn ?? ((id: string) => holdsClaudeSignIn(appAccountVault().list(id)));
  const excluded: Array<[string, PoolExclusion]> = [];
  const local = inGroup.filter((a) => {
    if (h.isUnc(a.configDir)) { excluded.push([a.id, 'unc']); return false; }
    if (!dirOk(a.configDir)) { excluded.push([a.id, 'missing-folder']); return false; }
    return true;
  });
  let drift: ReadonlySet<string> = new Set();
  try {
    drift = await h.hookDriftIds(local);
  } catch {
    // Unknown: every account counts as drifted rather than launch without its hooks.
    drift = new Set(local.map((a) => a.id));
  }
  const members: PoolMember[] = [];
  for (const a of local) {
    if (drift.has(a.id)) { excluded.push([a.id, 'hook-drift']); continue; }
    if (!(await signedIn(a.configDir).catch(() => false))) {
      let vault = false;
      try { vault = vaultSignIn(a.id); } catch { vault = false; }
      excluded.push([a.id, vault ? 'vault-only' : 'signed-out']);
      continue;
    }
    members.push({ id: a.id, configDir: a.configDir });
  }
  if (poolIncludesDefaultLogin(group, settings)) members.push({ id: POOL_DEFAULT_ACCOUNT, configDir: null });
  // A member with no reading ranks below every measured one: ask for one, so
  // an account that never got a worker is measured for the next picks.
  if (h.probeUsage) {
    const usage = h.claudeUsage();
    for (const m of members) {
      if (m.id !== POOL_DEFAULT_ACCOUNT && !claudeReading(usage.find((e) => e.accountId === m.id))) {
        try { h.probeUsage(m.id); } catch { /* the next read asks again */ }
      }
    }
  }
  if (excluded.length > 0) log(`[fanout-pool] left out of the pool: ${excluded.map(([id, why]) => `${id} (${why})`).join(', ')}`);
  return { settings, group, members };
}

// ── The pick (sync) ─────────────────────────────────────────────────────────

export interface PickDeps {
  host?: FanoutAccountPoolHost | null;
  slots?: WorkerSlots;
  holdFor?: (account: string) => { untilMs: number } | null;
  /** Whether a launched task's worker may still run (liveHolders: a free holder does not). */
  workerMayRun?: (taskId: string) => boolean;
  dirOk?: (dir: string) => boolean;
  now?: () => number;
}

/** The live-worker caps' holder set as a sync liveness source: a launched
 *  task runs a worker only while the set lists it as held or unknown. One it
 *  lists as free, or no longer lists (an ended task whose workspace closed),
 *  runs none; so does every one when the set cannot be read. */
function holderMayRun(): (taskId: string) => boolean {
  let running: Set<string> = new Set();
  try {
    const look = liveHolders();
    if (look) running = new Set(look.holders.filter((x) => x.state !== 'free').map((x) => x.taskId));
  } catch {
    running = new Set();
  }
  return (taskId) => running.has(taskId);
}

/** Open workers per pool account: launching ones under way, and launched ones
 *  whose worker may still run. Released and ended ones do not count. */
export function openWorkersByAccount(slots: WorkerSlots, workerMayRun: (taskId: string) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of slots.poolLaunches()) {
    if (l.state === 'launched' && !workerMayRun(l.taskId)) continue;
    out.set(l.accountId, (out.get(l.accountId) ?? 0) + 1);
  }
  return out;
}

/** The candidates of a prepared pool now: quota from the readings on hand,
 *  the reserve's holds, the open workers. A member whose folder went since
 *  is left out. */
export function poolCandidates(pool: PreparedPool, deps: PickDeps = {}): PoolCandidate[] {
  const h = deps.host === undefined ? host : deps.host;
  const now = (deps.now ?? Date.now)();
  const usage = h?.claudeUsage() ?? [];
  const holdFor = deps.holdFor ?? usageReserveHoldForAccount;
  const open = openWorkersByAccount(deps.slots ?? getWorkerSlots(), deps.workerMayRun ?? holderMayRun());
  const dirOk = deps.dirOk ?? isAccessibleDir;
  const out: PoolCandidate[] = [];
  for (const m of pool.members) {
    if (m.configDir !== null && !dirOk(m.configDir)) continue;
    const reading = m.id === POOL_DEFAULT_ACCOUNT
      ? defaultReading(h?.defaultSnapshot() ?? null)
      : claudeReading(usage.find((e) => e.accountId === m.id));
    out.push({ id: m.id, verdict: evaluateQuota(reading, now), heldUntilMs: holdFor(m.id)?.untilMs ?? null, open: open.get(m.id) ?? 0 });
  }
  return out;
}

function defaultReading(snapshot: UsageSnapshot | null): ReturnType<typeof claudeReading> {
  return snapshot ? claudeReading({ accountId: POOL_DEFAULT_ACCOUNT, status: 'ok', snapshot, fetchedAtMs: snapshot.fetchedAtMs ?? null, lastError: null }) : null;
}

/** The account the next worker launches on. Sync: the caller books it in
 *  the launch record in the same step. */
export function pickFromPool(pool: PreparedPool, deps: PickDeps = {}): PoolPick {
  return pickPoolAccount(poolCandidates(pool, deps), pool.settings);
}

/** For the usage reserve's check at the fan-out: null when some member is
 *  not held (or the pool has none: the pick refuses that itself), else the
 *  member's hold that ends first. */
export function poolAllHeld(pool: PreparedPool, holdFor: (account: string) => { account: string; untilMs: number } | null = usageReserveHoldForAccount): { account: string; untilMs: number } | null {
  if (pool.members.length === 0) return null;
  let first: { account: string; untilMs: number } | null = null;
  for (const m of pool.members) {
    const hold = holdFor(m.id);
    if (!hold) return null;
    if (!first || hold.untilMs < first.untilMs) first = { account: hold.account, untilMs: hold.untilMs };
  }
  return first;
}

/**
 * A respawn or resume of a task whose last launch ran on pool account
 * `accountId` launches there again (its conversation lives in that folder,
 * so it can resume nowhere else), or is held: null when it may launch now,
 * else why not. The account must still be registered with its folder; while
 * the pool is on it must also have quota and not be held by the usage
 * reserve. Reads only what is on hand (no network).
 */
export function poolRelaunchRefusal(accountId: string, deps: PickDeps & { account?: (id: string) => Account | undefined; poolOn?: () => boolean } = {}): string | null {
  const configDir = accountId === POOL_DEFAULT_ACCOUNT
    ? null
    : (deps.account ?? ((id: string) => getAccountStore().getAccount(id)))(accountId)?.configDir;
  if (configDir === undefined) return 'fan-out account pool: the account this task ran on is no longer registered';
  const [c] = poolCandidates({ settings: DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS, group: '', members: [{ id: accountId, configDir }] }, deps);
  if (!c) return 'fan-out account pool: the folder of the account this task ran on is missing';
  const h = deps.host === undefined ? host : deps.host;
  const poolOn = deps.poolOn ?? (() => !!h && loadFanoutAccountPoolSettings().enabled);
  if (!poolOn()) return null;
  const when = (ms: number | null) => (ms !== null ? `; it frees up at ${new Date(ms).toISOString()}` : '');
  if (!c.verdict.usable) return `fan-out account pool: the account this task ran on is out of quota${when(c.verdict.availableAtMs)}`;
  if (c.heldUntilMs !== null) return `fan-out account pool: the usage reserve holds the account this task ran on${when(c.heldUntilMs)}`;
  return null;
}

// ── The worker pane's create ────────────────────────────────────────────────

export type PoolCreateDecision =
  /** No pool account for this create: it runs as before. */
  | { kind: 'none' }
  /** The record named an account but the line launches no Claude: drop it. */
  | { kind: 'release'; taskId: string; gen: number }
  /** The default login: no account folder, and no quota rotation away from it. */
  | { kind: 'default' }
  | { kind: 'account'; accountId: string };

/**
 * What a fan-out task pane's create does with its launch record's pool
 * account. Read only after the launch was claimed (stampFanoutTaskPane). The
 * renderer's `accountId` is never taken: one that differs from the record's
 * refuses the create (THROWS). Only a Claude line (and not a Codex one) runs
 * on the account; any other line releases it. A WSL pane releases it too
 * (`place.wsl`): the pool reads no WSL sign-in or quota yet, so such a pane
 * runs as it did before the pool. Pure over its inputs.
 */
export function poolAccountForCreate(
  options: { fanoutTaskOf?: unknown; fanoutLaunch?: unknown; accountId?: unknown; initialCommand?: unknown } | undefined,
  launchOf: (taskId: string) => { gen: number; state: string; accountId?: string } | null,
  place: { wsl?: boolean } = {},
): PoolCreateDecision {
  if (typeof options?.fanoutTaskOf !== 'string' || !options.fanoutTaskOf) return { kind: 'none' };
  const token = parseLaunchToken(options.fanoutLaunch);
  if (!token) return { kind: 'none' };
  const launch = launchOf(token.taskId);
  if (!launch || launch.gen !== token.gen || launch.state === 'released' || !launch.accountId) return { kind: 'none' };
  const named = options.accountId;
  const recorded = launch.accountId === POOL_DEFAULT_ACCOUNT ? undefined : launch.accountId;
  if (named !== undefined && named !== recorded) {
    throw new Error('PTY_CREATE: this task pane runs on the account its launch recorded, not one the create names');
  }
  const raw = typeof options.initialCommand === 'string' ? options.initialCommand : '';
  const line = splitModelEnvMarker(raw).command;
  if (place.wsl === true || !line || !namesClaude(line) || namesCodex(line)) return { kind: 'release', taskId: token.taskId, gen: token.gen };
  return recorded ? { kind: 'account', accountId: recorded } : { kind: 'default' };
}

/** The pool account (never the default login) a task workspace's current
 *  launch runs on, for the turn-end usage probe. */
export function poolAccountOfWorkspace(workspaceId: string, slots: WorkerSlots = getWorkerSlots()): string | null {
  try {
    const ref = slots.workspaceOf(workspaceId);
    if (!ref) return null;
    const launch = slots.launchOf(ref.taskId);
    if (!launch || launch.gen !== ref.gen || !launch.accountId || launch.accountId === POOL_DEFAULT_ACCOUNT) return null;
    return launch.accountId;
  } catch {
    return null;
  }
}

/** A task pane moved to `accountId` in place (continueOnAccount, after the
 *  daemon confirmed): its launch record follows, when it has a pool account. */
export function notePoolPaneMoved(sessionId: string, accountId: string, slots: WorkerSlots = getWorkerSlots()): void {
  try {
    const pane = slots.paneOf(sessionId);
    if (pane) slots.setLaunchAccount(pane.taskId, pane.gen, accountId);
  } catch {
    // the record keeps the old account; the next pick may count it there
  }
}
