import { hasFlag, parseFlag } from './utils';
import { webHostIsLoopback, type WebTlsConfig } from '../shared/web';

/**
 * The server a `wmux web` re-run starts from: the running server's shape, or
 * the persisted record when the daemon has one it could not bring back.
 */
export interface PreviousWebShape {
  port: number;
  host: string;
  tailscale: boolean;
  allowedHosts: string[];
  tls: boolean;
  /**
   * Each grant, or undefined when the previous server did not report it (an
   * older daemon). An unknown grant is never sent, so it is never switched
   * off by accident; the daemon keeps it (`inheritUnsetGrants`).
   */
  allowInput: boolean | undefined;
  allowUpload: boolean | undefined;
  allowTranscript: boolean | undefined;
  allowDangerousLaunch: boolean | undefined;
  allowGitWrite: boolean | undefined;
}

export type WebGrantName = 'allowInput' | 'allowUpload' | 'allowTranscript' | 'allowDangerousLaunch' | 'allowGitWrite';

/** The CLI flag for each grant. `--no-<flag>` turns it off. */
export const WEB_GRANT_FLAGS: Record<WebGrantName, string> = {
  allowInput: 'allow-input',
  allowUpload: 'allow-upload',
  allowTranscript: 'allow-transcript',
  allowDangerousLaunch: 'allow-dangerous-launch',
  allowGitWrite: 'allow-git-write',
};

export interface WebStartPlan {
  port: number;
  /** Bind host to pass as `explicitHost`, or undefined to derive it from `expose`. */
  explicitHost: string | undefined;
  expose: boolean;
  tailscale: boolean;
  allowedHosts: string[];
  /** undefined = unknown and not given: leave it to the daemon. */
  grants: Record<WebGrantName, boolean | undefined>;
  /**
   * `false` = plain HTTP chosen, a config = native TLS chosen, undefined = not
   * this run's decision, so the daemon keeps whatever the server already had.
   */
  tls: WebTlsConfig | false | undefined;
  /** Human-readable settings carried over from the previous server. */
  kept: string[];
  /** Human-readable ways this run makes the server LESS reachable than before. */
  narrowed: string[];
}

const SCOPE_FLAGS = ['--tailscale', '--expose', '--host', '--loopback'] as const;

/**
 * Decide what a `wmux web` (re)start asks for.
 *
 * Every option NOT given on this command line keeps its previous value:
 * re-running `wmux web --allow-input` on a server started with `--tailscale
 * --allow-transcript` used to restart it loopback-only without the
 * transcript, cutting every paired phone off. Turning something off is now
 * explicit: `--no-allow-<x>` for a grant, `--loopback` for the exposure
 * scope, `--no-tls` for native HTTPS, or `--stop` for everything.
 *
 * With no previous server this reproduces the old fail-closed defaults
 * exactly: loopback, read-only, every grant off, plain HTTP.
 */
export function planWebStart(
  args: string[],
  requestedTls: WebTlsConfig | undefined,
  previous: PreviousWebShape | undefined,
  defaultPort: number,
): WebStartPlan {
  const kept: string[] = [];
  const narrowed: string[] = [];

  if (requestedTls && hasFlag(args, '--no-tls')) {
    throw new Error('--no-tls cannot be combined with --tls-cert/--tls-key');
  }

  const grants = {} as Record<WebGrantName, boolean | undefined>;
  for (const [name, flag] of Object.entries(WEB_GRANT_FLAGS) as [WebGrantName, string][]) {
    const on = hasFlag(args, `--${flag}`);
    const off = hasFlag(args, `--no-${flag}`);
    if (on && off) throw new Error(`--${flag} and --no-${flag} cannot be used together`);
    if (on || off) {
      grants[name] = on;
    } else if (!previous) {
      grants[name] = false;
    } else {
      grants[name] = previous[name];
      if (grants[name] === true) kept.push(`--${flag}`);
    }
  }

  const portRaw = parseFlag(args, '--port');
  let port: number;
  if (portRaw !== undefined) {
    port = Number(portRaw);
  } else if (previous) {
    port = previous.port;
    if (port !== defaultPort) kept.push(`--port ${port}`);
  } else {
    port = defaultPort;
  }

  const loopback = hasFlag(args, '--loopback');
  if (loopback && SCOPE_FLAGS.some((f) => f !== '--loopback' && hasFlag(args, f))) {
    throw new Error('--loopback cannot be combined with --tailscale, --expose or --host');
  }
  const scopeGiven = SCOPE_FLAGS.some((f) => hasFlag(args, f));
  const hostsGiven = hasFlag(args, '--allow-host');
  const givenHosts = (parseFlag(args, '--allow-host') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  let explicitHost: string | undefined;
  let expose: boolean;
  let tailscale: boolean;
  let allowedHosts: string[];
  if (scopeGiven || !previous) {
    // An explicit scope replaces the whole previous one, as before. The
    // allow-list goes with it unless it is given again: a tailnet MagicDNS
    // name kept after dropping the tailnet would advertise an address that
    // reaches nothing.
    explicitHost = parseFlag(args, '--host');
    expose = hasFlag(args, '--expose');
    tailscale = hasFlag(args, '--tailscale');
    allowedHosts = givenHosts;
  } else {
    // The exact bind the server had — loopback, 0.0.0.0, or a specific
    // address — so an option-only re-run cannot move it.
    explicitHost = previous.host;
    expose = false;
    tailscale = previous.tailscale;
    allowedHosts = hostsGiven ? givenHosts : [...previous.allowedHosts];
    if (tailscale) kept.push('--tailscale');
    if (!webHostIsLoopback(previous.host)) kept.push(`--host ${previous.host}`);
    if (!hostsGiven && previous.allowedHosts.length > 0 && !tailscale) {
      kept.push(`--allow-host ${previous.allowedHosts.join(',')}`);
    }
  }

  let tls: WebTlsConfig | false | undefined;
  if (requestedTls) {
    tls = requestedTls;
  } else if (hasFlag(args, '--no-tls') || !previous) {
    tls = false;
  } else if (tailscale) {
    // Tailscale terminates HTTPS itself, and the daemon never combines native
    // TLS with it, so there is nothing to keep or drop here.
    tls = undefined;
  } else {
    tls = undefined;
    if (previous.tls) kept.push('native HTTPS (--tls-cert/--tls-key)');
  }

  if (previous) {
    const nextHost = explicitHost ?? (expose ? '0.0.0.0' : '127.0.0.1');
    if (previous.tailscale && !tailscale) {
      narrowed.push('the tailnet (tailscale serve) address stops working for paired devices');
    }
    // Fronts behind a dropped Host name (a reverse proxy, a certificate DNS
    // name) stop working too. The tailnet case is already said above.
    if (!(previous.tailscale && !tailscale)) {
      const next = new Set(allowedHosts.map((h) => h.toLowerCase()));
      // With the tailnet kept, startWebTransport re-adds its MagicDNS name,
      // so that one is not being dropped.
      const dropped = previous.allowedHosts.filter(
        (h) => !next.has(h.toLowerCase()) && !(tailscale && h.toLowerCase().endsWith('.ts.net')),
      );
      if (dropped.length > 0) {
        narrowed.push(`requests for ${dropped.join(', ')} are no longer accepted (dropped from --allow-host)`);
      }
    }
    if (!webHostIsLoopback(previous.host) && webHostIsLoopback(nextHost)) {
      narrowed.push(`the server is no longer reachable from the network (was ${previous.host}, now loopback only)`);
    }
    if (previous.tls && tls === false) {
      narrowed.push('native HTTPS is dropped, which revokes every paired device');
    }
  }

  return { port, explicitHost, expose, tailscale, allowedHosts, grants, tls, kept, narrowed };
}
