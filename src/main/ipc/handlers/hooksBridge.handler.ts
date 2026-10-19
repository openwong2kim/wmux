// ─── Claude Code hook-bridge install (renderer-triggered) ────────────────────
//
// Completion/approval detection is HOOK-PRIMARY (#480): without the wmux hook
// bridge in ~/.claude/settings.json every agent lifecycle signal degrades to
// the regex detector, which can miss a real stop behind a TUI redraw. The CLI
// (`wmux setup-hooks`) has always been able to install the bridge; these two
// handlers expose the SAME logic to the in-app install prompt so a user who
// never opens a terminal still gets hook-quality signals.
//
// Deliberately NOT auto-run at boot: editing the user's Claude settings is an
// explicit, user-clicked action (owner decision 2026-07-17) — the renderer
// shows an install prompt (on launch and on off→assist/auto mode switches) and
// only this INSTALL handler writes.
//
// Reuses src/cli/commands/setupHooks.ts verbatim: same idempotent settings
// merge, same stable bridge copy under ~/.wmux/hooks/, same atomic writes.

import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import {
  defaultPaths,
  statusHooks,
  installHooks,
  updateHooks,
  allowFanoutWorkerTools,
  type AllowWorkerToolsOutcome,
  type StatusOutcome,
  type InstallOutcome,
  type UpdateOutcome,
  type SetupHooksPaths,
} from '../../../cli/commands/setupHooks';
import { getAccountStore, type Account } from '../../account/accountStore';
import { copiesSettingsJson } from '../../account/accountProvision';
import {
  loadHooksPromptPreference,
  setHooksPromptSuppressed,
  type HooksPromptPreference,
} from '../../hooks/hooksPromptPreference';

/** The one bit the renderer prompt needs, plus the full outcome for detail UI. */
export interface HooksBridgeStatus {
  /** True when every wmux hook event is present and the bridge copy exists. */
  installed: boolean;
  /** #2404 — installed, but older than the hook set this build expects. The
   *  Settings card offers Update for it; the launch prompt keeps reading
   *  `installed` alone, so a drifted install is never nagged about at launch. */
  updateAvailable: boolean;
  outcome: StatusOutcome;
  /** Claude account folders whose own copy of settings.json (made once, when
   *  the account was added) is older than the hook set this build expects.
   *  Each gets the same Update, by id; nothing writes without that click. */
  accounts: AccountHookDrift[];
}

export interface AccountHookDrift {
  accountId: string;
  name: string;
  /** The hooks an Update would write there, by label. */
  stale: string[];
}

/** The hook paths for an account folder: its own settings.json, the shared bridge. */
export function accountHookPaths(base: SetupHooksPaths, account: Pick<Account, 'configDir'>): SetupHooksPaths {
  return { ...base, settingsPath: path.join(account.configDir, 'settings.json') };
}

/** The file a path names once symlinks are followed (the path itself when it
 *  does not exist yet): two names for one settings file are one file. */
function physicalPath(file: string): string {
  try { return fs.realpathSync.native(file); } catch { return path.resolve(file); }
}

/** A UNC folder (`\\wsl.localhost\…`, a network share): the hook commands
 *  Update writes name this machine's node and bridge path, which a Claude
 *  running behind that path cannot run. Such accounts get no row. */
function isUncPath(dir: string): boolean {
  return /^[\\/]{2}/.test(dir);
}

/** The account's settings file when wmux may offer to update it: a Claude
 *  account on a local folder whose settings file is its own (not the default
 *  config's, which the card's own row covers). */
function ownAccountSettings(account: Account, base: SetupHooksPaths): SetupHooksPaths | null {
  // Only a vendor whose account folders copy Claude Code's settings.json.
  if (!copiesSettingsJson(account.vendor) || isUncPath(account.configDir)) return null;
  const paths = accountHookPaths(base, account);
  return physicalPath(paths.settingsPath) === physicalPath(base.settingsPath) ? null : paths;
}

/**
 * The Claude accounts whose settings copy is a wmux install that drifted,
 * by the same rule as the default config's Update (installed, and some
 * expected hook missing or outdated). A settings file two accounts share is
 * listed once. One unreadable folder never hides the rest.
 */
export function accountHookDrift(accounts: readonly Account[], base: SetupHooksPaths): AccountHookDrift[] {
  const out: AccountHookDrift[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    const paths = ownAccountSettings(account, base);
    if (!paths) continue;
    const file = physicalPath(paths.settingsPath);
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      const status = statusHooks(paths);
      if (!computeInstalled(status) || !status.updateAvailable) continue;
      out.push({ accountId: account.id, name: account.name, stale: status.hooks.filter((h) => h.state !== 'ok').map((h) => h.label) });
    } catch {
      // Unreadable: no row, rather than an Update for a file we could not read.
    }
  }
  return out;
}

export function computeInstalled(s: StatusOutcome): boolean {
  // "Installed" for prompt purposes = settings has at least one wmux hook group
  // AND the copied bridge exists. A stale bridge still counts as installed
  // (signals flow; the CLI refresh path handles staleness) — the prompt is an
  // onboarding nudge, not a version checker.
  return s.installedEvents.length > 0 && s.bridgeExists && !s.settingsCorrupted;
}

export function registerHooksBridgeHandlers(): void {
  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_STATUS);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_STATUS,
    wrapHandler(IPC.HOOKS_BRIDGE_STATUS, async (): Promise<HooksBridgeStatus> => {
      const paths = defaultPaths();
      const outcome = statusHooks(paths);
      const installed = computeInstalled(outcome);
      let accounts: AccountHookDrift[] = [];
      try { accounts = accountHookDrift(getAccountStore().listAccounts(), paths); } catch { /* no account rows */ }
      return { installed, updateAvailable: installed && outcome.updateAvailable, outcome, accounts };
    }),
  );

  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_INSTALL);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_INSTALL,
    wrapHandler(IPC.HOOKS_BRIDGE_INSTALL, async (): Promise<InstallOutcome> => {
      return installHooks(defaultPaths());
    }),
  );

  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_UPDATE);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_UPDATE,
    wrapHandler(IPC.HOOKS_BRIDGE_UPDATE, async (): Promise<UpdateOutcome> => {
      return updateHooks(defaultPaths());
    }),
  );

  // The same Update for one account folder. The renderer names the account by
  // id only; the folder comes from the account store, never from the caller.
  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_UPDATE_ACCOUNT);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_UPDATE_ACCOUNT,
    wrapHandler(IPC.HOOKS_BRIDGE_UPDATE_ACCOUNT, async (_event, accountId: unknown): Promise<UpdateOutcome> => {
      const base = defaultPaths();
      const accounts = getAccountStore().listAccounts();
      const account = typeof accountId === 'string' ? accounts.find((a) => a.id === accountId) : undefined;
      const paths = account ? ownAccountSettings(account, base) : null;
      if (!paths) throw new Error('HOOKS_BRIDGE_UPDATE_ACCOUNT: no Claude account with its own local settings');
      // Only an account the status lists: one that shares another's settings
      // file (an alias the listing folds into the other's row) is refused too.
      if (!accountHookDrift(accounts, base).some((d) => d.accountId === account?.id)) {
        throw new Error('HOOKS_BRIDGE_UPDATE_ACCOUNT: that account is not listed for an update');
      }
      // An Update, never an install: only a folder the status lists (a wmux
      // install there already) is written.
      if (!computeInstalled(statusHooks(paths))) throw new Error('HOOKS_BRIDGE_UPDATE_ACCOUNT: no wmux hooks in that account to update');
      return updateHooks(paths);
    }),
  );

  // Settings → Agents "Allow wmux worker tools in Claude Code". User-clicked,
  // never automatic (owner decision 2026-07-17), and only the fixed minimal
  // list — see FANOUT_WORKER_ALLOWED_TOOLS.
  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_ALLOW_WORKER_TOOLS);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_ALLOW_WORKER_TOOLS,
    wrapHandler(IPC.HOOKS_BRIDGE_ALLOW_WORKER_TOOLS, async (): Promise<AllowWorkerToolsOutcome> => {
      return allowFanoutWorkerTools(defaultPaths());
    }),
  );

  // The durable half of the prompt's refusal. A read failure resolves to "ask"
  // inside the store, so this handler has no error branch of its own; the WRITE
  // propagates, because a refusal the renderer reports as saved but that never
  // reached disk would re-nag on the next launch with no explanation.
  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_PROMPT_PREF_GET);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_PROMPT_PREF_GET,
    wrapHandler(IPC.HOOKS_BRIDGE_PROMPT_PREF_GET, async (): Promise<HooksPromptPreference> => {
      return loadHooksPromptPreference();
    }),
  );

  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_PROMPT_PREF_SET);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_PROMPT_PREF_SET,
    wrapHandler(
      IPC.HOOKS_BRIDGE_PROMPT_PREF_SET,
      async (_event, suppressed: unknown): Promise<HooksPromptPreference> => {
        // Only a literal boolean writes. Anything else is a caller bug: report
        // what is actually stored rather than writing a coerced value OR
        // claiming a default the disk does not agree with.
        if (typeof suppressed !== 'boolean') return loadHooksPromptPreference();
        return setHooksPromptSuppressed(suppressed);
      },
    ),
  );
}
