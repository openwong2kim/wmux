process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err);
});

import * as crypto from 'crypto';
import * as path from 'path';
import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron';
import { createWindow, loadMainRenderer } from './window/createWindow';
import { PTYManager } from './pty/PTYManager';
import { PTYBridge } from './pty/PTYBridge';
import { registerAllHandlers } from './ipc/registerHandlers';
import { RpcRouter } from './pipe/RpcRouter';
import { PipeServer } from './pipe/PipeServer';
import { registerWorkspaceRpc } from './pipe/handlers/workspace.rpc';
import { registerSurfaceRpc } from './pipe/handlers/surface.rpc';
import { registerPaneRpc } from './pipe/handlers/pane.rpc';
import { registerInputRpc } from './pipe/handlers/input.rpc';
import { registerNotifyRpc } from './pipe/handlers/notify.rpc';
import { registerMetaRpc } from './pipe/handlers/meta.rpc';
import { registerSystemRpc } from './pipe/handlers/system.rpc';
import { registerHooksRpc } from './pipe/handlers/hooks.rpc';
import { UsagePoller } from './claude/UsagePoller';
import { IPC } from '../shared/constants';
import { HookSignalRouter } from './hooks/HookSignalRouter';
import { SignalLatencyMeter } from './hooks/SignalLatencyMeter';
import { registerBrowserRpc } from './pipe/handlers/browser.rpc';
import { registerA2aRpc } from './pipe/handlers/a2a.rpc';
import { registerCompanyRpc } from './pipe/handlers/company.rpc';
import { registerEventsRpc } from './pipe/handlers/events.rpc';
import { registerMcpPluginRpc } from './pipe/handlers/mcp.rpc';
import { getPluginTrustStore } from './mcp/PluginTrustStore';
import { ShadowRejectionLogger } from './audit/shadowRejectionLog';
import { LegacyTrafficCounter } from './audit/legacyTrafficCounter';
import { ApprovalQueue } from './mcp/ApprovalQueue';
import { resolveEnforcementMode } from './mcp/enforcementMode';
import { ClaudeWorker } from './a2a/ClaudeWorker';
import { AutoUpdater } from './updater/AutoUpdater';
import { McpRegistrar } from './mcp/McpRegistrar';
import { WebviewCdpManager } from './browser-session/WebviewCdpManager';
import { DaemonClient, getDaemonPipeName, readDaemonAuthToken } from './DaemonClient';
import { raceDaemonShutdown } from './daemonShutdownRace';
import { migrateScrollbackOnce } from './scrollback/legacyMigration';
import { DaemonNotificationRouter } from './notification/DaemonNotificationRouter';
import { ensureDaemon, killDaemonByPidFile } from './daemon/launcher';
import { DaemonRespawnController } from './daemon/DaemonRespawnController';
import { createTray, destroyTray, updateTraySessionCount } from './tray';
import { FirstRunOrchestrator } from './firstRun/FirstRunOrchestrator';
import { registerFirstRunHandlers } from './firstRun';
import { isSquirrelInstallerEvent } from './squirrel';
import { ProcessMonitor } from '../daemon/ProcessMonitor';
import { metadataStore } from './metadata/MetadataStore';
import { collectLegacyMetadata } from './metadata/legacyMigration';
import { sessionManager, registerSessionHandlers } from './ipc/handlers/session.handler';
import { eventBus } from './events/EventBus';
import { initLogSink, logLine } from './util/logSink';

// Force English for Chromium internal messages to avoid encoding corruption
// on non-ASCII locales (e.g. Korean Windows where cp949 garbles console output).
app.commandLine.appendSwitch('lang', 'en-US');

// CDP (Chrome DevTools Protocol) remote debugging
let cdpPort = 0;
if (process.env.WMUX_DISABLE_CDP !== 'true') {
  // Randomize port within range to prevent predictable scanning
  const basePort = 18800;
  const range = 100;
  cdpPort = basePort + crypto.randomInt(range);
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort.toString());
  console.log(`[WinMux] CDP enabled on port ${cdpPort}`);
}

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

    if (squirrelCmd === '--squirrel-install') {
      // Register Windows startup entry so wmux survives reboot
      try {
        const { execFileSync } = require('child_process');
        const systemRoot = process.env.SystemRoot || 'C:\\Windows';
        const reg = path.join(systemRoot, 'System32', 'reg.exe');
        execFileSync(reg, [
          'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          '/v', 'wmux', '/t', 'REG_SZ', '/d', `"${process.execPath}"`, '/f',
        ], { windowsHide: true });
      } catch { /* best-effort */ }

      spawn(updateExe, ['--createShortcut', target, '--shortcut-locations', 'Desktop,StartMenu'], { detached: true, windowsHide: true })
        .on('close', () => {
          // Auto-launch app after install
          spawn(process.execPath, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          process.exit(0);
        });
      app.quit();
    } else if (squirrelCmd === '--squirrel-updated') {
      // Re-register startup entry with current exe path (may change after update)
      try {
        const { execFileSync } = require('child_process');
        const systemRoot = process.env.SystemRoot || 'C:\\Windows';
        const reg = path.join(systemRoot, 'System32', 'reg.exe');
        execFileSync(reg, [
          'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          '/v', 'wmux', '/t', 'REG_SZ', '/d', `"${process.execPath}"`, '/f',
        ], { windowsHide: true });
      } catch { /* best-effort */ }

      spawn(updateExe, ['--createShortcut', target], { detached: true, windowsHide: true })
        .on('close', () => process.exit(0));
      app.quit();
    } else if (squirrelCmd === '--squirrel-uninstall') {
      // Remove startup registry entry
      try {
        const { execFileSync } = require('child_process');
        const systemRoot = process.env.SystemRoot || 'C:\\Windows';
        const reg = path.join(systemRoot, 'System32', 'reg.exe');
        execFileSync(reg, [
          'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          '/v', 'wmux', '/f',
        ], { windowsHide: true });
      } catch { /* best-effort */ }

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
}

function appInit(): void {

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
  app.on('second-instance', () => {
    if (isQuitting) return;
    if (mainWindow) {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

const ptyManager = new PTYManager();
let mainWindow: BrowserWindow | null = null;
// Forward-declared: PTYBridge captures this binding by reference and reads it
// at runtime (after the actual HookSignalRouter is constructed further down
// in this file). Lets the detector tee call `recordDetector` on emit without
// reordering hook/router boot earlier than the PTY layer.
let hookSignalRouter: HookSignalRouter | null = null;
const ptyBridge = new PTYBridge(ptyManager, () => mainWindow, () => hookSignalRouter);
const autoUpdater = new AutoUpdater(() => mainWindow);

const rpcRouter = new RpcRouter();
const pipeServer = new PipeServer(rpcRouter);
const mcpRegistrar = new McpRegistrar();
const webviewCdpManager = new WebviewCdpManager(cdpPort);

const claudeWorker = new ClaudeWorker(() => mainWindow);

// Daemon client — initialized on app ready, used if daemon is available
let daemonClient: DaemonClient | null = null;

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

let cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow, undefined, mcpHandlerOptions);

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

registerWorkspaceRpc(rpcRouter, () => mainWindow);
registerSurfaceRpc(rpcRouter, () => mainWindow);
registerPaneRpc(rpcRouter, () => mainWindow);
registerInputRpc(rpcRouter, ptyManager, () => mainWindow, () => daemonClient);
registerNotifyRpc(rpcRouter, () => mainWindow);
registerMetaRpc(rpcRouter, () => mainWindow);
registerSystemRpc(rpcRouter);
registerBrowserRpc(rpcRouter, () => mainWindow, webviewCdpManager);
registerA2aRpc(rpcRouter, () => mainWindow, claudeWorker);
registerCompanyRpc(rpcRouter, () => mainWindow);
registerEventsRpc(rpcRouter);
registerMcpPluginRpc(rpcRouter);
// Returns an unsubscribe for the signal-health push subscription. Called from
// before-quit so HMR reload / shutdown does not leak the listener.
const disposeHooksRpc = registerHooksRpc(rpcRouter, () => mainWindow, hookSignalRouter);

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
ipcMain.on(IPC.USAGE_TOGGLE, (_event, enabled: unknown) => {
  if (enabled === true) {
    usagePoller.start();
  } else {
    usagePoller.stop();
  }
});
ipcMain.on(IPC.USAGE_REFRESH, () => {
  // refreshNow() is fire-and-forget here — the listener above will
  // push the resulting state to the renderer. Wrapping in `void` so
  // the floating promise doesn't trip lint.
  void usagePoller.refreshNow();
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
const shadowRejectionLogger = new ShadowRejectionLogger();
rpcRouter.setTrustLookup((clientName) =>
  getPluginTrustStore().get(clientName),
);
rpcRouter.setShadowRejectionSink((entry) => {
  shadowRejectionLogger.append(entry);
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
// Production wmux defaults to `enforce`; dev (electron-forge / npm start)
// defaults to `shadow` so a bad delta doesn't lock the developer out.
// Override via `mcp.mode` in `~/.wmux/config.json`.
const isDevEnvironment = !app.isPackaged || process.env.NODE_ENV === 'development';
const enforcementMode = resolveEnforcementMode({ isDev: isDevEnvironment });
rpcRouter.setEnforcementMode(enforcementMode);

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
ipcMain.handle('browser:register-webview', async (_event, surfaceId: string, webContentsId: number) => {
  await webviewCdpManager.register(surfaceId, webContentsId);
  return { ok: true };
});

console.log('[DEBUG] registering app.on(ready)');
app.on('ready', async () => {
  // Persistent log sink — must come first so every subsequent stderr write
  // and explicit logLine() call lands on disk for postmortem analysis.
  // Path: %APPDATA%\wmux\logs\main-YYYY-MM-DD.log (Windows default).
  initLogSink();
  logLine('info', 'main', 'app.on(ready) fired');
  console.log('[Main] App ready, creating window...');

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

  // First-launch race fix: create the BrowserWindow but DEFER renderer
  // navigation until after the daemon bootstrap completes below. Loading
  // the renderer here used to race the LOCAL→DAEMON handler swap inside
  // `DaemonRespawnController.bootstrap()` — on fresh PCs the daemon spawn
  // stretches into hundreds of ms (Defender realtime scan + ASAR cold
  // cache + ConPTY cold start), and any `pty.write` issued from a renderer
  // that mounted in LOCAL mode but reached the DAEMON-swapped handler
  // silently dropped because `sessionPipes.get('pty-N')` is undefined.
  // Symptom: "first keystroke doesn't register" / "only the first
  // keystroke registers" on cold-start. Deferring navigation closes the
  // race window at the cost of a brief solid-color window during the
  // first daemon spawn — `backgroundColor: '#1e1e2e'` keeps that visible
  // bridge inoffensive.
  mainWindow = createWindow({ deferLoad: true });
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
    logLine(lvl, 'renderer', `${where} — ${message}`);
  });

  attachWindowRecovery(mainWindow);

  // Intercept window close — hide to tray instead of destroying
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow!.hide();
    }
  });

  // Phase 2 — UsagePoller hidden-window cost control. We treat tray-hide
  // as "user not looking" so the poller's 30-min skip threshold kicks in
  // and we don't burn Anthropic quota for a UI nobody sees. Show always
  // unpauses immediately and forces a catch-up fetch.
  mainWindow.on('hide', () => {
    usagePoller.setWindowVisible(false);
    // Quit-to-tray is the accumulation blind spot: the daemon keeps every
    // live session (and any agent inside it) running with no visible UI.
    // Refresh the tray's session-count nudge so the user can see how much is
    // still alive in the background. Best-effort — a tray hint must never
    // block window hide, and listSessions may reject mid daemon-respawn.
    void refreshTraySessionCount();
  });
  mainWindow.on('show', () => {
    usagePoller.setWindowVisible(true);
    // Window is visible again — the panes speak for themselves, so clear the
    // background-session nudge back to the plain "wmux" tooltip/menu. Bump the
    // refresh token first so a slow in-flight hide refresh can't overwrite this
    // clear with a stale count after it resolves. (codex review P3)
    trayRefreshToken++;
    updateTraySessionCount(null);
  });

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
      // Handler swap to daemon-routed mode. The microsecond window where
      // pty/* handlers are torn down and re-registered is the same
      // surface the original code used; the swap is logged for the
      // race-investigation breadcrumb trail kept by previous fixes.
      logLine('info', 'main', 'handler swap (daemon connect): cleanup begin');
      cleanupHandlers();
      logLine('info', 'main', 'handler swap (daemon connect): cleanup done, register begin');
      cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow, daemonClient, mcpHandlerOptions);
      logLine('info', 'main', 'handler swap (daemon connect): register done');
      // Mount the notification router now that we have a live daemon
      // client. PTY data flows through daemon → DaemonClient events,
      // and this router translates them into the same renderer-facing
      // IPC signals PTYBridge produces in local mode.
      daemonNotificationRouter?.stop();
      daemonNotificationRouter = new DaemonNotificationRouter(client, () => mainWindow, () => hookSignalRouter);
      daemonNotificationRouter.start();
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
      cleanupHandlers = registerAllHandlers(ptyManager, ptyBridge, () => mainWindow, undefined, mcpHandlerOptions);
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
  });
  try {
    await daemonRespawnController.bootstrap();
  } catch (err) {
    console.warn('[Main] Daemon auto-start failed, using local PTY:', err);
  }

  // v2.8.1 hotfix (Bug 3): unblock any renderer that already invoked
  // `daemon:get-ready-state`. From this point on the handler answers
  // synchronously with the current `daemonClient` value, which means
  // mainWindow.reload() recovery paths (renderer crash, unresponsive,
  // did-fail-load) still get a truthful answer instead of deadlocking
  // on a one-shot event the previous preload instance consumed.
  // Order matters: mark ready BEFORE loading the renderer so the very
  // first `daemon.whenReady()` invoke from the renderer resolves on its
  // synchronous path (no pending-resolver queueing) and AppLayout can
  // reconcile immediately against the now-stable handler topology.
  markDaemonReady();

  // First-launch race fix companion: now that `cleanupHandlers` reflects
  // the final daemon-vs-local handler topology and `markDaemonReady()`
  // has unblocked future `daemon.whenReady()` calls, it is safe to load
  // the renderer. Every subsequent `pty.create` from the renderer will
  // be routed by the correct handler and produce a correctly-formatted
  // id (`daemon-XX` in daemon mode, `pty-N` in local mode) — eliminating
  // the LOCAL-id-into-DAEMON-handler silent-drop race documented above
  // the `createWindow({ deferLoad: true })` call.
  if (mainWindow && !mainWindow.isDestroyed()) {
    loadMainRenderer(mainWindow);
    logLine('info', 'main', 'renderer load triggered after daemon bootstrap');
  }

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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[Main] Page failed to load:', errorCode, errorDescription);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }, 2000);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Main] Page loaded successfully');
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

  // Write auth token BEFORE starting pipe server — prevents race where
  // MCP client reads old token while new pipe is already listening
  const authToken = pipeServer.getAuthToken();
  mcpRegistrar.register(authToken);
  pipeServer.start();
  autoUpdater.start();
});

app.on('window-all-closed', () => {
  // Don't quit — stay alive in system tray.
  // Actual quit is triggered from the tray "Quit" menu item.
});

app.on('before-quit', async (e) => {
  if (isQuitting) return; // second pass — let quit proceed
  e.preventDefault();
  isQuitting = true;

  // Attempt session save from renderer
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isCrashed()) {
    try {
      await mainWindow.webContents.executeJavaScript(
        `try { window.dispatchEvent(new Event('beforeunload')); } catch(e) {}`
      );
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch {
      // Renderer unavailable — rely on last periodic save
    }
  }

  cleanupHandlers();
  disposeFirstRunHandlers();
  disposeHooksRpc();
  disposeUsagePollerListener();
  usagePoller.dispose();
  // Tear down the respawn controller BEFORE the daemon-shutdown race so
  // a daemon close during the race window can't trigger a respawn attempt
  // while the rest of the app is exiting. `dispose()` only stops timers
  // and detaches listeners — it does NOT call `onUninstall()`, so the
  // shutdown-race path below remains the single authority for taking the
  // client offline cleanly.
  daemonRespawnController?.dispose();
  daemonRespawnController = null;

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

  claudeWorker.stop();
  webviewCdpManager.disposeAll();
  pipeServer.stop();
  mcpRegistrar.unregister();
  autoUpdater.stop();
  destroyTray();

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
    console.log('[Main] session-end received — emergency sync save + daemon race');
    try {
      // Import SessionManager lazily to avoid circular deps
      const { SessionManager } = require('./session/SessionManager');
      const sm = new SessionManager();
      const existing = sm.load();
      if (existing) {
        sm.save(existing); // ensure last periodic save is flushed to disk
      }
    } catch (err) {
      console.error('[Main] Emergency session save failed:', err);
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
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    attachWindowRecovery(mainWindow);
  }
});

} // end appInit()
