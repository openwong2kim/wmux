// ─── Account for a background claude launch (Deck brain, A2A worker) ────────
//
// Panes get quota-aware account choice from the PTY_CREATE gate
// (accountQuotaGate.ts). Background launches spawn claude without that path,
// so they resolve their account here — the same rules, one switch:
//
//   - A NEW conversation with "Switch accounts by quota" on runs on the bound
//     account while it has quota, else on the registered account with the
//     most left (AccountRotationService.prepareLaunch). Every account out →
//     hold.
//   - A RESUMED conversation stays on the account it started on — the one
//     rotation chose, the binding at the time, or the default login — even if
//     the workspace was rebound since: its transcript lives in that account's
//     config dir, so any other account would lose it (#2029). With the switch
//     on it is held with a notice when that account is out.
//   - With the switch off nothing is read and nothing is held.
//
// Never throws: any failure falls back to the plain binding, the pre-rotation
// behaviour.

import { getAccountStore, isAccessibleDir, VENDOR_ENV_KEYS, type Account, type AccountStore, type Vendor } from './accountStore';
import { getAccountRotationService, type AccountRotationService } from './AccountRotationService';
import { agentSlugToDisplay } from '../../shared/agentIdentity';

export type BackgroundLaunch =
  | {
    kind: 'run';
    /** Config-dir env to overlay on the spawn env; empty for the default login. */
    env: Record<string, string>;
    /** The registered account the launch runs on; null for the default login. */
    accountId: string | null;
  }
  | { kind: 'hold'; message: string };

export interface BackgroundLaunchOptions {
  /** The launch continues an existing conversation. */
  resuming: boolean;
  /** The account a resumed conversation runs on, persisted with its session:
   *  an account id, null for the default login, undefined when unknown (a
   *  session saved before accounts were recorded → the current binding). */
  conversationAccountId?: string | null;
  /** Warned when the bound account's config dir is missing. */
  onMissing?: (account: Account) => void;
  /** False when the launch does not authenticate with the account (e.g. a
   *  profile that sets its own auth token): plain binding, no quota check. */
  checkQuota?: boolean;
}

export interface BackgroundLaunchDeps {
  store?: Pick<AccountStore, 'getAccount' | 'getBinding' | 'resolveAccountEnv'>;
  rotation?: Pick<AccountRotationService, 'getSettings' | 'prepareLaunch' | 'cachedVerdict'>;
  dirExists?: (dir: string) => boolean;
}

type RunLaunch = Extract<BackgroundLaunch, { kind: 'run' }>;
type LaunchStore = NonNullable<BackgroundLaunchDeps['store']>;

function boundRun(store: LaunchStore, workspaceId: string | undefined, vendor: Vendor, onMissing?: (account: Account) => void): RunLaunch {
  if (!workspaceId) return { kind: 'run', env: {}, accountId: null };
  const env = store.resolveAccountEnv(workspaceId, vendor, onMissing);
  const accountId = env[VENDOR_ENV_KEYS[vendor]] ? store.getBinding(workspaceId, vendor) ?? null : null;
  return { kind: 'run', env, accountId };
}

function accountRun(account: Account, vendor: Vendor): RunLaunch {
  return { kind: 'run', env: { [VENDOR_ENV_KEYS[vendor]]: account.configDir }, accountId: account.id };
}

/**
 * The account a resumed conversation runs on: its recorded account, the
 * default login for null, or the binding when it is unknown — or when the
 * recorded account is gone or its config dir is missing (`fellBack`). Shared
 * by the resume launch and the Moa transcript lookup, so both look in the same
 * config dir. Sync; never warns (the caller decides).
 */
export function resolveConversationAccount(
  workspaceId: string | undefined,
  vendor: Vendor,
  conversationAccountId: string | null | undefined,
  deps: Pick<BackgroundLaunchDeps, 'store' | 'dirExists'> = {},
  onMissing?: (account: Account) => void,
): { run: RunLaunch; fellBack: boolean } {
  const store = deps.store ?? getAccountStore();
  if (conversationAccountId === undefined) return { run: boundRun(store, workspaceId, vendor, onMissing), fellBack: false };
  if (conversationAccountId === null) return { run: { kind: 'run', env: {}, accountId: null }, fellBack: false };
  const account = store.getAccount(conversationAccountId);
  const exists = deps.dirExists ?? isAccessibleDir;
  if (account && account.vendor === vendor && exists(account.configDir)) return { run: accountRun(account, vendor), fellBack: false };
  return { run: boundRun(store, workspaceId, vendor, onMissing), fellBack: true };
}

export async function resolveBackgroundLaunch(
  workspaceId: string | undefined,
  vendor: Vendor,
  opts: BackgroundLaunchOptions,
  deps: BackgroundLaunchDeps = {},
): Promise<BackgroundLaunch> {
  let store: LaunchStore;
  try {
    store = deps.store ?? getAccountStore();
  } catch (err) {
    console.warn(`[account] background ${vendor} launch could not read the account store:`, err);
    return { kind: 'run', env: {}, accountId: null };
  }
  const bound = (): RunLaunch => boundRun(store, workspaceId, vendor, opts.onMissing);
  /** The account a resumed conversation must run on; the binding when unknown
   *  or when that account is gone. */
  const conversationAccount = (): RunLaunch => {
    const { run, fellBack } = resolveConversationAccount(workspaceId, vendor, opts.conversationAccountId, { store, dirExists: deps.dirExists }, opts.onMissing);
    if (fellBack) {
      console.warn(
        `[account] background ${vendor} resume: the account this conversation runs on (${opts.conversationAccountId}) ` +
        'is gone or its config dir is missing — resuming on the binding, where the conversation may not be found.',
      );
    }
    return run;
  };
  const nameOf = (id: string) => store.getAccount(id)?.name ?? id;

  try {
    if (opts.resuming) {
      const run = conversationAccount();
      if (!run.accountId || opts.checkQuota === false) return run;
      const rotation = deps.rotation ?? getAccountRotationService();
      if (!rotation.getSettings()[vendor]) return run;
      // A failed quota check must not cost the conversation its account: the
      // outer catch would fall back to the binding, where the transcript may
      // not exist. Resume on the chosen account instead.
      let verdict: Awaited<ReturnType<typeof rotation.cachedVerdict>> = null;
      try {
        verdict = await rotation.cachedVerdict(run.accountId);
      } catch (err) {
        console.warn(`[account] background ${vendor} resume could not check quota, resuming on its account:`, err);
        return run;
      }
      if (verdict && !verdict.usable) {
        return { kind: 'hold', message: resumeHeldMessage(vendor, nameOf(run.accountId), verdict.availableAtMs) };
      }
      return run;
    }
    if (opts.checkQuota === false) return bound();
    const rotation = deps.rotation ?? getAccountRotationService();
    const decision = await rotation.prepareLaunch(vendor, workspaceId);
    if (decision.kind === 'hold') return { kind: 'hold', message: allOutMessage(vendor, decision.availableAtMs) };
    if (decision.kind === 'switch') {
      const account = store.getAccount(decision.accountId);
      if (account) return accountRun(account, vendor);
    }
    return bound();
  } catch (err) {
    console.warn(`[account] background ${vendor} launch could not check quota, using the binding:`, err);
    try {
      return bound();
    } catch {
      return { kind: 'run', env: {}, accountId: null };
    }
  }
}

function freesUp(availableAtMs: number | null): string {
  return availableAtMs ? ` It frees up at ${new Date(availableAtMs).toLocaleString()}.` : '';
}

function label(vendor: Vendor): string {
  return agentSlugToDisplay(vendor);
}

export function allOutMessage(vendor: Vendor, availableAtMs: number | null): string {
  const when = availableAtMs ? ` The first one frees up at ${new Date(availableAtMs).toLocaleString()}.` : '';
  return `${label(vendor)} was not started: every registered ${label(vendor)} account is out of quota.${when}`;
}

export function resumeHeldMessage(vendor: Vendor, accountName: string, availableAtMs: number | null): string {
  return `${label(vendor)} was not started: the account this conversation runs on ("${accountName}") is out of quota.${freesUp(availableAtMs)}` +
    ' A conversation stays on the account it started on; start a new conversation to run on another account.';
}
