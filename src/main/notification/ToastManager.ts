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
}

export class ToastManager {
  enabled = true;
  private flashingWindow: BrowserWindow | null = null;
  private focusHandler: (() => void) | null = null;

  show(title: string, body: string, context?: ToastFocusContext): void {
    if (!this.enabled) return;

    // Only show toast when app is not focused
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) return;

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
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (isWindows) {
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
      } else if (isMac) {
        // app.dock is only defined on darwin; optional-chain guards against
        // theoretical undefined (e.g. headless test envs).
        app.dock?.bounce('informational');
      }
      // Linux: intentionally no-op beyond the Notification.show() above.
    }
  }
}
