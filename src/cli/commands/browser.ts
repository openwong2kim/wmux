import { sendRequest } from '../client';
import { printResult, ensureOk, parseFlag } from '../utils';
import { resolveSelfContext, getParentPidDefault } from '../identity';
import type { RpcResponse } from '../../shared/rpc';

/**
 * wmux open <url> [--workspace <id>]
 *
 * Opens (or reuses — X3 semantics) a browser pane and navigates it to <url>.
 * Inside a wmux pane the browser opens in the caller's own workspace via
 * verified PID-map identity; otherwise the active workspace is used.
 */
export async function handleOpen(args: string[], jsonMode: boolean): Promise<void> {
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('Error: open requires <url> — e.g. `wmux open http://localhost:3000`');
    process.exit(1);
  }

  let workspaceId = parseFlag(args, '--workspace');
  if (!workspaceId) {
    const ctx = await resolveSelfContext({
      sendRequest,
      env: process.env,
      ppid: process.ppid,
      getParentPid: getParentPidDefault,
    });
    workspaceId = ctx.workspaceId;
  }

  const params: Record<string, unknown> = { url };
  if (workspaceId) params.workspaceId = workspaceId;

  const response = await sendRequest('browser.open', params);
  if (jsonMode) {
    printResult(response);
  } else {
    ensureOk(response);
    console.log(`Opened in browser pane: ${url}`);
  }
}

const BROWSER_HELP = `
wmux browser — Browser Commands

USAGE
  wmux browser <subcommand> [args]

SUBCOMMANDS
  navigate <url>                  Navigate the active browser surface to a URL
  close [--workspace <id>]        Close the browser panel (defaults to your own
                                  workspace when run inside a wmux pane)
  session start [--profile <name>]  Start a browser session
  session stop                      Stop the active browser session
  session status                    Show active session status
  session list                      List available profiles

EXAMPLES
  wmux browser navigate "https://example.com"
  wmux browser close
  wmux browser session start --profile login
  wmux browser session status
  wmux browser session list
`.trimStart();

export async function handleBrowser(
  args: string[],
  jsonMode: boolean,
): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(BROWSER_HELP);
    process.exit(0);
  }

  let response: RpcResponse;

  switch (sub) {
    // ── browser navigate <url> ───────────────────────────────────────────────
    case 'navigate': {
      const url = rest[0];
      if (!url) {
        console.error('Error: browser navigate requires <url>');
        process.exit(1);
      }
      response = await sendRequest('browser.navigate', { url });
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log(`Navigated to: ${url}`);
      }
      break;
    }

    // ── browser close [--workspace <id>] ─────────────────────────────────────
    case 'close': {
      // Mirror `wmux open`: inside a wmux pane the close targets the caller's
      // own workspace via verified PID-map identity, so it can never tear down
      // a browser the user is viewing in another workspace. Outside a pane the
      // identity resolves to nothing and the active workspace is used (the
      // pre-fix behavior).
      let workspaceId = parseFlag(rest, '--workspace');
      if (!workspaceId) {
        const ctx = await resolveSelfContext({
          sendRequest,
          env: process.env,
          ppid: process.ppid,
          getParentPid: getParentPidDefault,
        });
        workspaceId = ctx.workspaceId;
      }
      const params: Record<string, unknown> = {};
      if (workspaceId) params.workspaceId = workspaceId;

      response = await sendRequest('browser.close', params);
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log('Browser panel closed.');
      }
      break;
    }

    // ── browser session <action> ─────────────────────────────────────────────
    case 'session': {
      const action = rest[0];
      if (!action || action === '--help' || action === '-h') {
        console.log('Usage: wmux browser session <start|stop|status|list>');
        process.exit(0);
      }

      switch (action) {
        case 'start': {
          const profileIdx = rest.indexOf('--profile');
          const profile = profileIdx !== -1 ? rest[profileIdx + 1] : undefined;
          const params: Record<string, unknown> = {};
          if (profile) params['profile'] = profile;
          response = await sendRequest('browser.session.start', params);
          if (jsonMode) {
            printResult(response);
          } else {
            ensureOk(response);
            const r = response.result as Record<string, unknown>;
            console.log(`Session started with profile: ${r['profile'] ?? 'default'}`);
          }
          break;
        }
        case 'stop': {
          response = await sendRequest('browser.session.stop', {});
          if (jsonMode) {
            printResult(response);
          } else {
            ensureOk(response);
            console.log('Session stopped.');
          }
          break;
        }
        case 'status': {
          response = await sendRequest('browser.session.status', {});
          if (jsonMode) {
            printResult(response);
          } else {
            ensureOk(response);
            const r = response.result as Record<string, unknown>;
            console.log(`Active profile: ${r['profile'] ?? 'none'}`);
            console.log(`CDP port: ${r['port'] ?? 'none'}`);
          }
          break;
        }
        case 'list': {
          response = await sendRequest('browser.session.list', {});
          if (jsonMode) {
            printResult(response);
          } else {
            ensureOk(response);
            const profiles = (response.result as Record<string, unknown>)['profiles'] as Array<Record<string, unknown>>;
            if (!profiles || profiles.length === 0) {
              console.log('No profiles found.');
            } else {
              for (const p of profiles) {
                console.log(`  ${p['name']}  (partition: ${p['partition']}, persistent: ${p['persistent']})`);
              }
            }
          }
          break;
        }
        default:
          console.error(`Unknown session action: "${action}". Use start, stop, status, or list.`);
          process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown browser subcommand: "${sub}". Run 'wmux browser --help' for usage.`);
      process.exit(1);
  }
}
