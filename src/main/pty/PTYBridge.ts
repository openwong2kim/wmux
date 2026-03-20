import { BrowserWindow } from 'electron';
import { PTYManager } from './PTYManager';
import { OscParser } from './OscParser';
import { AgentDetector } from './AgentDetector';
import { ActivityMonitor } from './ActivityMonitor';
import { ToastManager } from '../notification/ToastManager';
import { IPC } from '../../shared/constants';

export class PTYBridge {
  private oscParsers = new Map<string, OscParser>();
  private agentDetectors = new Map<string, AgentDetector>();
  private toastManager = new ToastManager();
  private activityMonitor = new ActivityMonitor();
  private ptyCreatedAt = new Map<string, number>();

  constructor(
    private ptyManager: PTYManager,
    private getWindow: () => BrowserWindow | null,
  ) {
    // Activity-based notification: fires when sustained output drops to idle
    this.activityMonitor.onActiveToIdle((ptyId) => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;
      const notification = {
        type: 'agent' as const,
        title: 'Task may have finished',
        body: 'Terminal output stopped after active period',
      };
      win.webContents.send(IPC.NOTIFICATION, ptyId, notification);
      this.toastManager.show(notification.title, notification.body);
    });
  }

  setupDataForwarding(ptyId: string): void {
    const instance = this.ptyManager.get(ptyId);
    if (!instance) return;

    this.ptyCreatedAt.set(ptyId, Date.now());
    this.activityMonitor.start(ptyId);

    const oscParser = new OscParser();
    this.oscParsers.set(ptyId, oscParser);

    const agentDetector = new AgentDetector();
    this.agentDetectors.set(ptyId, agentDetector);

    // Handle OSC events
    oscParser.onOsc((event) => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;

      switch (event.code) {
        case 7: {
          const cwd = event.data.replace(/^file:\/\/[^/]*/, '');
          win.webContents.send(IPC.CWD_CHANGED, ptyId, cwd);
          break;
        }
        case 9:
        case 99: {
          const notification = { type: 'info' as const, title: 'Terminal', body: event.data };
          win.webContents.send(IPC.NOTIFICATION, ptyId, notification);
          this.toastManager.show(notification.title, notification.body);
          break;
        }
        case 777: {
          const parts = event.data.split(';');
          const title = parts[1] || 'Notification';
          const body = parts.slice(2).join(';') || '';
          const notification = { type: 'info' as const, title, body };
          win.webContents.send(IPC.NOTIFICATION, ptyId, notification);
          this.toastManager.show(title, body);
          break;
        }
      }
    });

    // Critical action detection (kept — this is precise and valuable)
    agentDetector.onCritical((criticalEvent) => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.send(IPC.APPROVAL_REQUEST, ptyId, {
        action: criticalEvent.action,
        riskLevel: criticalEvent.riskLevel,
      });
    });

    instance.process.onData((data: string) => {
      // Feed activity monitor with byte count
      this.activityMonitor.feed(ptyId, data.length);

      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        oscParser.process(data);
        agentDetector.feed(data);
        win.webContents.send(IPC.PTY_DATA, ptyId, data);
      }
    });

    instance.process.onExit(({ exitCode }) => {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.PTY_EXIT, ptyId, exitCode);

        if (exitCode !== 0) {
          const elapsed = Date.now() - (this.ptyCreatedAt.get(ptyId) ?? Date.now());
          const seconds = Math.round(elapsed / 1000);
          const notification = {
            type: 'error' as const,
            title: 'Process exited with error',
            body: `Exit code ${exitCode} after ${seconds}s`,
          };
          win.webContents.send(IPC.NOTIFICATION, ptyId, notification);
          this.toastManager.show(notification.title, notification.body);
        }
      }
      this.oscParsers.delete(ptyId);
      this.agentDetectors.delete(ptyId);
      this.ptyCreatedAt.delete(ptyId);
      this.activityMonitor.stop(ptyId);
      this.ptyManager.remove(ptyId);
    });
  }
}
