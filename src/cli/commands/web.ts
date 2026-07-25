import { sendDaemonStringRequest } from '../client';
import { printResult, ensureOk, parseFlag, hasFlag, getResultError } from '../utils';
import {
  describeTailscaleProblem,
  startWebTransport,
  stopWebTransport,
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
  /** Present instead of `pairCode` when this bind could never redeem one. */
  pairRefusal?: { reason: string; detail: string };
  pairExpiresAt?: number;
  /** False when the device roster is unavailable — pairing falls back to the shared token. */
  deviceCredentials?: boolean;
  /** TLS fronts named with `--allow-host`. The address a phone can actually use. */
  allowedHosts?: string[];
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
    // The read-before-stop ordering and the "only remove our own" rule now live
    // in stopWebTransport, so the GUI cannot get a different answer than this.
    const stop = await stopWebTransport({
      readPort: async () => webPortOf(await sendDaemonStringRequest('daemon.web.status', {})),
      stopServer: async () => {
        const res = await sendDaemonStringRequest('daemon.web.stop', {});
        return { failed: getResultError(res) !== undefined, value: res };
      },
    });
    const response = stop.value;
    if (jsonMode) {
      if (stop.serveRemoved && response.ok && isRecord(response.result)) {
        return printResult({ ...response, result: { ...response.result, tailscaleServeRemoved: true } });
      }
      return printResult(response);
    }
    ensureOk(response);
    console.log('wmux web stopped.');
    if (stop.serveRemoved) console.log('`tailscale serve` configuration removed.');
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

  // `--tailscale`: the HTTPS front door is registered BEFORE the server starts
  // (so the Host allowlist carries the MagicDNS name from the first boot) and
  // rolled back if the start fails. Both live in startWebTransport.
  const start = await startWebTransport({
    port,
    tailscale: hasFlag(args, '--tailscale'),
    ...(explicitHost !== undefined ? { explicitHost } : {}),
    expose: hasFlag(args, '--expose'),
    allowedHosts,
    startServer: async ({ host, allowedHosts: hosts }) => {
      const res = await sendDaemonStringRequest('daemon.web.start', {
        port,
        host,
        allowInput,
        allowedHosts: hosts,
        newToken,
      });
      return { failed: getResultError(res) !== undefined, value: res };
    },
  });

  if (!start.ok) {
    if (start.kind === 'binding') console.error(`Error: ${start.error}`);
    else for (const line of describeTailscaleProblem(start.problem, start.detail)) console.error(line);
    process.exit(1);
  }
  for (const warning of start.warnings) console.warn(warning);
  return report(start.value, jsonMode, 'start', start.tailnet);
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

/**
 * The origin to print for pairing, scheme included.
 *
 * A named TLS front wins over everything, INCLUDING a loopback bind — that
 * combination is not an edge case, it is what `wmux web --tailscale` produces on
 * purpose (bind 127.0.0.1, let `tailscale serve` terminate HTTPS). `pickPairHost`
 * skips the URL scan when the bind is loopback, which is right for a bare
 * loopback server and wrong the moment a front exists, so the front is checked
 * before that gate rather than inside it.
 *
 * This is also why `--status` needed the front in the first place: `tailnet` is
 * only populated by the invocation that SET UP the serve, so a later `--status`
 * had nothing to go on and printed a loopback URL to an operator holding a
 * phone.
 */
function pickPairOrigin(urls: string[], info: WebInfo, loopbackOnly: boolean): string {
  const front = (info.allowedHosts ?? []).find((h) => h.trim().length > 0);
  if (front) return `https://${front.trim()}`;
  return `http://${pickPairHost(urls, info, loopbackOnly)}`;
}

/**
 * The `--status` warning for a server running WITHOUT per-device credentials,
 * or `null` when there is nothing to say.
 *
 * Printed ONLY in the false case. Announcing "per-device credentials: on" at
 * every healthy start would be noise nobody reads; saying nothing when they are
 * off would let an operator believe a lost phone can be cut off individually
 * when the only lever is rotating everybody — so the silence is the defect, not
 * the fallback itself.
 *
 * `undefined` is deliberately NOT a warning. A daemon predating this field
 * cannot answer the question, and inventing a scary alarm for "old daemon" is
 * the same class of lie as staying quiet for a real one.
 *
 * Extracted so the three cases are unit-testable without a daemon or a captured
 * console — the same reason `revokeDeviceAndDisconnect` lives on its own.
 */
export function deviceCredentialWarning(info: Pick<WebInfo, 'deviceCredentials'>): string[] | null {
  if (info.deviceCredentials !== false) return null;
  return [
    '  ⚠ Per-device credentials are OFF — the device roster could not be',
    '    loaded, so pairing hands out the SHARED token and `wmux web` has',
    '    nothing to revoke one device at a time. `--new-token` still',
    '    rotates everyone at once. Check the daemon log for the reason.',
  ];
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

  const roster = deviceCredentialWarning(info);
  if (roster) {
    for (const line of roster) console.log(line);
    console.log('');
  }

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
    console.log('  ⚠ UNENCRYPTED. Anyone on this network who can sniff traffic (open Wi-Fi,');
    console.log('    ARP spoofing, compromised switch) can read the access token and the');
    console.log('    full scrollback. Use `tailscale serve` (HTTPS) or wait for native TLS.');
  }
  if (tailnet) {
    console.log('');
    console.log('  Open on your phone (any device on your tailnet):');
    console.log(`    ${tailnet.url}/?token=${info.token ?? ''}`);
  } else if (urls.length) {
    console.log('');
    // A front means the phone can reach this even though the bind is loopback.
    const phoneReachable = !loopbackOnly || (info.allowedHosts ?? []).length > 0;
    console.log(phoneReachable ? '  Open on your phone (same Tailscale tailnet or LAN):' : '  Open locally:');
    for (const u of urls) console.log(`    ${u}`);
  } else if (info.token) {
    console.log(`  token: ${info.token}`);
  }

  // Pairing code: far easier to key in on a phone than the 36-char UUID token.
  // Prefer the tailnet origin, else the first non-loopback URL's host, so the
  // phone hits a reachable /pair.
  if (info.pairCode) {
    const pairOrigin = tailnet ? tailnet.url : pickPairOrigin(urls, info, loopbackOnly);
    console.log('');
    console.log('  Pair from phone (no token typing):');
    console.log(`    open  ${pairOrigin}/pair`);
    console.log(`    enter code  ${info.pairCode}   (valid 10 min, single use)`);
  } else if (info.pairRefusal) {
    // The server withholds the code when it could never be redeemed. Say why
    // instead of silently dropping the whole section — an absent pairing block
    // reads as "this build has no pairing", not as "this bind cannot pair".
    console.log('');
    console.log('  Pairing unavailable:');
    for (const line of info.pairRefusal.detail.split('\n')) console.log(`    ${line}`);
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
