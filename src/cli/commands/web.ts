import { sendDaemonStringRequest } from '../client';
import { printResult, ensureOk, parseFlag, hasFlag, getResultError } from '../utils';
import {
  decideTailscaleBinding,
  describeTailscaleProblem,
  ensureTailscaleServe,
  removeTailscaleServe,
  type TailnetServe,
} from '../tailscale';
import type { RpcResponse } from '../../shared/rpc';

const DEFAULT_PORT = 7681;
const LOOPBACK_HOST = '127.0.0.1';
const EXPOSE_HOST = '0.0.0.0';

interface WebInfo {
  running: boolean;
  port?: number;
  host?: string;
  allowInput?: boolean;
  token?: string;
  urls?: string[];
  clients?: number;
  pairCode?: string;
  pairExpiresAt?: number;
}

/**
 * `wmux web` — expose wmux terminal panes to a browser / PWA.
 *
 * Safe defaults: read-only (execute-impossible stays the default) AND
 * loopback-only bind. Network exposure and keyboard input are each an explicit
 * opt-in flag. The server runs INSIDE the daemon, so it survives a GUI close
 * and never contends with the desktop for a pane.
 */
export async function handleWeb(args: string[], jsonMode: boolean): Promise<void> {
  // --status / --stop are control verbs; otherwise we (re)start.
  if (hasFlag(args, '--status')) {
    const response = await sendDaemonStringRequest('daemon.web.status', {});
    return report(response, jsonMode, 'status');
  }
  if (hasFlag(args, '--stop')) {
    // Learn the port BEFORE stopping: without it there is no way to tell a
    // serve config we created from one the operator set up themselves, and the
    // rule is that we only ever remove our own.
    const priorPort = webPortOf(await sendDaemonStringRequest('daemon.web.status', {}));
    const response = await sendDaemonStringRequest('daemon.web.stop', {});
    // Only tear the proxy down once the server is actually gone — a failed stop
    // leaves a running server that would otherwise lose its front door.
    const removal =
      priorPort !== undefined && getResultError(response) === undefined
        ? await removeTailscaleServe({ webPort: priorPort })
        : null;
    if (jsonMode) {
      if (removal?.removed && response.ok && isRecord(response.result)) {
        return printResult({ ...response, result: { ...response.result, tailscaleServeRemoved: true } });
      }
      return printResult(response);
    }
    ensureOk(response);
    console.log('wmux web stopped.');
    if (removal?.removed) console.log('`tailscale serve` configuration removed.');
    return;
  }

  const portRaw = parseFlag(args, '--port');
  const port = portRaw !== undefined ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    console.error('Error: --port must be an integer between 1 and 65535');
    process.exit(1);
  }

  // Host precedence: explicit --host wins; else --expose binds all interfaces;
  // else loopback-only (safe default — nothing off-machine can reach it).
  // `--tailscale` narrows this further — see decideTailscaleBinding.
  const explicitHost = parseFlag(args, '--host');
  let host = explicitHost ?? (hasFlag(args, '--expose') ? EXPOSE_HOST : LOOPBACK_HOST);
  const allowInput = hasFlag(args, '--allow-input');
  // Extra Host-header names the server should accept (comma-separated). A
  // reverse proxy in front of the loopback bind forwards the browser's Host
  // verbatim — `tailscale serve` sends the MagicDNS name, which the default
  // allowlist (loopback + bound addresses) would reject with 403.
  const allowedHosts = (parseFlag(args, '--allow-host') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  // #596: the token now survives a restart, so re-running `wmux web` to change
  // options no longer locks out a paired phone. `--new-token` is the explicit
  // way back to the old behaviour, i.e. revoke every device that has the token.
  const newToken = hasFlag(args, '--new-token');

  // `--tailscale`: register the HTTPS front door BEFORE the server starts, so
  // the Host-header allowlist can carry the MagicDNS name from the first boot
  // and the operator never has to restart to add it.
  let tailnet: TailnetServe | undefined;
  if (hasFlag(args, '--tailscale')) {
    const binding = decideTailscaleBinding({ explicitHost, expose: hasFlag(args, '--expose') });
    if (!binding.ok) {
      console.error(`Error: ${binding.error}`);
      process.exit(1);
    }
    host = binding.host;
    for (const warning of binding.warnings) console.warn(warning);

    const serve = await ensureTailscaleServe({ webPort: port });
    if (!serve.ok) {
      for (const line of describeTailscaleProblem(serve.problem, serve.detail)) console.error(line);
      process.exit(1);
    }
    tailnet = { magicDns: serve.magicDns, servePort: serve.servePort, url: serve.url };
    if (!allowedHosts.some((h) => h.toLowerCase() === serve.magicDns)) allowedHosts.push(serve.magicDns);
  }

  const response = await sendDaemonStringRequest('daemon.web.start', {
    port,
    host,
    allowInput,
    allowedHosts,
    newToken,
  });
  // Never leave a half-configured serve behind: a proxy in front of a server
  // that failed to start is a 502 the operator has to clean up by hand.
  if (tailnet && getResultError(response) !== undefined) {
    await removeTailscaleServe({ webPort: port, servePort: tailnet.servePort });
  }
  return report(response, jsonMode, 'start', tailnet);
}

/** The port a running web server reports, or undefined when it is not running. */
function webPortOf(response: RpcResponse): number | undefined {
  if (!response.ok || !isRecord(response.result)) return undefined;
  const port = response.result['port'];
  return typeof port === 'number' && Number.isInteger(port) ? port : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Pick a `host:port` for the `/pair` URL — a reachable LAN/tailnet address if
 * we have one, else fall back to the bind host:port. */
function pickPairHost(urls: string[], info: WebInfo, loopbackOnly: boolean): string {
  if (!loopbackOnly) {
    for (const u of urls) {
      try {
        const parsed = new URL(u);
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '::1') return parsed.host;
      } catch {
        /* ignore malformed */
      }
    }
  }
  // IPv6 literals must be bracketed in a URL authority (`[::1]:7681`).
  const host = info.host ?? '127.0.0.1';
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${authority}:${info.port ?? DEFAULT_PORT}`;
}

function report(
  response: RpcResponse,
  jsonMode: boolean,
  mode: 'start' | 'status',
  tailnet?: TailnetServe,
): void {
  if (jsonMode) {
    // A `--json` consumer must see the tailnet front door too — it is where the
    // phone connects, and it is nowhere in the daemon's own status payload.
    if (tailnet && response.ok && isRecord(response.result)) {
      return printResult({ ...response, result: { ...response.result, tailscale: tailnet } });
    }
    return printResult(response);
  }
  ensureOk(response);
  const info = response.result as WebInfo;

  if (!info.running) {
    console.log('wmux web is not running. Start it with `wmux web`.');
    return;
  }

  const urls = info.urls ?? [];
  const exposed = info.host === EXPOSE_HOST || info.host === '::';
  const loopbackOnly = info.host === LOOPBACK_HOST || info.host === '::1';

  console.log('');
  console.log(`  wmux web ${mode === 'start' ? 'started' : 'running'} — ${info.allowInput ? 'INPUT ENABLED' : 'read-only'}`);
  console.log(`  bind ${info.host}:${info.port}${typeof info.clients === 'number' ? `  ·  ${info.clients} viewer(s)` : ''}`);
  console.log('');

  // Severity-ordered warning: even read-only exposes the ENTIRE scrollback.
  console.log('  ⚠ Anyone who opens the page can read the FULL scrollback of the');
  console.log('    selected pane — even in read-only mode. Do not serve panes that');
  console.log('    have secrets, tokens, or private output on screen.');
  console.log('');

  if (tailnet) {
    console.log('  Fronted by `tailscale serve` — HTTPS, tailnet-only, no open LAN port.');
    console.log('  The proxy is removed again by `wmux web --stop`.');
    if (exposed) {
      console.log('  ⚠ The bind is ALSO reachable in plaintext on every interface (--expose).');
    }
  } else if (loopbackOnly) {
    console.log('  This bind is LOCAL-ONLY (127.0.0.1) — not reachable from your phone.');
    console.log('  For remote access, either:');
    console.log('    • run `wmux web --tailscale` for one-command HTTPS over your tailnet,');
    console.log('    • run `wmux web --expose` to bind all interfaces (tailnet + LAN), or');
    console.log('    • keep loopback and front it with `tailscale serve` (adds HTTPS) —');
    console.log('      restart with `wmux web --allow-host <your-magicdns-name>` so the');
    console.log('      proxied Host header is accepted.');
  } else if (exposed) {
    console.log('  ⚠ Reachable on ALL network interfaces (0.0.0.0). The access token is');
    console.log('    the only thing gating it — treat the URL below as a secret.');
  }
  if (tailnet) {
    console.log('');
    console.log('  Open on your phone (any device on your tailnet):');
    console.log(`    ${tailnet.url}/?token=${info.token ?? ''}`);
  } else if (urls.length) {
    console.log('');
    console.log(loopbackOnly ? '  Open locally:' : '  Open on your phone (same Tailscale tailnet or LAN):');
    for (const u of urls) console.log(`    ${u}`);
  } else if (info.token) {
    console.log(`  token: ${info.token}`);
  }

  // Pairing code: far easier to key in on a phone than the 36-char UUID token.
  // Prefer the tailnet origin, else the first non-loopback URL's host, so the
  // phone hits a reachable /pair.
  if (info.pairCode) {
    const pairOrigin = tailnet ? tailnet.url : `http://${pickPairHost(urls, info, loopbackOnly)}`;
    console.log('');
    console.log('  Pair from phone (no token typing):');
    console.log(`    open  ${pairOrigin}/pair`);
    console.log(`    enter code  ${info.pairCode}   (valid 10 min, single use)`);
  }
  console.log('');
  if (!info.allowInput) {
    console.log('  Read-only: the browser can watch panes but cannot type.');
    console.log('  Re-run with --allow-input to enable keyboard input.');
  } else {
    console.log('  Input is ENABLED: the browser can type into your panes.');
  }
  if (tailnet) {
    console.log('  PWA: served over HTTPS, so "Add to Home Screen", Android install and');
    console.log('  offline caching all work.');
  } else {
    console.log('  PWA: iOS "Add to Home Screen" works over HTTP; Android install');
    console.log('  and offline caching need HTTPS (front it with `tailscale serve`).');
  }
  console.log('');
  console.log('  This stays on across daemon restarts (crash, reboot, update) and the');
  console.log('  token above keeps working, so a phone left open reconnects by itself.');
  console.log('  Stop with `wmux web --stop` — that also revokes the token.');
  console.log('');
}
