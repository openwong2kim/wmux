import { Notification, BrowserWindow, app } from 'electron';
import { isWindows, isMac } from '../../shared/platform';
import { IPC } from '../../shared/constants';

/**
 * Originating context for a toast. When present, clicking the toast not only
 * focuses the app window but also asks the renderer to jump to the source:
 *   - ptyId: strongest signal — renderer resolves the owning workspace, pane
 *     and surface and activates all three.
 *   - workspaceId: fallback for app-level toasts (external `notify` RPC) —
 *     renderer switches to that workspace's current active pane.
 * Both absent → click only restores/focuses the window (legacy behavior).
 */
export interface ToastFocusContext {
  ptyId?: string | null;
  workspaceId?: string | null;
  /**
   * macOS dock-bounce gate. The renderer has no dock-bounce action of its
   * own (Electron's cross-platform `flashFrame` is a Windows/Linux no-op on
   * macOS), so this method is the ONLY place it can be suppressed — omitted
   * → true (legacy default: bounce whenever a window exists).
   */
  dockBounceEnabled?: boolean;
  /**
   * Windows taskbar flashFrame gate. Omitted → true, which is correct for
   * every DIRECT caller of show()/showDirect() (no renderer, or renderer
   * not ready — nothing else would flash in those cases). The renderer-
   * decided osToast relay explicitly sets this to FALSE: the renderer
   * already flashes the taskbar itself via a separately-throttled
   * (500ms burst-protected), settings-gated action. Without this flag,
   * showDirect's own unconditional flash both double-flashed on the first
   * notification AND bypassed that throttle on every subsequent one (codex
   * review catch round 2 — a round-1 fix here only handled the
   * setting-off case, not the double-flash-when-on case).
   */
  windowsFlashEnabled?: boolean;
}

export class ToastManager {
  enabled = true;
  private flashingWindow: BrowserWindow | null = null;
  private focusHandler: (() => void) | null = null;

  /**
   * Legacy entry: suppress whenever ANY app window has OS focus, then show.
   * Kept for main-side callers that have no renderer to consult (window
   * gone / notify fallback). The renderer-decided path uses showDirect —
   * the policy there already established the window is unfocused, with the
   * added precision (active-surface awareness) main can't have.
   */
  show(title: string, body: string, context?: ToastFocusContext): void {
    // Only show toast when app is not focused
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) return;

    this.showDirect(title, body, context);
  }

  /**
   * Show without the focused-window suppression. Callers are responsible
   * for the visibility decision — today that is the renderer notification
   * policy (`osToast` action, emitted only when `!windowFocused`), relayed
   * over IPC.NOTIFICATION_OS_TOAST. The click handler / flashFrame / dock
   * bounce behavior is identical to the legacy show() path.
   *
   * `ignoreToastSetting` is for security notices only (a paired phone started
   * an agent with approvals off): the host user must see those even with
   * toasts turned off in Settings.
   */
  showDirect(title: string, body: string, context?: ToastFocusContext, options?: { ignoreToastSetting?: boolean }): void {
    if (!this.enabled && !options?.ignoreToastSetting) return;

    if (!Notification.isSupported()) return;

    const notification = new Notification({
      title,
      body,
      silent: false,
    });

    notification.on('click', () => {
      // Bring app to front when toast is clicked. Windows Action Center
      // keeps toasts clickable long after they fire — the window may be
      // gone or mid-teardown by now, so guard isDestroyed before touching it.
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
        // X2 — pane jump. Sent after focus so the renderer applies the
        // workspace/pane switch on an already-foregrounded window. The
        // context is captured at show() time; by click time the PTY may be
        // gone — the renderer treats unresolvable ids as a silent no-op.
        if (context && (context.ptyId || context.workspaceId) && !win.webContents.isDestroyed()) {
          win.webContents.send(IPC.NOTIFICATION_FOCUS, {
            ptyId: context.ptyId ?? null,
            workspaceId: context.workspaceId ?? null,
          });
        }
      }
    });

    notification.show();

    // OS-aware "attract attention" behavior:
    //   - Windows: flashFrame(true) until window regains focus, then flashFrame(false).
    //   - macOS:   one-shot dock bounce (Apple HIG; no listener needed — bounce is fire-and-forget).
    //   - Linux:   the Notification API itself is sufficient; no additional taskbar API.
    // Each platform's gate is independent (see ToastFocusContext) — the
    // renderer-decided path suppresses ONLY the Windows flash (it owns that
    // itself) while still wanting the macOS bounce (which it can't do).
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (isWindows && context?.windowsFlashEnabled !== false) {
        win.flashFrame(true);
        if (this.flashingWindow !== win) {
          // Remove previous listener to prevent accumulation
          if (this.flashingWindow && this.focusHandler) {
            this.flashingWindow.removeListener('focus', this.focusHandler);
          }
          this.flashingWindow = win;
          this.focusHandler = () => { win.flashFrame(false); };
          win.on('focus', this.focusHandler);
        }
      } else if (isMac && context?.dockBounceEnabled !== false) {
        // app.dock is only defined on darwin; optional-chain guards against
        // theoretical undefined (e.g. headless test envs).
        app.dock?.bounce('informational');
      }
      // Linux: intentionally no-op beyond the Notification.show() above.
    }
  }
}

/**
 * Process-wide singleton. Historically lived in pipe/handlers/notify.rpc.ts
 * (which still re-exports it for existing importers); moved here so
 * notification-layer modules (dispatchNotification, the OS-toast IPC
 * handler) can depend on it without reaching into an RPC handler module.
 */
export const toastManager = new ToastManager();
