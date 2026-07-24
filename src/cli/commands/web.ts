import { sendDaemonStringRequest } from '../client';
import { printResult, ensureOk, parseFlag, hasFlag } from '../utils';
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
    const response = await sendDaemonStringRequest('daemon.web.stop', {});
    if (jsonMode) return printResult(response);
    ensureOk(response);
    console.log('wmux web stopped.');
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
  const explicitHost = parseFlag(args, '--host');
  const host = explicitHost ?? (hasFlag(args, '--expose') ? EXPOSE_HOST : LOOPBACK_HOST);
  const allowInput = hasFlag(args, '--allow-input');

  const response = await sendDaemonStringRequest('daemon.web.start', { port, host, allowInput });
  return report(response, jsonMode, 'start');
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
  return `${info.host ?? '127.0.0.1'}:${info.port ?? DEFAULT_PORT}`;
}

function report(response: RpcResponse, jsonMode: boolean, mode: 'start' | 'status'): void {
  if (jsonMode) return printResult(response);
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

  if (loopbackOnly) {
    console.log('  This bind is LOCAL-ONLY (127.0.0.1) — not reachable from your phone.');
    console.log('  For remote access, either:');
    console.log('    • run `wmux web --expose` to bind all interfaces (tailnet + LAN), or');
    console.log('    • keep loopback and front it with `tailscale serve` (adds HTTPS).');
  } else if (exposed) {
    console.log('  ⚠ Reachable on ALL network interfaces (0.0.0.0). The access token is');
    console.log('    the only thing gating it — treat the URL below as a secret.');
  }
  if (urls.length) {
    console.log('');
    console.log(loopbackOnly ? '  Open locally:' : '  Open on your phone (same Tailscale tailnet or LAN):');
    for (const u of urls) console.log(`    ${u}`);
  } else if (info.token) {
    console.log(`  token: ${info.token}`);
  }

  // Pairing code: far easier to key in on a phone than the 36-char UUID token.
  // Prefer the first non-loopback URL's host so the phone hits a reachable /pair.
  if (info.pairCode) {
    const pairHost = pickPairHost(urls, info, loopbackOnly);
    console.log('');
    console.log('  Pair from phone (no token typing):');
    console.log(`    open  http://${pairHost}/pair`);
    console.log(`    enter code  ${info.pairCode}   (valid 10 min, single use)`);
  }
  console.log('');
  if (!info.allowInput) {
    console.log('  Read-only: the browser can watch panes but cannot type.');
    console.log('  Re-run with --allow-input to enable keyboard input.');
  } else {
    console.log('  Input is ENABLED: the browser can type into your panes.');
  }
  console.log('  PWA: iOS "Add to Home Screen" works over HTTP; Android install');
  console.log('  and offline caching need HTTPS (front it with `tailscale serve`).');
  console.log('  Stop with `wmux web --stop`.');
  console.log('');
}
