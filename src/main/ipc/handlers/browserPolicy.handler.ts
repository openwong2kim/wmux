import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  BROWSER_POLICY_IPC,
  type BrowserPolicyReadResult,
  type BrowserPolicyWritePayload,
} from '../../../shared/browserPolicy';
import type { ChromePaneBindings } from '../../../shared/chromePaneBinding';
import { BrowserPolicyWriteError, type BrowserPolicyStore } from '../../browser-session/BrowserPolicyStore';
import { wrapHandler } from '../wrapHandler';

type GetWindow = () => BrowserWindow | null;

/**
 * Whether an IPC came from the main window's own top frame — not a <webview>
 * guest, not a subframe, not another window. The operator surfaces (policy,
 * Chrome profiles, backend, permission prompts) answer only to that sender:
 * a page loaded anywhere else in the app must not be able to bind accounts,
 * lift a pane's protection or approve a prompt. `getWindow()` is read per
 * call because the main window can be recreated.
 */
export function isTrustedMainFrameSender(
  event: Pick<IpcMainInvokeEvent | IpcMainEvent, 'sender' | 'senderFrame'>,
  getWindow: GetWindow,
): boolean {
  const win = getWindow();
  const wc = win && !win.isDestroyed() ? win.webContents : null;
  if (!wc || wc.isDestroyed()) return false;
  return event.sender === wc && event.senderFrame === wc.mainFrame;
}

export const UNTRUSTED_SENDER_ERROR = 'refused: this request must come from the wmux window';

export interface BrowserPolicyIpcDeps {
  getWindow: GetWindow;
  store: Pick<BrowserPolicyStore, 'fileState' | 'epoch' | 'entryFor' | 'decisionFor' | 'write'>;
  /** The profile a pane resolves to now (ChromeProfileStore.profileFor). */
  profileFor: (workspaceId: string, paneId: string) => string;
  paneBindings: () => ChromePaneBindings;
  /** The workspace the pane lives in now, or null when unknown. */
  paneWorkspace: (paneId: string) => string | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Policy read/write for the A-ui editor. Agents have no path here. */
export function registerBrowserPolicyIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: BrowserPolicyIpcDeps): void {
  const membershipError = (workspaceId: string, paneId: string): string | null => {
    if (!workspaceId || !paneId) return 'invalid payload';
    return deps.paneWorkspace(paneId) === workspaceId ? null : 'that pane is not in that workspace';
  };

  ipcMain.handle(BROWSER_POLICY_IPC.get, wrapHandler(BROWSER_POLICY_IPC.get, (event: IpcMainInvokeEvent, payload: unknown): BrowserPolicyReadResult => {
    if (!isTrustedMainFrameSender(event, deps.getWindow)) return { ok: false, error: UNTRUSTED_SENDER_ERROR };
    const p = (payload ?? {}) as Record<string, unknown>;
    const workspaceId = str(p.workspaceId);
    const paneId = str(p.paneId);
    const bad = membershipError(workspaceId, paneId);
    if (bad) return { ok: false, error: bad };
    const currentProfile = deps.profileFor(workspaceId, paneId);
    // What the gate would decide for this pane right now — with a missing or
    // unreadable file only main's history knows whether the pane is refused.
    const decision = deps.store.decisionFor(paneId, workspaceId, currentProfile, !!deps.paneBindings()[paneId]);
    return {
      ok: true,
      state: deps.store.fileState(),
      epoch: deps.store.epoch(),
      policy: deps.store.entryFor(paneId),
      currentProfile,
      decision: decision.kind,
      ...(decision.kind === 'protected' && { confirmed: decision.confirmed }),
    };
  }));

  ipcMain.handle(BROWSER_POLICY_IPC.set, wrapHandler(BROWSER_POLICY_IPC.set, async (event: IpcMainInvokeEvent, payload: unknown) => {
    if (!isTrustedMainFrameSender(event, deps.getWindow)) return { ok: false, error: UNTRUSTED_SENDER_ERROR };
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid payload' };
    const p = payload as Record<string, unknown>;
    const workspaceId = str(p.workspaceId);
    const paneId = str(p.paneId);
    const bad = membershipError(workspaceId, paneId);
    if (bad) return { ok: false, error: bad };
    const currentProfile = deps.profileFor(workspaceId, paneId);
    const binding = deps.paneBindings()[paneId];
    const isExclusive =
      !!binding
      && binding.workspaceId === workspaceId
      && binding.profile.toLowerCase() === currentProfile.toLowerCase();
    try {
      const epoch = await deps.store.write(p as unknown as BrowserPolicyWritePayload, currentProfile, isExclusive);
      return { ok: true, epoch };
    } catch (err) {
      // The editor branches on `code`, never on the message text.
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof BrowserPolicyWriteError ? err.code : 'io',
      };
    }
  }));
}
