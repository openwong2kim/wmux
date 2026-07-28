import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
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
  opts: { timeout: number; windowsHide: boolean; maxBuffer: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export type TailscaleProblem =
  | 'not-installed'
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

export type TailscaleSetup = ({ ok: true } & TailnetServe) | { ok: false; problem: TailscaleProblem; detail?: string };

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
export function describeTailscaleProblem(problem: TailscaleProblem, detail?: string): string[] {
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
        '  Refusing to overwrite it — a serve config is one shared slot per port.',
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
  push('', '  wmux web was NOT started and no serve configuration was left behind.');
  return lines;
}

// === orchestration ==========================================================

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

  let statusOut: string;
  try {
    statusOut = (await runTailscale(exec, ['status', '--json'])).stdout;
  } catch (err) {
    return { ok: false, problem: classifyStatusError(err), detail: errText(err) };
  }
  const identity = parseTailnetIdentity(statusOut);
  if (!identity.ok) return { ok: false, problem: identity.problem };

  let ownership: ServeOwnership;
  try {
    ownership = classifyServeConfig((await runTailscale(exec, ['serve', 'status', '--json'])).stdout, {
      servePort,
      webPort: opts.webPort,
    });
  } catch (err) {
    return { ok: false, problem: 'serve-status-unreadable', detail: errText(err) };
  }
  if (ownership === 'foreign') return { ok: false, problem: 'port-taken' };
  if (ownership === 'unreadable') return { ok: false, problem: 'serve-status-unreadable' };

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
    magicDns: identity.magicDns,
    servePort,
    url: servePort === 443 ? `https://${identity.magicDns}` : `https://${identity.magicDns}:${servePort}`,
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
export function tailscaleCandidates(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    return ['tailscale.exe', path.join(programFiles, 'Tailscale', 'tailscale.exe')];
  }
  if (process.platform === 'darwin') {
    return ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  }
  return ['tailscale'];
}

async function runTailscale(exec: TailscaleExec, args: string[]): Promise<{ stdout: string; stderr: string }> {
  let lastErr: unknown = new Error('tailscale not found');
  for (const bin of tailscaleCandidates()) {
    try {
      return await exec(bin, args, {
        timeout: TAILSCALE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: TAILSCALE_MAX_BUFFER,
        env: getExecEnv(),
      });
    } catch (err) {
      // Only a missing binary is worth trying the next candidate for; a real
      // failure (bad flags, not logged in) must surface as itself.
      if (!isEnoent(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
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
