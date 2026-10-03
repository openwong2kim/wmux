// ─── Quota-driven account choice for Claude and Codex launches ──────────────
//
// Claude and Codex accounts are config directories (CLAUDE_CONFIG_DIR /
// CODEX_HOME) bound per workspace. With "Switch accounts by quota" on for a
// vendor, a typed launch of that vendor's CLI keeps the workspace's bound
// account while it has quota and otherwise runs THAT PANE on the registered
// account with the most quota left — the binding itself is not changed. When
// every account is out, the launch is held instead of collecting another
// quota error. The decision rules live in src/shared/accountQuota.ts.
//
// Off by default, and off means untouched: no reading, no network. With it
// on, Claude readings come from AccountUsageService (a read of the usage
// endpoint, no model request) and are refreshed before a launch only when
// older than READING_MAX_AGE_MS, bounded by PROBE_TIMEOUT_MS. Codex readings
// come from the limits Codex writes into each account's session files — no
// network at all.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import {
  chooseByQuota,
  evaluateQuota,
  type AccountQuotaReading,
  type QuotaVerdict,
} from '../../shared/accountQuota';
import { getAccountStore, isAccessibleDir, VENDOR_ENV_KEYS, type Account, type Vendor } from './accountStore';
import type { AccountUsageEntry } from './AccountUsageService';
import { readCodexRolloutLimits, type RolloutLimits } from '../quota/codexRollout';

const READING_MAX_AGE_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 3000;

export interface ClaudeUsageSource {
  getAll(): AccountUsageEntry[];
  refreshNow(accountId: string): Promise<void>;
}

export interface RotationSettings {
  claude: boolean;
  codex: boolean;
}

export interface RotationAccountRow {
  accountId: string;
  vendor: Vendor;
  verdict: QuotaVerdict;
  capturedAtMs: number | null;
}

export type RotationDecision =
  | { kind: 'keep' }
  | { kind: 'switch'; accountId: string; env: Record<string, string> }
  | { kind: 'hold'; availableAtMs: number | null };

export interface AccountRotationDeps {
  dataDir?: string;
  now?: () => number;
  accounts?: () => Account[];
  getBinding?: (workspaceId: string, vendor: Vendor) => string | undefined;
  claudeUsage?: ClaudeUsageSource | null;
  readCodexLimits?: (sessionsDir: string) => Promise<RolloutLimits | null>;
  dirExists?: (dir: string) => boolean;
}

/** Null unless the account's last probe succeeded: a logged-out or erroring
 *  account's old snapshot says nothing about whether it can run a launch. */
export function claudeReading(entry: AccountUsageEntry | undefined): AccountQuotaReading | null {
  const s = entry?.snapshot;
  if (!s || entry.status !== 'ok') return null;
  const win = (pct: number, resetSec: number) => ({
    remaining: 1 - Math.max(0, Math.min(100, pct)) / 100,
    resetAtMs: resetSec > 0 ? resetSec * 1000 : null,
  });
  return { windows: [win(s.sessionPct, s.sessionResetEpochSec), win(s.weeklyPct, s.weeklyResetEpochSec)], capturedAtMs: s.fetchedAtMs };
}

export function codexReading(limits: RolloutLimits | null): AccountQuotaReading | null {
  if (!limits) return null;
  const windows = [limits.primary, limits.secondary]
    .filter((w): w is NonNullable<typeof w> => w !== null)
    .map((w) => ({ remaining: 1 - Math.max(0, Math.min(100, w.usedPercent)) / 100, resetAtMs: w.resetsAtMs }));
  return { windows, capturedAtMs: limits.capturedAtMs };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(undefined); });
  });
}

export class AccountRotationService {
  private readonly filePath: string;
  private readonly now: () => number;
  private settings: RotationSettings | null = null;
  /** Account a rotated launch put each workspace's pane on, per vendor —
   *  so a turn end can refresh the account that actually ran. */
  private readonly launched = new Map<string, Partial<Record<Vendor, string>>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: AccountRotationDeps = {}) {
    this.filePath = path.join(deps.dataDir ?? getWmuxDir(), 'account-rotation.json');
    this.now = deps.now ?? Date.now;
  }

  setClaudeUsage(source: ClaudeUsageSource | null): void {
    this.deps.claudeUsage = source;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSettings(): RotationSettings {
    if (!this.settings) {
      let raw: Record<string, unknown> = {};
      try { raw = (atomicReadJSONSync<Record<string, unknown>>(this.filePath) ?? {}) as Record<string, unknown>; } catch { raw = {}; }
      this.settings = { claude: raw.claude === true, codex: raw.codex === true };
    }
    return { ...this.settings };
  }

  async setEnabled(vendor: Vendor, on: boolean): Promise<void> {
    const next = { ...this.getSettings(), [vendor]: on };
    await atomicWriteJSON(this.filePath, next);
    this.settings = next;
    if (!on) for (const ws of this.launched.keys()) this.forgetLaunch(ws, vendor);
    for (const l of this.listeners) { try { l(); } catch { /* listener faults stay local */ } }
  }

  private accounts(vendor: Vendor): Account[] {
    const all = this.deps.accounts ? this.deps.accounts() : getAccountStore().listAccounts();
    const exists = this.deps.dirExists ?? isAccessibleDir;
    return all.filter((a) => a.vendor === vendor && exists(a.configDir));
  }

  private async reading(account: Account, refresh: boolean): Promise<AccountQuotaReading | null> {
    if (account.vendor === 'codex') {
      const read = this.deps.readCodexLimits ?? ((dir: string) => readCodexRolloutLimits(dir));
      return codexReading(await withTimeout(read(path.join(account.configDir, 'sessions')), PROBE_TIMEOUT_MS) ?? null);
    }
    const usage = this.deps.claudeUsage;
    if (!usage) return null;
    const find = () => usage.getAll().find((e) => e.accountId === account.id);
    const entry = find();
    // Age of the last SUCCESSFUL reading: a failed probe also bumps
    // entry.fetchedAtMs but leaves the old snapshot in place.
    const readAt = entry?.snapshot?.fetchedAtMs;
    const stale = !readAt || this.now() - readAt > READING_MAX_AGE_MS;
    if (refresh && stale) await withTimeout(usage.refreshNow(account.id), PROBE_TIMEOUT_MS);
    return claudeReading(find());
  }

  /** Quota rows for Settings. Never refreshes (no network from a list call),
   *  and a vendor whose switch is off is not read at all. */
  async rows(vendor: Vendor): Promise<RotationAccountRow[]> {
    if (!this.getSettings()[vendor]) return [];
    const now = this.now();
    return Promise.all(this.accounts(vendor).map(async (a) => {
      const r = await this.reading(a, false);
      return { accountId: a.id, vendor, verdict: evaluateQuota(r, now), capturedAtMs: r?.capturedAtMs ?? null };
    }));
  }

  /**
   * Decide the account for a typed `vendor` launch in `workspaceId`. Rotation
   * off, no registered account, or a workspace not bound to one → keep (the
   * launch runs exactly as before). Anything but a switch forgets the
   * workspace's rotated account, so turn ends stop probing it.
   */
  async prepareLaunch(vendor: Vendor, workspaceId: string | undefined): Promise<RotationDecision> {
    const decision = await this.decideLaunch(vendor, workspaceId);
    if (decision.kind !== 'switch' && workspaceId) this.forgetLaunch(workspaceId, vendor);
    return decision;
  }

  private forgetLaunch(workspaceId: string, vendor: Vendor): void {
    const entry = this.launched.get(workspaceId);
    if (!entry) return;
    delete entry[vendor];
    if (Object.keys(entry).length === 0) this.launched.delete(workspaceId);
  }

  private async decideLaunch(vendor: Vendor, workspaceId: string | undefined): Promise<RotationDecision> {
    if (!this.getSettings()[vendor]) return { kind: 'keep' };
    const pool = this.accounts(vendor);
    if (pool.length === 0) return { kind: 'keep' };
    const bound = workspaceId
      ? (this.deps.getBinding ? this.deps.getBinding(workspaceId, vendor) : getAccountStore().getBinding(workspaceId, vendor))
      : undefined;
    // An unbound workspace runs on the CLI's default login, which is not a
    // registered account wmux can measure: leave it alone.
    if (!bound || !pool.some((a) => a.id === bound)) return { kind: 'keep' };
    const now = this.now();
    // The bound account first: while it has quota nothing else is read.
    const boundAccount = pool.find((a) => a.id === bound)!;
    const boundReading = await this.reading(boundAccount, true);
    if (evaluateQuota(boundReading, now).usable) return { kind: 'keep' };
    const read = [
      { a: boundAccount, reading: boundReading },
      ...await Promise.all(pool.filter((a) => a !== boundAccount).map(async (a) => ({ a, reading: await this.reading(a, true) }))),
    ];
    // Only a measured account is a switch target; an unmeasured one (no
    // reading, or a Claude account whose last probe failed) is never picked.
    const candidates = read
      .filter(({ a, reading }) => a.id === bound || reading !== null)
      .map(({ a, reading }) => ({ id: a.id, current: a.id === bound, verdict: evaluateQuota(reading, now) }));
    const choice = chooseByQuota(candidates);
    if (choice.kind === 'hold') {
      // "Every account is out" is only true when every account was measured.
      if (candidates.length < pool.length) return { kind: 'keep' };
      return { kind: 'hold', availableAtMs: choice.availableAtMs };
    }
    if (choice.kind === 'keep') return { kind: 'keep' };
    const account = pool.find((a) => a.id === choice.id);
    if (!account) return { kind: 'keep' };
    if (workspaceId) this.launched.set(workspaceId, { ...this.launched.get(workspaceId), [vendor]: account.id });
    console.log(`[account-rotation] ${vendor} launch in workspace ${workspaceId} runs on account ${account.id} (bound account is out of quota)`);
    return { kind: 'switch', accountId: account.id, env: { [VENDOR_ENV_KEYS[vendor]]: account.configDir } };
  }

  /** The account a rotated launch last put this workspace's `vendor` pane on. */
  launchedAccount(workspaceId: string, vendor: Vendor): string | undefined {
    return this.launched.get(workspaceId)?.[vendor];
  }
}

let instance: AccountRotationService | null = null;

export function getAccountRotationService(): AccountRotationService {
  if (!instance) instance = new AccountRotationService();
  return instance;
}

export function __resetAccountRotationServiceForTests(): void {
  instance = null;
}
