// usage.rateLimits — live Claude Code rate limits pushed by the wmux
// statusline script (integrations/claude/bin/wmux-statusline.mjs).
//
// Claude Code hands its statusline command `rate_limits` (5h / 7d utilization
// + reset) on every render, for free. The script forwards a changed sample
// here so the usage view shows live numbers and the HTTP poll can stand down.
//
// Trust: same bar as `hooks.signal` (`wmux.internal`, main-pipe auth token).
// The method writes display state only — no spawn, no fs write — so the worst
// a forged call from a token-holding local process can do is show a wrong %.
// It is validated strictly anyway, and the account is resolved HERE from the
// config dir, never taken from the caller.

import fs from 'node:fs';
import path from 'node:path';
import type { RpcRouter } from '../RpcRouter';
import type { UsageUpdate, UsageWindow } from '../../claude/usageMerge';
import { notePaneUsageSample } from '../../usageLimit/paneUsageLimits';

export interface UsageRpcDeps {
  /** Registered claude accounts (id + canonical config dir). */
  listClaudeAccounts: () => Array<{ id: string; configDir: string }>;
  /** The default profile's config dir (`~/.claude`). */
  defaultConfigDir: () => string;
  /** Returns whether the sample was accepted (applied, or already reflected). */
  ingestDefault: (update: UsageUpdate) => boolean;
  ingestAccount: (accountId: string, update: UsageUpdate) => boolean;
  log?: (line: string) => void;
}

/** Budget for resolving the caller's config dir. Filesystem calls on a stalled
 *  network mount can hang; past this the lexical path is used. */
const REALPATH_TIMEOUT_MS = 200;

const MAX_CONFIG_DIR_LEN = 4096;
const MAX_PTY_ID_LEN = 128;
/** Epoch seconds sanity band: after 2020-01-01 and before 2100. Rejects a
 *  millisecond value (13 digits) sent by mistake. */
const MIN_EPOCH_SEC = 1_577_836_800;
const MAX_EPOCH_SEC = 4_102_444_800;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `{ pct, resets_at }` → window; undefined when absent, null when malformed. */
function readWindow(v: unknown): UsageWindow | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (!isRecord(v)) return null;
  const { pct, resets_at: resetsAt } = v;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) return null;
  if (typeof resetsAt !== 'number' || !Number.isInteger(resetsAt)
      || resetsAt < MIN_EPOCH_SEC || resetsAt > MAX_EPOCH_SEC) return null;
  // Over 100 is possible (usage can overshoot a limit); the meter caps at 100.
  return { pct: Math.min(100, Math.round(pct)), resetEpochSec: resetsAt };
}

export interface RateLimitsParams {
  configDir: string | null;
  ptyId: string | null;
  update: UsageUpdate;
}

/** Strict shape check. Returns null on anything unexpected. */
export function validateRateLimitsParams(params: Record<string, unknown>): RateLimitsParams | null {
  const { configDir, ptyId, rateLimits } = params;
  if (configDir !== undefined && configDir !== null
      && (typeof configDir !== 'string' || configDir.length === 0 || configDir.length > MAX_CONFIG_DIR_LEN
          || configDir.includes('\0'))) return null;
  if (ptyId !== undefined && ptyId !== null
      && (typeof ptyId !== 'string' || ptyId.length === 0 || ptyId.length > MAX_PTY_ID_LEN)) return null;
  if (!isRecord(rateLimits)) return null;
  const session = readWindow(rateLimits.five_hour);
  const weekly = readWindow(rateLimits.seven_day);
  if (session === null || weekly === null) return null;
  if (!session && !weekly) return null;
  const update: UsageUpdate = {};
  if (session) update.session = session;
  if (weekly) update.weekly = weekly;
  return {
    configDir: typeof configDir === 'string' ? configDir : null,
    ptyId: typeof ptyId === 'string' ? ptyId : null,
    update,
  };
}

function foldCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** Physical identity of a caller-supplied dir: async realpath (never a sync
 *  fs call on the main thread for caller input) with a short budget, lexical
 *  when it does not resolve in time; case-folded on Windows. */
export async function dirIdentity(p: string, timeoutMs = REALPATH_TIMEOUT_MS): Promise<string> {
  const resolved = path.resolve(p);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const real = await Promise.race([
      fs.promises.realpath(resolved),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve(resolved), timeoutMs); }),
    ]);
    return foldCase(real);
  } catch {
    return foldCase(resolved); // missing/inaccessible — it will simply not match
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ResolvedTarget {
  isDefault: boolean;
  accountIds: string[];
}

/** Which usage entries a sample from `configDir` belongs to. Unset → the
 *  default profile. A dir that is neither the default nor a registered
 *  account resolves to nothing, and the sample is dropped. */
export async function resolveUsageTarget(
  configDir: string | null,
  deps: Pick<UsageRpcDeps, 'listClaudeAccounts' | 'defaultConfigDir'>,
): Promise<ResolvedTarget> {
  if (configDir === null) return { isDefault: true, accountIds: [] };
  // Both sides go through the same identity function, so a registered dir and
  // the same dir as the script reports it compare equal on every platform.
  const accounts = deps.listClaudeAccounts();
  const [want, defaultId, ...accountIdentities] = await Promise.all([
    dirIdentity(configDir),
    dirIdentity(deps.defaultConfigDir()),
    ...accounts.map((a) => dirIdentity(a.configDir)),
  ]);
  const accountIds = accounts.filter((_a, i) => accountIdentities[i] === want).map((a) => a.id);
  return { isDefault: want === defaultId, accountIds };
}

export function registerUsageRpc(router: RpcRouter, deps: UsageRpcDeps): void {
  // Result contract (the script records delivery only on `applied: true`):
  //   { ok: true, applied: true }        accepted (applied, or already reflected)
  //   { ok: false, reason: 'invalid' | 'unknown-account' | 'not-applied' }
  router.register('usage.rateLimits', async (params) => {
    const parsed = validateRateLimitsParams(params);
    if (!parsed) return { ok: false, reason: 'invalid' };
    // Per pane, whatever account it is: a pane held at a usage limit with no
    // reset time in its hook text takes it from its own exhausted window.
    if (parsed.ptyId) notePaneUsageSample(parsed.ptyId, parsed.update);
    const target = await resolveUsageTarget(parsed.configDir, deps);
    if (!target.isDefault && target.accountIds.length === 0) {
      deps.log?.(`[usage.rateLimits] dropped: unknown config dir (pty ${parsed.ptyId ?? '-'})`);
      return { ok: false, reason: 'unknown-account' };
    }
    let applied = false;
    if (target.isDefault) applied = deps.ingestDefault(parsed.update) || applied;
    for (const id of target.accountIds) applied = deps.ingestAccount(id, parsed.update) || applied;
    // e.g. a single window with no earlier reading to merge it onto
    return applied ? { ok: true, applied: true } : { ok: false, reason: 'not-applied' };
  });
}
