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
//   - A RESUMED conversation stays on the account it started on (its
//     transcript lives in that account's config dir, so a switch would lose
//     it). With the switch on it is held with a notice when that account is
//     out.
//   - With the switch off nothing is read and nothing is held: the launch
//     runs on the bound account (or the one a resumed conversation moved to),
//     exactly as before rotation.
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
    /** True when the account differs from the workspace binding. */
    rotated: boolean;
  }
  | { kind: 'hold'; message: string };

export interface BackgroundLaunchOptions {
  /** The launch continues an existing conversation. */
  resuming: boolean;
  /** The account a rotated conversation moved to, persisted with its session. */
  rotatedAccountId?: string | null;
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

export async function resolveBackgroundLaunch(
  workspaceId: string | undefined,
  vendor: Vendor,
  opts: BackgroundLaunchOptions,
  deps: BackgroundLaunchDeps = {},
): Promise<BackgroundLaunch> {
  const key = VENDOR_ENV_KEYS[vendor];
  const exists = deps.dirExists ?? isAccessibleDir;
  let store: NonNullable<BackgroundLaunchDeps['store']>;
  try {
    store = deps.store ?? getAccountStore();
  } catch (err) {
    console.warn(`[account] background ${vendor} launch could not read the account store:`, err);
    return { kind: 'run', env: {}, accountId: null, rotated: false };
  }
  const bound = (): Extract<BackgroundLaunch, { kind: 'run' }> => {
    if (!workspaceId) return { kind: 'run', env: {}, accountId: null, rotated: false };
    const env = store.resolveAccountEnv(workspaceId, vendor, opts.onMissing);
    const accountId = env[key] ? store.getBinding(workspaceId, vendor) ?? null : null;
    return { kind: 'run', env, accountId, rotated: false };
  };
  const onAccount = (account: Account): Extract<BackgroundLaunch, { kind: 'run' }> => {
    const boundId = workspaceId ? store.getBinding(workspaceId, vendor) : undefined;
    return { kind: 'run', env: { [key]: account.configDir }, accountId: account.id, rotated: account.id !== boundId };
  };
  const nameOf = (id: string) => store.getAccount(id)?.name ?? id;

  try {
    if (opts.resuming) {
      const pinned = opts.rotatedAccountId ? store.getAccount(opts.rotatedAccountId) : undefined;
      const usable = !!pinned && pinned.vendor === vendor && exists(pinned.configDir);
      if (opts.rotatedAccountId && !usable) {
        console.warn(
          `[account] background ${vendor} resume: the account this conversation moved to (${opts.rotatedAccountId}) ` +
          'is gone or its config dir is missing — resuming on the binding, where the conversation may not be found.',
        );
      }
      const run = usable && pinned ? onAccount(pinned) : bound();
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
      if (account) return onAccount(account);
    }
    return bound();
  } catch (err) {
    console.warn(`[account] background ${vendor} launch could not check quota, using the binding:`, err);
    try {
      return bound();
    } catch {
      return { kind: 'run', env: {}, accountId: null, rotated: false };
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
