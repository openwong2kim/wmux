// #582: Suppress Electron's dev-only "Insecure Content-Security-Policy"
// warning at the earliest possible point — before `app` ready and before any
// BrowserWindow is created. Vite's HMR requires `unsafe-eval`, so the warning
// is unavoidable in dev; the production CSP (enforced in createWindow) is
// strict with no `unsafe-eval`, so this is dev-only noise reduction, not a
// security trade-off. This MUST run before createWindow()/loadMainRenderer()
// so the override is active before the first renderer navigates — setting it
// inside createWindow (after loadMainRenderer) leaves a window where Electron
// reads the flag before the override lands.
if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

// Never report a broken inherited stdio pipe back into that same pipe. Only
// during early boot: once initLogSink() runs, the tee consumes stdio errors
// itself, so a broken-pipe code arriving here after that came from some other
// stream and deserves a normal report.
const isUnreportableStdioError = (error: unknown): boolean =>
  !stdioErrorsConsumed() && isBrokenPipeError(error);

process.on('unhandledRejection', (reason) => {
  if (isUnreportableStdioError(reason)) return;
  console.error('[Main] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  if (isUnreportableStdioError(err)) return;
  console.error('[Main] Uncaught exception:', err);
});

// MUST stay the first import: ESM import hoisting means evaluation order ==
// import order, and bootTrace's module body stamps `js-start` (the first JS
// the main process runs). Moving it below another import skews every boot
// phase measurement by that import's eval cost.
import { markBoot, emitBootSummary } from './util/bootTrace';
import * as crypto from 'crypto';
import * as path from 'path';
import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron';
import { checkUserDataIsolation } from './dataIsolation';
import { createWindow, loadMainRenderer } from './window/createWindow';
import { attachDesktopPresenceReporter, reportDesktopPresence } from './window/desktopPresence';
import { PTYManager } from './pty/PTYManager';
import { PTYBridge } from './pty/PTYBridge';
import { registerAllHandlers } from './ipc/registerHandlers';
import { RpcRouter } from './pipe/RpcRouter';
import type { RpcMethod } from '../shared/rpc';
import { PipeServer } from './pipe/PipeServer';
import { registerWorkspaceRpc } from './pipe/handlers/workspace.rpc';
import { registerSurfaceRpc } from './pipe/handlers/surface.rpc';
import { registerPaneRpc } from './pipe/handlers/pane.rpc';
import { registerInputRpc, makeRoleBindingResolver } from './pipe/handlers/input.rpc';
import { registerDeckRpc } from './pipe/handlers/deck.rpc';
import { registerNotifyRpc } from './pipe/handlers/notify.rpc';
import { registerMetaRpc } from './pipe/handlers/meta.rpc';
import { registerSystemRpc } from './pipe/handlers/system.rpc';
import { registerPerfRpc } from './pipe/handlers/perf.rpc';
import { revealStatsAggregator } from './perf/revealStatsAggregator';
import { registerHooksRpc } from './pipe/handlers/hooks.rpc';
import { CompletionAlarm } from '../shared/hooks/CompletionAlarm';
import { UsagePoller } from './claude/UsagePoller';
import { AccountUsageService } from './account/AccountUsageService';
import { getAccountStore } from './account/accountStore';
import { IPC, getWmuxHomeDir } from '../shared/constants';
import { HookSignalRouter } from './hooks/HookSignalRouter';
import { SignalLatencyMeter } from './hooks/SignalLatencyMeter';
import { registerBrowserRpc } from './pipe/handlers/browser.rpc';
import { registerA2aRpc } from './pipe/handlers/a2a.rpc';
import { registerA2aChannelRpc } from './pipe/handlers/a2a.channel.rpc';
import { registerCompanyRpc } from './pipe/handlers/company.rpc';
import { registerEventsRpc } from './pipe/handlers/events.rpc';
import { PluginHostLoader } from './plugins/PluginHostLoader';
import { registerPluginSchemePrivileges, registerPluginProtocolHandler } from './plugins/pluginProtocol';
import { registerPluginHostHandlers } from './ipc/handlers/pluginHost.handler';
import { registerProjectConfigHandlers } from './ipc/handlers/projectConfig.handler';
import { registerChannelLocalHandlers } from './ipc/handlers/channelLocal.handler';
import { registerRemoteHandlers } from './ipc/handlers/remote.handler';
import { RemoteHostsStore } from './remote/RemoteHostsStore';
import { RemoteAttachmentsStore } from './remote/RemoteAttachmentsStore';
import { registerFanOutHandler } from './ipc/handlers/fanout.handler';
import { createFanOutService } from './worktask/createFanOutService';
import { registerFanOutRpc } from './pipe/handlers/fanout.rpc';
import { registerLedgerRpc } from './pipe/handlers/ledger.rpc';
import { registerWorktaskHandlers, type WorktaskServices } from './ipc/handlers/worktask.handler';
import { registerWorktaskRpc } from './pipe/handlers/worktask.rpc';
import { TaskAdoptService } from './worktask/TaskAdoptService';
import { TaskGateRunner } from './worktask/TaskGateRunner';
import { createHostedLedgerPort } from './worktask/ledgerPort';
import { getProjectConfigStore } from './project/ProjectConfigStore';
import { registerDeckHandler } from './ipc/handlers/deck.handler';
import { registerWorkspaceMirrorHandler } from './ipc/handlers/workspaceMirror.handler';
import { getWorkspaceMirror } from './workspace/WorkspaceMirror';
import { registerUiPluginRpc } from './pipe/handlers/uiPlugin.rpc';
import { registerMcpPluginRpc } from './pipe/handlers/mcp.rpc';
import { getPluginTrustStore } from './mcp/PluginTrustStore';
import { ShadowRejectionLogger } from './audit/shadowRejectionLog';
import { LegacyTrafficCounter } from './audit/legacyTrafficCounter';
import { ApprovalQueue } from './mcp/ApprovalQueue';
import { resolveEnforcementMode } from './mcp/enforcementMode';
import { setConfiguredFirstPartyClients } from './mcp/firstParty';
import { readConfiguredFirstPartyClients } from './mcp/firstPartyConfig';
import { ClaudeWorker } from './a2a/ClaudeWorker';
import { AutoUpdater } from './updater/AutoUpdater';
import { warnOnInstallIntegrityGap } from './updater/installIntegrity';
import { readDaemonPid } from './updater/installTeardown';
import { McpRegistrar } from './mcp/McpRegistrar';
import { BrokerSupervisor, isMcpBrokerEnabled } from './mcp/BrokerSupervisor';
import { WebviewCdpManager } from './browser-session/WebviewCdpManager';
import { BrowserBackendStore } from './browser-session/BrowserBackendStore';
import { ChromeLauncherRegistry } from './browser-session/ChromeLauncher';
import { ChromeProfileStore } from './browser-session/ChromeProfileStore';
import { ChromeSurfaceStore } from './browser-session/ChromeSurfaceStore';
import { getActionCacheStore } from './browser-session/ActionCacheStore';
import { getPromotedSkillStore } from './browser-session/PromotedSkillStore';
import { isBrowserBackend } from '../shared/browserBackend';
import { DaemonClient, getDaemonPipeName, readDaemonAuthToken } from './DaemonClient';
import { raceDaemonShutdown } from './daemonShutdownRace';
import { migrateScrollbackOnce } from './scrollback/legacyMigration';
import { DaemonNotificationRouter } from './notification/DaemonNotificationRouter';
import { markRendererNotificationListenerNotReady } from './notification/rendererNotificationReadiness';
import { RemoteInboxBridge } from './lanlink/RemoteInboxBridge';
import { WorkspaceContextRouter } from './metadata/WorkspaceContextRouter';
import { ensureDaemon, killDaemonByPidFile, killVerifiedDaemonPid, checkProcessLiveness, isDaemonPipeGone } from './daemon/launcher';
import { DaemonRespawnController } from './daemon/DaemonRespawnController';
import { loadConfig, getWmuxDir } from '../daemon/config';
import { CHANNELS_EPOCH } from '../shared/channels';
import { createTray, destroyTray, updateTraySessionCount } from './tray';
import { installApplicationMenu } from './menu/appMenu';
import { FirstRunOrchestrator } from './firstRun/FirstRunOrchestrator';
import { registerFirstRunHandlers } from './firstRun';
import { isSquirrelInstallerEvent } from './squirrel';
import { terminateRunningAppInstances } from './squirrelTeardown';
// Static imports (NOT require('./...')) so rollup inlines these into the
// single .vite/build/index.js bundle. A dynamic require left literal in the
// bundle has no adjacent chunk to resolve at runtime and throws
// MODULE_NOT_FOUND — silently swallowed by the best-effort catches below,
// which would break autostart registration / CLI-shim install during
// Squirrel events entirely (issue #463).
import * as autostart from './autostart';
import * as cliShim from './cliShim';
import * as shortcutHygiene from './shortcutHygiene';
import {
  refreshStatuslineScript,
  defaultPaths as defaultStatuslinePaths,
} from '../cli/commands/setupStatusline';
import {
  refreshHookBridge,
  defaultPaths as defaultHooksPaths,
} from '../cli/commands/setupHooks';
import { detectStalePluginGates } from './hooks/stalePluginGate';
import { ProcessMonitor } from '../daemon/ProcessMonitor';
import { metadataStore } from './metadata/MetadataStore';
import { collectLegacyMetadata } from './metadata/legacyMigration';
import { sessionManager, registerSessionHandlers } from './ipc/handlers/session.handler';
import { eventBus } from './events/EventBus';
import { broadcastMetadataUpdate } from './ipc/handlers/metadata.handler';
import { readOrchRole } from '../shared/orchestratorRole';
import { initLogSink, isBrokenPipeError, logLine, stdioErrorsConsumed } from './util/logSink';

markBoot('imports-done');

// Force English for Chromium internal messages to avoid encoding corruption
// on non-ASCII locales (e.g. Korean Windows where cp949 garbles console output).
app.commandLine.appendSwitch('lang', 'en-US');

// Handle Squirrel installer events.
// We must run Update.exe to create/remove shortcuts, then exit cleanly.
// The original electron-squirrel-startup had a race between its async
// app.quit() callback and our synchronous app.quit(). We avoid that by
// using spawn + 'close' event and only calling process.exit() once.
//
// IMPORTANT: Set a flag so the rest of the app initialization is skipped
// during Squirrel events. Without this, PTYManager/PipeServer/etc.
// initialize and the before-quit handler tries cleanup — causing errors.
//
// Only the four INSTALLER lifecycle events (install/updated/uninstall/obsolete)
// are handled-and-exited here. '--squirrel-firstrun' is NOT an installer hook —
// Squirrel passes it on the first normal launch, so it must fall through to
// appInit() where the single-instance lock dedupes it against the clean instance
// auto-launched from --squirrel-install. (A bare startsWith('--squirrel-') guard
// used to catch firstrun, set the flag, match no handler, never quit, and skip
// appInit() — leaving an invisible zombie that spawned its own gpu/network procs.
// See isSquirrelInstallerEvent + src/main/squirrel.ts.)
let isSquirrelEvent = false;
if (process.platform === 'win32') {
  const squirrelCmd = process.argv[1];
  if (isSquirrelInstallerEvent(squirrelCmd)) {
    isSquirrelEvent = true;
    const path = require('path');
    const { spawn } = require('child_process');
    const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
    const target = path.basename(process.execPath);

    // #502: running Setup.exe while wmux was still open crashed the update —
    // Update.exe's shortcut/old-version work collides with the live
    // instance, and the post-install relaunch dies on its single-instance
    // lock (silently leaving the user on the OLD version). This hook process
    // runs the NEW exe's code, so take the running instance down FIRST,
    // before any Update.exe work. Helpers, the daemon (live sessions — the
    // persistence promise), and concurrent hook processes are all spared;
    // see squirrelTeardown.ts. Skipped for --squirrel-obsolete: that fires
    // mid-update on the version being superseded, where the NEWER version's
    // install/updated hook owns the takeover. Best-effort — a kill failure
    // must never block the install itself.
    // The hook branches below are the ONLY production callers of the shortcut
    // hygiene pass, and they run in a packaged Windows process with no parent
    // console: without the sink, every console.warn they emit — including the
    // one that now says WHY a repair pass could not run (#962) — goes nowhere
    // at all. initLogSink is idempotent and resolves its path lazily, so
    // calling it here just makes install-time output land in
    // %APPDATA%\wmux\logs alongside everything else.
    try { initLogSink(); } catch { /* best-effort — never block an install */ }

    if (squirrelCmd !== '--squirrel-obsolete') {
      try {
        const killed = terminateRunningAppInstances();
        if (killed.length > 0) {
          console.log(`[Squirrel] terminated running wmux instance(s) before install work: ${killed.join(', ')}`);
        }
      } catch { /* best-effort */ }
    }

    if (squirrelCmd === '--squirrel-install') {
      // Register Windows startup entry so wmux survives reboot. Autostart
      // defaults ON at install time; users can turn it off in Settings →
      // General (Settings toggle + squirrel-updated both go through
      // ./autostart, which treats the Run key as the source of truth).
      try { autostart.enableAutostart(process.execPath); } catch { /* best-effort */ }

      // X4: drop the `wmux` CLI shim into <root>\bin and register it on the
      // user PATH. Internally best-effort — never blocks the install.
      try { cliShim.installCliShim(process.execPath); } catch { /* best-effort */ }

      // #863: stage <root>\app.ico from the packaged icon so shortcut icons
      // stop depending on Squirrel's iconUrl download. Best-effort.
      let installIcon: string | null = null;
      try { installIcon = shortcutHygiene.stageRootIcon(process.execPath); } catch { /* best-effort */ }

      const installShortcutArgs = ['--createShortcut', target, '--shortcut-locations', 'Desktop,StartMenu'];
      if (installIcon) installShortcutArgs.push('--icon', installIcon);
      spawn(updateExe, installShortcutArgs, { detached: true, windowsHide: true })
        .on('close', () => {
          // #863: repair leftover shortcuts AFTER Update.exe has written the
          // canonical ones. Order matters: the legacy top-level Start Menu
          // link is only deduped when the publisher-folder link exists, and on
          // an install over a <=3.3.x layout that link does not exist until
          // --createShortcut has run. Repairing first would retarget the legacy
          // link instead of removing it and leave two Start Menu entries.
          try { shortcutHygiene.repairInstalledShortcuts(process.execPath); } catch { /* best-effort */ }
          // Auto-launch app after install
          spawn(process.execPath, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          process.exit(0);
        });
      app.quit();
    } else if (squirrelCmd === '--squirrel-updated') {
      // Refresh the startup entry's exe path (it changes on every update) —
      // but ONLY if autostart is still on. Re-adding unconditionally would
      // silently re-enable it for a user who turned it off. See ./autostart.
      try { autostart.refreshAutostartEntry(process.execPath); } catch { /* best-effort */ }

      // X4: regenerate the CLI shim — it embeds the absolute app-X.Y.Z path,
      // which changes on every update.
      try { cliShim.installCliShim(process.execPath); } catch { /* best-effort */ }

      // #863: same shortcut hygiene as the install hook — an update is when
      // versioned shortcut targets (old app-X.Y.Z paths) actually die.
      let updateIcon: string | null = null;
      try { updateIcon = shortcutHygiene.stageRootIcon(process.execPath); } catch { /* best-effort */ }

      const updateShortcutArgs = ['--createShortcut', target];
      if (updateIcon) updateShortcutArgs.push('--icon', updateIcon);
      spawn(updateExe, updateShortcutArgs, { detached: true, windowsHide: true })
        .on('close', () => {
          // Repair after the canonical links are written — see the install
          // branch for why the ordering is load-bearing.
          try { shortcutHygiene.repairInstalledShortcuts(process.execPath); } catch { /* best-effort */ }
          // #502: relaunch the updated app — the pre-update instance was
          // taken down above (or quit itself in the in-app "Restart to
          // install" flow), and the single-instance lock dedupes if
          // Squirrel also launches one itself.
          spawn(process.execPath, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          process.exit(0);
        });
      app.quit();
    } else if (squirrelCmd === '--squirrel-uninstall') {
      // Remove startup registry entry
      try { autostart.disableAutostart(); } catch { /* best-effort */ }

      // X4: remove the CLI shim + strip <root>\bin from the user PATH.
      try { cliShim.uninstallCliShim(process.execPath); } catch { /* best-effort */ }

      spawn(updateExe, ['--removeShortcut', target], { detached: true, windowsHide: true })
        .on('close', () => process.exit(0));
      app.quit();
    } else if (squirrelCmd === '--squirrel-obsolete') {
      process.exit(0);
    }
  }
}

// Skip all app initialization during Squirrel installer events.
// Squirrel handlers above already called process.exit() in their callbacks.
if (!isSquirrelEvent) {
appInit();
// All module-level construction is done (PTYManager, PipeServer ctor's sync
// token-file read, handler registration). ready-fired minus this mark =
// pure Electron app-ready wait.
markBoot('module-eval-end');
}

function appInit(): void {

// 인스턴스 격리: dev 빌드(!app.isPackaged)는 packaged 빌드 및 다른 체크아웃의
// 빌드와 SingletonLock·userData·소켓·~/.wmux를 공유해 충돌한다(둘 다 productName
// "wmux"). dev일 때 WMUX_DATA_SUFFIX='-dev'를 박아 모든 경로(소켓/토큰/데몬/홈)를
// 격리하고, userData도 분리한다. daemon은 spawn 시 이 env를 상속받아 같은 suffix
// 경로를 쓴다. packaged 기본은 suffix 빈 문자열이라 기존 경로와 100% 동일.
// setPath('userData')는 app ready 전에 호출해야 효력이 있으므로 lock 체크보다 먼저 둔다.
if (!app.isPackaged && !process.env.WMUX_DATA_SUFFIX) {
  process.env.WMUX_DATA_SUFFIX = '-dev';
}
if (process.env.WMUX_DATA_SUFFIX) {
  const suffix = process.env.WMUX_DATA_SUFFIX;
  const originalUserData = app.getPath('userData');
  try {
    app.setPath('userData', originalUserData + suffix);
  } catch (err) {
    console.error('[Main] userData 격리 setPath 실패:', err);
  }
  // Diagnostics + fail-loud: confirm the suffix actually landed in userData. If
  // setPath threw / no-op'd, userData stayed at the PRODUCTION dir and an
  // isolated instance would boot onto prod's session.json — silently restoring
  // the wrong workspaces (the "a fresh suffix restored an old workspace" bug).
  // Hard-exit rather than corrupt prod state. Only trips on a real mismatch;
  // an empty suffix (normal production) never enters this block. app.exit (not
  // throw) because the top-level uncaughtException handler above would swallow a
  // throw and let the boot continue onto the prod dir.
  const resolvedUserData = app.getPath('userData');
  console.log(`[Main] WMUX_DATA_SUFFIX="${suffix}" → userData="${resolvedUserData}"`);
  const isolation = checkUserDataIsolation(suffix, resolvedUserData, originalUserData);
  if (!isolation.ok) {
    console.error(`[Main] FATAL: ${isolation.error}`);
    app.exit(1);
  }
}

// Windows taskbar identity: bind the running window to the Squirrel-installed
// shortcut's AppUserModelID so the taskbar button groups/pins against it (and
// Windows resolves the shortcut's icon for the button) instead of spawning a
// second, ungrouped button under a process-derived ID. Squirrel sets the
// shortcut AUMID to `com.squirrel.<package>.<exe>` = `com.squirrel.wmux.wmux`
// (MakerSquirrel name 'wmux' + wmux.exe). Must run before any BrowserWindow.
// Packaged-only: in dev there is no Squirrel-created shortcut whose AUMID
// matches this id, so setting it unpackaged can muddle taskbar grouping. Gate
// on app.isPackaged, mirroring the WMUX_DATA_SUFFIX dev/packaged split above.
if (process.platform === 'win32' && app.isPackaged) {
  app.setAppUserModelId('com.squirrel.wmux.wmux');
}

// CDP (Chrome DevTools Protocol) remote debugging.
//
// Must run AFTER the WMUX_DATA_SUFFIX block above: loadConfig() reads
// ~/.wmux{suffix}/config.json, and the suffix is only resolved once that block
// has executed. Reading it earlier would consult the production config in a dev
// build (or vice-versa).
//
// Enabled by default — webview-based browser automation (MCP browser tools,
// screenshots, DOM snapshots) depends on it — but configurable via
// `~/.wmux/config.json` `browser.cdp.enabled` (issue #613). The
// `WMUX_DISABLE_CDP=true` env var remains and force-disables regardless of
// config. Closing the port is the single largest same-user surface reduction
// in the app: CDP only needs a loopback socket, unlike other same-user vectors
// which need filesystem or process control. See docs/SECURITY.md §3.
const cdpEnabled =
  process.env.WMUX_DISABLE_CDP !== 'true' &&
  loadConfig().browser?.cdp?.enabled !== false;
let cdpPort = 0;
if (cdpEnabled) {
  // Randomize port within range to prevent predictable scanning
  const basePort = 18800;
  const range = 100;
  cdpPort = basePort + crypto.randomInt(range);
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort.toString());
  console.log(`[WinMux] CDP enabled on port ${cdpPort}`);
} else {
  console.log('[WinMux] CDP disabled — browser automation will be unavailable (enable via ~/.wmux/config.json browser.cdp.enabled)');
}

let isQuitting = false;
// tmux-style persistence: a normal Quit (window-close intercept / tray
// "Quit (keep sessions running)") only DETACHES from the daemon — live PTY
// sessions keep running and the next launch reattaches to them. This flag is
// flipped ONLY by the tray "Shut down wmux (close all sessions)" item and
// tells before-quit to additionally tear the daemon down (daemon.shutdown +
// pid-kill backstop) for an explicit full exit.
let fullShutdownRequested = false;

// Prevent multiple instances — focus existing window instead
const gotLock = app.requestSingleInstanceLock();
console.log(`[DEBUG] gotLock = ${gotLock}`);
if (!gotLock) {
  console.log('[DEBUG] failed to get single instance lock, quitting');
  app.quit();
  return;
} else {
  // Mark only on the success path — the duplicate-instance branch quits and
  // must not leave a "lock-acquired" lie in the boot trace.
  markBoot('lock-acquired');
  app.on('second-instance', () => {
    if (isQuitting) return;
    if (mainWindow) {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

markBoot('construction-start');
const ptyManager = new PTYManager();
let mainWindow: BrowserWindow | null = null;
// Forward-declared: PTYBridge captures this binding by reference and reads it
// at runtime (after the actual HookSignalRouter is constructed further down
// in this file). Lets the detector tee call `recordDetector` on emit without
// reordering hook/router boot earlier than the PTY layer.
let hookSignalRouter: HookSignalRouter | null = null;
// Forward-declared the same way: the local-mode CompletionAlarm (verdict gate
// for the daemon-UNREACHABLE hook fallback and the detector path) is built
// later in boot order alongside the router. ONE instance is shared by
// PTYBridge and registerHooksRpc — the detector's provisional window and the
// hook's Stop candidate must arbitrate against the same pane gate.
let localCompletionAlarm: CompletionAlarm | null = null;
const ptyBridge = new PTYBridge(ptyManager, () => mainWindow, () => hookSignalRouter, () => localCompletionAlarm);
// The hooks carry the two things the updater cannot reach: the quit flag that
// lets windows actually close (without it quitAndInstall never installs — see
// prepareInstallQuit) and the way back if that handoff stalls.
const autoUpdater = new AutoUpdater(() => mainWindow, {
  onBeforeInstallQuit: () => prepareInstallQuit(),
  onInstallQuitAborted: () => abortInstallQuit(),
  // #866: the Windows installer deletes the install root, and the daemon runs
  // out of it. Flip the same flag the tray's "Shut down wmux" item uses so
  // before-quit takes the daemon.shutdown branch instead of detaching.
  onInstallRequiresFullShutdown: () => { fullShutdownRequested = true; },
  getDaemonPid: () => readDaemonPid(getWmuxDir()),
});

// #1046: a Squirrel install can half-complete (an AV lock race inside the
// installer aborts it mid-copy) and leave an installation that RUNS but can
// never update or uninstall -- Update.exe was simply never written. Detect
// that shape once the app is up and say so, instead of letting every later
// update fail with no visible reason. The dead-on-arrival half of the class
// (icudtl.dat missing) cannot reach any in-app check by definition; the
// install waiter's post-exit verification (installTeardown.ts) covers it on
// the update path.
void app.whenReady().then(() => { try { warnOnInstallIntegrityGap(); } catch { /* best-effort */ } });

// ── Promoted browser flows: the idle sweep ─────────────────────────────────
//
// Promoted flows are permanent by design, which is precisely why they need a
// sweep: without one, a flow promoted for a page that has since been redesigned
// out of existence would be announced on every landing forever.
//
// Boot plus a 24h timer, rather than a timer alone. wmux is frequently quit and
// relaunched, so a machine that never stays up for a day would otherwise never
// sweep at all; and a machine that stays up for months would never sweep
// without the timer. The two together cover both.
//
// Deliberately not awaited and never allowed to reject: an unsweepable store
// must not delay or fail startup. The ladder itself (30 days to the archive,
// 90 to deletion) is enforced in the pure layer against the record's own
// lastRunAt, so a missed sweep only ever postpones a decision.
const PROMOTED_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function sweepPromotedSkills(): void {
  void getPromotedSkillStore()
    .sweep()
    .then(({ archived, removed }) => {
      if (archived > 0 || removed > 0) {
        console.log(
          `[Main] promoted browser flows swept: ${archived} archived, ${removed} deleted`,
        );
      }
    })
    .catch((err) => console.warn('[Main] promoted flow sweep failed:', err));
}

void app.whenReady().then(() => {
  sweepPromotedSkills();
  const timer = setInterval(sweepPromotedSkills, PROMOTED_SWEEP_INTERVAL_MS);
  // Housekeeping must never be the reason the process stays alive.
  timer.unref?.();
});

const rpcRouter = new RpcRouter();
markBoot('pre-pipe-server-ctor');
const pipeServer = new PipeServer(rpcRouter);
// Isolates the PipeServer constructor: its loadOrCreateToken() shells out to
// PowerShell for token-file ACL hardening (secureWriteTokenFile /
// reHardenTokenFileAcl) — a prime cold-start suspect.
markBoot('pipe-server-ctor-done');

// Plugin host (B-1). Scheme privileges MUST be registered before app
// 'ready'; the loader itself is constructed inside the ready handler (it
// reads ~/.wmux) and the protocol/IPC layers read it through this binding.
registerPluginSchemePrivileges();
let pluginHostLoader: PluginHostLoader | null = null;
const mcpRegistrar = new McpRegistrar();
// Shared MCP broker (Option A, WMUX_MCP_BROKER=1; default OFF). Started on
// ready BEFORE mcpRegistrar.register so the broker pipe is (or is about to
// be) listening when the first shim spawns — the shim retries connect with
// backoff, so start order is a latency nicety, not a correctness gate.
const mcpBrokerSupervisor = new BrokerSupervisor();
const webviewCdpManager = new WebviewCdpManager(cdpPort);

// Daemon client — initialized on app ready, used if daemon is available
let daemonClient: DaemonClient | null = null;

// envelope PR4 C12: 워커 전이는 데몬 A2aTaskService(정본 로그)에 먼저 커밋된다 —
// getter 주입이라 앱-레디 이후 연결되는 daemonClient를 자연 추적한다.
const claudeWorker = new ClaudeWorker(() => mainWindow, () => daemonClient);

// Monotonic token guarding the async tray refresh. Bumped on every refresh
// start and on window 'show', so a slow `daemon.listSessions` from an earlier
// 'hide' can't land its now-stale count after the window is visible again (or
// after a newer refresh superseded it). (codex review P3)
let trayRefreshToken = 0;

/**
 * Query the daemon for its live (attached + detached) session count and push
 * it to the tray's background-session nudge. Dead/suspended tombstones hold no
 * live process, so they're excluded. Best-effort and self-contained: any
 * failure (local-only mode, daemon mid-respawn, RPC timeout) clears the nudge
 * to `null` rather than surfacing an error — the count is a cosmetic hint.
 * The result is only applied if no newer refresh/show has superseded this one.
 */
async function refreshTraySessionCount(): Promise<void> {
  const token = ++trayRefreshToken;
  if (!daemonClient) {
    if (token === trayRefreshToken) updateTraySessionCount(null);
    return;
  }
  try {
    const sessions = (await daemonClient.rpc('daemon.listSessions', {})) as Array<{ state: string }>;
    const live = sessions.filter((s) => s.state === 'attached' || s.state === 'detached').length;
    if (token === trayRefreshToken) updateTraySessionCount(live);
  } catch {
    if (token === trayRefreshToken) updateTraySessionCount(null);
  }
}

// In daemon mode, this router bridges daemon-broadcast events (agent status,
// activity transitions, critical actions) into the same IPC channels
// PTYBridge writes to in local mode. Without it, daemon mode would render
// the notification pipeline 100% inert (Codex 2nd review #1).
let daemonNotificationRouter: DaemonNotificationRouter | null = null;
let remoteInboxBridge: RemoteInboxBridge | null = null;
// X1 — folds daemon context.git/context.ports broadcasts into the sidebar
// metadata channel (and drives the gh PR cache). Same lifecycle as the
// notification router above.
let workspaceContextRouter: WorkspaceContextRouter | null = null;
// Owns the daemon respawn lifecycle: initial bootstrap, disconnect detection,
// exponential-backoff respawn attempts, active health-ping probe, and the
// renderer-facing IPC events (daemon:reconnecting / :reconnected /
// :respawn-exhausted). Lifetime: created on `ready`, disposed on `before-quit`.
let daemonRespawnController: DaemonRespawnController | null = null;

// v2.8.1 hotfix (Bug 3): one-shot decision flag for the daemon-vs-local
// mode. Stays false until app.on('ready') has finished its connect
// attempt; once flipped, every subsequent `daemon:get-ready-state`
// invoke resolves immediately with the CURRENT `daemonClient` state.
// Pending invokes (renderer asked before main decided) are queued and
// flushed by `markDaemonReady`.
let daemonReadyDecided = false;
let daemonReadyPendingResolvers: Array<() => void> = [];

function markDaemonReady(): void {
  if (daemonReadyDecided) return;
  daemonReadyDecided = true;
  const pending = daemonReadyPendingResolvers;
  daemonReadyPendingResolvers = [];
  for (const resolve of pending) {
    try { resolve(); } catch { /* listener cleanup errors are non-fatal */ }
  }
}

// Registered once, OUTSIDE the registerAllHandlers swap cycle, so the
// brief window where pty/* handlers are torn down and re-registered
// can never race a `whenReady` invoke. The handler always reads the
// live `daemonClient` value via closure, which means a renderer that
// reloaded after a mid-session daemon disconnect still gets a truthful
// answer instead of a cached stale one.
// renderer가 agentStatus='running'을 받았는데 그 ptyId의 agentName이 아직
// 비어 있을 때 호출한다(1회성 session:agent emit을 매핑 준비 전에 놓친 경우).
// daemon AgentDetector를 직접 조회한다 — router 캐시(lastAgentNameByPty)는
// session:agent emit 도착에 의존해 같은 race를 타므로 쓰지 않는다. daemon은
// 배너를 직접 feed받아 lastAgent를 설정하므로 전파 race와 무관한 권위 소스다.
ipcMain.handle('detection:resolveAgent', async (_e, ptyId: string) => {
  const id = typeof ptyId === 'string' ? ptyId : '';
  if (!id) return null;
  return (await daemonClient?.getAgentName(id)) ?? null;
});

ipcMain.handle('daemon:get-ready-state', async () => {
  if (!daemonReadyDecided) {
    await new Promise<void>((resolve) => {
      daemonReadyPendingResolvers.push(resolve);
    });
  }
  return { connected: daemonClient !== null };
});

// Settings panel (MCP section) + `wmux mcp` CLI parity. Lazy token getter
// because pipeServer.getAuthToken() reads the file written during startup,
// which may not have happened yet when handlers are first registered.
const mcpHandlerOptions = {
  mcpRegistrar,
  getMcpAuthToken: (): string | null => {
    try {
      return pipeServer.getAuthToken();
    } catch {
      return null;
    }
  },
};

// Register session + scrollback handlers ONCE, outside the registerAllHandlers
// swap cycle. These channels (session:load/save, scrollback:load/dump) only
// depend on the local sessionManager singleton and have no daemon-mode vs
// local-mode variant, so there is no reason to tear them down on daemon
// connect/disconnect. Keeping them in the swap cycle exposed renderer
// scrollback.load to a microsecond "No handler registered" rejection window
// on cold boot, which silently destroyed previous-session scrollback when
// the post-restore 5s autosave dumped the empty/fresh buffer over it.
// Same hardening pattern as the v2.8.1 Bug 3 fix for `daemon:get-ready-state`.
// Phase A — A6. Pass a live getter for the daemon-connected state so the
// scrollback:dump + scrollback:load handlers short-circuit while a daemon
// is healthy. The getter closes over the `daemonClient` let above, so the
// handlers see every connect/disconnect transition that mutates that
// variable (no closure snapshot).
registerSessionHandlers(() => daemonClient?.isConnected === true);

// Presence reporting for push suppression. Registered once on `app` (not on a
// BrowserWindow) so it survives window recreation; the getter closes over the
// live `daemonClient` for the same reason as above. powerMonitor is wired too:
// a lock screen does not blur the window, so without it the daemon would keep
// holding notifications after the user locked up and left.
attachDesktopPresenceReporter(app, () => daemonClient, {
  powerMonitor,
  isFocused: () => BrowserWindow.getFocusedWindow() !== null,
});

// Bridge the in-renderer `__wmuxEventsPoll` / `__wmuxChannelsRpc` globals
// (installed in `src/renderer/hooks/useRpcBridge.ts`) into the live pipe
// `RpcRouter`. A request id is synthesized per call because the
// renderer-to-main IPC channel is request/response (no correlation id
// echoed back), and the router only requires id+method+params to dispatch.
// Used by every `registerAllHandlers` call site below; factoring it out
// keeps the three swaps consistent.
const invokeRendererRpc = (method: string, params: Record<string, unknown>): Promise<unknown> =>
  rpcRouter.dispatch(
    {
      id: `renderer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method: method as RpcMethod,
      params,
    },
    // The renderer IPC bridge is the trusted operator surface — unreachable
    // from the external wire and distinct from the in-process iframe plugin
    // host. The router also derives firstParty:true for existing handlers.
    { operator: true },
  );

let cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow, undefined, {
  ...mcpHandlerOptions,
  invokeRendererRpc,
});

// First-run wizard orchestrator (Plan 1.15) — registered once and survives
// crash-recovery handler-reload because it owns its own marker + IPC channels
// distinct from the renderer-facing pty/mcp surfaces.
const firstRunOrchestrator = new FirstRunOrchestrator(
  ptyManager,
  ptyBridge,
  () => daemonClient,
  mcpRegistrar,
  () => {
    try {
      return pipeServer.getAuthToken();
    } catch {
      return null;
    }
  },
  () => mainWindow,
);
const disposeFirstRunHandlers = registerFirstRunHandlers(firstRunOrchestrator);

// Module-scope crash tracking so activate-created windows share the same counters
let lastCrashTime = 0;
let crashCount = 0;

function attachWindowRecovery(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Main] Renderer crashed:', details.reason, details.exitCode);
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    if (now - lastCrashTime < 5000) {
      crashCount++;
    } else {
      crashCount = 1;
    }
    lastCrashTime = now;
    if (crashCount >= 3) {
      require('electron').dialog.showErrorBox('wmux', 'Renderer crashed repeatedly. Please restart.');
      app.quit();
      return;
    }
    cleanupHandlers();
    cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow, daemonClient ?? undefined, mcpHandlerOptions);
    const activePtys = ptyManager.getActiveInstances();
    console.log(`[Main] ${activePtys.length} PTY(s) still alive — reloading renderer`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }, 1000);
  });

  let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
  win.on('unresponsive', () => {
    console.warn('[Main] Renderer is unresponsive');
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.warn('[Main] Renderer still unresponsive after 10s — reloading');
        cleanupHandlers();
        cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow, daemonClient ?? undefined, mcpHandlerOptions);
        mainWindow.reload();
      }
    }, 10_000);
  });

  win.on('responsive', () => {
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
      console.log('[Main] Renderer recovered from unresponsive state');
    }
  });
}

// Hook integration backbone — owns hook-signal dedup ledger + latency
// observability. Single instance per process, shared with PTYBridge
// once detector-side wiring lands (see plan Phase 1.5).
const signalLatencyMeter = new SignalLatencyMeter();
hookSignalRouter = new HookSignalRouter({ latencyMeter: signalLatencyMeter });

// Local-mode verdict gate — the same CompletionAlarm the daemon's HookIngest
// runs, mirroring its rules onto the daemon-UNREACHABLE fallback path
// (hooks.rpc) and the detector path (PTYBridge). onConfirmed just resumes
// the stashed fan-out; every reject/hold decision lives in the shared module.
// Unref'd timers, same rule as the daemon's: an open provisional window must
// never hold the process open at quit.
localCompletionAlarm = new CompletionAlarm({
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
  onConfirmed: (_pane, _slug, _cls, resume) => resume(),
});

registerWorkspaceRpc(rpcRouter, () => mainWindow);
registerSurfaceRpc(rpcRouter, () => mainWindow);
registerPaneRpc(rpcRouter, () => mainWindow, {}, () => daemonClient);
registerInputRpc(
  rpcRouter,
  ptyManager,
  () => mainWindow,
  () => daemonClient,
  makeRoleBindingResolver(() => mainWindow),
);
registerDeckRpc(rpcRouter, () => mainWindow);
registerNotifyRpc(rpcRouter, () => mainWindow);
registerMetaRpc(rpcRouter, () => mainWindow);
registerSystemRpc(rpcRouter);
registerPerfRpc(rpcRouter);
// #517 backend choice: main owns the setting (sync read at boot — an RPC can
// arrive before the renderer has pushed anything, so renderer-push authority
// would race and fail open to builtin).
const browserBackendStore = new BrowserBackendStore(app.getPath('userData'));
// 'chrome' backend: per-profile real-Chrome instances (Phase 2.5). The
// 'default' profile keeps the pre-registry dir so existing logins survive.
const chromeProfileStore = new ChromeProfileStore();
// Stable chrome surface ids survive both Chrome swapping the target behind a
// tab and an app restart, so an agent's tab handle stays valid across either.
const chromeSurfaceStore = new ChromeSurfaceStore();
const chromeRegistry = new ChromeLauncherRegistry({
  defaultDir: path.join(app.getPath('userData'), 'chrome-agent-profile'),
  profilesDir: path.join(app.getPath('userData'), 'chrome-profiles'),
  store: chromeProfileStore,
  surfaceStore: chromeSurfaceStore,
});
// Phase 2.2 enforcement mode. Production wmux defaults to `enforce`; dev
// (electron-forge / npm start) defaults to `shadow` so a bad delta doesn't lock
// the developer out. Override via `mcp.mode` in `~/.wmux/config.json`.
//
// Resolved HERE, above every handler that reads it, rather than next to
// `rpcRouter.setEnforcementMode` further down. Nothing awaits between the two
// points today, so a later read was safe — but only accidentally: adding one
// `await` in between would turn a browser RPC's mode read into a TDZ
// ReferenceError instead of a mode. Ordering the declaration first removes the
// class rather than relying on the gap staying synchronous.
const isDevEnvironment = !app.isPackaged || process.env.NODE_ENV === 'development';
const enforcementMode = resolveEnforcementMode({ isDev: isDevEnvironment });

// Shared bounded audit sink for permission rejections, legacy milestones, and
// #810's browser caller-scope decisions.
const shadowRejectionLogger = new ShadowRejectionLogger();
registerBrowserRpc(
  rpcRouter,
  () => mainWindow,
  webviewCdpManager,
  browserBackendStore,
  (entry) => shadowRejectionLogger.appendBrowserScope(entry),
  // Same `mcp.mode` the permission enforcer runs on, so one switch rolls both
  // back. `enforcementMode` is resolved just above; the getter keeps the read
  // lazy so registration does not depend on where the mode is resolved.
  () => enforcementMode,
  chromeRegistry,
);
registerA2aRpc(rpcRouter, () => mainWindow, claudeWorker, { getDaemonClient: () => daemonClient });
registerA2aChannelRpc(rpcRouter, () => daemonClient, () => mainWindow);
registerCompanyRpc(rpcRouter, () => mainWindow);
registerEventsRpc(rpcRouter, () => mainWindow, (clientName) => getPluginTrustStore().get(clientName));
registerUiPluginRpc(rpcRouter, () => mainWindow);
registerMcpPluginRpc(rpcRouter);
// Plugin host IPC (B-1): plugins:list + the iframe bridge forwarder. Same
// RpcRouter instance, so plugin-iframe RPCs hit the identical enforcement
// stack as pipe clients. Registered once, outside the handler swap cycle.
registerPluginHostHandlers(rpcRouter, () => pluginHostLoader, () => approvalQueue);
// Project config IPC (X5 wmux.json): discovery + trust gate. Renderer-only
// surface — never exposed on the pipe RPC (external clients must not be able
// to read project files or grant trust). Registered once, like plugin host.
registerProjectConfigHandlers();
// Renderer-only channel-mutation surface (D5). Lets the in-app channels UI
// (create + composer post) mutate channel state — the pipe-facing a2a.channel
// handler fails a no-senderPtyId mutation closed, and this ipcMain.handle
// channel is unreachable from the pipe. See channelLocal.handler.ts.
registerChannelLocalHandlers(() => daemonClient);
// Remote workspace attach — renderer-only surface (same trust posture as
// channelLocal above). Registered once, outside the daemon-swap cycle: the
// registered hosts/tokens live on disk in main, independent of the local
// daemon connection. See remote.handler.ts for the push-routing contract.
registerRemoteHandlers({
  store: new RemoteHostsStore(path.join(getWmuxDir(), 'remote-hosts.json')),
  attachments: new RemoteAttachmentsStore(path.join(getWmuxDir(), 'remote-attachments.json')),
});
// J1 fan-out — 프롬프트 1개 → N 격리 태스크. 렌더러 다이얼로그가 fanout:start를
// invoke하면 main의 FanOutService가 데몬 RPC + 렌더러 spawn을 조립한다(channelLocal과
// 동일 renderer-trusted 신원).
//
// ONE service instance, shared by both entry points: it owns the idempotency
// LRU and the TaskWorktreeManager serial queue that keeps concurrent
// `git worktree add` off the same repo. The renderer IPC path stays ungated
// (the human's click is the authorization); the pipe/MCP path re-derives
// identity + repo server-side and adds its own approval gate — see
// pipe/handlers/fanout.rpc.ts.
const fanOutService = createFanOutService(() => daemonClient, () => mainWindow);
registerFanOutHandler(fanOutService);
registerFanOutRpc(rpcRouter, fanOutService, () => mainWindow);
registerLedgerRpc(rpcRouter, () => mainWindow);
// J3 태스크 수명주기 — close(remove→close 순서)·1클릭 PR(gh 4중 게이트)·정리 스캔
// (디스크 정본)·미발사 재발사(prompt.md 읽기). 물질화 필드는 데몬 projection에서
// 역참조하므로 렌더러는 taskId만 싣는다(단일 정본). 파이프 미노출(renderer-trusted).
// Integration lane: the SAME close/pr instances also serve the pipe surface
// below. TaskWorktreeManager keeps a per-repo mutex chain, so a second set of
// instances would race the renderer's for git's index.lock.
// Task lifecycle on the pipe (pipe/handlers/worktask.rpc.ts) — the half of
// fan-out that FINISHES a task: run its gate, adopt its diff, open its PR,
// close it, and read its git/gh state. Reached from the commander-only MCP
// tools; local-origin only and owner-scoped in the handler. Registered from
// inside the callback because that is where the shared instances exist; the
// callback runs synchronously, before registerWorktaskHandlers returns.
registerWorktaskHandlers(() => daemonClient, (services: WorktaskServices) => {
  registerWorktaskRpc(rpcRouter, {
    daemon: {
      rpc: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        if (!daemonClient) throw new Error('Daemon not connected');
        return daemonClient.rpc(method as RpcMethod, params);
      },
    },
    getWindow: () => mainWindow,
    close: services.close,
    pr: services.pr,
    adopt: new TaskAdoptService(),
    gate: new TaskGateRunner({
      // In-process: the TaskLedger is hosted in main, and `recordGate` is a
      // system-actor write no wire caller may make (see ledgerPort.ts).
      ledger: createHostedLedgerPort(),
      project: { getState: (cwd: string) => getProjectConfigStore().getState(cwd) },
    }),
  });
});
// Command Deck Phase 2 — the Commander brain. Renderer-only surface (same
// process-boundary trust basis as channelLocal/fanout, pipe-unreachable): the
// Agent-SDK orchestrator session runs in MAIN and drives the fleet via the wmux
// MCP bundle. Lazily spawned on the first deck:send; disposed on before-quit.
// getDaemonClient: the `claude-pty` brain vendor spawns its interactive TUI as
// a daemon session, so it needs the live client (a getter, because the deck
// handler registers before the daemon connects).
const disposeDeckHandler = registerDeckHandler(() => mainWindow, {
  getDaemonClient: () => daemonClient,
});
// WorkspaceMirror — renderer push (fire-and-forget) keeps a main-process cache
// of the workspace tree + per-pane agent status warm, so routing / hook
// resolution is served locally instead of via the workspace.list renderer
// round-trip (which a large-buffer flush storm starves). Snapshot-only.
const disposeWorkspaceMirrorHandler = registerWorkspaceMirrorHandler();
// Returns an unsubscribe for the signal-health push subscription. Called from
// before-quit so HMR reload / shutdown does not leak the listener.
// ─── M2 — per-account usage service (hook-gated, opt-in) ─────────────────────
// Shares the opt-in USAGE_TOGGLE with the default-account poller below. Probes
// fire on the `agent.stop` hook for the pane's bound claude account (main
// resolves workspace → account here so hooks.rpc stays account-agnostic).
const accountUsageService = new AccountUsageService();
const disposeAccountUsageListener = accountUsageService.onChange((entry) => {
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.ACCOUNT_USAGE_UPDATE, entry);
  }
});
const onClaudeTurnEnd = (workspaceId: string): void => {
  // Resolve the workspace's bound claude account; only registered accounts probe
  // (an unbound workspace uses the default credential, covered by usagePoller).
  //
  // KNOWN M2 LIMITATION (Codex review 2026-07-14, accepted — defer to M3 §4c):
  // this follows the workspace's CURRENT claude binding, not the ending pane's
  // spawn-time account. Binding is a per-PTY generation (plan §2): a "bind-only"
  // change leaves running terminals on their spawn-time account. So a pane that
  // outlived a rebind refreshes the NEW binding's card on turn-end, and the
  // account it actually runs on refreshes only on its next spawn or a manual ↻.
  // No wrong NUMBER is ever shown (each probe reads the probed account's real
  // quota) and it self-heals — but the trigger routing is imprecise until M3
  // persists a per-pane resolved accountId (plan §4c) that this can key on via
  // the hook's ptyId instead of the workspace binding.
  const accountId = getAccountStore().getBinding(workspaceId, 'claude');
  if (accountId) void accountUsageService.maybeProbe(accountId);
};
const disposeHooksRpc = registerHooksRpc(rpcRouter, () => mainWindow, hookSignalRouter, () => daemonClient, onClaudeTurnEnd, getWorkspaceMirror, localCompletionAlarm);

// ─── Phase 2 — Anthropic 5h/7d usage meter ──────────────────────────────────
// Opt-in. Stays idle until the renderer sends IPC.USAGE_TOGGLE with `true`.
// Window visibility is hooked below in the BrowserWindow event wire-up.
const usagePoller = new UsagePoller();
const disposeUsagePollerListener = usagePoller.onStateChange((state) => {
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.USAGE_UPDATE, state);
  }
});
// LanLink PR-2 — renderer requests a full inbox replay on mount (cold start /
// reload). Reset the bridge cursor to 0 and re-pull so the (possibly just-
// reloaded, empty) renderer re-materializes every live record; isNew dedups.
// No-op when no daemon bridge is mounted yet (the bridge's own start() pull
// will deliver once it connects).
ipcMain.on(IPC.LANLINK_RESYNC, () => {
  remoteInboxBridge?.resync();
});

ipcMain.on(IPC.USAGE_TOGGLE, (_event, enabled: unknown) => {
  if (enabled === true) {
    usagePoller.start();
    accountUsageService.setEnabled(true);
  } else {
    usagePoller.stop();
    accountUsageService.setEnabled(false);
  }
});
ipcMain.on(IPC.USAGE_REFRESH, () => {
  // refreshNow() is fire-and-forget here — the listener above will
  // push the resulting state to the renderer. Wrapping in `void` so
  // the floating promise doesn't trip lint.
  void usagePoller.refreshNow();
});

// M2 — per-account usage IPC. LIST pulls the current cache on Settings mount;
// REFRESH forces a manual probe for one account (explicit user action, bypasses
// the opt-in/cooldown gates in the service). The UPDATE push is wired above.
ipcMain.handle(IPC.ACCOUNT_USAGE_LIST, () => accountUsageService.getAll());
ipcMain.on(IPC.ACCOUNT_USAGE_REFRESH, (_event, accountId: unknown) => {
  if (typeof accountId === 'string' && accountId) {
    void accountUsageService.refreshNow(accountId);
  }
});

// Wire the legacy-contact bookkeeping so envelope-less RPCs land in
// plugin-trust.json as a `legacy` audit entry, per spec §2.2.
// fire-and-forget — the recorder must never affect dispatch latency.
rpcRouter.setLegacyContactRecorder(() => {
  void getPluginTrustStore()
    .upsertLegacyContact()
    .catch(() => {
      /* trust-store writes are best-effort; never block RPC */
    });
});

// Phase 2.2 enforcement substrate (shadow mode). Trust lookups consult the
// existing plugin-trust.json store; would-be rejections are appended to
// `~/.wmux/shadow-rejections.log` for the v3.0 dogfood window before the
// pre-commit-6 flip turns rejections into hard RPC failures.
rpcRouter.setTrustLookup((clientName) =>
  getPluginTrustStore().get(clientName),
);
rpcRouter.setShadowRejectionSink((entry) => {
  shadowRejectionLogger.append(entry);
});

// #922 PR2: hosted-workspace binding decisions that CHANGED a dispatch — a
// refused plugin write, or a plugin read answered about the workspace hosting
// it rather than the one it named. Same bounded file as every other audit
// entry kind, so one rotation policy covers all of them.
rpcRouter.setHostedScopeSink((entry) => {
  shadowRejectionLogger.appendHostedScope(entry);
});

// Per-method legacy traffic counter (Phase 2.2 pre-commit 4). Milestone
// crossings (1st, 10th, 100th, 1000th, 10000th call) emit a summary row to
// the shadow audit log. The trust-DB write above remains process-once and
// independent — this counter is purely audit telemetry.
const legacyTrafficCounter = new LegacyTrafficCounter({
  sink: ({ method, count }) => {
    shadowRejectionLogger.appendLegacyTraffic({ method, count });
  },
});
rpcRouter.setLegacyTrafficCounter(legacyTrafficCounter);

// Phase 2.2 pre-commit 6: enforcement mode + approval queue.
// (`isDevEnvironment` / `enforcementMode` are resolved above, before the RPC
// handlers that read them are registered.)
rpcRouter.setEnforcementMode(enforcementMode);

// Issue #636: operator-extensible first-party client names. Read once here —
// the same boot-time-only posture as `mcp.mode` above, so a config edit needs
// an app restart to take effect. Refused entries are logged rather than thrown:
// a bad name must never block boot, but it must not fail silently either, or an
// operator waits for a recognition that will never happen.
{
  const configured = setConfiguredFirstPartyClients(
    readConfiguredFirstPartyClients(),
  );
  if (configured.accepted.length > 0) {
    console.log(
      `[mcp] first-party client names extended from config: ${configured.accepted.join(', ')}`,
    );
  }
  for (const r of configured.rejected) {
    console.warn(
      `[mcp] refused first-party client name "${r.name}": not an identifying name ` +
        `(SDK default or wmux-internal tier). It would grant recognition to every ` +
        `client reporting it. See docs/api/mcp-plugin-spec.md §2.4.`,
    );
  }
}

const approvalQueue = new ApprovalQueue(getPluginTrustStore(), {
  openPrompt: (info) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(IPC.PERMISSION_PROMPT_OPEN, info);
    } catch {
      /* renderer might be mid-reload — the next request will surface */
    }
  },
  closePrompt: (promptId) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(IPC.PERMISSION_PROMPT_CLOSED, { promptId });
    } catch {
      /* renderer might be mid-reload */
    }
  },
});
rpcRouter.setApprovalQueue(approvalQueue);

ipcMain.handle(
  IPC.PERMISSION_PROMPT_RESOLVE,
  async (_event, payload: { promptId: string; approved: boolean }) => {
    if (
      !payload ||
      typeof payload.promptId !== 'string' ||
      typeof payload.approved !== 'boolean'
    ) {
      return { ok: false, error: 'invalid permission prompt payload' };
    }
    await approvalQueue.resolvePrompt(payload.promptId, payload.approved);
    return { ok: true };
  },
);

console.log(
  `[Main] Phase 2.2 enforcement mode: ${enforcementMode} (dev=${isDevEnvironment})`,
);

// IPC: webview CDP registration
ipcMain.handle('browser:register-webview', async (_event, surfaceId: string, webContentsId: number, workspaceId?: string) => {
  await webviewCdpManager.register(surfaceId, webContentsId, typeof workspaceId === 'string' ? workspaceId : undefined);
  return { ok: true };
});

// #517 lightweight mode: the renderer reports each browser surface's effective
// visibility (workspace ∧ window ∧ ¬zoom ∧ selected) and the global setting.
ipcMain.handle('browser:set-visibility', (_event, surfaceId: string, visible: boolean) => {
  if (typeof surfaceId !== 'string' || typeof visible !== 'boolean') return { ok: false };
  webviewCdpManager.setVisibility(surfaceId, visible);
  return { ok: true };
});
ipcMain.handle('browser:set-lightweight', (_event, enabled: boolean) => {
  if (typeof enabled !== 'boolean') return { ok: false };
  webviewCdpManager.setLightweightMode(enabled);
  return { ok: true };
});
// #517 slice C — memory relief: discard long-invisible guests.
ipcMain.handle('browser:set-discard', (_event, enabled: boolean) => {
  if (typeof enabled !== 'boolean') return { ok: false };
  webviewCdpManager.setDiscardMode(enabled);
  return { ok: true };
});
// #517 backend choice — renderer Settings UI reads/writes the main-owned value.
ipcMain.handle('browser:get-backend', () => browserBackendStore.get());
// Synchronous boot read: the renderer initializes its mirror from this BEFORE
// its first render, so no browser-open path (user click or session-restored
// browser leaf) can spawn an embedded webview during the async-hydration window
// while the persisted value is 'external' (#517, CodeRabbit).
ipcMain.on('browser:get-backend-sync', (event) => {
  event.returnValue = browserBackendStore.get();
});
ipcMain.handle('browser:set-backend', (_event, value: unknown) => {
  if (!isBrowserBackend(value)) return { ok: false };
  browserBackendStore.set(value);
  return { ok: true };
});
// Phase 2.5 — chrome-backend profiles + workspace bindings (workspace card
// menu). Validation lives in the store; IPC only shapes the payloads.
ipcMain.handle('browser:chrome-profiles:list', () => ({
  profiles: chromeProfileStore.listProfiles(),
  bindings: chromeProfileStore.getBindings(),
}));
ipcMain.handle('browser:chrome-profiles:create', async (_event, name: unknown) => {
  if (typeof name !== 'string') return { ok: false, error: 'invalid name' };
  try {
    await chromeProfileStore.create(name.trim());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
ipcMain.handle(
  'browser:chrome-profiles:bind',
  async (_event, payload: { workspaceId?: unknown; profileName?: unknown } | undefined) => {
    const workspaceId = typeof payload?.workspaceId === 'string' ? payload.workspaceId : '';
    const profileName =
      payload?.profileName === null
        ? null
        : typeof payload?.profileName === 'string'
          ? payload.profileName
          : undefined;
    if (!workspaceId || profileName === undefined) return { ok: false, error: 'invalid payload' };
    try {
      await chromeProfileStore.setBinding(workspaceId, profileName);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);
// Discard/wake signals travel main → renderer: the renderer owns the <webview>
// element, so main can only ask it to unmount (discard) or remount (wake).
webviewCdpManager.setDiscardHooks({
  onDiscard: (surfaceId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser:discarded', surfaceId);
    }
  },
  onWake: (surfaceId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser:wake', surfaceId);
    }
  },
});

console.log('[DEBUG] registering app.on(ready)');
app.on('ready', async () => {
  markBoot('ready-fired');
  // Persistent log sink — must come first so every subsequent stderr write
  // and explicit logLine() call lands on disk for postmortem analysis.
  // Path: %APPDATA%\wmux\logs\main-YYYY-MM-DD.log (Windows default).
  initLogSink();
  logLine('info', 'main', 'app.on(ready) fired');
  console.log('[Main] App ready, creating window...');

  // #818: own the accelerator table before any window can exist. Skipping this
  // left Electron's default menu in charge, and on macOS its NSMenu key
  // equivalents fire before the renderer — Cmd+Shift+R force-reloaded (wiping
  // every attached remote workspace) instead of renaming, and Cmd+W closed the
  // window instead of the surface.
  //
  // Must stay BEFORE this callback's first `await` (Codex review on #854).
  // `app.on('activate')` is registered at module scope, so once `ready` has
  // fired macOS can dispatch an activate while this callback is parked on a
  // pending promise; that handler sees zero windows and calls createWindow()
  // itself. A window built during that gap would be governed by the default
  // menu — the exact startup path this change exists to close. App-global and
  // idempotent, so this one call covers those windows too.
  installApplicationMenu();

  // P3 — macOS CLI shim: DMG/ZIP 설치엔 Squirrel 훅이 없으므로 첫 실행 시 1회만
  // `/usr/local/bin/wmux`(폴백 `~/.local/bin/wmux`) 심링크 설치를 시도한다.
  // 마커 파일로 1회 게이트하되, 마커가 있어도 "우리 소유 심링크가 현재 번들을
  // 안 가리키면"(DMG/ZIP 임시 경로에서 첫 설치 후 볼륨 제거·앱 이동으로 죽은
  // 링크가 됨, issue #505) 복구를 위해 재실행한다. 부팅 경로를 막지 않게 지연
  // 실행, 전체 best-effort.
  if (process.platform === 'darwin' && app.isPackaged) {
    const shimTimer = setTimeout(() => {
      try {
        const fs = require('fs') as typeof import('fs');
        const markerPath = `${getWmuxHomeDir()}/cli-shim-darwin-attempted`;
        if (fs.existsSync(markerPath) && !cliShim.darwinShimNeedsRepair(process.execPath)) return;
        const result = cliShim.installCliShimDarwin(process.execPath);
        logLine('info', 'main', `darwin CLI shim: ${result.status}${result.linkPath ? ` (${result.linkPath})` : ''}`);
        if (result.guidance) {
          console.log(`[cliShim] ${result.guidance}`);
          logLine('info', 'main', `darwin CLI shim guidance: ${result.guidance}`);
        }
        // foreign(다른 설치가 제공 중)·성공·실패 모두 재시도하지 않는다 — 1회 시도.
        fs.mkdirSync(getWmuxHomeDir(), { recursive: true });
        fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
      } catch (err) {
        console.warn('[cliShim] darwin shim install failed (non-fatal):', err);
      }
    }, 3000);
    shimTimer.unref();
  }

  // ~/.wmux/hooks/의 설치본 스크립트(statusline·hook bridge)를 번들 버전에 맞춘다.
  // Squirrel은 app-x.y.z를 통째로 갈아치우지만 이 스크립트들은 (업데이트에서
  // 살아남으라고) 그 바깥에 복사돼 있어서, 지금까지는 `wmux setup-statusline` /
  // `wmux setup-hooks`를 손으로 다시 돌리기 전까지 옛 파일이 계속 돌았다. 낡은
  // 스크립트는 에러 없이 조용히 옛 동작을 유지한다 — statusline은 틀린 줄을
  // 그리고, bridge는 로그 로테이션·훅 스로틀 같은 스케일 픽스를 못 받는다.
  // 이미 wmux가 소유한 설치에만, 내용이 실제로 다를 때만 손대고 settings.json은
  // 절대 건드리지 않으므로 "부팅 시 자동 설치 금지" 제약(2026-07-17)과 충돌하지
  // 않는다 — 그 규칙은 사용자를 새로 가입시키지 말라는 것이지, 이미 켠 파일을
  // 낡은 채로 두라는 게 아니다. bridge refresh는 플러그인 캐시본(마켓플레이스가
  // 버전 디렉터리로 따로 관리)은 건드리지 않고 오직 plugin-LESS 복사본만 담당한다.
  // 부팅 경로를 막지 않게 지연 실행, 전체 best-effort.
  if (app.isPackaged) {
    const refreshTimer = setTimeout(() => {
      try {
        const sl = refreshStatuslineScript(defaultStatuslinePaths());
        // 정상 무동작(up-to-date/not-installed)은 로그 소음이라 남기지 않는다.
        // refreshed는 info, failed(실제 IO 실패)·no-source(설치 레이아웃 이상)는
        // 정상과 섞이지 않게 warn으로 올린다.
        if (sl === 'refreshed') logLine('info', 'main', `statusline script refresh: ${sl}`);
        else if (sl === 'failed' || sl === 'no-source') logLine('warn', 'main', `statusline script refresh: ${sl}`);
      } catch (err) {
        console.warn('[statusline] script refresh failed (non-fatal):', err);
      }
      try {
        const br = refreshHookBridge(defaultHooksPaths());
        if (br === 'refreshed') logLine('info', 'main', `hook bridge refresh: ${br}`);
        else if (br === 'failed' || br === 'no-source') logLine('warn', 'main', `hook bridge refresh: ${br}`);
      } catch (err) {
        console.warn('[hooks] bridge refresh failed (non-fatal):', err);
      }
    }, 3000);
    refreshTimer.unref();
  }

  // #898 — the OTHER copy of the bridge. `refreshHookBridge` above owns
  // `~/.wmux/hooks/`; a Claude Code plugin install is a snapshot in a version
  // directory that Claude Code owns, and no wmux release touches it. A user who
  // installed the plugin can therefore keep being prompted for every tool call
  // long after the fix shipped, with `WMUX_GATE=0` powerless to stop it.
  //
  // Read-only on purpose (see stalePluginGate): repairing another tool's cache
  // would put content in a directory whose name promises a different version,
  // and could downgrade a bridge newer than this app's. So: detect, and tell
  // the user the one command that fixes it. Runs unpackaged too — it writes
  // nothing, and dogfooding the notice needs it. Deferred so a probe spawn
  // never sits on the boot path.
  const staleGateTimer = setTimeout(() => {
    void detectStalePluginGates()
      .then((found) => {
        if (found.length === 0) return;
        logLine('warn', 'main', `stale plugin permission gate: ${found.map((f) => `${f.pluginKey}@${f.version}`).join(', ')}`);
        const wc = mainWindow?.webContents;
        if (!wc || wc.isDestroyed()) return;
        // A slow first paint would otherwise swallow the notice: a send before
        // the renderer subscribes goes nowhere.
        if (wc.isLoading()) wc.once('did-finish-load', () => wc.send(IPC.PLUGIN_GATE_STALE, found));
        else wc.send(IPC.PLUGIN_GATE_STALE, found);
      })
      .catch(() => {
        // detectStalePluginGates already swallows; belt and braces.
      });
  }, 5000);
  staleGateTimer.unref();

  // Dev Dock 아이콘: dev에선 패키징 안 된 제네릭 Electron 바이너리로 실행돼
  // macOS Dock에 기본 원자 아이콘이 뜬다. 패키지 빌드는 packagerConfig.icon으로
  // 실제 아이콘이 박히지만 dev는 그게 없으므로, 개발 편의상 실제 아이콘으로 교체.
  // packaged 빌드는 이미 올바른 아이콘이라 건드리지 않는다(!app.isPackaged 가드).
  if (!app.isPackaged && process.platform === 'darwin') {
    try {
      app.dock?.setIcon(path.join(app.getAppPath(), 'assets', 'icon.png'));
    } catch (err) {
      console.warn('[Main] dev Dock 아이콘 설정 실패(무시):', err);
    }
  }

  // Populate the native About panel (macOS shows this automatically in
  // the app menu; Windows/Linux render it when `app.showAboutPanel()`
  // is called from the tray). Including copyright + website here is
  // best-practice for downstream redistribution and complements the
  // bundled LICENSE / THIRD_PARTY_NOTICES files.
  app.setAboutPanelOptions({
    applicationName: 'wmux',
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: 'MIT License — see LICENSE in the install folder.',
    website: 'https://github.com/openwong2kim/wmux',
    iconPath: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '..', '..', 'assets', 'icon.png'),
  });

  // Create the BrowserWindow but DEFER renderer navigation until the
  // explicit loadMainRenderer() call below — after the console-message
  // relay, recovery hooks, and tray wiring are attached, and after the
  // daemon bootstrap has been KICKED (S-A Step 1 runs the renderer load in
  // parallel with the bootstrap; see the comment at the loadMainRenderer
  // call site for why the dda4c0c LOCAL-id-into-DAEMON-handler race that
  // originally motivated full serialization is now closed by the
  // get-ready-state resolver queue + paneGate instead of by ordering).
  // Plugin host (B-1): discover UI plugin bundles and serve them over
  // wmux-plugin:// to sandboxed iframes. Registered before the window
  // loads so panel iframes never race the protocol handler. Best-effort:
  // a broken plugins dir must never block app boot.
  try {
    const loader = new PluginHostLoader(getPluginTrustStore());
    await loader.loadAll();
    pluginHostLoader = loader;
    const failures = loader.listFailures();
    logLine('info', 'main', `plugin host: ${loader.list().length} plugin(s) loaded, ${failures.length} failed`);
    for (const f of failures) {
      logLine('warn', 'main', `plugin host: skipped "${f.name}": ${f.errors.join('; ')}`);
    }
  } catch (err) {
    logLine('warn', 'main', `plugin host load failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  registerPluginProtocolHandler(() => pluginHostLoader);
  markBoot('plugins-loaded');

  mainWindow = createWindow({ deferLoad: true });
  markBoot('window-created');
  console.log(`[Main] Window created (renderer load deferred): ${!!mainWindow}`);
  logLine('info', 'main', `window created (deferred): present=${!!mainWindow}`);

  // Relay renderer console messages (warn + error) into the persistent log
  // file so renderer-side instrumentation (e.g. useTerminal scrollback
  // .catch) survives the postmortem cycle. level enum: 0=verbose, 1=info,
  // 2=warning, 3=error. We capture 2 and 3 only — verbose/info from
  // renderer would otherwise drown the signal we care about.
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // Forward all renderer console messages to the main log file for
    // postmortem analysis. The previous `if (level < 2) return` filter
    // dropped every console.log (level 1), which hid renderer-side
    // diagnostics (AppLayout reconcile path, useTerminal mount events,
    // pty.reconnect outcomes) — exactly the lines needed to root-cause
    // IPC race conditions like the scrollback-restore PTY_DATA loss.
    // Per-level routing preserved so warn/error keep their own bucket.
    const lvl: 'info' | 'warn' | 'error' = level === 3 ? 'error' : level === 2 ? 'warn' : 'info';
    const where = sourceId ? `${sourceId}:${line}` : 'renderer';
    // P0-5c: feed the reveal-stats aggregator (`wmux doctor --performance`).
    // Cheap prefix check inside — non-`[wmux:reveal]` lines return immediately.
    revealStatsAggregator.ingest(message);
    logLine(lvl, 'renderer', `${where} — ${message}`);
  });

  adoptMainWindow(mainWindow);

  // Phase 2 — UsagePoller hidden-window cost control. We treat tray-hide
  // as "user not looking" so the poller's 30-min skip threshold kicks in
  // and we don't burn Anthropic quota for a UI nobody sees. Show always
  // unpauses immediately and forces a catch-up fetch.
  // System tray — lets the app stay alive when window is closed.
  // Phase A — A3/A5 fix (codex review P1, session 019e2af8): the callback
  // used to set isQuitting=true before tray.ts then called app.quit(). The
  // resulting before-quit handler hit `if (isQuitting) return` on its first
  // pass and skipped the entire daemon.shutdown race added in A3. Now the
  // callback is a no-op; before-quit's first pass sets isQuitting itself.
  createTray(mainWindow, {
    // Default Quit: detach only. before-quit's persistence path keeps the
    // daemon + every live session running; isQuitting is set by before-quit's
    // own first pass (not here), so the daemon.shutdown race is never skipped.
    onQuit: () => { /* no-op — before-quit handles isQuitting + detach */ },
    // Explicit full teardown: flip the flag BEFORE app.quit() so before-quit
    // takes the daemon.shutdown branch instead of the detach branch.
    onShutdownAll: () => { fullShutdownRequested = true; },
  });

  // Auto-start daemon and connect.
  //
  // Previously a one-shot `ensureDaemon()` call with a degrade-only
  // `disconnected` handler — once the daemon died, the app silently
  // ran in local-only mode for the rest of the session (no persistence,
  // no MCP notifications, no memory watchdog). Issue #54.
  //
  // `DaemonRespawnController` owns the full lifecycle now: initial
  // launch, exponential-backoff respawn (5 attempts, 1s→30s, reset
  // after 5 min healthy uptime), active health-ping probe to catch
  // daemon-hang cases the socket-close path misses, and renderer
  // signaling via `daemon:reconnecting` / `daemon:reconnected` /
  // `daemon:respawn-exhausted` so UX can show a toast/badge.
  daemonRespawnController = new DaemonRespawnController({
    ensureDaemon,
    createClient: (pipeName, token) => new DaemonClient(pipeName, token),
    onInstall: async (client) => {
      daemonClient = client;
      console.log('[Main] Connected to wmux-daemon (auth verified)');
      // DaemonClient has already sent subscribe -> identify, followed by a
      // post-identify subscribe when the daemon enforces the gate. Repeat the
      // idempotent identity RPC here so the presence report
      // is chained to an acknowledged classification even if the event
      // handshake's first identify attempt was transiently rejected. The
      // daemon refuses `daemon.presence.desktop` from a client it cannot place
      // — a report that withholds a notification must not be sendable by the
      // MCP server, the CLI, or an agent talked into it. Both are best-effort:
      // an old daemon without either method simply never learns the user is
      // present and keeps sending pushes.
      //
      // The presence report is a one-shot because a fresh daemon has never
      // heard a focus transition, and the user may have been sitting in a
      // focused window the whole time. Without it the app looks absent until
      // the next alt-tab. A new connection is a new pipe client id, so the
      // daemon starts from empty presence and this is the only thing that
      // fills it in.
      void client
        .rpc('daemon.client.identify', { role: 'main' })
        .then(() => {
          reportDesktopPresence(() => client, BrowserWindow.getFocusedWindow() !== null);
        })
        .catch(() => {
          // Old daemon: no identify, therefore no presence, therefore pushes.
        });
      // Handler swap to daemon-routed mode. The microsecond window where
      // pty/* handlers are torn down and re-registered is the same
      // surface the original code used; the swap is logged for the
      // race-investigation breadcrumb trail kept by previous fixes.
      logLine('info', 'main', 'handler swap (daemon connect): cleanup begin');
      cleanupHandlers();
      logLine('info', 'main', 'handler swap (daemon connect): cleanup done, register begin');
      cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow, daemonClient, {
        ...mcpHandlerOptions,
        invokeRendererRpc,
      });
      logLine('info', 'main', 'handler swap (daemon connect): register done');
      // Mount the notification router now that we have a live daemon
      // client. PTY data flows through daemon → DaemonClient events,
      // and this router translates them into the same renderer-facing
      // IPC signals PTYBridge produces in local mode.
      daemonNotificationRouter?.stop();
      // M1: onClaudeTurnEnd rides along because a hook signal may now reach the
      // daemon without ever passing through registerHooksRpc — the router is the
      // only place left that sees the turn end. (`now` / `getMirror` keep their
      // defaults.)
      daemonNotificationRouter = new DaemonNotificationRouter(
        client,
        () => mainWindow,
        () => hookSignalRouter,
        undefined,
        undefined,
        onClaudeTurnEnd,
      );
      daemonNotificationRouter.start();
      // LanLink PR-2 — mount the remote-inbox cursor-pull bridge. On every
      // (re)connect it pulls the daemon's durable inbox from its retained cursor
      // and materializes read-only remote items to the renderer over a dedicated
      // IPC channel (never the PTY paste / a2a execute path). Re-created per
      // install like the notification router; the cursor lives in module scope.
      remoteInboxBridge?.stop();
      remoteInboxBridge = new RemoteInboxBridge(() => mainWindow);
      remoteInboxBridge.start(client);
      // X1 — context fold (git branch / worktree / ports / PR badge).
      workspaceContextRouter?.stop();
      workspaceContextRouter = new WorkspaceContextRouter(client, () => mainWindow);
      workspaceContextRouter.start();
      if (mainWindow && !mainWindow.isDestroyed()) {
        // RCA A3/A8 — every install (initial AND every reconnect/respawn) emits
        // daemon:connected, which drives the renderer's late reconcile. Logging
        // the emit makes the "reconnect → re-reconcile" cadence visible in the
        // main log file so it can be correlated with any renderer ptyId-clear.
        // The preceding handler-swap lines + any 'daemon hang detected' /
        // 'respawn attempt' lines above distinguish initial from reconnect.
        logLine('info', 'main', 'emitting daemon:connected → renderer will re-reconcile PTYs');
        mainWindow.webContents.send('daemon:connected');
      }
      // Phase A — A7. Run the one-time legacy scrollback migration on
      // the first daemon-healthy transition. Idempotent — subsequent
      // calls (e.g. after respawn) return status=already-migrated and
      // are no-ops; safe to invoke on every install.
      try {
        const result = migrateScrollbackOnce(app.getPath('userData'), app.getVersion());
        if (result.status === 'migrated') {
          console.log(`[Main] A7 scrollback legacy migration → ${result.legacyDir}`);
        } else if (result.status === 'retry-needed') {
          console.warn(`[Main] A7 scrollback migration retry-needed: ${result.error}`);
        }
      } catch (err) {
        console.warn('[Main] A7 scrollback migration threw:', err);
      }
    },
    onUninstall: () => {
      console.warn('[Main] Daemon disconnected, falling back to local PTY');
      daemonNotificationRouter?.stop();
      daemonNotificationRouter = null;
      remoteInboxBridge?.stop();
      remoteInboxBridge = null;
      workspaceContextRouter?.stop();
      workspaceContextRouter = null;
      daemonClient = null;
      // Phase A — A6. Notify the renderer so the daemon-mode .txt
      // write/load gates open again (local mode preserves the
      // pre-existing scrollback path). Without this, the renderer
      // would still treat itself as daemon-connected and skip the
      // .txt autosave even though no daemon is replaying PTY data.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('daemon:disconnected');
      }
      logLine('warn', 'main', 'handler swap (daemon disconnect): cleanup begin');
      cleanupHandlers();
      logLine('warn', 'main', 'handler swap (daemon disconnect): cleanup done, register begin');
      cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow, undefined, {
        ...mcpHandlerOptions,
        invokeRendererRpc,
      });
      logLine('warn', 'main', 'handler swap (daemon disconnect): register done');
    },
    emit: (event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (event.type === 'reconnecting') {
        mainWindow.webContents.send('daemon:reconnecting', {
          attempt: event.attempt,
          backoffMs: event.backoffMs,
        });
      } else if (event.type === 'reconnected') {
        mainWindow.webContents.send('daemon:reconnected');
      } else if (event.type === 'replacing') {
        // B′: renderer shows an "updating daemon…" toast so the pane freeze
        // + recovery replay reads as intentional.
        mainWindow.webContents.send('daemon:replacing');
      } else if (event.type === 'respawn-exhausted') {
        // Forward to renderer (channel exists since v2.7.x — preload.ts
        // and daemonMode.ts both subscribe). The renderer doesn't yet
        // render a toast for this signal, but a future UX iteration
        // will hook the lastError payload directly.
        mainWindow.webContents.send('daemon:respawn-exhausted', { lastError: event.lastError });
        // Native OS dialog gives the user a visible, persistent breadcrumb
        // even when wmux is sitting in the tray. showErrorBox blocks the
        // main thread until dismissed; that's harmless here because the
        // daemon-respawn budget exhausted means there is no daemon for the
        // main thread to talk to anyway. Suppress for automated runs.
        if (process.env.WMUX_NO_DIALOG !== '1') {
          const hint = event.lastError && event.lastError.length > 0
            ? event.lastError
            : 'wmux could not bring the daemon back up after 5 retries.';
          dialog.showErrorBox(
            'wmux daemon unavailable',
            `${hint}\n\nwmux will keep running in local-only mode. To recover:\n  1. Quit wmux from the tray.\n  2. In an elevated PowerShell, run:  Get-Process | Where-Object { $_.Path -like '*wmux*' }\n  3. taskkill /F /PID <pid>  for any leftover daemon process.\n  4. Delete ~/.wmux/daemon.pid if it exists.\n  5. Re-launch wmux.`,
          );
        }
      }
    },
    logger: {
      info: (msg) => { logLine('info', 'daemon-respawn', msg); },
      warn: (msg) => { logLine('warn', 'daemon-respawn', msg); },
      error: (msg) => { logLine('error', 'daemon-respawn', msg); },
    },
    // B′ stale-daemon auto-replacement (plans/daemon-auto-replace-plan-
    // 2026-07-05.md). Fires only when a REUSED daemon is positively older
    // than this app; the whole destructive path rides the daemon's own
    // daemon.shutdown suspend loop + the launcher's verified-kill guards.
    replacement: {
      appVersion: app.getVersion(),
      channelsEpoch: CHANNELS_EPOCH,
      raceShutdown: async (client, timeoutMs) => {
        const r = await raceDaemonShutdown(client, timeoutMs);
        return { acked: r.ok, stateSaved: r.stateSaved };
      },
      checkLiveness: checkProcessLiveness,
      killVerifiedPid: (pid) => killVerifiedDaemonPid(pid, { definitiveOnly: true }),
      // #545 — tasklist-independent confirmation that the old daemon finished
      // shutting down, so an AV-blocked process probe can't turn a clean
      // shutdown into a 5 s burn plus dead-end.
      isPipeGone: () => isDaemonPipeGone(),
      // dispose() fires on every quit; only a tray "Shut down completely"
      // may kill a freshly spawned replacement daemon (detach Quit wants
      // it left alive with the recovered sessions).
      isFullShutdown: () => fullShutdownRequested,
    },
  });
  markBoot('daemon-bootstrap-start');
  // S-A Step 1 — kick the bootstrap WITHOUT awaiting so the renderer load
  // below runs in parallel with the daemon spawn/connect (boot-trace showed
  // renderer ~625 ms vs bootstrap ~464 ms serialized back-to-back; the
  // shorter leg now hides behind the longer one). The .catch preserves the
  // v2.8.1 invariant: a bootstrap failure must still fall through to
  // markDaemonReady() so the renderer unblocks into local-PTY mode.
  const daemonBootstrapP = daemonRespawnController.bootstrap().catch((err) => {
    console.warn('[Main] Daemon auto-start failed, using local PTY:', err);
  });

  // S-A Step 1 — load the renderer NOW, in parallel with the daemon
  // bootstrap above. This deliberately reopens the dda4c0c window (renderer
  // mounting while the LOCAL→DAEMON handler swap happens mid-flight), which
  // is safe today because two defenses that did not exist back then both
  // gate the race:
  //   (a) the renderer's first `daemon.whenReady()` invoke parks in the
  //       `daemon:get-ready-state` pending-resolver queue until
  //       markDaemonReady() flushes it after the bootstrap settles, and
  //   (b) paneGate keeps every renderer `pty.create` path closed until the
  //       startup reconcile (which itself awaits whenReady) flips it to
  //       'ready' — so no pty id can be minted against a mid-swap handler
  //       topology.
  // Companion changes gate the renderer paths that became reachable under
  // the new timing: AppLayout's late-reconcile listener plus the three
  // event-driven pty.create entry points (Ctrl+T, Ctrl+` floating pane,
  // palette new-surface) whose handlers live outside the paneGate
  // placeholder subtree.
  //
  // Load-failure recovery (adversarial review P2): these listeners used to
  // be registered later in the ready handler with no intervening await, so
  // they could not miss the first load failure. Now that an `await
  // daemonBootstrapP` sits between the load and the rest of the handler,
  // they must be attached BEFORE loadMainRenderer() or a did-fail-load
  // fired during the bootstrap await (dev server not up yet, corrupt
  // packaged assets) would escape the auto-reload backoff entirely.
  //
  // dev에서 Vite dev server가 아직 준비 전이거나(포트 점유로 5174 지연) 죽었을 때
  // did-fail-load가 발생한다. 기존엔 2초 고정 간격으로 무한 reload해 콘솔을
  // ERR_CONNECTION_REFUSED로 도배했다. 지수 백오프 + 재시도 상한으로 교체한다.
  // Codex review catch: dispatchNotification's "window alive → send IPC"
  // path silently loses notifications whenever the window exists but its
  // content is mid-reload (crash recovery, did-fail-load retry, dev HMR) —
  // a live BrowserWindow does not imply a live useNotificationListener
  // subscription. did-start-loading fires on every navigation regardless of
  // cause, so this correctly re-arms for the full reload→remount window;
  // the renderer flips it back via IPC.NOTIFICATION_LISTENER_READY once
  // useNotificationListener's effect actually resubscribes.
  if (mainWindow && !mainWindow.isDestroyed()) {
    loadMainRenderer(mainWindow);
    markBoot('renderer-load-triggered');
    logLine('info', 'main', 'renderer load triggered in parallel with daemon bootstrap');
  }

  await daemonBootstrapP;
  markBoot('daemon-bootstrap-end');

  // v2.8.1 hotfix (Bug 3): unblock any renderer that already invoked
  // `daemon:get-ready-state`. From this point on the handler answers
  // synchronously with the current `daemonClient` value, which means
  // mainWindow.reload() recovery paths (renderer crash, unresponsive,
  // did-fail-load) still get a truthful answer instead of deadlocking
  // on a one-shot event the previous preload instance consumed.
  // With the parallel renderer load above, the FIRST whenReady() invoke
  // typically arrives before the bootstrap settles — it parks in the
  // pending-resolver queue and this call flushes it with the now-final
  // `daemonClient` value. Order still matters: mark ready only AFTER the
  // bootstrap promise settles so the flushed answer reflects the decided
  // daemon-vs-local topology.
  markDaemonReady();

  // Handle system sleep/wake — verify PTY processes survived.
  //
  // The previous implementation relied on `process.kill(pid, 0)`, which is
  // documented as unreliable on Windows (always returns success even for
  // stale PIDs). That made the post-wake health check a no-op on the very
  // platform we ship most. We now use ProcessMonitor.isAlive (`tasklist`)
  // which is reliable on Windows and consistent with the daemon's own
  // liveness checks.
  //
  // Defense-in-depth: if the FIRST tasklist call after wake reports every
  // PTY dead at once, that's almost always the OS still settling rather
  // than actual mass death. Wait briefly and re-verify each PID before
  // sending pty:exit so the renderer can never be told "all your terminals
  // exploded" because the OS hadn't finished waking up.
  powerMonitor.on('resume', async () => {
    console.log('[Main] System resumed from sleep — checking PTY health');
    // Sleep can invalidate GPU texture memory without any context-loss event
    // firing; tell the renderer so it can rebuild the shared glyph atlas
    // (terminal/atlasWakeRecovery.ts). Sent before the PTY health check —
    // the visual repair must not wait on tasklist round-trips.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SYSTEM_RESUMED);
    }
    const active = ptyManager.getActiveInstances();
    if (active.length === 0) return;

    const checks: Array<{ id: string; pid: number }> = [];
    for (const { id } of active) {
      const instance = ptyManager.get(id);
      if (!instance) continue;
      checks.push({ id, pid: instance.process.pid });
    }
    if (checks.length === 0) return;

    const apparentlyDead: Array<{ id: string; pid: number }> = [];
    for (const c of checks) {
      let alive = true;
      try {
        alive = await ProcessMonitor.isAlive(c.pid);
      } catch {
        alive = true; // on error, assume alive — defer to next signal
      }
      if (!alive) apparentlyDead.push(c);
    }
    if (apparentlyDead.length === 0) return;

    const massDeath = apparentlyDead.length === checks.length && checks.length >= 2;
    if (massDeath) {
      // Suspicious — wait for the OS to settle, then re-verify each PID.
      // Mass-dead-on-wake is a known false-positive class on Windows.
      await new Promise((r) => setTimeout(r, 1000));
    }

    for (const { id, pid } of apparentlyDead) {
      // Skip if already cleaned up by another path
      if (!ptyManager.get(id)) continue;

      let confirmedDead = !massDeath;
      if (massDeath) {
        try {
          confirmedDead = !(await ProcessMonitor.isAlive(pid));
        } catch {
          confirmedDead = false;
        }
      }
      if (!confirmedDead) continue;
      if (!ptyManager.get(id)) continue;

      console.warn(`[Main] PTY ${id} (pid ${pid}) died during sleep`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:exit', id, -1);
      }
      ptyBridge.cleanupInstance(id);
    }
  });

  // M0-e — hydrate MetadataStore from disk, then wire the persist callback
  // so subsequent `metadataStore.set/clear/onPaneDeleted` flush to disk
  // BEFORE the `pane.metadata.changed` event publishes (race spec #1).
  //
  // Hydrate first, then wire — otherwise the hydrate path itself would
  // re-trigger a persist write of state we just read from disk.
  //
  // M0-f follow-up (codex P2): v2.8.x → v2.9.0 migration. When
  // `metadata.json` does not exist yet (first boot after upgrade),
  // `loadMetadata()` returns null. `session.json` still carries every
  // user-set label/role/status/custom on `PaneLeaf.metadata`. Without the
  // lift below, `pane.list` would still render correctly (it falls back
  // to the renderer's PaneLeaf.metadata — M0-c P2 fix) but
  // `pane.getMetadata` would return `{}/version 0`, and the next
  // merge-mode write would silently drop the legacy fields. We migrate
  // them into the store and persist immediately so the second boot uses
  // metadata.json as the source of truth and skips this branch.
  try {
    const persistedMetadata = sessionManager.loadMetadata();
    if (persistedMetadata) {
      metadataStore.hydrate(persistedMetadata);
    } else {
      const session = sessionManager.load();
      if (session) {
        const migrated = collectLegacyMetadata(session);
        if (migrated.length > 0) {
          // Hydrate directly, then persist synchronously. The persist
          // callback is wired AFTER this block so hydrate() does not
          // recursively trigger saveMetadataSync; we drive the initial
          // write here explicitly so the next boot reads metadata.json.
          metadataStore.hydrate({ schema_version: 1, entries: migrated });
          try {
            sessionManager.saveMetadataSync(metadataStore.serialize());
            console.log(
              `[boot] migrated ${migrated.length} legacy PaneLeaf.metadata entries to MetadataStore`,
            );
          } catch (persistErr) {
            // Non-fatal: hydrate succeeded and the in-memory store has the
            // legacy data, so this boot is correct. The next mutation goes
            // through the persist callback below and will retry the write.
            console.error('[Main] legacy metadata persist failed:', persistErr);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Main] metadata hydrate failed; starting clean:', err);
  }
  metadataStore.setPersist((shape) => {
    sessionManager.saveMetadataSync(shape);
  });

  // P2 — push hydrated pane labels to the renderer. In daemon mode this hydrate
  // lands AFTER the renderer has mounted (its mount-time `metadata.snapshot`
  // pull therefore sees an empty store), so re-broadcast each persisted label
  // through the existing METADATA_UPDATE relay — the renderer's onUpdate handler
  // seeds its volatile paneLabel mirror, re-displaying renames after restart.
  // The renderer is already loaded + listening by now (boot order verified); a
  // did-finish-load fallback re-pushes for the rare hydrate-before-mount boot.
  const pushHydratedPaneLabels = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    for (const entry of metadataStore.snapshot().entries) {
      const label = entry.metadata.label;
      const role = readOrchRole(entry.metadata.custom);
      // Re-push a pane on boot if it carries EITHER a label or a role, so both
      // volatile mirrors re-seed after restart. Send '' for the absent one so
      // the corresponding mirror entry is dropped rather than left stale.
      if ((typeof label === 'string' && label.length > 0) || role) {
        broadcastMetadataUpdate(mainWindow, {
          paneId: entry.paneId,
          paneLabel: typeof label === 'string' ? label : '',
          paneRole: role ?? '',
        });
      }
    }
  };
  pushHydratedPaneLabels();
  mainWindow.webContents.once('did-finish-load', pushHydratedPaneLabels);

  // Final-review follow-up (P0-1): wire pane lifecycle into MetadataStore.
  //
  // Without this subscriber, `MetadataStore.onPaneDeleted()` had no
  // production caller — only unit tests exercised it. Two consequences:
  //   1. `metadata.json` grew monotonically as panes were created/closed;
  //      every closed pane left a tombstone slot in the in-memory map and,
  //      worse, kept its label/role/status durably on disk.
  //   2. After daemon restart, `hydrate()` re-seeded every closed-pane
  //      entry, so `pane.list` and `pane.getMetadata` would surface
  //      metadata for paneIds that no longer existed in the renderer's
  //      pane tree — ghost panes resurrected on every boot.
  //
  // The renderer publishes `pane.closed` through preload IPC (see
  // `registerHandlers.ts` `onEventsPublish`), which lands as an
  // `eventBus.emit(...)` call. We subscribe to the main-side EventBus so
  // any future producer of `pane.closed` (PTYBridge, daemon broadcast)
  // gets the same tombstone treatment without duplicating the wiring.
  eventBus.subscribe((event) => {
    if (event.type !== 'pane.closed') return;
    try {
      metadataStore.onPaneDeleted(event.paneId);
    } catch (err) {
      // onPaneDeleted swallows persist failures internally; this catch
      // is a belt-and-suspenders guard against a future refactor that
      // throws synchronously (e.g. a validate step). The pane-close
      // signal must never propagate an error back to the emitter.
      console.error('[Main] metadataStore.onPaneDeleted failed:', err);
    }
  });

  // P2 — pane label relay. MetadataStore emits `pane.metadata.changed` only on
  // the in-process EventBus; tee it onto the existing METADATA_UPDATE IPC as a
  // paneId-only payload so the renderer's volatile paneLabel mirror tracks
  // renames/clears. An empty/absent label (rename-to-empty, clear, or the
  // onPaneDeleted tombstone) sends '' so the mirror entry is dropped.
  eventBus.subscribe((event) => {
    if (event.type !== 'pane.metadata.changed') return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    broadcastMetadataUpdate(mainWindow, {
      paneId: event.paneId,
      paneLabel: event.metadata.label ?? '',
      paneRole: readOrchRole(event.metadata.custom) ?? '',
    });
  });

  // Write auth token BEFORE starting pipe server — prevents race where
  // MCP client reads old token while new pipe is already listening
  const authToken = pipeServer.getAuthToken();
  if (isMcpBrokerEnabled()) {
    // Gate shim registration on broker readiness: if the broker can't serve
    // within the timeout, register the full bundle so agents still get tools
    // (W1). whenReady never rejects and caps boot delay at the timeout.
    mcpBrokerSupervisor.start();
    const brokerReady = await mcpBrokerSupervisor.whenReady(4000);
    await mcpRegistrar.register(authToken, { useShim: brokerReady });
  } else {
    await mcpRegistrar.register(authToken);
  }
  pipeServer.start();
  autoUpdater.start();
  markBoot('ready-end');
  // Log sink is up by now, so the summary line (unlike the early per-mark
  // stderr lines) is durably teed into the daily log file for postmortems.
  emitBootSummary();
});

// Browser-pane popup policy (X3). The BrowserPanel webview sets allowpopups
// (without it the guest-view manager rejects window.open before any handler
// runs), and this handler is the actual gate: never create a new window;
// load http(s) popups (target=_blank links) in the SAME webview instead so
// in-pane browsing keeps working. Applies to every <webview> guest — the
// only one in the app is BrowserPanel. Known limitation: window.open-based
// OAuth flows that postMessage back to their opener cannot work with the
// same-view replacement.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void contents.loadURL(url);
    }
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => {
  // Don't quit — stay alive in system tray.
  // Actual quit is triggered from the tray "Quit" menu item.
});

// quitAndInstall() closes every window and only installs once the window list
// empties. With isQuitting still false the hide-to-tray close intercept above
// cancels that close, so the window list never empties, the install never runs,
// and ShipIt waits forever on a process that will not exit. Flipping the flag
// here is what lets the windows close through.
//
// This used to hang off `app.on('before-quit-for-update')`. That listener never
// fired: the event belongs to Electron's `autoUpdater`, not to `app`, and the
// `as unknown as NodeJS.EventEmitter` cast that was added to "work around the
// missing type" silenced the very error that said so. The updater now calls
// this directly, so there is no event name left to get wrong.
//
// The full before-quit teardown is skipped on this path, so anything it
// guarantees has to be done here: the broker is stopped explicitly, and the
// session state is flushed the same way the darwin before-quit pass flushes it
// (the renderer-side save already ran in AutoUpdater.performInstall, but that
// does not cover the main process's pending debounced write).
// Wiring every main window needs, wherever it was created. Boot, the Dock
// 'activate' path and the aborted-install recovery all built windows their own
// way, and only boot attached the hide-to-tray close intercept — a window from
// either of the other two destroyed itself on close instead of hiding.
function adoptMainWindow(win: BrowserWindow): void {
  attachWindowRecovery(win);

  win.on('closed', () => {
    // Guarded: a recovery window may be adopted while the old reference is
    // still being torn down, and only the current one may clear the binding.
    if (mainWindow === win) mainWindow = null;
  });

  // Intercept window close — hide to tray instead of destroying
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Phase 2 — UsagePoller hidden-window cost control. We treat tray-hide
  // as "user not looking" so the poller's 30-min skip threshold kicks in
  // and we don't burn Anthropic quota for a UI nobody sees. Show always
  // unpauses immediately and forces a catch-up fetch.
  win.on('hide', () => {
    usagePoller.setWindowVisible(false);
    accountUsageService.setWindowVisible(false);
    // Quit-to-tray is the accumulation blind spot: the daemon keeps every
    // live session (and any agent inside it) running with no visible UI.
    // Refresh the tray's session-count nudge so the user can see how much is
    // still alive in the background. Best-effort — a tray hint must never
    // block window hide, and listSessions may reject mid daemon-respawn.
    void refreshTraySessionCount();
  });
  win.on('show', () => {
    usagePoller.setWindowVisible(true);
    accountUsageService.setWindowVisible(true);
    // Window is visible again — the panes speak for themselves, so clear the
    // background-session nudge back to the plain "wmux" tooltip/menu. Bump the
    // refresh token first so a slow in-flight hide refresh can't overwrite this
    // clear with a stale count after it resolves. (codex review P3)
    trayRefreshToken++;
    updateTraySessionCount(null);
  });

  // A reload/remount means the renderer's notification listener is gone until
  // it resubscribes; re-arm so a stale "ready" cannot outlive the old renderer.
  // The renderer flips it back via IPC.NOTIFICATION_LISTENER_READY.
  win.webContents.on('did-start-loading', () => {
    markRendererNotificationListenerNotReady();
  });

  // Reload backoff. Attached here rather than at the boot site so every window
  // gets it — the update-recovery window in particular exists only to render a
  // failure message, and a blank window that never retries would reproduce the
  // silence it was created to break.
  let didFailLoadCount = 0;
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    // ERR_ABORTED(-3): 새 내비게이션이 이전 로드를 정상 취소한 경우 — 재시도 불필요.
    if (errorCode === -3) return;
    console.error('[Main] Page failed to load:', errorCode, errorDescription);
    didFailLoadCount += 1;
    if (didFailLoadCount > 10) {
      console.error('[Main] did-fail-load 10회 초과 — 자동 reload 중단. dev server(npm start)나 빌드 자산을 확인하세요.');
      return;
    }
    const delay = Math.min(500 * 2 ** (didFailLoadCount - 1), 30_000);
    setTimeout(() => {
      if (!win.isDestroyed()) win.reload();
    }, delay);
  });
  win.webContents.on('did-finish-load', () => {
    didFailLoadCount = 0; // 로드 성공 — 백오프 카운터 리셋
    console.log('[Main] Page loaded successfully');
  });
}

function prepareInstallQuit(): void {
  isQuitting = true;
  mcpBrokerSupervisor.stop();
  // The full before-quit teardown is skipped on this path — the agent Chrome
  // must not outlive the app across an update install.
  try {
    chromeRegistry.disposeAll();
    chromeSurfaceStore.flushSync();
    getActionCacheStore().flushSync();
  } catch (err) {
    console.error('[Main] install-quit chromeRegistry.disposeAll failed:', err);
  }
  try {
    sessionManager.flushSync();
  } catch (err) {
    console.error('[Main] install-quit flushSync failed:', err);
  }
}

// The handoff above is one-way unless it can be undone. If Squirrel never
// terminates us, the windows are already gone and `isQuitting` makes
// 'second-instance' and 'activate' early-return — a live process with no window
// and no way back, recoverable only with kill -9 (observed 2026-07-12). The
// updater's watchdog calls this to put the app back within reach before it
// reports the failure.
async function abortInstallQuit(): Promise<void> {
  isQuitting = false;
  // stop() latches, so start() alone would be a no-op — without resume() one
  // aborted install leaves MCP down for the rest of the session, silently.
  mcpBrokerSupervisor.resume();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    return;
  }
  // quitAndInstall already destroyed the window (isQuitting was true, so the
  // hide-to-tray intercept let the close through). Build a new one and wait for
  // its renderer, or the caller's error IPC lands before any listener exists.
  // deferLoad so the reload backoff and console wiring are attached before the
  // navigation starts — this window's whole job is to render the failure.
  const win = createWindow({ deferLoad: true });
  mainWindow = win;
  adoptMainWindow(win);
  loadMainRenderer(win);
  await new Promise<void>((resolve) => {
    if (win.isDestroyed()) { resolve(); return; }
    if (!win.webContents.isLoading()) { resolve(); return; }
    const done = () => { clearTimeout(cap); resolve(); };
    // Never block the failure report on a renderer that will not finish.
    const cap = setTimeout(done, 10_000);
    win.webContents.once('did-finish-load', done);
    win.once('closed', done);
  });
}

/**
 * #980 — outer bound on the whole before-quit teardown.
 *
 * Generous on purpose: daemon.shutdown alone is budgeted 8 s and the renderer
 * save adds ~0.5 s, so a healthy quit never comes close. This is not a
 * performance knob — it is the guarantee that a quit ALWAYS ends in an exit.
 */
const QUIT_HARD_DEADLINE_MS = 20_000;

/**
 * #980 — how long the renderer gets to run its beforeunload save. Short: the
 * save is a synchronous dispatch, so anything past this is a renderer that is
 * not going to answer at all.
 */
const RENDERER_SAVE_TIMEOUT_MS = 3_000;

app.on('before-quit', async (e) => {
  if (isQuitting) return; // second pass — let quit proceed
  e.preventDefault();
  isQuitting = true;

  // #980 — everything below is a sequence of awaits, and the force-exit
  // fallback at the BOTTOM is only armed once they have all resolved. Anything
  // that never settles therefore leaves a process that has preventDefault'ed
  // its own quit, latched `isQuitting`, and armed no timer: alive indefinitely,
  // with 'second-instance' and 'activate' both early-returning on that latch.
  //
  // Not hypothetical. On the install path the updater force-killed our own
  // renderer and then quit, so the session-save await below was addressing a
  // process that no longer existed — and the main process stayed up for a day
  // holding the install root the installer was waiting to see released. The
  // renderer kill is fixed at its source (AutoUpdater), but a quit that can
  // wedge AT ALL is the more expensive defect: it strands the user with a live
  // process no click can reach, and on the update path it silently blocks every
  // future release. So the deadline is armed FIRST, before anything can hang.
  //
  // Deliberately never cleared: a normal quit exits long before it fires, and
  // clearing it anywhere would reintroduce a window in which nothing is armed.
  const quitDeadline = setTimeout(() => {
    console.error(`[Main] before-quit did not finish within ${QUIT_HARD_DEADLINE_MS}ms — forcing app.exit(0)`);
    logLine('error', 'main', `before-quit hard deadline (${QUIT_HARD_DEADLINE_MS}ms) fired — forcing exit`);
    app.exit(0);
  }, QUIT_HARD_DEADLINE_MS);
  quitDeadline.unref();

  // Broker dies with the app: shims exit and hosts mark the server down,
  // same visible behavior as the old per-agent child dying with wmux.
  mcpBrokerSupervisor.stop();

  // macOS 로그아웃/재시작/종료 대응(P4): win32의 'session-end' flushSync와 동등한
  // 동기 세션 flush. macOS는 WM_ENDSESSION 대신 Apple Event로 quit을 보내고
  // 이 async 핸들러가 끝까지 못 돌 수 있으므로, 어떤 await보다도 먼저 pending
  // debounced write를 동기로 밀어 넣는다(디스크는 이벤트 기반 sync save로 이미
  // 최신 — 이 flush는 session-end 경로와 동일한 안전망). 이중 실행 가드는 위의
  // `isQuitting` 게이트가 담당한다: 두 번째 pass는 이 지점에 도달하지 않는다.
  if (process.platform === 'darwin') {
    try {
      sessionManager.flushSync();
    } catch (err) {
      console.error('[Main] before-quit flushSync failed:', err);
    }
  }

  // Attempt session save from renderer.
  //
  // #980 — bounded. `isCrashed()` only reports a renderer Electron has already
  // noticed is gone; between an external kill and that notification the guard
  // passes and this call goes to a process that will never answer. The periodic
  // save is the fallback the catch below already relies on, so waiting longer
  // than the save itself needs buys nothing and risks everything.
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isCrashed()) {
    try {
      await Promise.race([
        mainWindow.webContents.executeJavaScript(
          `try { window.dispatchEvent(new Event('beforeunload')); } catch(e) {}`
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('renderer session-save timed out')), RENDERER_SAVE_TIMEOUT_MS),
        ),
      ]);
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch {
      // Renderer unavailable, or too slow to answer — rely on last periodic save
    }
  }

  // Every teardown step below is ISOLATED in its own try/catch. Two guarantees
  // ride on this:
  //
  //  1. app.quit() below and the 1.5s force-exit fallback timer must ALWAYS be
  //     reached. If this async handler's promise rejected mid-sequence while
  //     `isQuitting` is already `true`, the app wedges forever: the
  //     'second-instance' and 'activate' handlers both early-return on
  //     `if (isQuitting) return`, so a Dock click, relaunch, or taskbar click
  //     silently no-ops against a process that is alive but has zero windows
  //     and no way back — only `kill -9` recovers. Observed 2026-07-12 (macOS):
  //     0 windows, unresponsive to `app.on('activate')`.
  //
  //  2. A single earlier disposer failure must NOT skip the daemon-shutdown /
  //     pid-kill branch (Codex P1). An earlier version wrapped the whole
  //     sequence in ONE try, so a throw from e.g. cleanupHandlers() jumped
  //     straight to the catch and skipped daemon shutdown — an explicit
  //     "Shut down wmux (close all sessions)" would then let the app exit with
  //     the daemon + PTYs still running. Per-step isolation keeps the daemon
  //     branch reachable no matter what the best-effort disposers do.
  const safeStep = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      console.error(`[Main] before-quit step "${label}" threw — continuing:`, err);
      logLine('error', 'main', `before-quit step ${label} threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  };

  safeStep('cleanupHandlers', () => cleanupHandlers());
  safeStep('disposeFirstRunHandlers', () => disposeFirstRunHandlers());
  safeStep('disposeDeckHandler', () => disposeDeckHandler());
  safeStep('disposeWorkspaceMirrorHandler', () => disposeWorkspaceMirrorHandler());
  safeStep('disposeHooksRpc', () => disposeHooksRpc());
  safeStep('disposeUsagePollerListener', () => disposeUsagePollerListener());
  safeStep('usagePoller.dispose', () => usagePoller.dispose());
  safeStep('disposeAccountUsageListener', () => disposeAccountUsageListener());
  safeStep('cleanupAccountUsageIpc', () => {
    ipcMain.removeHandler(IPC.ACCOUNT_USAGE_LIST);
    ipcMain.removeAllListeners(IPC.ACCOUNT_USAGE_REFRESH);
  });
  // Tear down the respawn controller BEFORE the daemon-shutdown race so
  // a daemon close during the race window can't trigger a respawn attempt
  // while the rest of the app is exiting. `dispose()` only stops timers
  // and detaches listeners — it does NOT call `onUninstall()`, so the
  // shutdown-race path below remains the single authority for taking the
  // client offline cleanly.
  safeStep('daemonRespawnController.dispose', () => {
    daemonRespawnController?.dispose();
    daemonRespawnController = null;
  });

  // tmux-style persistence (the entire reason the daemon exists): a normal
  // Quit must NOT kill the daemon. We DETACH — close our control socket and
  // leave every live PTY session running inside the daemon. Watchdog keeps the
  // daemon alive while sessions>0 (idle-shutdown only fires once the last pane
  // is closed AND no client is attached — Watchdog.ts:159), and the next
  // launch reconnects via ensureDaemon (ping → spawned:false) and
  // AppLayout.reconcilePtys() reattaches each pane to its still-live session,
  // running processes and all.
  //
  // Only an explicit "Shut down wmux (close all sessions)" from the tray flips
  // fullShutdownRequested → the teardown branch: ask the daemon to shut down
  // gracefully (it dumps RingBuffers + saves state), and if that RPC doesn't
  // land in time, pid-kill it so a wedged daemon can't survive a teardown the
  // user explicitly asked for.
  //
  // `clientAtQuit` captures the reference BEFORE any await: the daemon may
  // close its socket mid-teardown, firing the module-level 'disconnected'
  // handler that nulls `daemonClient`. Without a local capture the later
  // `disconnect()` would deref null and the unhandled rejection could stall
  // app.quit().
  const clientAtQuit = daemonClient;
  try {
    if (clientAtQuit?.isConnected) {
      if (fullShutdownRequested) {
        // Daemon-side hard timeout guard is 10 s; 8 s keeps us safely under it
        // while giving large-session daemons room to flush RingBuffers.
        const FULL_SHUTDOWN_TIMEOUT_MS = 8_000;
        console.log(
          `[Main] Full shutdown — racing daemon.shutdown (${FULL_SHUTDOWN_TIMEOUT_MS}ms budget)`,
        );
        logLine('info', 'main', 'full-shutdown: racing daemon.shutdown');
        const shutdownStart = Date.now();
        const race = await raceDaemonShutdown(clientAtQuit, FULL_SHUTDOWN_TIMEOUT_MS);
        const elapsed = Date.now() - shutdownStart;
        if (race.ok) {
          console.log(`[Main] daemon.shutdown ack received (elapsed=${elapsed}ms)`);
        } else {
          console.warn(
            `[Main] daemon.shutdown did not complete (elapsed=${elapsed}ms): ${race.error} — pid-kill backstop`,
          );
          logLine('warn', 'main', `full-shutdown: daemon.shutdown timed out (${race.error}); invoking pid-kill backstop`);
          const killed = killDaemonByPidFile();
          logLine('warn', 'main', `full-shutdown: pid-kill backstop ${killed ? 'killed the daemon' : 'found no verified daemon to kill'}`);
        }
      } else {
        console.log('[Main] Quit — detaching from daemon; live sessions stay alive (tmux-style persistence)');
        logLine('info', 'main', 'quit: detaching from daemon, sessions remain live (persistence)');
      }
      // Detach our half of the control pipe in BOTH branches. In full-shutdown
      // the daemon is already gone (RPC ack) or killed (backstop), so this just
      // cleans up our socket; in the detach branch it is the whole operation.
      // Best-effort — if the 'disconnected' handler already tore the socket
      // down, disconnect() may throw; swallow it so the quit sequence proceeds.
      try {
        await clientAtQuit.disconnect();
      } catch (err) {
        console.warn('[Main] daemon disconnect threw (likely already torn down):', err);
      }
      daemonClient = null;
    } else {
      // Local mode (daemon never connected): PTYs are children of main and die
      // with us regardless — dispose explicitly for a clean exit. There is no
      // persistence in local mode; that is the cost of running without a daemon.
      ptyManager.disposeAll();
      // Codex P2: an explicit "Shut down wmux (close all sessions)" must still
      // tear down a daemon that is alive on disk even when main has NO live
      // client to it — the daemon dropped/respawn-exhausted into local mode while
      // daemon.pid still points at a live daemon. Without this the user's
      // close-all request silently leaves that daemon and its PTYs running. The
      // pid-kill is verify-before-kill (image + cmdline), so a recycled PID is
      // never signalled. A normal Quit (fullShutdownRequested=false) still leaves
      // any such daemon alone — that is the persistence promise.
      if (fullShutdownRequested) {
        const killed = killDaemonByPidFile();
        logLine('warn', 'main', `full-shutdown (no live client): pid-kill backstop ${killed ? 'killed the daemon' : 'found no verified daemon to kill'}`);
      }
    }
  } catch (err) {
    console.error('[Main] before-quit daemon teardown threw — continuing to quit:', err);
    logLine('error', 'main', `before-quit daemon teardown threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    // Close-all must still complete even if the graceful path above threw: a
    // verified pid-kill is the last-resort backstop so an explicit shutdown
    // can't leave the daemon + PTYs running. verify-before-kill (image +
    // cmdline), and a normal Quit skips this entirely.
    if (fullShutdownRequested) {
      safeStep('full-shutdown pid-kill (post-throw backstop)', () => {
        const killed = killDaemonByPidFile();
        logLine('warn', 'main', `full-shutdown: post-throw pid-kill backstop ${killed ? 'killed the daemon' : 'found no verified daemon to kill'}`);
      });
    }
  }

  safeStep('claudeWorker.stop', () => claudeWorker.stop());
  safeStep('webviewCdpManager.disposeAll', () => webviewCdpManager.disposeAll());
  safeStep('chromeRegistry.disposeAll', () => chromeRegistry.disposeAll());
  safeStep('chromeSurfaceStore.flushSync', () => chromeSurfaceStore.flushSync());
  // Recorded browser flows are written on a debounce, so a quit inside that
  // window would drop the save the agent just made — the one it is most likely
  // to want on the next launch.
  safeStep('actionCacheStore.flushSync', () => getActionCacheStore().flushSync());
  safeStep('pipeServer.stop', () => pipeServer.stop());
  safeStep('mcpRegistrar.unregister', () => mcpRegistrar.unregister());
  safeStep('autoUpdater.stop', () => autoUpdater.stop());
  safeStep('destroyTray', () => destroyTray());

  app.quit(); // re-trigger quit — isQuitting flag skips preventDefault

  // Hard-exit guarantee against helper-orphan zombies. If `app.quit()` does
  // not finalize within 1.5s — pipeServer.stop() hanging on a stuck pipe,
  // a detached webview blocking will-quit, ConPTY/OSC 7 finalization
  // stalling, or any future cleanup path that races a daemon disconnect —
  // force the process down so no Electron helper survives as an orphan.
  //
  // The graceful path (will-quit → quit → exit) almost always completes
  // well under 1.5s; this timer only fires when something hangs. unref()
  // makes the timer non-blocking so a normal quit isn't held open by it.
  //
  // Without this, dev (`npm start`) Ctrl+C and prod tray-Quit both leak
  // helper processes (renderer / GPU / utility) — observed locally as
  // 16-helper orphans dating back days and reproducible by repeated start
  // + quit cycles. See user dogfood 2026-05-22 zombie cleanup audit.
  const forceExitTimer = setTimeout(() => {
    console.warn('[Main] app.quit() did not finalize in 1.5s — forcing app.exit(0)');
    logLine('warn', 'main', 'before-quit force-exit fallback fired (1.5s)');
    app.exit(0);
  }, 1500);
  forceExitTimer.unref();
});

// Windows-specific: handle OS shutdown/logoff/restart.
// Electron fires 'session-end' on WM_ENDSESSION, which is the last reliable
// signal before Windows force-kills the process. The 'before-quit' async
// handler may not complete in time, so we do a synchronous emergency save here.
if (process.platform === 'win32') {
  app.on('session-end' as any, async () => {
    console.log('[Main] session-end received — flush pending session write + daemon race');
    try {
      // v2 RCA fix (reboot-reattach): the previous block built a FRESH
      // `new SessionManager()`, `load()`ed the on-disk snapshot, and `save()`d
      // it back. That did NOT capture the renderer's latest layout — it merely
      // re-confirmed whatever stale (possibly `.bak`-fallback fossil) snapshot
      // was already on disk, overwriting nothing useful and resurrecting fossils.
      // The renderer now persists ptyId changes the instant they happen
      // (event-driven session.save → synchronous main-side write), so disk
      // already holds the latest layout here. Flush the LIVE singleton's
      // pending debounced write as a safety net — a no-op today (saveDebounced
      // has no production callers; SESSION_SAVE goes through sync save()), but
      // it keeps this path correct if a debounced producer ever appears. Never
      // reload-and-resave stale state.
      //
      // Use the module-level `sessionManager` (imported at top) directly — the
      // former `require('./ipc/handlers/session.handler')` here was left literal
      // in the bundle and threw MODULE_NOT_FOUND at runtime (same bundling bug
      // as #463), silently failing this flush on every shutdown.
      sessionManager.flushSync();
    } catch (err) {
      console.error('[Main] session-end flushSync failed:', err);
    }

    if (daemonClient?.isConnected) {
      // Phase A — A5. Race daemon.shutdown against the WM_ENDSESSION budget
      // (~5 s before Windows SIGKILLs us) so the daemon can complete its
      // atomic RingBuffer dumps before we tear down the pipe. Leave a 1 s
      // safety margin for disconnectSync + Electron's own teardown.
      //
      // 4 s is the documented floor pending the T5 dynamic test
      // measurement (Task #15). The harness exists at
      // scripts/daemon-shutdown-dynamic.mjs; rerun on the target box and
      // adjust if measured p99 latency calls for a smaller value.
      const A5_TIMEOUT_MS = 4_000;
      const race = await raceDaemonShutdown(daemonClient, A5_TIMEOUT_MS);
      if (!race.ok) {
        console.warn(
          `[Main] session-end daemon.shutdown race failed (${A5_TIMEOUT_MS} ms): ${race.error}`,
        );
      }
      try {
        daemonClient.disconnectSync();
      } catch {
        // best effort — process is about to die
      }
    }
  });
}

app.on('activate', () => {
  if (isQuitting) return;
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    mainWindow = createWindow();
    adoptMainWindow(mainWindow);
    return;
  }
  // macOS: 창을 닫아도 hide()만 하고 파괴하지 않으므로(위 close 인터셉트)
  // getAllWindows()는 계속 0보다 크다 — Dock 아이콘 재클릭으로 숨겨진 창을
  // 복귀시키는 mac 표준 관례가 이 분기 없이는 무반응이었다(owner-reported
  // 2026-07-19). Windows/Linux는 트레이 컨텍스트 메뉴가 이미 이 경로를
  // 담당하므로 이 핸들러는 mac에서만 의미 있지만, 숨겨진 창이 있으면
  // 어느 OS에서든 보여주는 편이 안전하다.
  const hidden = windows.find((w) => !w.isVisible());
  if (hidden) hidden.show();
});

} // end appInit()
