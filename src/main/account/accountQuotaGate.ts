// ─── Quota gate for a typed Claude or Codex launch (PTY_CREATE) ─────────────
//
// Kept out of pty.handler.ts (which imports electron) so it can be tested.

import { splitModelEnvMarker } from '../../shared/workerLaunch';
import {
  envSetsKey,
  heldLaunchNotice,
  isCompoundLine,
  isNewSessionLaunch,
  launchInlineEnvKeys,
  launchStem,
} from '../../shared/accountQuota';
import { getAccountRotationService, type RotationDecision } from './AccountRotationService';
import { VENDOR_ENV_KEYS, type Vendor } from './accountStore';

export interface QuotaLaunchOptions {
  workspaceId?: string;
  env?: Record<string, string>;
  initialCommand?: string;
}

export interface AccountQuotaGateDeps {
  prepareLaunch?: (vendor: Vendor, workspaceId: string | undefined) => Promise<RotationDecision>;
  platform?: string;
}

/**
 * With "Switch accounts by quota" on, a new session (not a resume or a
 * management subcommand) runs on a registered account that still has quota
 * when the workspace's bound one is out, by setting the account's config dir
 * in this pane's env (applied after the binding). When no account has quota
 * the launch is replaced with a notice. A launch that already names its
 * account (the vendor's config-dir key in the pane/profile env, or an inline
 * `KEY=… claude` prefix) is the user's choice and is left alone. A fan-out
 * worker line's model-env marker is wmux's own prefix, not a user command:
 * the checks run on the launch after it, and a hold keeps it. Never throws.
 */
export async function withAccountQuota<T extends QuotaLaunchOptions>(
  options: T | undefined,
  deps: AccountQuotaGateDeps = {},
): Promise<T | undefined> {
  if (!options?.initialCommand) return options;
  const { marker, command } = splitModelEnvMarker(options.initialCommand);
  const stem = launchStem(command);
  if (stem !== 'claude' && stem !== 'codex') return options;
  if (!isNewSessionLaunch(stem, command)) return options;
  const key = VENDOR_ENV_KEYS[stem];
  if (launchInlineEnvKeys(command).includes(key) || envSetsKey(options.env, key, deps.platform ?? process.platform)) return options;
  try {
    const prepare = deps.prepareLaunch ?? ((v: Vendor, ws: string | undefined) => getAccountRotationService().prepareLaunch(v, ws));
    const decision = await prepare(stem, options.workspaceId);
    if (decision.kind === 'switch') return { ...options, env: { ...options.env, ...decision.env } };
    if (decision.kind === 'hold') {
      // Holding replaces the launch; never drop commands chained after it.
      if (isCompoundLine(command)) {
        console.warn(`[account-rotation] ${stem} accounts are all out of quota, but the launch line runs other commands too: launching unchanged`);
        return options;
      }
      console.warn(`[account-rotation] ${stem} launch held: every registered ${stem} account is out of quota`);
      return { ...options, initialCommand: marker + heldLaunchNotice(stem, decision.availableAtMs) };
    }
  } catch (err) {
    console.warn(`[account-rotation] launch gate failed, launching unchanged: ${String(err)}`);
  }
  return options;
}
