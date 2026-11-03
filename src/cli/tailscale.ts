import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { isCanonicalIpv4, isTailnetIpv4 } from '../shared/a2aRemote';
import { getExecEnv } from '../shared/execEnv';

const execFileAsync = promisify(execFile);

/**
 * `wmux web --tailscale` — collapse the "get a phone connected" ritual.
 *
 * Without this, reaching a pane from a phone is: install Tailscale, run
 * `tailscale serve` by hand, work out your own MagicDNS name, then RESTART
 * `wmux web --allow-host <that name>` because the Host-header allowlist is
 * fixed at start. Three of those four steps exist only because the two halves
 * never talked to each other.
 *
 * What this module owns:
 *   - reading the tailnet identity (`tailscale status --json`),
 *   - deciding whether the serve slot is free, ALREADY OURS, or someone else's
 *     — a foreign config is never overwritten, it is reported and refused,
 *   - registering and deregistering the serve, so the lifecycle belongs to
 *     `wmux web` / `wmux web --stop` rather than to the operator's memory.
 *
 * Everything that makes a DECISION is a pure exported function tested on its
 * own; the only impure part is `runTailscale`, which goes through an injectable
 * exec seam (same shape as `PrExec` in TaskPrService) so no test ever spawns a
 * real binary.
 */

/** The tailnet HTTPS port `tailscale serve` fronts on by default. */
export const DEFAULT_SERVE_PORT = 443;

const TAILSCALE_TIMEOUT_MS = 15_000;
const TAILSCALE_MAX_BUFFER = 4 * 1024 * 1024;

/** exec minimum surface (test injection). Rejects on a non-zero exit. */
export type TailscaleExec = (
  cmd: string,
  args: string[],
  opts: { timeout: number; windowsHide: boolean; maxBuffer: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export type TailscaleProblem =
  | 'not-installed'
  | 'not-running'
  | 'not-logged-in'
  | 'needs-machine-auth'
  | 'stopped'
  | 'no-magicdns'
  | 'status-unreadable'
  | 'serve-status-unreadable'
  | 'port-taken'
  | 'needs-elevation'
  | 'no-https-certs'
  | 'serve-failed';

export interface TailnetServe {
  /** The machine's MagicDNS name, lowercased, no trailing dot. */
  magicDns: string;
  /** The tailnet-side HTTPS port the serve listens on. */
  servePort: number;
  /** Browser origin the phone opens, port omitted when it is the default. */
  url: string;
}

export type TailscaleSetup =
  | ({
      ok: true;
      /**
       * The slot already proxied to this web port before this call. Then the
       * front was not created here and may belong to a server that is still
       * running (another wmux instance on the same port), so a failed start
       * must leave it alone.
       */
      preexisting: boolean;
    } & TailnetServe)
  | { ok: false; problem: TailscaleProblem; detail?: string };

// === identity ===============================================================

/**
 * Extract the machine's MagicDNS name from `tailscale status --json`.
 *
 * `BackendState` is checked before `Self`, because a logged-out client still
 * reports a stale `Self` block and reading a name out of it would produce a
 * serve pointing at a host nothing can resolve.
 */
export function parseTailnetIdentity(
  stdout: string,
): { ok: true; magicDns: string } | { ok: false; problem: TailscaleProblem } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { ok: false, problem: 'status-unreadable' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, problem: 'status-unreadable' };

  const state = typeof parsed['BackendState'] === 'string' ? parsed['BackendState'] : '';
  if (state === 'NeedsLogin' || state === 'NoState') return { ok: false, problem: 'not-logged-in' };
  if (state === 'NeedsMachineAuth') return { ok: false, problem: 'needs-machine-auth' };
  if (state === 'Stopped') return { ok: false, problem: 'stopped' };

  const tailnet = parsed['CurrentTailnet'];
  if (tailnet && typeof tailnet === 'object' && (tailnet as Record<string, unknown>)['MagicDNSEnabled'] === false) {
    return { ok: false, problem: 'no-magicdns' };
  }

  const self = parsed['Self'];
  const dnsName =
    self && typeof self === 'object' && typeof (self as Record<string, unknown>)['DNSName'] === 'string'
      ? ((self as Record<string, unknown>)['DNSName'] as string)
      : '';
  const magicDns = dnsName.trim().replace(/\.$/, '').toLowerCase();
  // A bare hostname means MagicDNS handed out no FQDN — there is nothing an
  // HTTPS certificate could be issued for, so serve would fail later anyway.
  if (!magicDns || !magicDns.includes('.')) return { ok: false, problem: 'no-magicdns' };
  return { ok: true, magicDns };
}

// === serve config ownership =================================================

export type ServeOwnership = 'free' | 'ours' | 'foreign' | 'unreadable';

/**
 * Who owns the serve configuration on `servePort`.
 *
 * `ours` means every handler on that port already proxies to our own loopback
 * web port — re-registering is then idempotent. ANYTHING else that is
 * configured is `foreign` and must not be touched: a `tailscale serve` config
 * is a single shared slot per port, so overwriting it would silently take down
 * whatever the operator was already publishing.
 */
export function classifyServeConfig(
  stdout: string,
  opts: { servePort: number; webPort: number },
): ServeOwnership {
  const raw = stdout.trim();
  // Nothing configured: modern clients print `{}`, some print nothing at all.
  if (!raw) return 'free';

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 'unreadable';
  }
  if (!parsed || typeof parsed !== 'object') return 'unreadable';

  const suffix = `:${opts.servePort}`;
  const web = asRecord(parsed['Web']);
  const matching = Object.keys(web).filter((k) => k.endsWith(suffix));

  if (matching.length === 0) {
    // A TCP entry with no web handlers is a raw port forward someone else set
    // up. It occupies the same slot, so it is theirs, not free.
    const tcp = asRecord(parsed['TCP']);
    return tcp[String(opts.servePort)] === undefined ? 'free' : 'foreign';
  }

  for (const key of matching) {
    const handlers = asRecord(asRecord(web[key])['Handlers']);
    const paths = Object.keys(handlers);
    if (paths.length === 0) return 'foreign';
    for (const p of paths) {
      if (p !== '/') return 'foreign';
      const proxy = asRecord(handlers[p])['Proxy'];
      if (typeof proxy !== 'string' || !isLoopbackProxy(proxy, opts.webPort)) return 'foreign';
    }
  }
  return 'ours';
}

/** Does this proxy target point at our own loopback web port? */
function isLoopbackProxy(proxy: string, webPort: number): boolean {
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  return loopback && url.port === String(webPort);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// === flag precedence ========================================================

/**
 * Resolve the bind host when `--tailscale` is combined with `--host`/`--expose`.
 *
 * PRECEDENCE, stated once so no flag is silently dropped: `--tailscale` means
 * "front the web server with `tailscale serve`", and serve always proxies to
 * `127.0.0.1:<port>`. So the bind must include loopback.
 *
 *   - `--tailscale` alone            → loopback. Nothing is exposed directly.
 *   - `--tailscale` + a loopback     → identical to the above.
 *     `--host`
 *   - `--tailscale` + `--expose`, or → the wildcard bind wins and is honoured,
 *     `--host 0.0.0.0` / `--host ::`   with a warning: the port is now ALSO
 *                                      reachable in plaintext on every
 *                                      interface, which `--tailscale` alone
 *                                      deliberately avoids.
 *   - `--tailscale` + any other      → REFUSED. Pinning the bind to one
 *     `--host`                         address means serve's loopback target is
 *                                      not listening, so the setup would look
 *                                      successful and serve 502s forever.
 */
export function decideTailscaleBinding(opts: {
  explicitHost?: string;
  expose: boolean;
}): { ok: true; host: string; warnings: string[] } | { ok: false; error: string } {
  const host = (opts.explicitHost ?? '').trim().toLowerCase();
  const wildcardWarning =
    '⚠ --tailscale with a wildcard bind: `tailscale serve` still fronts loopback with HTTPS, ' +
    'but the port is now also reachable in plaintext on every interface.';

  if (!host) {
    return opts.expose
      ? { ok: true, host: '0.0.0.0', warnings: [wildcardWarning] }
      : { ok: true, host: '127.0.0.1', warnings: [] };
  }
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    return { ok: true, host, warnings: [] };
  }
  if (host === '0.0.0.0' || host === '::') {
    return { ok: true, host, warnings: [wildcardWarning] };
  }
  return {
    ok: false,
    error:
      `--tailscale cannot be combined with --host ${host}: \`tailscale serve\` proxies to ` +
      '127.0.0.1, which that bind does not listen on. Use --tailscale on its own (loopback), ' +
      'or add --expose if you also want direct LAN access.',
  };
}

// === failure copy ===========================================================

/**
 * What to print when a `--tailscale` step fails. Severity-ordered like the rest
 * of `wmux web`'s output: what went wrong, what to do about it, and — last —
 * the reassurance that nothing was left half-configured.
 */
export function describeTailscaleProblem(
  problem: TailscaleProblem,
  detail?: string,
  /**
   * `check`: the copy for a read-only readiness check, which started and
   * refused nothing — so no "Refusing to overwrite it" and no closing "was NOT
   * started" line, both of which describe a start that never happened.
   */
  opts: { context?: 'start' | 'check' } = {},
): string[] {
  const check = opts.context === 'check';
  const lines: string[] = [];
  const push = (...l: string[]): void => {
    lines.push(...l);
  };

  switch (problem) {
    case 'not-installed':
      push(
        'Error: --tailscale needs the Tailscale CLI, and `tailscale` is not on PATH.',
        '  • Install it from https://tailscale.com/download, then run `tailscale up`.',
        '  • On Windows the CLI ships with the desktop app; a fresh install may need',
        '    a new terminal before PATH picks it up.',
      );
      break;
    case 'not-running':
      push(
        'Error: Tailscale is off: it is installed but not running.',
        '  • Open the Tailscale app (or start the tailscaled service), then retry.',
      );
      break;
    case 'not-logged-in':
      push(
        'Error: Tailscale is installed but not logged in.',
        '  • Run `tailscale up` and complete the browser sign-in, then retry.',
      );
      break;
    case 'needs-machine-auth':
      push(
        'Error: this machine is signed in but still waiting for tailnet approval.',
        '  • Approve it at https://login.tailscale.com/admin/machines, then retry.',
      );
      break;
    case 'stopped':
      push(
        'Error: Tailscale is logged in but stopped, so it has no tailnet address.',
        '  • Run `tailscale up` (or start it from the tray icon), then retry.',
      );
      break;
    case 'no-magicdns':
      push(
        'Error: this tailnet has no MagicDNS name for the machine, so there is no',
        '  HTTPS hostname to serve on.',
        '  • Enable MagicDNS AND HTTPS Certificates on the DNS page of the admin',
        '    console (https://login.tailscale.com/admin/dns), then retry.',
        '  • Or skip --tailscale and use `wmux web --expose` over plain HTTP.',
      );
      break;
    case 'port-taken':
      push(
        'Error: `tailscale serve` already publishes something else on this port.',
        ...(check ? [] : ['  Refusing to overwrite it — a serve config is one shared slot per port.']),
        '  • Inspect it with `tailscale serve status`.',
        '  • Free it with `tailscale serve --https=443 off`, or run `wmux web`',
        '    without --tailscale.',
      );
      break;
    case 'needs-elevation':
      push(
        'Error: `tailscale serve` was refused for lack of privileges.',
        '  • Windows: re-run from a terminal started with "Run as administrator".',
        '  • macOS/Linux: re-run with sudo, or grant your user standing access',
        '    with `tailscale set --operator=$USER`.',
      );
      break;
    case 'no-https-certs':
      push(
        'Error: `tailscale serve` needs HTTPS certificates, which this tailnet has',
        '  not enabled.',
        '  • Turn on HTTPS Certificates on the DNS page of the admin console',
        '    (https://login.tailscale.com/admin/dns), then retry.',
      );
      break;
    case 'status-unreadable':
      push(
        'Error: could not read `tailscale status --json`.',
        '  • Check that the Tailscale service is running, then retry.',
      );
      break;
    case 'serve-status-unreadable':
      push(
        'Error: could not read `tailscale serve status --json`, so there is no way',
        '  to tell whether this port is already publishing something.',
        '  • Refusing to configure it blind. Check `tailscale serve status`, or',
        '    update the Tailscale client, then retry.',
      );
      break;
    case 'serve-failed':
      push('Error: `tailscale serve` failed.');
      break;
  }

  if (detail) {
    // Print what tailscale actually said, not just the first line. The first
    // line is the exec wrapper ("Command failed: <the command>"), and the part
    // that helps is underneath it — "Serve is not enabled on your tailnet",
    // followed by a one-click URL to enable it. Taking [0] threw exactly that
    // away and left the operator with a failure and no next step, which is
    // what dogfooding hit. Capped so a pathological stderr cannot bury the
    // rollback line below.
    const said = detail
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^Command failed:/i.test(l))
      .slice(0, 8);
    if (said.length > 0) {
      push('', '  tailscale said:');
      for (const line of said) push(`    ${line}`);
    }
  }
  if (!check) push('', '  wmux web was NOT started and no serve configuration was left behind.');
  return lines;
}

// === orchestration ==========================================================

export type TailscaleDiagnosis =
  | { ok: true; magicDns: string; serve: 'free' | 'ours' }
  | { ok: false; problem: TailscaleProblem; detail?: string };

/**
 * Could `tailscale serve` be set up in front of `webPort` right now?
 *
 * READ-ONLY: runs `tailscale status --json` and `tailscale serve status --json`
 * and nothing else. It is the read half of `ensureTailscaleServe` (which calls
 * it before writing), exported so the phone wizard can check readiness without
 * registering, removing or repairing anything.
 */
export async function diagnoseTailscale(opts: {
  webPort: number;
  servePort?: number;
  exec?: TailscaleExec;
  /** Aborting kills a tailscale read still running (the caller's deadline). */
  signal?: AbortSignal;
}): Promise<TailscaleDiagnosis> {
  const exec = opts.exec ?? (execFileAsync as unknown as TailscaleExec);
  const servePort = opts.servePort ?? DEFAULT_SERVE_PORT;

  let statusOut: string;
  try {
    statusOut = (await runTailscale(exec, ['status', '--json'], opts.signal)).stdout;
  } catch (err) {
    return { ok: false, problem: classifyStatusError(err), detail: errText(err) };
  }
  const identity = parseTailnetIdentity(statusOut);
  if (!identity.ok) return { ok: false, problem: identity.problem };

  let ownership: ServeOwnership;
  try {
    ownership = classifyServeConfig((await runTailscale(exec, ['serve', 'status', '--json'], opts.signal)).stdout, {
      servePort,
      webPort: opts.webPort,
    });
  } catch (err) {
    return { ok: false, problem: 'serve-status-unreadable', detail: errText(err) };
  }
  if (ownership === 'foreign') return { ok: false, problem: 'port-taken' };
  if (ownership === 'unreadable') return { ok: false, problem: 'serve-status-unreadable' };
  return { ok: true, magicDns: identity.magicDns, serve: ownership };
}

/**
 * Bring up `tailscale serve` in front of a loopback `wmux web` on `webPort`.
 *
 * Fails CLOSED at every step: an unreadable serve status is treated as "cannot
 * prove the slot is free", not as "probably fine".
 */
export async function ensureTailscaleServe(opts: {
  webPort: number;
  servePort?: number;
  exec?: TailscaleExec;
}): Promise<TailscaleSetup> {
  const exec = opts.exec ?? (execFileAsync as unknown as TailscaleExec);
  const servePort = opts.servePort ?? DEFAULT_SERVE_PORT;

  const probe = await diagnoseTailscale({ webPort: opts.webPort, servePort, exec });
  if (!probe.ok) return probe;
  const { magicDns, serve: ownership } = probe;

  try {
    await runTailscale(exec, ['serve', '--bg', `--https=${servePort}`, `http://127.0.0.1:${opts.webPort}`]);
  } catch (err) {
    // A failed registration can still have written a partial config. Roll back
    // only what we could have created: if the slot was already ours before, the
    // operator's earlier working config stays.
    if (ownership === 'free') {
      await runTailscale(exec, ['serve', `--https=${servePort}`, 'off']).catch(() => undefined);
    }
    return { ok: false, problem: classifyServeError(errText(err)), detail: errText(err) };
  }

  return {
    ok: true,
    preexisting: ownership === 'ours',
    magicDns,
    servePort,
    url: servePort === 443 ? `https://${magicDns}` : `https://${magicDns}:${servePort}`,
  };
}

export type ServeRemoval = 'removed' | 'not-ours' | 'nothing' | 'unavailable';

/**
 * Tear down the serve registration `ensureTailscaleServe` created — and ONLY
 * that one. A config that points anywhere but our own loopback web port is
 * reported as `not-ours` and left exactly as it was.
 *
 * Called unconditionally by `wmux web --stop`, including on machines with no
 * Tailscale at all: the classification is what makes that safe, and a missing
 * binary resolves to `unavailable` without printing anything.
 */
export async function removeTailscaleServe(opts: {
  webPort: number;
  servePort?: number;
  exec?: TailscaleExec;
}): Promise<{ removed: boolean; reason: ServeRemoval }> {
  const exec = opts.exec ?? (execFileAsync as unknown as TailscaleExec);
  const servePort = opts.servePort ?? DEFAULT_SERVE_PORT;

  let ownership: ServeOwnership;
  try {
    ownership = classifyServeConfig((await runTailscale(exec, ['serve', 'status', '--json'])).stdout, {
      servePort,
      webPort: opts.webPort,
    });
  } catch {
    return { removed: false, reason: 'unavailable' };
  }
  if (ownership === 'unreadable') return { removed: false, reason: 'unavailable' };
  if (ownership === 'foreign') return { removed: false, reason: 'not-ours' };
  if (ownership === 'free') return { removed: false, reason: 'nothing' };

  try {
    await runTailscale(exec, ['serve', `--https=${servePort}`, 'off']);
  } catch {
    return { removed: false, reason: 'unavailable' };
  }
  return { removed: true, reason: 'removed' };
}

// === process plumbing =======================================================

/**
 * Where to look for the CLI when a bare `tailscale` gets ENOENT.
 *
 * Windows: the binary ships with the desktop app and its directory is
 * frequently absent from a shell's PATH (the installer only updates the
 * machine PATH, which an already-open terminal never sees).
 *
 * macOS: the standalone desktop app ships the CLI INSIDE the app bundle and
 * never puts it on any PATH at all — Tailscale's own docs tell users to alias
 * it by hand. And when this module runs in the GUI process (Serve-to-browser
 * panel), even a hand-made `/usr/local/bin` or `~/.local/bin` symlink is
 * invisible to launchd's minimal PATH, which is exactly how the "Start" button
 * failed with ENOENT while `wmux web --tailscale` worked in a terminal
 * (owner-reported 2026-07-27; `getExecEnv()` covers the symlink case, the
 * bundle path covers a stock install).
 */
export function tailscaleCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    return ['tailscale.exe', ...windowsTailscaleDirs(env).map((dir) => path.win32.join(dir, 'tailscale.exe'))];
  }
  if (platform === 'darwin') {
    // A Homebrew or hand-made symlink is found as a bare `tailscale`, because
    // `getExecEnv()` adds the Homebrew prefixes to PATH. The app bundle may
    // also have been dragged into the per-user Applications folder.
    const home = env['HOME'];
    return [
      'tailscale',
      MAC_APP_CLI,
      ...(home ? [path.posix.join(home, MAC_APP_CLI)] : []),
    ];
  }
  return ['tailscale'];
}

const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * Where the Windows installer puts Tailscale. `ProgramW6432` is the 64-bit
 * Program Files even from a 32-bit process, whose own `ProgramFiles` points
 * at `Program Files (x86)`.
 */
function windowsTailscaleDirs(env: NodeJS.ProcessEnv): string[] {
  const roots = [env['ProgramFiles'] || 'C:\\Program Files', env['ProgramW6432']].filter((r): r is string => !!r);
  return [...new Set(roots)].map((root) => path.win32.join(root, 'Tailscale'));
}

/** The page the "download" action opens: Tailscale's official download page. */
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';

/**
 * How to bring the Tailscale app to the front, per platform, or null where
 * there is no app to open (Linux runs the daemon only).
 *
 * Opening the app is the MOST a click on the checklist ever does: signing in,
 * connecting and `tailscale up` stay the person's own act inside Tailscale.
 * On Windows the candidates are absolute paths, so the caller launches the
 * first one that exists and falls back to the download page.
 */
export function tailscaleAppLaunch(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[] }[] | null {
  if (platform === 'darwin') return [{ cmd: 'open', args: ['-a', 'Tailscale'] }];
  if (platform === 'win32') {
    return windowsTailscaleDirs(env).map((dir) => ({ cmd: path.win32.join(dir, 'tailscale-ipn.exe'), args: [] }));
  }
  return null;
}

// === connection checklist ===================================================
//
// The Remote page's four checks, read from ONE `tailscale status --json`:
//
//   installed ── the CLI ran at all                   fail → download page
//   signed-in ── the daemon answered and has a login   fail → open Tailscale
//   self      ── this PC is Running and online         fail → open Tailscale
//   peer      ── the other PC or phone is online       fail → how to sign it in
//
// The first failure is the only one with an action; the checks after it are
// `unchecked`, since they cannot be known (or acted on) until it is fixed.
// Read-only like `diagnoseTailscale`: nothing here runs `up`, `login` or any
// other command that changes Tailscale.

export type TailscaleCheckId = 'installed' | 'signed-in' | 'self' | 'peer';
export type TailscaleFix = 'download' | 'open-app' | 'sign-in' | 'peer-help';
export type TailscaleCheckReason =
  | 'not-installed'
  | 'not-running'
  | 'signed-out'
  | 'unreadable'
  | 'needs-approval'
  | 'stopped'
  | 'offline'
  | 'no-peer'
  | 'peer-offline';

export interface TailscaleCheckItem {
  id: TailscaleCheckId;
  state: 'pass' | 'fail' | 'unchecked';
  reason?: TailscaleCheckReason;
  fix?: TailscaleFix;
}

export interface TailscaleChecklist {
  /** Always the four items, in the order above. */
  items: TailscaleCheckItem[];
  ok: boolean;
  /** This PC's tailnet name, when signed in. */
  selfName?: string;
  /** Other devices on the tailnet that are online now. */
  peersOnline?: number;
}

const CHECK_IDS: readonly TailscaleCheckId[] = ['installed', 'signed-in', 'self', 'peer'];

/**
 * The four checks from what `tailscale status --json` returned (or how it
 * failed). `peer` names the device to look for — its MagicDNS name, short
 * host name or tailnet address; without one, any other online device passes.
 */
export function classifyTailscaleChecklist(
  input: { stdout: string } | { error: unknown },
  peer?: string,
): TailscaleChecklist {
  const items: TailscaleCheckItem[] = CHECK_IDS.map((id) => ({ id, state: 'unchecked' }));
  const result = (extra: Omit<TailscaleChecklist, 'items' | 'ok'> = {}): TailscaleChecklist => ({
    items,
    ok: items.every((i) => i.state === 'pass'),
    ...extra,
  });
  const passUntil = (n: number): void => {
    for (let i = 0; i < n; i++) items[i] = { id: CHECK_IDS[i], state: 'pass' };
  };
  const fail = (n: number, reason: TailscaleCheckReason, fix: TailscaleFix, extra?: Omit<TailscaleChecklist, 'items' | 'ok'>) => {
    passUntil(n);
    items[n] = { id: CHECK_IDS[n], state: 'fail', reason, fix };
    return result(extra);
  };

  if ('error' in input) {
    const problem = classifyStatusError(input.error);
    if (problem === 'not-installed') return fail(0, 'not-installed', 'download');
    if (problem === 'not-logged-in') return fail(1, 'signed-out', 'sign-in');
    if (problem === 'stopped') return fail(2, 'stopped', 'open-app');
    return fail(1, problem === 'not-running' ? 'not-running' : 'unreadable', 'open-app');
  }

  let status: Record<string, unknown>;
  try {
    status = asRecord(JSON.parse(input.stdout));
  } catch {
    return fail(1, 'unreadable', 'open-app');
  }
  const state = typeof status['BackendState'] === 'string' ? status['BackendState'] : '';
  if (!state) return fail(1, 'unreadable', 'open-app');
  if (state === 'NeedsLogin' || state === 'NoState') return fail(1, 'signed-out', 'sign-in');

  const self = asRecord(status['Self']);
  const selfName = typeof self['HostName'] === 'string' && self['HostName'] ? self['HostName'] : undefined;
  const named = selfName ? { selfName } : {};
  if (state === 'NeedsMachineAuth') return fail(2, 'needs-approval', 'open-app', named);
  if (state === 'Stopped') return fail(2, 'stopped', 'open-app', named);
  // `Online` is absent from older clients; only an explicit false counts.
  if (state !== 'Running' || self['Online'] === false) return fail(2, 'offline', 'open-app', named);

  const peers = Object.values(asRecord(status['Peer'])).map(asRecord);
  const peersOnline = peers.filter((p) => p['Online'] === true).length;
  const extra = { ...named, peersOnline };
  const target = normalizeTailnetName(peer ?? '');
  if (target) {
    const match = peers.find((p) => peerMatches(p, target));
    if (!match) return fail(3, 'no-peer', 'peer-help', extra);
    if (match['Online'] !== true) return fail(3, 'peer-offline', 'peer-help', extra);
  } else if (peersOnline === 0) {
    return fail(3, 'no-peer', 'peer-help', extra);
  }
  passUntil(4);
  return result(extra);
}

function normalizeTailnetName(v: string): string {
  return v.trim().replace(/\.$/, '').toLowerCase();
}

/** Is this `Peer` entry the device `target` names (MagicDNS name, its first label, host name, or a tailnet IP)? */
function peerMatches(p: Record<string, unknown>, target: string): boolean {
  const dns = normalizeTailnetName(typeof p['DNSName'] === 'string' ? p['DNSName'] : '');
  const host = normalizeTailnetName(typeof p['HostName'] === 'string' ? p['HostName'] : '');
  const ips = Array.isArray(p['TailscaleIPs']) ? p['TailscaleIPs'].filter((x): x is string => typeof x === 'string') : [];
  return (
    (dns !== '' && (dns === target || dns.split('.')[0] === target)) ||
    (host !== '' && host === target) ||
    ips.includes(target)
  );
}

/**
 * Run the checklist. One `tailscale status --json` and nothing else; an abort
 * (the caller's deadline) reads as "could not read the status", which never
 * blocks a connection on its own.
 */
export async function checkTailscale(opts: {
  peer?: string;
  exec?: TailscaleExec;
  signal?: AbortSignal;
}): Promise<TailscaleChecklist> {
  const exec = opts.exec ?? (execFileAsync as unknown as TailscaleExec);
  let stdout: string;
  try {
    // A CLI whose own daemon is not running (a Homebrew `tailscale` beside a
    // working app) says nothing about the app's: ask the next one.
    stdout = (await runTailscale(exec, ['status', '--json'], opts.signal, (err) => classifyStatusError(err) === 'not-running')).stdout;
  } catch (err) {
    return classifyTailscaleChecklist({ error: err }, opts.peer);
  }
  return classifyTailscaleChecklist({ stdout }, opts.peer);
}

// === tailnet nodes and whois ================================================
//
// What A2A discovery ("find wmux PCs on your tailnet") reads: this PC and the
// other nodes (`status --json`), and which node and login hold a tailnet
// address (`whois --json <ip>`). Read-only like the checklist: nothing here
// runs `up`, `login`, `serve` or `set`.

/** One node of `tailscale status --json`: `Self` or a `Peer` entry. */
export interface TailnetNode {
  /** Tailscale's stable node ID (`ID`); '' when absent. */
  stableId: string;
  hostName: string;
  /** MagicDNS name, lowercased, no trailing dot; '' when none. */
  dnsName: string;
  /** As Tailscale reports it (`windows`, `macOS`, `linux`, `iOS`, `android`…); '' when absent. */
  os: string;
  /** The owning user's numeric ID; null when absent. */
  userId: number | null;
  /** The node's tailnet IPv4s (100.64.0.0/10), in the order listed. */
  ipv4s: string[];
  /** Only an explicit `Online: true`; older clients omit the field. */
  online: boolean;
  tags: string[];
  /** In the netmap only because it may connect to a node this user shared out (`ShareeNode`). */
  sharee: boolean;
}

export interface TailnetStatus {
  backendState: string;
  /** The Tailscale client's version (`Version`); '' when absent. */
  version: string;
  self: TailnetNode;
  /** The login of `self.userId` from the `User` map; '' when absent. */
  selfLogin: string;
  peers: TailnetNode[];
}

export type TailnetStatusRead =
  /** `bin`: the CLI that answered, which a whois must use too (see `tailscaleWhois`). */
  | { ok: true; status: TailnetStatus; bin: string }
  /** The first failed checklist item, so the caller can offer the checklist's own fix. */
  | { ok: false; check: TailscaleCheckItem };

/** What `whois --json <ip>` says about the node holding `ip`. */
export interface TailnetWhois {
  /** `Node.Name`, no trailing dot. */
  nodeName: string;
  /** `Node.ComputedName`, else `Hostinfo.Hostname`. */
  deviceName: string;
  /** `Hostinfo.OS`. */
  os: string;
  /** `Node.StableID`. */
  stableId: string;
  /** `Node.User`; null when absent. */
  userId: number | null;
  tags: string[];
  /** The node's own addresses (`Node.Addresses`, `ip/32` and `ip/128` prefixes). */
  addresses: string[];
  allowedIps: string[];
  /** `Hostinfo.RoutableIPs`: the routes it advertises. */
  routableIps: string[];
  primaryRoutes: string[];
  /** `UserProfile.LoginName` and `DisplayName`. */
  loginName: string;
  displayName: string;
}

/** Why a whois answer does not identify a node A2A discovery may pair with. */
export type TailnetWhoisRefusal = 'unidentified' | 'self' | 'tagged' | 'other-user' | 'subnet-router';

const WHOIS_TIMEOUT_MS = 3_000;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** A user ID; 0 (Go's zero value: unset) and anything not a positive integer read as none. */
function userIdOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

function parseTailnetNode(raw: unknown): TailnetNode {
  const n = asRecord(raw);
  return {
    stableId: str(n['ID']),
    hostName: str(n['HostName']),
    dnsName: normalizeTailnetName(str(n['DNSName'])),
    os: str(n['OS']),
    userId: userIdOf(n['UserID']),
    ipv4s: strList(n['TailscaleIPs']).filter(isTailnetIpv4),
    online: n['Online'] === true,
    tags: strList(n['Tags']),
    sharee: n['ShareeNode'] === true,
  };
}

/**
 * This PC and the other nodes from `tailscale status --json`; null when the
 * output is not a status object with a `Self` block that names its node ID.
 * Whether the backend is usable is the caller's call (`tailscaleStatus` asks
 * the checklist).
 */
export function parseTailnetStatus(stdout: string): TailnetStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const status = asRecord(parsed);
  const selfRaw = status['Self'];
  if (!selfRaw || typeof selfRaw !== 'object' || Array.isArray(selfRaw)) return null;
  const self = parseTailnetNode(selfRaw);
  if (!self.stableId) return null;
  const users = asRecord(status['User']);
  const selfUser = self.userId === null ? {} : asRecord(users[String(self.userId)]);
  return {
    backendState: str(status['BackendState']),
    version: str(status['Version']),
    self,
    selfLogin: str(selfUser['LoginName']),
    peers: Object.values(asRecord(status['Peer'])).map(parseTailnetNode),
  };
}

/**
 * The node holding `ip`, from `tailscale whois --json <ip>`. Null when the
 * output is not JSON (an older CLI without `--json` prints text), names no
 * stable node ID, or lists `ip/32` in neither its own addresses nor its
 * allowed IPs (Tailscale always lists it in both): an answer about another
 * address is no answer about this one.
 */
export function parseWhois(stdout: string, ip: string): TailnetWhois | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  const node = asRecord(root['Node']);
  const hostinfo = asRecord(node['Hostinfo']);
  const profile = asRecord(root['UserProfile']);
  const addresses = strList(node['Addresses']);
  const allowedIps = strList(node['AllowedIPs']);
  const stableId = str(node['StableID']);
  if (!stableId || !addresses.includes(`${ip}/32`) || !allowedIps.includes(`${ip}/32`)) return null;
  return {
    nodeName: normalizeTailnetName(str(node['Name'])),
    deviceName: str(node['ComputedName']) || str(hostinfo['Hostname']),
    os: str(hostinfo['OS']),
    stableId,
    userId: userIdOf(node['User']),
    tags: strList(node['Tags']),
    addresses,
    allowedIps,
    routableIps: strList(hostinfo['RoutableIPs']),
    primaryRoutes: strList(node['PrimaryRoutes']),
    loginName: str(profile['LoginName']),
    displayName: str(profile['DisplayName']),
  };
}

/**
 * Whether the node a whois identified may pair with this PC: another node
 * (not this one), owned by this PC's own user (numeric IDs, not login
 * strings), with no tags, and routing nothing but its own addresses. A
 * subnet router or exit node is refused: a device behind it would whois as
 * the router. `AllowedIPs`, `Hostinfo.RoutableIPs` and `PrimaryRoutes` are
 * all read: `PrimaryRoutes` alone misses a standby router. Without this PC's
 * own node ID nothing can be told apart from it, so nothing passes.
 */
export function judgeWhois(
  whois: TailnetWhois,
  self: { stableId: string; userId: number | null },
): { ok: true } | { ok: false; reason: TailnetWhoisRefusal } {
  if (!self.stableId) return { ok: false, reason: 'unidentified' };
  if (whois.stableId === self.stableId) return { ok: false, reason: 'self' };
  if (whois.tags.length > 0) return { ok: false, reason: 'tagged' };
  if (self.userId === null || whois.userId !== self.userId) return { ok: false, reason: 'other-user' };
  // The node's own addresses: its single-host /32 (IPv4) and /128 (IPv6) prefixes only.
  const own = new Set(whois.addresses.filter((a) => (a.includes(':') ? a.endsWith('/128') : a.endsWith('/32'))).map((a) => a.toLowerCase()));
  const routesOther = (prefixes: string[]): boolean => prefixes.some((p) => !own.has(p.toLowerCase()));
  if (routesOther(whois.allowedIps) || routesOther(whois.routableIps) || routesOther(whois.primaryRoutes)) {
    return { ok: false, reason: 'subnet-router' };
  }
  return { ok: true };
}

/**
 * Read `tailscale status --json`. Not ok when the checklist fails before its
 * peer check (not installed, not running, signed out, stopped, offline) or
 * the status has no `Self` block; the failed item carries the checklist's fix.
 */
export async function tailscaleStatus(
  opts: { exec?: TailscaleExec; signal?: AbortSignal; /** Test seam; default `tailscaleCandidates()`. */ candidates?: string[] } = {},
): Promise<TailnetStatusRead> {
  const exec = opts.exec ?? (execFileAsync as unknown as TailscaleExec);
  let stdout: string;
  let bin: string;
  try {
    ({ stdout, bin } = await runTailscale(exec, ['status', '--json'], opts.signal, isNotRunning, opts.candidates));
  } catch (err) {
    return { ok: false, check: firstFailedCheck(classifyTailscaleChecklist({ error: err })) };
  }
  const failed = classifyTailscaleChecklist({ stdout }).items.find((i) => i.state === 'fail' && i.id !== 'peer');
  if (failed) return { ok: false, check: failed };
  const status = parseTailnetStatus(stdout);
  if (!status) return { ok: false, check: UNREADABLE_CHECK };
  return { ok: true, status, bin };
}

/** A CLI whose own daemon is not running (a Homebrew `tailscale` beside a working app) says nothing about the app's. */
function isNotRunning(err: unknown): boolean {
  return classifyStatusError(err) === 'not-running';
}

const UNREADABLE_CHECK: TailscaleCheckItem = { id: 'signed-in', state: 'fail', reason: 'unreadable', fix: 'open-app' };

function firstFailedCheck(list: TailscaleChecklist): TailscaleCheckItem {
  return list.items.find((i) => i.state === 'fail') ?? UNREADABLE_CHECK;
}

/**
 * Ask `tailscale whois --json <ip>` which node holds `ip`. `ip` must be a
 * canonical IPv4 in 100.64.0.0/10, checked before anything runs. Null on any
 * failure: a refused argument, a non-zero exit (an older CLI that does not
 * know `--json`), output that is not JSON, an answer about another address,
 * or no answer within 3 s.
 *
 * `bin` pins the CLI that answered `tailscaleStatus`, so both reads ask the
 * same daemon; without it the candidates are tried as `status` tries them.
 */
export async function tailscaleWhois(
  ip: string,
  opts: { exec?: TailscaleExec; signal?: AbortSignal; timeoutMs?: number; bin?: string; /** Test seam. */ candidates?: string[] } = {},
): Promise<TailnetWhois | null> {
  if (!isCanonicalIpv4(ip) || !isTailnetIpv4(ip)) return null;
  const exec = opts.exec ?? (execFileAsync as unknown as TailscaleExec);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? WHOIS_TIMEOUT_MS);
  const onAbort = (): void => abort.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) abort.abort();
  try {
    const candidates = opts.bin ? [opts.bin] : opts.candidates;
    const { stdout } = await runTailscale(exec, ['whois', '--json', ip], abort.signal, isNotRunning, candidates);
    return parseWhois(stdout, ip);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Development seam (unpackaged builds only — the caller gates it): an exec
 * that answers `tailscale status --json` from a fixture file instead of the
 * real CLI, so a failed checklist can be shown on a machine whose Tailscale
 * is fine without touching it. A missing file reads as "not installed", a
 * file starting with `stderr:` as a failed status with that text. Every other
 * command is refused, so a dev build pointed at a fixture can never write a
 * serve configuration.
 */
export function fixtureTailscaleExec(file: string, readFile: (p: string) => Promise<string>): TailscaleExec {
  return async (_cmd, args) => {
    if (args.length !== 2 || args[0] !== 'status' || args[1] !== '--json') {
      throw Object.assign(new Error('tailscale fixture: read-only, only `status --json` is answered'), { stderr: 'fixture: refused' });
    }
    let text: string;
    try {
      text = await readFile(file);
    } catch {
      throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
    }
    if (text.startsWith('stderr:')) throw Object.assign(new Error('Command failed'), { stderr: text.slice(7).trim() });
    return { stdout: text, stderr: '' };
  };
}

/**
 * Development seam like `fixtureTailscaleExec`, for A2A discovery: answers
 * `status --json` from `<dir>/status.json` (same rules) and
 * `whois --json <ip>` from `<dir>/whois/<ip>.json`, where a missing file is a
 * failed whois and `stderr:` works as above. The IP must be a canonical
 * tailnet IPv4 before any path is built. Every other command is refused.
 */
export function fixtureTailscaleDirExec(dir: string, readFile: (p: string) => Promise<string>): TailscaleExec {
  const status = fixtureTailscaleExec(path.join(dir, 'status.json'), readFile);
  return async (cmd, args, opts) => {
    if (args.length === 2 && args[0] === 'status' && args[1] === '--json') return status(cmd, args, opts);
    if (args.length === 3 && args[0] === 'whois' && args[1] === '--json' && isCanonicalIpv4(args[2]) && isTailnetIpv4(args[2])) {
      let text: string;
      try {
        text = await readFile(path.join(dir, 'whois', `${args[2]}.json`));
      } catch {
        throw Object.assign(new Error('Command failed'), { stderr: `fixture: no whois for ${args[2]}` });
      }
      if (text.startsWith('stderr:')) throw Object.assign(new Error('Command failed'), { stderr: text.slice(7).trim() });
      return { stdout: text, stderr: '' };
    }
    throw Object.assign(new Error('tailscale fixture: read-only, only `status --json` and `whois --json <ip>` are answered'), {
      stderr: 'fixture: refused',
    });
  };
}

async function runTailscale(
  exec: TailscaleExec,
  args: string[],
  signal?: AbortSignal,
  /** A real failure that is still worth asking the next candidate about. */
  tryNextOn?: (err: unknown) => boolean,
  candidates: string[] = tailscaleCandidates(),
): Promise<{ stdout: string; stderr: string; bin: string }> {
  let lastErr: unknown = new Error('tailscale not found');
  /** The first real failure, which is what to report when no later candidate does better. */
  let firstReal: unknown = null;
  for (const bin of candidates) {
    try {
      const out = await exec(bin, args, {
        timeout: TAILSCALE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: TAILSCALE_MAX_BUFFER,
        env: getExecEnv(),
        ...(signal ? { signal } : {}),
      });
      return { ...out, bin };
    } catch (err) {
      // Only a missing binary is worth trying the next candidate for; a real
      // failure (bad flags, not logged in) must surface as itself, unless the
      // caller says this one is worth another candidate.
      if (!isEnoent(err)) {
        if (!tryNextOn?.(err) || signal?.aborted) throw err;
        firstReal ??= err;
      }
      lastErr = err;
    }
  }
  throw firstReal ?? lastErr;
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * What the process actually said: stderr, else stdout, else the error's own
 * message.
 *
 * stdout is in there because tailscale puts its most useful failure on it, not
 * on stderr — "Serve is not enabled on your tailnet." followed by a one-click
 * URL to enable it. Reading only stderr left that on the floor and reduced the
 * operator's output to "Command failed: <the command we just ran>", which is
 * exactly what dogfooding hit.
 */
export function errText(err: unknown): string {
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  if (stderr) return stderr;
  const stdout = typeof e?.stdout === 'string' ? e.stdout.trim() : '';
  if (stdout) return stdout;
  return typeof e?.message === 'string' ? e.message : String(err);
}

/** Why `tailscale status` failed, when it failed to run at all. */
export function classifyStatusError(err: unknown): TailscaleProblem {
  if (isEnoent(err)) return 'not-installed';
  const text = errText(err);
  if (/logged out|needs ?login|not logged in|please run:? tailscale up/i.test(text)) return 'not-logged-in';
  if (/is stopped|tailscale is stopped/i.test(text)) return 'stopped';
  // The CLI is there but its daemon does not answer: the app was quit, or the
  // service is not started. Matched loosely, since the wording differs by
  // platform and version; what they share is "could not reach tailscaled".
  if (/failed to connect to (the )?local tailscale|is tailscale(d)? running|tailscaled.*(not running|connection refused)|connect: connection refused|no such file or directory.*tailscaled|cannot connect to .*tailscale/i.test(text)) {
    return 'not-running';
  }
  return 'status-unreadable';
}

/** Why `tailscale serve` refused. Cert wording is checked first — it is the
 * more specific message, and an unprivileged run can mention both. */
export function classifyServeError(text: string): TailscaleProblem {
  if (/https|certificate|cert\b/i.test(text) && /not enabled|disabled|unavailable|enable/i.test(text)) {
    return 'no-https-certs';
  }
  if (/access is denied|permission denied|must be run as|administrator|--operator|sudo|not permitted/i.test(text)) {
    return 'needs-elevation';
  }
  return 'serve-failed';
}

// === transport orchestration ================================================
//
// Everything above is a primitive. What follows is the ORDER those primitives
// have to run in, which is the part that actually breaks.
//
// It used to live inline in `handleWeb`, which was fine while the CLI was the
// only caller. The GUI needs the identical sequence, and the steps that would
// get dropped in a second copy are the two rollbacks — the ones that only run
// on a failure path nobody exercises by hand. So the sequence lives here once,
// and callers hand it a `startServer` / `stopServer` callback rather than a
// checklist to remember.
//
//   START                                    STOP
//   ┌──────────────────────────────┐         ┌──────────────────────────────┐
//   │ 1. decideTailscaleBinding    │         │ 1. readPort()  ← BEFORE stop │
//   │ 2. ensureTailscaleServe      │         │    (afterwards the server is │
//   │ 3. allowedHosts += magicDns  │         │     gone and there is no way │
//   │ 4. startServer()             │         │     to tell our serve from   │
//   │    ├ ok   → done             │         │     the operator's own)      │
//   │    └ FAIL → removeTailscale- │         │ 2. stopServer()              │
//   │             Serve  (else a   │         │ 3. removeTailscaleServe      │
//   │             proxy fronts     │         │    ONLY when the stop worked │
//   │             nothing: 502)    │         └──────────────────────────────┘
//   └──────────────────────────────┘

/**
 * Is the HTTPS front we registered still in place?
 *
 * `ours` — the serve config points at our loopback web port.
 * `gone` — nothing is serving, or something else took the slot. Either way the
 *          `https://<magicdns>` address we advertise no longer reaches us.
 * `unknown` — tailscale could not be asked. Distinct from `gone` on purpose:
 *          "I cannot tell" must not be rendered as "it is broken", or a laptop
 *          with a briefly-busy tailscaled would tell the operator their setup
 *          fell apart.
 *
 * Read-only. It never registers, removes, or repairs anything — the caller
 * decides what to do about the answer.
 */
export async function checkWebFront(opts: {
  webPort: number;
  servePort?: number;
  exec?: TailscaleExec;
}): Promise<'ours' | 'gone' | 'unknown'> {
  const exec = opts.exec ?? (execFileAsync as unknown as TailscaleExec);
  const servePort = opts.servePort ?? DEFAULT_SERVE_PORT;
  let stdout: string;
  try {
    stdout = (await runTailscale(exec, ['serve', 'status', '--json'])).stdout;
  } catch {
    return 'unknown';
  }
  const ownership = classifyServeConfig(stdout, { servePort, webPort: opts.webPort });
  if (ownership === 'ours') return 'ours';
  if (ownership === 'unreadable') return 'unknown';
  return 'gone';
}

/** What a transport start did, including the caller's own server result. */
export type WebTransportStart<T> =
  | {
      ok: true;
      /** The bind the server was started on. */
      host: string;
      /** `allowedHosts` as passed to the server, MagicDNS appended when fronted. */
      allowedHosts: string[];
      /** Present only when a tailnet front was registered. */
      tailnet?: TailnetServe;
      /** Non-fatal notes the caller should surface (wildcard-bind warning). */
      warnings: string[];
      /** Whatever `startServer` returned. */
      value: T;
      /** True when the server start failed and the serve registration was rolled back. */
      rolledBack: boolean;
    }
  | { ok: false; kind: 'binding'; error: string }
  | { ok: false; kind: 'serve'; problem: TailscaleProblem; detail?: string };

/**
 * Start `wmux web`, optionally behind a `tailscale serve` HTTPS front.
 *
 * `startServer` reports `failed` rather than throwing so that a transport
 * rollback is driven by the same value the caller inspects — a callback that
 * threw would skip the rollback and strand a serve pointing at nothing.
 */
export async function startWebTransport<T>(opts: {
  port: number;
  /** Register (and roll back) a tailnet front. False reproduces the plain path exactly. */
  tailscale: boolean;
  explicitHost?: string;
  expose: boolean;
  /** Operator-supplied Host allowlist. Not mutated — a copy is returned. */
  allowedHosts?: string[];
  servePort?: number;
  exec?: TailscaleExec;
  startServer: (args: { host: string; allowedHosts: string[] }) => Promise<{ failed: boolean; value: T }>;
}): Promise<WebTransportStart<T>> {
  const allowedHosts = [...(opts.allowedHosts ?? [])];

  // No tailnet front: this must stay byte-for-byte the old behaviour, so it
  // touches nothing tailscale-related and cannot roll anything back.
  if (!opts.tailscale) {
    const host = opts.explicitHost ?? (opts.expose ? '0.0.0.0' : '127.0.0.1');
    const started = await opts.startServer({ host, allowedHosts });
    return { ok: true, host, allowedHosts, warnings: [], value: started.value, rolledBack: false };
  }

  const binding = decideTailscaleBinding({ explicitHost: opts.explicitHost, expose: opts.expose });
  if (!binding.ok) return { ok: false, kind: 'binding', error: binding.error };

  const serve = await ensureTailscaleServe({
    webPort: opts.port,
    ...(opts.servePort !== undefined ? { servePort: opts.servePort } : {}),
    ...(opts.exec ? { exec: opts.exec } : {}),
  });
  if (!serve.ok) {
    return { ok: false, kind: 'serve', problem: serve.problem, ...(serve.detail ? { detail: serve.detail } : {}) };
  }

  // The allowlist has to carry the MagicDNS name from the first boot, or the
  // very first request through the front is refused by the rebinding guard.
  if (!allowedHosts.some((h) => h.toLowerCase() === serve.magicDns)) allowedHosts.push(serve.magicDns);

  const started = await opts.startServer({ host: binding.host, allowedHosts });
  if (started.failed) {
    // Roll back only a front this call created. A front that already pointed
    // at this port is not ours to remove: when another wmux owns the port, its
    // server is why this start failed, and removing the front would cut off
    // every phone paired with it.
    if (serve.preexisting) {
      return {
        ok: true,
        host: binding.host,
        allowedHosts,
        warnings: binding.warnings,
        value: started.value,
        rolledBack: false,
      };
    }
    await removeTailscaleServe({
      webPort: opts.port,
      servePort: serve.servePort,
      ...(opts.exec ? { exec: opts.exec } : {}),
    });
    return {
      ok: true,
      host: binding.host,
      allowedHosts,
      warnings: binding.warnings,
      value: started.value,
      rolledBack: true,
    };
  }

  return {
    ok: true,
    host: binding.host,
    allowedHosts,
    tailnet: { magicDns: serve.magicDns, servePort: serve.servePort, url: serve.url },
    warnings: binding.warnings,
    value: started.value,
    rolledBack: false,
  };
}

/**
 * Stop `wmux web` and tear down the front it was running behind.
 *
 * Safe to call when no tailnet front was ever registered: `removeTailscaleServe`
 * classifies first and reports `nothing` / `not-ours` / `unavailable` without
 * touching anything it did not create.
 */
export async function stopWebTransport<T>(opts: {
  servePort?: number;
  exec?: TailscaleExec;
  /** Read the running server's port. Called BEFORE the stop, deliberately. */
  readPort: () => Promise<number | undefined>;
  stopServer: () => Promise<{
    failed: boolean;
    /**
     * A failed control reply can still follow a completed live stop (for
     * example, durable-state revocation failed afterward). Set only after a
     * fresh status check confirms the listener is down.
     */
    liveStopped?: boolean;
    value: T;
  }>;
}): Promise<{ value: T; serveRemoved: boolean; reason: ServeRemoval | 'skipped' }> {
  const priorPort = await opts.readPort();
  const stopped = await opts.stopServer();

  // Most failed stops leave a server running that still needs its front door.
  // Durable-state revocation is the exception: the listener is intentionally
  // stopped before that error is returned, and leaving its front creates a 502.
  if ((stopped.failed && !stopped.liveStopped) || priorPort === undefined) {
    return { value: stopped.value, serveRemoved: false, reason: 'skipped' };
  }

  const removal = await removeTailscaleServe({
    webPort: priorPort,
    ...(opts.servePort !== undefined ? { servePort: opts.servePort } : {}),
    ...(opts.exec ? { exec: opts.exec } : {}),
  });
  return { value: stopped.value, serveRemoved: removal.removed, reason: removal.reason };
}
