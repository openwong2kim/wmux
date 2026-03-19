import { BrowserWindow } from 'electron';
import { PTYManager } from './PTYManager';
import { OscParser } from './OscParser';
import { AgentDetector } from './AgentDetector';
import { ToastManager } from '../notification/ToastManager';
import { IPC } from '../../shared/constants';

export class PTYBridge {
  private oscParsers = new Map<string, OscParser>();
  private agentDetectors = new Map<string, AgentDetector>();
  private toastManager = new ToastManager();

  constructor(
    private ptyManager: PTYManager,
    private getWindow: () => BrowserWindow | null,
  ) {}

  setupDataForwarding(ptyId: string): void {
    const instance = this.ptyManager.get(ptyId);
    if (!instance) return;

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
          // CWD changed — data is typically file://host/path
          const cwd = event.data.replace(/^file:\/\/[^/]*/, '');
          win.webContents.send(IPC.CWD_CHANGED, ptyId, cwd);
          break;
        }
        case 9:   // Windows Terminal notification
        case 99:  // iTerm2 notification
        case 777: // rxvt-unicode notification
          // Silently ignore — no notification, no sound
          break;
      }
    });

    // Handle agent detection events — status tracking only, no notification/sound
    agentDetector.onEvent(() => {
      // Agent status is tracked internally by AgentDetector.
      // No notification or sound — these fire too frequently and flood the UI.
    });

    // Handle critical action events — send approval request to renderer
    agentDetector.onCritical((criticalEvent) => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;

      win.webContents.send(IPC.APPROVAL_REQUEST, ptyId, {
        action: criticalEvent.action,
        riskLevel: criticalEvent.riskLevel,
      });
    });

    instance.process.onData((data: string) => {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        // Process data through OscParser (strips OSC sequences)
        oscParser.process(data);
        // Feed data to AgentDetector
        agentDetector.feed(data);
        // Forward raw data to renderer (xterm handles OSC itself)
        win.webContents.send(IPC.PTY_DATA, ptyId, data);
      }
    });

    instance.process.onExit(({ exitCode }) => {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.PTY_EXIT, ptyId, exitCode);
      }
      this.oscParsers.delete(ptyId);
      this.agentDetectors.delete(ptyId);
      // Process already exited — remove from map without calling kill()
      this.ptyManager.remove(ptyId);
    });
  }
}
