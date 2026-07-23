import { sendDaemonStringRequest } from '../client';
import { printResult, ensureOk, parseFlag, hasFlag } from '../utils';
import type { RpcResponse } from '../../shared/rpc';

const DEFAULT_PORT = 7681;
const DEFAULT_HOST = '0.0.0.0';

interface WebInfo {
  running: boolean;
  port?: number;
  host?: string;
  allowInput?: boolean;
  token?: string;
  urls?: string[];
  clients?: number;
}

/**
 * `wmux web` — expose wmux terminal panes to a browser / PWA.
 *
 * Read-only by default (execute-impossible stays the default posture); pass
 * `--allow-input` to enable keyboard input. The server runs INSIDE the daemon,
 * so it survives a GUI close and never contends with the desktop for a pane.
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
  const host = parseFlag(args, '--host') ?? DEFAULT_HOST;
  const allowInput = hasFlag(args, '--allow-input');

  const response = await sendDaemonStringRequest('daemon.web.start', { port, host, allowInput });
  return report(response, jsonMode, 'start');
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
  console.log('');
  console.log(`  wmux web ${mode === 'start' ? 'started' : 'running'} — ${info.allowInput ? 'INPUT ENABLED' : 'read-only'}`);
  console.log(`  bind ${info.host}:${info.port}${typeof info.clients === 'number' ? `  ·  ${info.clients} viewer(s)` : ''}`);
  console.log('');
  if (urls.length) {
    console.log('  Open on your phone (same Tailscale tailnet or LAN):');
    for (const u of urls) console.log(`    ${u}`);
  } else if (info.token) {
    console.log(`  token: ${info.token}`);
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
