import { Notification, BrowserWindow } from 'electron';

export class ToastManager {
  show(title: string, body: string): void {
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
  }
}
