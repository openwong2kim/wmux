import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import {
  WEB_DEFAULT_PORT,
  type WebDeviceRevokeResult,
  type WebDeviceSummary,
  type WebStartArgs,
  type WebTerminalInfo,
} from '../../../shared/web';
// The tailscale sequence is shared with `wmux web --tailscale` rather than
// reimplemented here: the steps a second copy drops are the rollbacks, and
// those only run on failure paths nobody exercises by hand.
import {
  checkWebFront,
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
 *     registered". When the control operation cannot complete, the handler
 *     resolves `{ running: false, error }` so the popover can render the actual
 *     failure instead of surfacing an exception toast.
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

  /**
   * Last answer from `checkWebFront`, or null before anything asked.
   *
   * Verifying costs a process spawn, and the popover re-reads status every 10
   * seconds while it is open — checking on every poll would spawn tailscale six
   * times a minute for a fact that changes when a human does something. So the
   * shell-out runs on deliberate events only (see `verifyFront` below) and the
   * ANSWER is applied to every reply afterwards, including the cheap polls.
   *
   * The residual stale window is "the front died while the popover sat open and
   * untouched", where nothing is being scanned anyway.
   */
  let frontState: 'ours' | 'gone' | 'unknown' | null = null;

  /**
   * Fold what we know about the front into a daemon reply.
   *
   * The daemon replays a persisted `allowedHosts` across a restart and puts
   * `https://<magicdns>/…` first in `urls` — it has no way to know the serve
   * behind that name is gone. Left alone, the popover would render a QR for an
   * address that answers nothing, and the failure would land on the phone.
   */
  /**
   * Does this reply advertise a separately managed HTTPS front?
   *
   * Keyed on `allowedHosts`, NOT on the `tailscale` flag. Dogfooding caught the
   * difference: a `web-state.json` written before that flag existed replays its
   * allowedHosts and gets `tailscale: false`, and the CLI's `--allow-host` path
   * never sets the flag either. Both still put `https://<name>/` first in
   * `urls`. Gating on the flag left exactly the dead address this is here to
   * catch — verified against a real tailnet, where the advertised URL answered
   * nothing. Native TLS also advertises operator-supplied names, but its HTTPS
   * listener is owned by the daemon itself and must never be sent through a
   * Tailscale configuration probe.
   */
  const advertisesFront = (info: WebTerminalInfo): boolean =>
    info.tls !== true && (info.allowedHosts ?? []).length > 0;

  const withFront = (info: WebTerminalInfo): WebTerminalInfo => {
    if (!info.running || !advertisesFront(info) || frontState !== 'gone') return info;
    return {
      ...info,
      // Drop the fronted URLs: an https address with no serve behind it is
      // worse than no address, because it looks like the working one.
      urls: (info.urls ?? []).filter((u) => !u.startsWith('https://')),
      allowedHosts: [],
      // Do not overwrite a refusal the daemon already made — the bind is a
      // harder fact than our tailscale probe.
      pairRefusal: info.pairRefusal ?? {
        reason: 'no-front',
        detail:
          'the tailscale serve front this server was started behind is no longer configured, ' +
          'so its https address reaches nothing. Start wmux web again with the tailnet option.',
      },
    };
  };

  ipcMain.removeHandler(IPC.WEB_STATUS);
  ipcMain.handle(
    IPC.WEB_STATUS,
    wrapHandler(IPC.WEB_STATUS, async (_event, input: unknown): Promise<WebTerminalInfo> => {
      const args = input && typeof input === 'object' ? (input as { verifyFront?: boolean }) : {};
      const info = await call('daemon.web.status', {});
      // Deliberate events only: the popover opening, the tailnet toggle going
      // on, a new pairing code being minted. Never the 10s poll.
      if (args.verifyFront === true && info.running && advertisesFront(info)) {
        frontState = await checkWebFront({
          webPort: info.port ?? WEB_DEFAULT_PORT,
          ...(exec ? { exec } : {}),
        });
      }
      return withFront(info);
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
        // We just registered it (or deliberately did not), so this is known
        // without asking tailscale again.
        frontState = tailscale ? 'ours' : null;
        return start.value;
      },
    ),
  );

  ipcMain.removeHandler(IPC.WEB_PAIR_REFRESH);
  ipcMain.handle(
    IPC.WEB_PAIR_REFRESH,
    wrapHandler(IPC.WEB_PAIR_REFRESH, async (): Promise<WebTerminalInfo> => {
      const info = await call('daemon.web.pairRefresh', {});
      // Minting a code is a deliberate "I am about to pair a phone" moment, and
      // it is the last chance to notice the front died before the operator
      // points a camera at a QR. Cheap here: it happens once per human action.
      if (info.running && advertisesFront(info)) {
        frontState = await checkWebFront({
          webPort: info.port ?? WEB_DEFAULT_PORT,
          ...(exec ? { exec } : {}),
        });
      }
      return withFront(info);
    }),
  );

  ipcMain.removeHandler(IPC.WEB_PAIR_START);
  ipcMain.handle(
    IPC.WEB_PAIR_START,
    wrapHandler(IPC.WEB_PAIR_START, async (_event, input: unknown): Promise<WebTerminalInfo> => {
      const name =
        input && typeof input === 'object' ? String((input as { name?: unknown }).name ?? '') : '';
      const dc = getDaemonClient();
      if (!dc || !dc.isConnected) {
        return {
          running: false,
          error: 'wmux web runs inside the background daemon, which is not running.',
        };
      }
      // `daemon.web.pairStart` answers {ok,code,expiresAt} or {ok:false,error},
      // NOT a WebTerminalInfo — it is the roster seam, shared with the CLI. The
      // popover only ever renders WebTerminalInfo, so read the fresh status
      // rather than hand-assemble one and let the two drift.
      let failure: string | undefined;
      try {
        const res = (await dc.rpc('daemon.web.pairStart', { name })) as {
          ok?: boolean;
          error?: string;
        };
        if (res?.ok !== true) failure = res?.error ?? 'pairing could not be started';
      } catch (err) {
        failure = (err as Error)?.message ?? String(err);
      }
      const info = await call('daemon.web.status', {});
      // NOT `error`: that field means the control operation as a whole failed
      // and carries no trustworthy running status. This reply has a healthy
      // server; only the pairing-code operation failed.
      if (failure) return { ...withFront(info), pairStartError: failure };
      // A fresh code is the last moment before a camera is pointed at it.
      if (info.running && advertisesFront(info)) {
        frontState = await checkWebFront({
          webPort: info.port ?? WEB_DEFAULT_PORT,
          ...(exec ? { exec } : {}),
        });
      }
      return withFront(info);
    }),
  );

  ipcMain.removeHandler(IPC.WEB_DEVICE_LIST);
  ipcMain.handle(
    IPC.WEB_DEVICE_LIST,
    wrapHandler(IPC.WEB_DEVICE_LIST, async (): Promise<{ devices: WebDeviceSummary[]; error?: string }> => {
      const dc = getDaemonClient();
      if (!dc || !dc.isConnected) {
        return { devices: [], error: 'wmux web runs inside the background daemon, which is not running.' };
      }
      try {
        // `daemon.web.deviceList` answers {devices}, NOT a WebTerminalInfo — it
        // reads the roster store, which outlives any one run of the server. A
        // stopped server still has devices worth revoking.
        const res = (await dc.rpc('daemon.web.deviceList', {})) as { devices?: unknown };
        return Array.isArray(res?.devices)
          ? { devices: res.devices as WebDeviceSummary[] }
          : { devices: [], error: 'daemon.web.deviceList: malformed daemon response' };
      } catch (err) {
        return { devices: [], error: (err as Error)?.message ?? String(err) };
      }
    }),
  );

  ipcMain.removeHandler(IPC.WEB_DEVICE_REVOKE);
  ipcMain.handle(
    IPC.WEB_DEVICE_REVOKE,
    wrapHandler(IPC.WEB_DEVICE_REVOKE, async (_event, input: unknown): Promise<WebDeviceRevokeResult> => {
      const deviceId =
        input && typeof input === 'object' ? String((input as { deviceId?: unknown }).deviceId ?? '') : '';
      if (!deviceId) return { ok: false, reason: 'not-found' };
      const dc = getDaemonClient();
      // 'unavailable' rather than a generic failure: nothing was revoked AND
      // nothing was attempted, which the operator must read differently from a
      // roster write that failed halfway.
      if (!dc || !dc.isConnected) return { ok: false, reason: 'unavailable' };
      try {
        const res = (await dc.rpc('daemon.web.deviceRevoke', { deviceId })) as WebDeviceRevokeResult;
        if (res && typeof res === 'object' && typeof res.ok === 'boolean') return res;
        return { ok: false, reason: 'persist-failed' };
      } catch {
        // A rejected RPC leaves the roster in an unknown state. Report the
        // pessimistic outcome: the caller re-lists either way, and claiming a
        // revoke that may not have persisted is the one lie that matters here.
        return { ok: false, reason: 'persist-failed' };
      }
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
          const failed = info.error !== undefined;
          // A durable-revocation error is returned AFTER the daemon has stopped
          // the live listener. Confirm that fact rather than treating every
          // failed reply as "still running" and leaving a dead Tailscale front.
          const status = failed ? await call('daemon.web.status', {}) : undefined;
          const liveStopped =
            status !== undefined && status.error === undefined && status.running === false;
          // `call` has to use running:false for a rejected RPC because that
          // envelope carries no status. Once the fresh status succeeds, keep
          // its actual running state and attach the original stop error. This
          // leaves the toggle on when the listener itself failed to stop.
          const value =
            failed && status !== undefined && status.error === undefined
              ? { ...status, error: info.error }
              : info;
          return { failed, liveStopped, value };
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
    ipcMain.removeHandler(IPC.WEB_PAIR_START);
    ipcMain.removeHandler(IPC.WEB_DEVICE_LIST);
    ipcMain.removeHandler(IPC.WEB_DEVICE_REVOKE);
  };
}
