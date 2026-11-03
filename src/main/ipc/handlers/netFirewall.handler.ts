import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, shell, type BrowserWindow } from 'electron';
import { IPC, dataSuffix } from '../../../shared/constants';
import {
  NETWORK_SETTINGS_URIS,
  isFirewallListener,
  isNetworkSettingsUri,
  type ElevationOutcome,
  type FirewallActionResult,
  type InboundStatusView,
  type NetworkSettingsUri,
} from '../../../shared/netFirewall';
import { FIREWALL_GROUP, currentRuleUser, elevatedPowerShellParameters, windowsPowerShellPath } from '../../../shared/netFirewallScripts';
import type { ListenProblemReport } from '../../../shared/netListen';
import { canonicalExePath, onLocalFixedDrive, systemDirectory } from '../../../shared/netWinPaths';
import { wrapHandler } from '../wrapHandler';
import { isMainWindowSender } from '../mainWindowSender';
import type { DaemonClient } from '../../DaemonClient';
import { FirewallFixer } from '../../net/firewallFix';
import { stagedDaemonExe } from '../../daemon/launcher';
import { shellExecuteAndWait, tokenElevationType } from '../../net/elevate';
import { isSelfElevated } from '../../computer/selfElevation';

// The firewall and port problems of remote pairing (A2A, Share & pair with
// "Expose to network", LanLink): the read-only checks pass through to the
// daemon (`net.*`), and the Fix / Remove run here, in main, through the OS
// consent prompt. Only the main window's own top frame may ask, for a check
// as for an elevation, and elevations run one click at a time
// (FirewallFixer). powershell.exe and mmc.exe come from System32 as
// GetSystemDirectoryW reports it, never from the SystemRoot variable.

let liveClient: (() => DaemonClient | null) | null = null;

function rpcClient(): DaemonClient {
  const dc = liveClient?.() ?? null;
  if (!dc || !dc.isConnected) throw Object.assign(new Error('the daemon is not connected'), { code: 'DAEMON_DISCONNECTED' });
  return dc;
}

/** macOS: the admin sheet. Unverified on a Mac: osascript reports a declined sheet as error -128. */
function runAppleScript(script: string): Promise<ElevationOutcome> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 120_000 }, (err, _stdout, stderr) => {
      if (!err) resolve({ kind: 'ok' });
      else if (/\(-128\)/.test(String(stderr))) resolve({ kind: 'cancelled' });
      else resolve({ kind: 'failed', stage: null, code: typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null });
    });
  });
}

let getMainWindow: () => BrowserWindow | null = () => null;

function system32(): string {
  const dir = systemDirectory();
  if (!dir) throw new Error('the System32 folder could not be read');
  return dir;
}

const fixer = new FirewallFixer({
  rpc: (method, params, opts) => rpcClient().rpc(method, params, opts),
  elevateWindows: async (script) =>
    shellExecuteAndWait({
      verb: 'runas',
      file: windowsPowerShellPath(system32()),
      parameters: elevatedPowerShellParameters(script),
      hwnd: (() => {
        const win = getMainWindow();
        return win && !win.isDestroyed() ? win.getNativeWindowHandle() : null;
      })(),
    }),
  elevateMac: runAppleScript,
  facts: { exists: (p) => fs.existsSync(p), onLocalFixedDrive },
  // Per action: main sets WMUX_DATA_SUFFIX in appInit(), after this module loads.
  scope: () => ({ dataSuffix: dataSuffix(), user: currentRuleUser(), group: FIREWALL_GROUP }),
  // The same long form the daemon reports for the same program.
  selfExe: canonicalExePath(process.execPath),
  stagedExe: () => {
    const exe = stagedDaemonExe();
    return exe ? canonicalExePath(exe) : null;
  },
  tokenType: tokenElevationType,
  selfElevated: isSelfElevated,
  log: (msg) => console.warn(msg),
});

const NOT_OPERATOR: FirewallActionResult = { outcome: { kind: 'refused', refusal: 'changed' }, status: null };

function openFirewallSettings(): void {
  if (process.platform === 'win32') {
    // wf.msc through the absolute mmc.exe: Windows Defender Firewall with Advanced Security.
    const dir = systemDirectory();
    if (!dir) {
      console.warn('[net] could not open Windows Firewall: the System32 folder could not be read');
      return;
    }
    const child = spawn(path.win32.join(dir, 'mmc.exe'), [path.win32.join(dir, 'wf.msc')], { detached: true, stdio: 'ignore' });
    child.once('error', (err) => console.warn('[net] could not open Windows Firewall:', err.message));
    child.unref();
    return;
  }
  if (process.platform === 'darwin') void shell.openExternal('x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall');
}

/**
 * What an Open request may open: Windows Firewall, network settings, or on
 * Windows exactly one of the listed Settings pages (NETWORK_SETTINGS_URIS).
 * Null refuses it: the renderer never names anything else. Pure.
 */
export function openTarget(which: unknown, page: unknown, platform: NodeJS.Platform): { kind: 'firewall' } | { kind: 'network'; page?: NetworkSettingsUri } | null {
  if (page === undefined) return which === 'firewall' ? { kind: 'firewall' } : which === 'network' ? { kind: 'network' } : null;
  return which === 'network' && platform === 'win32' && isNetworkSettingsUri(page) ? { kind: 'network', page } : null;
}

/** `page`: one of the Windows Settings pages, checked by openTarget. */
function openNetworkSettings(page: NetworkSettingsUri = NETWORK_SETTINGS_URIS.status): void {
  if (process.platform === 'win32') void shell.openExternal(page);
  else if (process.platform === 'darwin') void shell.openExternal('x-apple.systempreferences:com.apple.Network-Settings.extension');
}

export function registerNetFirewallHandlers(getDaemonClient: () => DaemonClient | null, getWindow: () => BrowserWindow | null): () => void {
  liveClient = getDaemonClient;
  getMainWindow = getWindow;
  const listener = (v: unknown) => {
    if (!isFirewallListener(v)) throw new Error('listener must be one of a2a, web, lanlink');
    return v;
  };
  const fromMainWindow = (e: Electron.IpcMainInvokeEvent): void => {
    if (!isMainWindowSender(e, getWindow())) throw new Error('only the main window may check the firewall');
  };
  const handlers: Array<[string, (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>]> = [
    [
      IPC.NET_FIREWALL_STATUS,
      async (e, l, fresh): Promise<InboundStatusView> => {
        fromMainWindow(e);
        return fixer.status(listener(l), { fresh: fresh === true });
      },
    ],
    [
      IPC.NET_LISTEN_PROBLEM,
      async (e, l): Promise<ListenProblemReport | null> => {
        fromMainWindow(e);
        return fixer.listenProblem(listener(l));
      },
    ],
    [
      IPC.NET_FIREWALL_FIX,
      async (e, l): Promise<FirewallActionResult> => (isMainWindowSender(e, getWindow()) ? fixer.fix(listener(l)) : NOT_OPERATOR),
    ],
    [
      IPC.NET_FIREWALL_REMOVE,
      async (e, l): Promise<FirewallActionResult> => (isMainWindowSender(e, getWindow()) ? fixer.remove(listener(l)) : NOT_OPERATOR),
    ],
    [
      IPC.NET_FIREWALL_OPEN,
      async (e, which, page): Promise<{ ok: boolean }> => {
        if (!isMainWindowSender(e, getWindow())) return { ok: false };
        const target = openTarget(which, page, process.platform);
        if (!target) return { ok: false };
        if (target.kind === 'firewall') openFirewallSettings();
        else openNetworkSettings(target.page);
        return { ok: true };
      },
    ],
  ];
  for (const [channel, fn] of handlers) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, fn));
  }
  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
  };
}
