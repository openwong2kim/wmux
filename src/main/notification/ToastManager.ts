import { Notification, BrowserWindow } from 'electron';

export class ToastManager {
  enabled = true;
  private flashingWindow: BrowserWindow | null = null;
  private focusHandler: (() => void) | null = null;

  show(title: string, body: string): void {
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
      // Bring app to front when toast is clicked
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });

    notification.show();

    // Flash taskbar to attract attention
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
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
    }
  }
}
