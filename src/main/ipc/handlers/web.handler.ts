import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import {
  WEB_DEFAULT_PORT,
  type WebStartArgs,
  type WebTerminalInfo,
} from '../../../shared/web';
// The tailscale sequence is shared with `wmux web --tailscale` rather than
// reimplemented here: the steps a second copy drops are the rollbacks, and
// those only run on failure paths nobody exercises by hand.
import {
  describeTailscaleProblem,
  startWebTransport,
  stopWebTransport,
  type TailscaleExec,
} from '../../../cli/tailscale';

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
export function registerWebHandlers(
  getDaemonClient: () => DaemonClient | null,
  /**
   * Test seam for the tailscale shell-out.
   *
   * Not a nicety: without it a unit test that exercises the tailnet path
   * registers a REAL `tailscale serve` on the developer's machine. That
   * happened once during development — the suite left an HTTPS front pointing
   * at a port nothing was listening on, which is a 502 on the operator's
   * tailnet until someone runs a tailscale command by hand.
   */
  exec?: TailscaleExec,
): () => void {
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
      async (_event, input: unknown): Promise<WebTerminalInfo> => {
        // A default parameter only covers `undefined` — an explicit `null`
        // payload would throw here instead of resolving `{running:false}`,
        // breaking this handler's never-rejects contract.
        const args: WebStartArgs = input && typeof input === 'object' ? (input as WebStartArgs) : {};
        // Safe defaults enforced main-side too: read-only + loopback unless the
        // renderer explicitly opted into input / network exposure.
        const allowInput = args.allowInput === true;
        // `tailscale serve` proxies loopback, so the two transports are
        // alternatives. Tailnet wins if a confused caller asks for both — it is
        // the stronger one, and picking the weaker would quietly put a terminal
        // on every interface for someone who asked for HTTPS.
        const tailscale = args.tailscale === true;
        const expose = !tailscale && args.expose === true;

        const start = await startWebTransport({
          port: WEB_DEFAULT_PORT,
          tailscale,
          expose,
          ...(exec ? { exec } : {}),
          startServer: async ({ host, allowedHosts }) => {
            const info = await call('daemon.web.start', {
              port: WEB_DEFAULT_PORT,
              host,
              allowInput,
              allowedHosts,
              tailscale,
            });
            // `call` never rejects; it reports failure as `error`. Feed that
            // back so a failed start rolls the serve registration back instead
            // of leaving a proxy in front of nothing.
            return { failed: info.error !== undefined || info.running !== true, value: info };
          },
        });

        if (!start.ok) {
          // Not an exception: the popover renders this as a quiet reason, the
          // same as every other failure on this surface.
          return {
            running: false,
            transportError:
              start.kind === 'binding'
                ? { reason: 'binding' as const, lines: [start.error] }
                : {
                    reason: start.problem,
                    lines: describeTailscaleProblem(start.problem, start.detail),
                  },
          };
        }
        return start.value;
      },
    ),
  );

  ipcMain.removeHandler(IPC.WEB_PAIR_REFRESH);
  ipcMain.handle(
    IPC.WEB_PAIR_REFRESH,
    wrapHandler(IPC.WEB_PAIR_REFRESH, async (): Promise<WebTerminalInfo> => {
      return call('daemon.web.pairRefresh', {});
    }),
  );

  ipcMain.removeHandler(IPC.WEB_STOP);
  ipcMain.handle(
    IPC.WEB_STOP,
    wrapHandler(IPC.WEB_STOP, async (): Promise<WebTerminalInfo> => {
      // Tearing the front down is part of stopping. Leaving it up would point a
      // tailnet HTTPS address at a port nothing is listening on — a 502 the
      // operator can only clear with a tailscale command they were never told
      // to run. stopWebTransport owns the read-port-before-stop ordering.
      const stop = await stopWebTransport({
        ...(exec ? { exec } : {}),
        readPort: async () => (await call('daemon.web.status', {})).port,
        stopServer: async () => {
          const info = await call('daemon.web.stop', {});
          return { failed: info.error !== undefined, value: info };
        },
      });
      return stop.value;
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.WEB_STATUS);
    ipcMain.removeHandler(IPC.WEB_START);
    ipcMain.removeHandler(IPC.WEB_STOP);
    ipcMain.removeHandler(IPC.WEB_PAIR_REFRESH);
  };
}
