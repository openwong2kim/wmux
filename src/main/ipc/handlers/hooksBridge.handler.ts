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
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { IPC, dataSuffix } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import {
  defaultPaths,
  hookTargets,
  statusHooks,
  installHooks,
  installHooksWithNative,
  installHookTargetsWithNative,
  updateHooksWithNative,
  allowFanoutWorkerTools,
  type AllowWorkerToolsOutcome,
  type StatusOutcome,
  type InstallOutcome,
  type UpdateOutcome,
  type SetupHooksPaths,
  type HookTarget,
} from '../../../cli/commands/setupHooks';
import { getAccountStore, type Account } from '../../account/accountStore';
import { getWmuxDir } from '../../../daemon/config';
import { INSTALL_PROBE_TIMEOUT_MS, claudeConfigDirEnv, readClaudeConfigDirEnv } from '../../hooks/claudeConfigDirProbe';
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

/**
 * True when this process's home (os.homedir(), which follows HOME, or
 * USERPROFILE on Windows) is the account's own (os.userInfo().homedir, which
 * the OS reads from the account: the passwd entry, or the Windows profile).
 * Compared resolved, and without case where the filesystem ignores it. When
 * the account's home cannot be read, it counts as the real one.
 */
function homeIsTheAccounts(): boolean {
  let account: string;
  try {
    account = os.userInfo().homedir;
  } catch {
    return true;
  }
  const canonical = (dir: string): string => {
    let resolved: string;
    try { resolved = fs.realpathSync.native(dir); } catch { resolved = path.resolve(dir); }
    return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
  };
  return canonical(os.homedir()) === canonical(account);
}

/**
 * Why this instance must not write Claude Code's settings, or null when it may.
 * ~/.claude/settings.json (and account copies of it) and the bridge under
 * ~/.wmux/hooks are shared with the installed wmux (#2104), so an isolated
 * instance (WMUX_DATA_SUFFIX set) or a development build writing them in the
 * account's real home would change what the installed wmux runs. With a
 * sandbox home (a test harness's) they are its own, and it may. The boot
 * refresh skips for the same reason; the deliberate path is the CLI, which
 * warns and proceeds.
 */
export function claudeSettingsWriteRefusal(command = 'wmux setup-hooks'): string | null {
  const suffix = dataSuffix();
  if (suffix === '' && app.isPackaged) return null;
  if (!homeIsTheAccounts()) return null;
  const instance = suffix !== '' ? `an isolated instance (WMUX_DATA_SUFFIX=${suffix})` : 'a development build';
  return `This wmux is ${instance}. Claude Code settings are shared with your installed wmux, so it does not ` +
    `change them. Make this change from your installed wmux, or run ${command} in a terminal.`;
}

/**
 * The hook paths of the settings file an unset-account `claude` reads:
 * `$CLAUDE_CONFIG_DIR/settings.json` (this process's env, else the login
 * shell's, asked within its bound), else `~/.claude/settings.json`.
 */
export async function primaryHookPaths(): Promise<SetupHooksPaths> {
  return (await appHookTargets('status'))[0].paths;
}

/** The Claude accounts that keep their own settings.json, from the account store. */
function claudeAccountDirs(): Array<{ label: string; configDir: string }> {
  return getAccountStore().listAccounts()
    .filter((a) => copiesSettingsJson(a.vendor))
    .map((a) => ({ label: a.name, configDir: a.configDir }));
}

/** hookTargets as the app sees them: the probed env, the account store, defaultPaths(). */
async function appHookTargets(action: 'install' | 'status'): Promise<HookTarget[]> {
  return targetsFor(action, await claudeConfigDirEnv());
}

function targetsFor(action: 'install' | 'status', env: string | undefined): HookTarget[] {
  return hookTargets({ action, env, wmuxDir: getWmuxDir(), accounts: claudeAccountDirs(), base: defaultPaths() }).targets;
}

/** Said when the login shell never answered, so its CLAUDE_CONFIG_DIR is unknown. */
export const SHELL_ENV_UNREAD_WARNING =
  "Could not read CLAUDE_CONFIG_DIR from your login shell, so only ~/.claude and the Claude accounts were written. If you set it in your shell profile, run 'wmux setup-hooks' in a terminal.";

/**
 * Install into every Claude folder a claude can run with (hookTargets): the
 * primary first, whose outcome is returned, then each account and, when the
 * env points elsewhere, a ~/.claude that already has wmux's hooks. A target
 * that fails turns the result's ok off and names itself in the error; the
 * others are still written.
 */
export async function installAllHookTargets(): Promise<InstallOutcome> {
  // A user-started install waits longer for the shell than boot does, and
  // says so when it still got no answer rather than reporting a plain success.
  const env = await readClaudeConfigDirEnv({ timeoutMs: INSTALL_PROBE_TIMEOUT_MS });
  // Every folder through the native path: one copy, prepared once, named by
  // each folder's entries. A throw (a read-only folder) is that target's
  // failure, not the call's: the primary's included.
  const [first, ...others] = await installHookTargetsWithNative(targetsFor('install', env.value));
  const installed = first.outcome;
  const outcome = env.read
    ? installed
    : { ...installed, warning: [installed.warning, SHELL_ENV_UNREAD_WARNING].filter(Boolean).join(' ') };
  if (!env.read) console.warn(`[hooksBridge] ${SHELL_ENV_UNREAD_WARNING}`);
  const failed = others
    .filter(({ outcome: o }) => !o.ok)
    .map(({ target: t, outcome: o }) => `${t.label}: ${o.error ?? 'failed'}`);
  if (failed.length === 0) return outcome;
  return { ...outcome, ok: false, error: [outcome.error, ...failed].filter(Boolean).join('; ') };
}

/**
 * A Claude account folder just made (account onboarding) gets wmux's hooks
 * when the primary folder has them, on the primary's profile: an account must
 * not be the one place agent state silently stops working. Never from a build
 * that may not write Claude settings (claudeSettingsWriteRefusal). Best-effort:
 * returns the outcome, or null when nothing was due.
 */
export async function installHooksIntoNewAccount(configDir: string): Promise<InstallOutcome | null> {
  if (claudeSettingsWriteRefusal()) return null;
  const primary = await primaryHookPaths();
  const status = statusHooks(primary);
  if (!computeInstalled(status)) return null;
  // In the form the primary's entries run now: the one copy when they name
  // it, node otherwise (an older install, or a copy that did not pass).
  const paths = { ...primary, settingsPath: path.join(configDir, 'settings.json') };
  return status.hookRuntime.copy ? installHooksWithNative(paths, status.profile) : installHooks(paths, status.profile);
}

export function registerHooksBridgeHandlers(): void {
  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_STATUS);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_STATUS,
    wrapHandler(IPC.HOOKS_BRIDGE_STATUS, async (): Promise<HooksBridgeStatus> => {
      const paths = await primaryHookPaths();
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
      const refusal = claudeSettingsWriteRefusal();
      if (refusal) {
        const paths = await primaryHookPaths();
        return {
          ok: false,
          settingsPath: paths.settingsPath,
          bridgeDest: paths.bridgeDest,
          bridgeSource: paths.bridgeSource,
          events: [],
          profile: 'full',
          bridgeCopied: false,
          pluginDetected: false,
          removedForPlugin: 0,
          warning: null,
          error: refusal,
        };
      }
      return installAllHookTargets();
    }),
  );

  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_UPDATE);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_UPDATE,
    wrapHandler(IPC.HOOKS_BRIDGE_UPDATE, async (): Promise<UpdateOutcome> => {
      const paths = await primaryHookPaths();
      const refusal = claudeSettingsWriteRefusal();
      if (refusal) return { ok: false, settingsPath: paths.settingsPath, profile: 'full', updated: [], error: refusal };
      return updateHooksWithNative(paths);
    }),
  );

  // The same Update for one account folder. The renderer names the account by
  // id only; the folder comes from the account store, never from the caller.
  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_UPDATE_ACCOUNT);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_UPDATE_ACCOUNT,
    wrapHandler(IPC.HOOKS_BRIDGE_UPDATE_ACCOUNT, async (_event, accountId: unknown): Promise<UpdateOutcome> => {
      const base = await primaryHookPaths();
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
      const refusal = claudeSettingsWriteRefusal();
      if (refusal) return { ok: false, settingsPath: paths.settingsPath, profile: 'full', updated: [], error: refusal };
      return updateHooksWithNative(paths);
    }),
  );

  // Settings → Agents "Allow wmux worker tools in Claude Code". User-clicked,
  // never automatic (owner decision 2026-07-17), and only the fixed minimal
  // list — see FANOUT_WORKER_ALLOWED_TOOLS.
  ipcMain.removeHandler(IPC.HOOKS_BRIDGE_ALLOW_WORKER_TOOLS);
  ipcMain.handle(
    IPC.HOOKS_BRIDGE_ALLOW_WORKER_TOOLS,
    wrapHandler(IPC.HOOKS_BRIDGE_ALLOW_WORKER_TOOLS, async (): Promise<AllowWorkerToolsOutcome> => {
      const paths = await primaryHookPaths();
      const refusal = claudeSettingsWriteRefusal();
      if (refusal) return { ok: false, settingsPath: paths.settingsPath, added: [], error: refusal };
      return allowFanoutWorkerTools(paths);
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
