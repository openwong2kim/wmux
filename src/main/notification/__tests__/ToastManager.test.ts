import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ----- electron mock -----------------------------------------------------
//
// We need to control:
//   - Notification (constructor + .show + .on + isSupported)
//   - BrowserWindow.getFocusedWindow / .getAllWindows (the "window" returned
//     exposes flashFrame / on / removeListener / isMinimized / restore / focus)
//   - app.dock?.bounce (only used on macOS branch)
//
// `vi.hoisted` lets the mock factory below reference the same mocks the tests
// poke at, despite vi.mock being hoisted above all imports.
const electronMocks = vi.hoisted(() => {
  const notificationInstances: Array<{
    on: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
  }> = [];

  // Use a real `class` so `new Notification(...)` works inside production code.
  // Each instance records itself for assertion in tests.
  class NotificationMock {
    on = vi.fn();
    show = vi.fn();
    constructor(...args: unknown[]) {
      void args;
      notificationInstances.push(this);
    }
    static isSupported = vi.fn().mockReturnValue(true);
  }

  const flashFrame = vi.fn();
  const on = vi.fn();
  const removeListener = vi.fn();
  const win = {
    flashFrame,
    on,
    removeListener,
    isMinimized: vi.fn().mockReturnValue(false),
    isDestroyed: vi.fn().mockReturnValue(false),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn(), isDestroyed: vi.fn().mockReturnValue(false) },
  };

  const BrowserWindow = {
    getFocusedWindow: vi.fn().mockReturnValue(null),
    getAllWindows: vi.fn().mockReturnValue([win]),
  };

  const dockBounce = vi.fn();
  const app = {
    dock: { bounce: dockBounce },
  };

  return { NotificationMock, BrowserWindow, app, win, dockBounce, notificationInstances };
});

vi.mock('electron', () => ({
  Notification: electronMocks.NotificationMock,
  BrowserWindow: electronMocks.BrowserWindow,
  app: electronMocks.app,
}));

// ----- platform mock -----------------------------------------------------
//
// Default state is Windows. Per-OS suites below call vi.resetModules() and
// vi.doMock to flip isWindows/isMac/isLinux before re-importing the SUT.
vi.mock('../../../shared/platform', () => ({
  isWindows: true,
  isMac: false,
  isLinux: false,
}));

describe('ToastManager (OS-aware notifications)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Drain any instances retained from the previous test.
    electronMocks.notificationInstances.length = 0;
    // Default: app unfocused, one window available, Notification supported.
    electronMocks.BrowserWindow.getFocusedWindow.mockReturnValue(null);
    electronMocks.BrowserWindow.getAllWindows.mockReturnValue([electronMocks.win]);
    electronMocks.NotificationMock.isSupported.mockReturnValue(true);
    electronMocks.win.isMinimized.mockReturnValue(false);
    electronMocks.win.isDestroyed.mockReturnValue(false);
    electronMocks.win.webContents.isDestroyed.mockReturnValue(false);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('skips entirely when disabled', async () => {
    const { ToastManager } = await import('../ToastManager');
    const mgr = new ToastManager();
    mgr.enabled = false;
    mgr.show('t', 'b');
    expect(electronMocks.notificationInstances).toHaveLength(0);
  });

  it('skips when a window is currently focused', async () => {
    electronMocks.BrowserWindow.getFocusedWindow.mockReturnValue(electronMocks.win);
    const { ToastManager } = await import('../ToastManager');
    new ToastManager().show('t', 'b');
    expect(electronMocks.notificationInstances).toHaveLength(0);
  });

  it('skips when Notification.isSupported() is false', async () => {
    electronMocks.NotificationMock.isSupported.mockReturnValue(false);
    const { ToastManager } = await import('../ToastManager');
    new ToastManager().show('t', 'b');
    expect(electronMocks.notificationInstances).toHaveLength(0);
    expect(electronMocks.win.flashFrame).not.toHaveBeenCalled();
    expect(electronMocks.dockBounce).not.toHaveBeenCalled();
  });

  describe('click → pane jump (X2)', () => {
    // Pull the 'click' handler the SUT registered on the Notification mock
    // and invoke it, simulating the user clicking the OS toast.
    function clickToast(): void {
      const onCalls = electronMocks.notificationInstances[0].on.mock.calls;
      const clickCall = onCalls.find((c: unknown[]) => c[0] === 'click');
      expect(clickCall).toBeDefined();
      if (!clickCall) throw new Error('no click handler registered');
      (clickCall[1] as () => void)();
    }

    it('sends NOTIFICATION_FOCUS with the ptyId context after focusing the window', async () => {
      const { ToastManager } = await import('../ToastManager');
      const { IPC } = await import('../../../shared/constants');
      new ToastManager().show('t', 'b', { ptyId: 'pty-1' });
      clickToast();
      expect(electronMocks.win.focus).toHaveBeenCalled();
      expect(electronMocks.win.webContents.send).toHaveBeenCalledWith(
        IPC.NOTIFICATION_FOCUS,
        { ptyId: 'pty-1', workspaceId: null },
      );
    });

    it('sends NOTIFICATION_FOCUS with the workspaceId fallback context', async () => {
      const { ToastManager } = await import('../ToastManager');
      const { IPC } = await import('../../../shared/constants');
      new ToastManager().show('t', 'b', { workspaceId: 'ws-1' });
      clickToast();
      expect(electronMocks.win.webContents.send).toHaveBeenCalledWith(
        IPC.NOTIFICATION_FOCUS,
        { ptyId: null, workspaceId: 'ws-1' },
      );
    });

    it('does NOT send NOTIFICATION_FOCUS without a context (legacy focus-only click)', async () => {
      const { ToastManager } = await import('../ToastManager');
      new ToastManager().show('t', 'b');
      clickToast();
      expect(electronMocks.win.focus).toHaveBeenCalled();
      expect(electronMocks.win.webContents.send).not.toHaveBeenCalled();
    });

    it('does NOT send NOTIFICATION_FOCUS when the context carries only nulls', async () => {
      const { ToastManager } = await import('../ToastManager');
      new ToastManager().show('t', 'b', { ptyId: null, workspaceId: undefined });
      clickToast();
      expect(electronMocks.win.webContents.send).not.toHaveBeenCalled();
    });

    it('does nothing when the window was destroyed before the click (Action Center late click)', async () => {
      electronMocks.win.isDestroyed.mockReturnValue(true);
      const { ToastManager } = await import('../ToastManager');
      new ToastManager().show('t', 'b', { ptyId: 'pty-1' });
      clickToast();
      expect(electronMocks.win.focus).not.toHaveBeenCalled();
      expect(electronMocks.win.webContents.send).not.toHaveBeenCalled();
    });

    it('skips the IPC send (but still focuses) when only webContents is destroyed', async () => {
      electronMocks.win.webContents.isDestroyed.mockReturnValue(true);
      const { ToastManager } = await import('../ToastManager');
      new ToastManager().show('t', 'b', { ptyId: 'pty-1' });
      clickToast();
      expect(electronMocks.win.focus).toHaveBeenCalled();
      expect(electronMocks.win.webContents.send).not.toHaveBeenCalled();
    });

    it('restores a minimized window before focusing', async () => {
      electronMocks.win.isMinimized.mockReturnValue(true);
      const { ToastManager } = await import('../ToastManager');
      new ToastManager().show('t', 'b', { ptyId: 'pty-1' });
      clickToast();
      expect(electronMocks.win.restore).toHaveBeenCalled();
      expect(electronMocks.win.focus).toHaveBeenCalled();
    });
  });

  describe('on Windows', () => {
    // The top-level vi.mock already sets isWindows: true. No re-mock needed.

    it('flashes the taskbar and registers a focus listener to clear the flash', async () => {
      const { ToastManager } = await import('../ToastManager');
      new ToastManager().show('hello', 'world');

      // Notification was constructed and shown.
      expect(electronMocks.notificationInstances).toHaveLength(1);
      expect(electronMocks.notificationInstances[0].show).toHaveBeenCalledTimes(1);

      // Windows-specific: flashFrame(true) + focus listener.
      expect(electronMocks.win.flashFrame).toHaveBeenCalledWith(true);
      expect(electronMocks.win.on).toHaveBeenCalledWith('focus', expect.any(Function));

      // macOS dock bounce must NOT have fired.
      expect(electronMocks.dockBounce).not.toHaveBeenCalled();
    });

    it('does not stack focus listeners when called repeatedly on the same window', async () => {
      const { ToastManager } = await import('../ToastManager');
      const mgr = new ToastManager();
      mgr.show('a', 'b');
      mgr.show('a', 'b');
      mgr.show('a', 'b');
      // First call registers; subsequent calls hit the `flashingWindow !== win`
      // guard and do not re-register.
      expect(electronMocks.win.on).toHaveBeenCalledTimes(1);
      expect(electronMocks.win.flashFrame).toHaveBeenCalledTimes(3);
    });
  });

  describe('on macOS', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.doMock('../../../shared/platform', () => ({
        isWindows: false,
        isMac: true,
        isLinux: false,
      }));
    });

    it('bounces the dock once and never touches flashFrame', async () => {
      const platform = await import('../../../shared/platform');
      // Sanity: confirm the mac mock actually took effect for this test.
      expect(platform.isMac).toBe(true);
      expect(platform.isWindows).toBe(false);

      const { ToastManager } = await import('../ToastManager');
      new ToastManager().show('hello', 'world');

      expect(electronMocks.dockBounce).toHaveBeenCalledTimes(1);
      expect(electronMocks.dockBounce).toHaveBeenCalledWith('informational');
      expect(electronMocks.win.flashFrame).not.toHaveBeenCalled();
      expect(electronMocks.win.on).not.toHaveBeenCalled();
    });
  });

  describe('on Linux', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.doMock('../../../shared/platform', () => ({
        isWindows: false,
        isMac: false,
        isLinux: true,
      }));
    });

    it('only shows the Notification — no flashFrame, no dock bounce', async () => {
      const platform = await import('../../../shared/platform');
      // Sanity: confirm the linux mock actually took effect for this test.
      expect(platform.isLinux).toBe(true);
      expect(platform.isWindows).toBe(false);
      expect(platform.isMac).toBe(false);

      const { ToastManager } = await import('../ToastManager');
      new ToastManager().show('hello', 'world');

      expect(electronMocks.notificationInstances).toHaveLength(1);
      expect(electronMocks.notificationInstances[0].show).toHaveBeenCalledTimes(1);
      expect(electronMocks.win.flashFrame).not.toHaveBeenCalled();
      expect(electronMocks.win.on).not.toHaveBeenCalled();
      expect(electronMocks.dockBounce).not.toHaveBeenCalled();
    });
  });
});
