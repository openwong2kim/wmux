import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import {
  WEB_DEFAULT_PORT,
  webBindHost,
  type WebStartArgs,
  type WebTerminalInfo,
} from '../../../shared/web';

/**
 * wmux web — titlebar toggle ↔ daemon control-plane IPC. Forwards the renderer's
 * status/start/stop to the daemon control pipe (DaemonClient), which owns the
 * WebTerminalServer. Mirrors lanlink.handler.ts / mcp.handler.ts.
 *
 * Two differences from lanlink.handler.ts, both deliberate:
 *
 *  1. It takes a live `getDaemonClient` getter and registers UNCONDITIONALLY
 *     (not gated on a DaemonClient snapshot). The web toggle is always present
 *     in the titlebar, so a click must ALWAYS resolve — never throw "No handler
 *     registered". When there is no daemon (local mode, or the pipe is down) the
 *     handler resolves `{ running: false, error }` so the popover can render a
 *     quiet "daemon not running" state instead of surfacing an exception toast.
 *
 *  2. Every method resolves a WebTerminalInfo (never rejects) for the same
 *     reason — a browser-terminal toggle is a low-stakes convenience surface,
 *     not a data-integrity path.
 *
 * The daemon.web.* RPCs return the WebInfo shape directly as the RPC result
 * (see cli/commands/web.ts, which reads `response.result as WebInfo`);
 * DaemonClient.rpc resolves that `result` for us.
 */
export function registerWebHandlers(getDaemonClient: () => DaemonClient | null): () => void {
  const call = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<WebTerminalInfo> => {
    const dc = getDaemonClient();
    if (!dc || !dc.isConnected) {
      return {
        running: false,
        error: 'wmux web runs inside the background daemon, which is not running.',
      };
    }
    try {
      const result = await dc.rpc(method, params);
      if (result && typeof result === 'object') {
        return result as WebTerminalInfo;
      }
      return { running: false, error: `${method}: malformed daemon response` };
    } catch (err) {
      return { running: false, error: (err as Error)?.message ?? String(err) };
    }
  };

  ipcMain.removeHandler(IPC.WEB_STATUS);
  ipcMain.handle(
    IPC.WEB_STATUS,
    wrapHandler(IPC.WEB_STATUS, async (): Promise<WebTerminalInfo> => {
      return call('daemon.web.status', {});
    }),
  );

  ipcMain.removeHandler(IPC.WEB_START);
  ipcMain.handle(
    IPC.WEB_START,
    wrapHandler(
      IPC.WEB_START,
      async (_event, args: WebStartArgs = {}): Promise<WebTerminalInfo> => {
        // Safe defaults enforced main-side too: read-only + loopback unless the
        // renderer explicitly opted into input / network exposure.
        const allowInput = args.allowInput === true;
        const host = webBindHost(args.expose === true);
        return call('daemon.web.start', { port: WEB_DEFAULT_PORT, host, allowInput });
      },
    ),
  );

  ipcMain.removeHandler(IPC.WEB_STOP);
  ipcMain.handle(
    IPC.WEB_STOP,
    wrapHandler(IPC.WEB_STOP, async (): Promise<WebTerminalInfo> => {
      return call('daemon.web.stop', {});
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.WEB_STATUS);
    ipcMain.removeHandler(IPC.WEB_START);
    ipcMain.removeHandler(IPC.WEB_STOP);
  };
}
