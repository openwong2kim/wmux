import { sendRequest, setWorkspaceToken } from '../client';
import { printResult, ensureOk, parseFlag } from '../utils';
import { resolveSelfContext, getParentPidDefault, type SelfContext } from '../identity';
import type { RpcResponse } from '../../shared/rpc';
import type { ClaimRefusal } from '../../shared/identityClaims';

/**
 * Resolve this CLI's pane through main's own process-tree walk and carry the
 * pane claim main returns on every later request. Browser calls act on the
 * workspace main verifies for the caller; `--workspace` can only narrow it.
 */
async function attestBrowserCaller(): Promise<SelfContext> {
  const ctx = await resolveSelfContext({
    sendRequest,
    env: process.env,
    ppid: process.ppid,
    getParentPid: getParentPidDefault,
    callerPid: process.pid,
  });
  if (ctx.workspaceToken) {
    setWorkspaceToken(ctx.workspaceToken);
    return ctx;
  }
  // Nothing to send that wmux would accept: say how to run it instead of
  // making a call that is refused. A pane found without a claim means the
  // running wmux app predates pane claims (it answers the walk, mints none),
  // unless main says it did not take this process's claim.
  console.error(browserCallerError(ctx));
  process.exit(1);
}

/** What `wmux browser` / `wmux open` say when wmux gave no pane claim. */
export function browserCallerError(ctx: SelfContext): string {
  if (ctx.claimRefused) {
    return `Error: wmux could not verify this process for browser commands: ${claimRefusalText(ctx.claimRefused)} ` +
      'Run `wmux doctor` (identity section) for details.';
  }
  return ctx.workspaceId
    ? 'Error: wmux found this pane but did not verify it for browser commands. If the wmux app is ' +
        'older than the wmux CLI, update the wmux app (and restart it); otherwise run `wmux doctor` ' +
        'to see why, then run the command again.'
    : 'Error: wmux browser commands act on the wmux pane they run in, and this terminal is not ' +
        'one (or wmux could not verify it). Run the command from a wmux pane terminal, or run ' +
        '`wmux doctor` to see why it was not verified.';
}

/** One sentence on why main did not take the claim. */
export function claimRefusalText(reason: ClaimRefusal, platform: NodeJS.Platform = process.platform): string {
  switch (reason) {
    case 'no-peer': return 'wmux cannot read which process is on the other end of this connection.';
    case 'other-pid': return 'the connection came from another process than this one.';
    case 'start-unread':
      return platform === 'darwin'
        ? 'wmux cannot read this process\'s start time (a process running as another user is always refused).'
        : 'wmux cannot read this process\'s start time (from /proc).';
    case 'restarted': return 'this process id now belongs to a process that started later.';
    case 'broker-unverified': return 'the connection came from an MCP broker wmux did not verify.';
  }
}

/**
 * wmux open <url> [--new] [--workspace <id>]
 *
 * Opens (or reuses — X3 semantics) a browser pane and navigates it to <url>.
 * `--new` opens <url> in a new tab of that pane instead (#2140).
 * The browser opens in the workspace of the wmux pane this runs in, verified
 * by main; outside a pane the command is refused with how to run it.
 */
export async function handleOpen(args: string[], jsonMode: boolean): Promise<void> {
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('Error: open requires <url> — e.g. `wmux open http://localhost:3000`');
    process.exit(1);
  }

  const self = await attestBrowserCaller();
  const workspaceId = parseFlag(args, '--workspace') ?? self.workspaceId;

  const params: Record<string, unknown> = { url };
  if (workspaceId) params.workspaceId = workspaceId;
  if (args.includes('--new')) params.newTab = true;

  const response = await sendRequest('browser.open', params);
  if (jsonMode) {
    printResult(response);
  } else {
    ensureOk(response);
    console.log(params.newTab ? `Opened in a new browser tab: ${url}` : `Opened in browser pane: ${url}`);
  }
}

const BROWSER_HELP = `
wmux browser — Browser Commands

USAGE
  wmux browser <subcommand> [args]

SUBCOMMANDS
  navigate <url>                  Navigate your workspace's browser surface
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
      // Resolve the caller exactly like `wmux open` / `wmux browser close`:
      // the pane this runs in, verified by main.
      const ctx = await attestBrowserCaller();
      const workspaceId = ctx.workspaceId;
      const params: Record<string, unknown> = { url };
      if (workspaceId) params.workspaceId = workspaceId;

      response = await sendRequest('browser.navigate', params);
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
      // command is refused with how to run it.
      const self = await attestBrowserCaller();
      const workspaceId = parseFlag(rest, '--workspace') ?? self.workspaceId;
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
      // Session calls take the caller's workspace from the pane claim too.
      await attestBrowserCaller();

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
