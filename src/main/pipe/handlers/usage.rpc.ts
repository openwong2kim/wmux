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

export interface UsageRpcDeps {
  /** Registered claude accounts (id + canonical config dir). */
  listClaudeAccounts: () => Array<{ id: string; configDir: string }>;
  /** The default profile's config dir (`~/.claude`). */
  defaultConfigDir: () => string;
  ingestDefault: (update: UsageUpdate) => void;
  ingestAccount: (accountId: string, update: UsageUpdate) => void;
  log?: (line: string) => void;
}

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
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  if (typeof resetsAt !== 'number' || !Number.isInteger(resetsAt)
      || resetsAt < MIN_EPOCH_SEC || resetsAt > MAX_EPOCH_SEC) return null;
  return { pct: Math.round(pct), resetEpochSec: resetsAt };
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

/** Physical identity of a dir for comparison: realpath when it resolves,
 *  lexical otherwise; case-folded on Windows. */
export function dirIdentity(p: string): string {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync.native(r);
  } catch {
    // Missing/inaccessible — compare lexically; it will simply not match.
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export interface ResolvedTarget {
  isDefault: boolean;
  accountIds: string[];
}

/** Which usage entries a sample from `configDir` belongs to. Unset → the
 *  default profile. A dir that is neither the default nor a registered
 *  account resolves to nothing, and the sample is dropped. */
export function resolveUsageTarget(configDir: string | null, deps: Pick<UsageRpcDeps, 'listClaudeAccounts' | 'defaultConfigDir'>): ResolvedTarget {
  const defaultId = dirIdentity(deps.defaultConfigDir());
  if (configDir === null) return { isDefault: true, accountIds: [] };
  const want = dirIdentity(configDir);
  const accountIds = deps.listClaudeAccounts()
    .filter((a) => dirIdentity(a.configDir) === want)
    .map((a) => a.id);
  return { isDefault: want === defaultId, accountIds };
}

export function registerUsageRpc(router: RpcRouter, deps: UsageRpcDeps): void {
  router.register('usage.rateLimits', (params) => {
    const parsed = validateRateLimitsParams(params);
    if (!parsed) return Promise.resolve({ ok: false, reason: 'invalid' });
    const target = resolveUsageTarget(parsed.configDir, deps);
    if (!target.isDefault && target.accountIds.length === 0) {
      deps.log?.(`[usage.rateLimits] dropped: unknown config dir (pty ${parsed.ptyId ?? '-'})`);
      return Promise.resolve({ ok: false, reason: 'unknown-account' });
    }
    if (target.isDefault) deps.ingestDefault(parsed.update);
    for (const id of target.accountIds) deps.ingestAccount(id, parsed.update);
    return Promise.resolve({ ok: true });
  });
}
