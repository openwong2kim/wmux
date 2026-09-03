import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { dataSuffix, getMcpBrokerPipeName, getPluginTrustPath } from '../../shared/constants';
import {
  MAX_PLUGIN_NAME_LEN,
  NON_IDENTIFYING_CLIENT_NAMES,
  sanitizeClientDisplayName,
} from '../../shared/rpc';
import { MCP_TARGETS, type McpTarget } from '../../shared/mcpTargets';
import {
  readAllTargetStatuses,
  registerTarget,
  unregisterTarget,
  type TargetRegStatus,
} from '../../shared/mcpRegistration';
import type { WmuxMcpEntryProfile } from '../../shared/configIO';

/**
 * `wmux mcp …` — inspect / manage MCP registration across the installed agent
 * CLIs (Claude `~/.claude.json`, Codex `~/.codex/config.toml`, Gemini
 * `~/.gemini/settings.json`) without touching the running wmux daemon. Reading
 * and editing the configs directly means the user can verify the integration
 * even when the GUI app is not running (DX-D4: CLI as a one-line verification
 * path; Settings panel as the GUI parity).
 *
 * Shares the per-target orchestration with the main-process McpRegistrar via
 * `shared/mcpRegistration`, so behavior is identical. Non-installed agents are
 * skipped (their config is never created); foreign entries are left untouched;
 * TOML writes are surgical (comments / ordering preserved).
 */

const HELP_TEXT = `
wmux mcp — inspect / manage MCP registration across agent CLIs

USAGE
  wmux mcp <subcommand> [--target <id>] [--json]

SUBCOMMANDS
  check        Show whether the wmux MCP server is registered in each agent config.
  clients      List the MCP clients wmux has seen, by the clientName each one
               reported. Use this when a client is stuck at "unconfirmed" and you
               need the exact name to add to mcp.firstPartyClients in
               ~/.wmux/config.json. Reads ~/.wmux/plugin-trust.json; the app does
               not need to be running.
  register     Add the wmux entry to each installed agent's config.
               Note: written paths point at this CLI's own bundle layout — for a
               GUI re-register that uses the running app's resolved paths, use
               Settings → General → MCP → Re-register.
  unregister   Remove the wmux key from each agent config.
               Other entries are left untouched.

OPTIONS
  --target <id>  Limit to one agent: claude | codex | gemini (default: all).
  --profile <p>  register only. Tool surface the registered server launches
                 with: full | core (default: full).
                   full  every tool, including the browser family.
                   core  drops browser_* — about 27 KB less tools/list schema
                         for agents that never touch the browser.
                 Without this flag an existing entry KEEPS the profile it
                 already has, so re-registering never undoes your choice.
                 Pass --profile full to move a core entry back.
  --json         Output raw JSON (useful for scripting).
`.trimStart();

function homeDir(): string {
  return os.homedir();
}

// Returns the selected targets, or null when `--target` was given with an
// unknown/missing id (so the caller can error out instead of silently acting on
// ALL targets — a `--target codxe` typo must NOT unregister everything).
function selectedTargets(args: string[]): McpTarget[] | null {
  const i = args.indexOf('--target');
  if (i === -1) return [...MCP_TARGETS];
  const id = args[i + 1];
  const t = MCP_TARGETS.find((x) => x.id === id);
  return t ? [t] : null;
}

// The explicit `--profile` choice for `register`. `undefined` when the flag is
// absent — that is "no opinion", and registerTarget then PRESERVES whatever
// profile the config already carries. Returns null for an unrecognized value so
// the caller can error out rather than silently registering the default: a
// `--profile cores` typo must not quietly write `full` over someone's `core`.
export function selectedProfile(args: string[]): WmuxMcpEntryProfile | null | undefined {
  const value = profileArgValue(args);
  if (value === undefined) return undefined;
  return value === 'full' || value === 'core' ? value : null;
}

/** The raw `--profile` value exactly as typed, or undefined when the flag is
 *  absent. Accepts BOTH `--profile core` and `--profile=core`: the attached form
 *  is what most people reach for, and parsing only the separated one meant
 *  `--profile=core` silently fell through as "no flag" and printed a success
 *  message for a registration that ignored the request. Exported so the error
 *  path can echo the value back. */
export function profileArgValue(args: string[]): string | undefined {
  const inline = args.find((a) => a.startsWith('--profile='));
  if (inline !== undefined) return inline.slice('--profile='.length);
  const i = args.indexOf('--profile');
  if (i === -1) return undefined;
  // Present but with nothing after it (`wmux mcp register --profile`) is an
  // ERROR, not an absent flag: `?? ''` keeps it distinguishable from undefined
  // so it takes the same "unknown value" exit as a typo, rather than silently
  // registering the default.
  return args[i + 1] ?? '';
}

/**
 * #1151 — the single place this CLI decides it is speaking for an ISOLATED
 * instance. Reads the shared `dataSuffix()` helper rather than the env var, so
 * it agrees with every other suffix-aware path (socket, auth token, data dir).
 *
 * Every agent config this command touches lives at a suffix-BLIND path
 * (`~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`), so
 * there is no isolated variant to read or write: an isolated instance is always
 * looking at, or editing, the PRODUCTION entries. `McpRegistrar` (an implicit
 * boot/Settings action) therefore skips outright; this CLI is an explicit user
 * action, so it says what it is doing and proceeds. `check` gets the same
 * sentence as a heading so nobody reads the production rows as this instance's
 * own registration.
 *
 * Returns null when this is the user's daily (unsuffixed) instance.
 */
export function isolatedInstanceNotice(action: 'check' | 'register' | 'unregister'): string | null {
  const suffix = dataSuffix();
  if (suffix === '') return null;
  const head = `WMUX_DATA_SUFFIX=${suffix} is set — this is an isolated instance`;
  switch (action) {
    case 'check':
      return `note: ${head}. It never registers itself in the agent configs, so the ` +
        'entries below belong to your production wmux, not to this instance. Agents reach ' +
        `this instance by running with WMUX_DATA_SUFFIX=${suffix}.`;
    case 'register':
      return `warning: ${head} — this writes the production agent configs ` +
        '(~/.claude.json et al.), and the script path it registers may live inside a ' +
        'disposable checkout';
    case 'unregister':
      return `warning: ${head} — this removes the production agent config entries ` +
        '(~/.claude.json et al.)';
  }
}

function formatModified(d: Date | null): string {
  if (!d) return 'does not exist';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `modified ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function printCheck(statuses: TargetRegStatus[], jsonMode: boolean): void {
  // #1151 — an isolated instance reads the PRODUCTION configs here (there is no
  // suffixed variant of ~/.claude.json), so say so before the rows rather than
  // letting them be read as this instance's own registration.
  const notice = isolatedInstanceNotice('check');
  if (jsonMode) {
    // Additive field: existing `--json` consumers keep reading `targets`.
    const isolated = notice === null ? null : { suffix: dataSuffix(), note: notice };
    console.log(JSON.stringify({ isolated, targets: statuses }, null, 2));
    return;
  }
  if (notice) console.log(`${notice}\n`);
  for (const s of statuses) {
    const tag = s.verified ? '' : ' (experimental)';
    console.log(`${s.displayName}${tag}:`);
    if (!s.configExists) {
      console.log(`  not detected — ${s.configPath}`);
      continue;
    }
    // Show the profile alongside the path: the surface an entry launches with
    // is invisible otherwise, and "registered" alone cannot answer "did my
    // --profile core actually take?".
    const fmt = (srv: { registered: boolean; path: string | null; profile: string | null }) =>
      srv.registered ? `registered (${srv.profile}) → ${srv.path}` : 'NOT REGISTERED';
    console.log(`  wmux:   ${fmt(s.wmux)}`);
    console.log(`  config: ${s.configPath} (${formatModified(s.configModified)})`);
  }
}

// `wmux mcp clients` (issue #636) — answer "what name did wmux actually see?".
//
// A client whose reported clientName is not recognised sits at `unconfirmed`
// under enforce mode, and the rejection alone never told the operator which
// name to allowlist. Finding it used to mean reading plugin-trust.json by hand,
// which is how a real agent ended up guessing its own name wrong. Reading the
// file directly (rather than an RPC) keeps this usable when the app is closed —
// which is exactly when someone is editing config.json.
interface ObservedClient {
  name: string;
  version?: string;
  status: string;
  firstSeen?: number;
  lastSeen?: number;
  /** True when this name can never be added to mcp.firstPartyClients. */
  nonIdentifying: boolean;
}

/**
 * Discriminated so `--json` can tell "nothing has connected yet" apart from "I
 * could not read my own source". Collapsing both to an empty list (and exit 0)
 * would let a script treat an unreadable or corrupt trust DB as an
 * authoritative "no clients" — the one answer that is never safe here, since
 * this command exists to be believed about who has connected.
 */
export type ObservedClientsResult =
  | { ok: true; clients: ObservedClient[] }
  | { ok: false; reason: 'absent' | 'unreadable' };

export function readObservedClients(trustPath: string): ObservedClientsResult {
  let raw: string;
  try {
    raw = fs.readFileSync(trustPath, 'utf-8');
  } catch (err) {
    // A missing file is a legitimate empty state (no client has ever
    // connected). Any other read error — permissions, I/O — is a failure.
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, reason: code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
      }
      return value;
    });
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'unreadable' };
  const plugins = (parsed as Record<string, unknown>).plugins;
  if (!plugins || typeof plugins !== 'object') return { ok: true, clients: [] };
  const out: ObservedClient[] = [];
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const rec = value as Record<string, unknown>;
    const rawName = typeof rec.name === 'string' && rec.name.length > 0 ? rec.name : key;
    // Name and version are self-asserted by the client and stored verbatim —
    // the trust store bounds their length but does not strip control
    // characters. They are printed to a terminal below, so they go through the
    // same sanitizer the RPC rejection path uses; otherwise running this
    // diagnostic would let a previously-connected client repaint the terminal
    // or forge output around its own row.
    const name = sanitizeClientDisplayName(rawName, MAX_PLUGIN_NAME_LEN);
    out.push({
      name,
      version:
        typeof rec.version === 'string'
          ? sanitizeClientDisplayName(rec.version, 64)
          : undefined,
      status:
        typeof rec.status === 'string'
          ? sanitizeClientDisplayName(rec.status, 32)
          : 'unknown',
      firstSeen: typeof rec.firstSeen === 'number' ? rec.firstSeen : undefined,
      lastSeen: typeof rec.lastSeen === 'number' ? rec.lastSeen : undefined,
      nonIdentifying: NON_IDENTIFYING_CLIENT_NAMES.has(name.toLowerCase()),
    });
  }
  // Most recently seen first — the client the operator is debugging right now
  // is almost always the last one that connected.
  out.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  return { ok: true, clients: out };
}

function formatSeen(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return 'never';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Exit code: 0 when the listing is authoritative, 1 when it could not be read. */
function printClients(
  result: ObservedClientsResult,
  trustPath: string,
  jsonMode: boolean,
): number {
  if (!result.ok) {
    if (jsonMode) {
      console.log(
        JSON.stringify({ trustPath, error: result.reason, clients: null }, null, 2),
      );
    } else if (result.reason === 'absent') {
      console.log(`No clients recorded yet — ${trustPath} does not exist.`);
      console.log('Connect an MCP client to wmux once, then run this again.');
    } else {
      console.error(`Could not read ${trustPath} (unreadable or corrupt).`);
    }
    // `absent` is a normal empty state, not a failure. Only a real read/parse
    // failure gets a non-zero status, so `--json` consumers can trust a 0.
    return result.reason === 'absent' ? 0 : 1;
  }
  const clients = result.clients;
  if (jsonMode) {
    console.log(JSON.stringify({ trustPath, clients }, null, 2));
    return 0;
  }
  if (clients.length === 0) {
    console.log(`No clients recorded yet — ${trustPath}`);
    return 0;
  }
  for (const c of clients) {
    const version = c.version ? ` v${c.version}` : '';
    console.log(`${c.name}${version}`);
    console.log(`  status:    ${c.status}`);
    console.log(`  last seen: ${formatSeen(c.lastSeen)}`);
    if (c.nonIdentifying) {
      console.log(
        '  NOT CONFIGURABLE: this is a generic default (an MCP SDK fallback or a',
      );
      console.log(
        '  wmux-internal name), not an identity. Adding it to mcp.firstPartyClients',
      );
      console.log(
        '  would recognise every client reporting it, so wmux refuses it. Fix the',
      );
      console.log(
        "  client to send its own clientInfo.name instead.",
      );
    }
  }
  console.log(`\nSource: ${trustPath}`);
  console.log(
    'To recognise a client, add its exact name to mcp.firstPartyClients in',
  );
  console.log('~/.wmux/config.json, then restart wmux.');
  return 0;
}

// Full single-child MCP bundle candidates (the pre-broker layout). Used when the
// broker is unreachable, so an agent still gets a self-contained MCP server.
const FULL_BUNDLE_CANDIDATES = [
  path.join('mcp-bundle', 'index.js'),
  path.join('dist', 'mcp-bundle', 'index.js'),
  // Unbundled dev layout: entry.js is the stdio boot (index.js became a
  // side-effect-free factory after the broker split).
  path.join('dist', 'mcp', 'mcp', 'entry.js'),
  path.join('dist', 'mcp', 'mcp', 'index.js'),
];

// Thin shim candidates (the broker topology). Preferred only when a broker is
// actually listening — the shim is worthless (agent gets no tools) without one.
const SHIM_CANDIDATES = [
  path.join('mcp-bundle', 'shim.js'),
  path.join('dist', 'mcp-bundle', 'shim.js'),
  path.join('dist', 'mcp', 'mcp', 'shim.js'),
];

/**
 * Walk up to 6 dirs from this file, returning the first candidate that exists.
 * Mirrors McpRegistrar's packaged/dev layout resolution.
 */
function findScriptUp(candidates: string[]): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    for (const rel of candidates) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Single-shot probe: is a broker listening on the MCP broker pipe? Resolves
 * true on connect, false on timeout/error. Never rejects. A Windows named-pipe
 * connect can hang if the server process exists but hasn't called `listen()`
 * yet, so the socket carries an explicit timeout and is always destroyed.
 */
export function canConnectBrokerPipe(timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(getMcpBrokerPipeName());
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    // on(), not once(): a stray second 'error' after destroy() would be an
    // unhandled exception that crashes `wmux mcp register`. finish() is
    // idempotent, so absorbing every 'error' is safe.
    socket.on('error', () => finish(false));
  });
}

/**
 * Find the bundled wmux MCP script when this CLI is invoked from a packaged
 * install. The CLI bundle lives in `dist/cli-bundle/index.js` next to
 * `dist/mcp-bundle/index.js` (or the legacy `dist/mcp/mcp/index.js` layout).
 * Returns null when no candidate exists.
 *
 * Broker-aware (plans/mcp-broker-enable-plan-2026-07-24.md W4 / RISK 4): if a
 * broker is actually listening, prefer the thin shim so `wmux mcp register`
 * doesn't silently overwrite the shim path with the ~32 MB full bundle and
 * destroy the broker topology. The decision is made by a live PIPE PROBE, not
 * the env flag: the CLI shell env is not the app env, so env-gating would write
 * the shim path when no broker is running (every agent exits after its retry
 * window) or the bundle when one is. `WMUX_MCP_BROKER=0` is honored only as an
 * explicit escape hatch that skips the probe entirely. Falls back to the full
 * bundle whenever the broker is unreachable or the shim file is missing
 * (fail-open, mirroring McpRegistrar).
 */
export async function resolveWmuxScript(): Promise<string | null> {
  if (process.env.WMUX_MCP_BROKER !== '0' && (await canConnectBrokerPipe(300))) {
    const shim = findScriptUp(SHIM_CANDIDATES);
    if (shim) return shim;
  }
  return findScriptUp(FULL_BUNDLE_CANDIDATES);
}

export async function handleMcp(args: string[], jsonMode: boolean): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(HELP_TEXT);
    process.exit(sub ? 0 : 1);
    return;
  }

  const home = homeDir();
  const targets = selectedTargets(args);
  if (targets === null) {
    const ti = args.indexOf('--target');
    console.error(`Unknown --target "${args[ti + 1] ?? ''}". Valid: ${MCP_TARGETS.map((t) => t.id).join(', ')}.`);
    process.exit(1);
    return;
  }

  switch (sub) {
    case 'check': {
      const all = readAllTargetStatuses(home);
      const ids = new Set<string>(targets.map((t) => t.id));
      printCheck(all.filter((s) => ids.has(s.id)), jsonMode);
      return;
    }

    case 'clients': {
      const trustPath = getPluginTrustPath();
      const code = printClients(readObservedClients(trustPath), trustPath, jsonMode);
      if (code !== 0) process.exit(code);
      return;
    }

    case 'register': {
      const profile = selectedProfile(args);
      if (profile === null) {
        console.error(`Unknown --profile "${profileArgValue(args) ?? ''}". Valid: full, core.`);
        process.exit(1);
        return;
      }
      // #1151 — explicit user action, so warn rather than skip: the target
      // configs are suffix-blind, so this writes the PRODUCTION entries even
      // when this CLI itself runs inside an isolated instance.
      // stderr in BOTH modes: --json consumers (the most automated callers,
      // e.g. a CLI run from inside an isolated instance's pane) are exactly
      // who must see this, and stderr never pollutes the stdout JSON.
      const registerNotice = isolatedInstanceNotice('register');
      if (registerNotice) console.error(registerNotice);
      const wmuxScript = await resolveWmuxScript();
      // The wmux MCP script is required; bail if the bundle can't be found.
      if (!wmuxScript) {
        const warning =
          'Could not locate the wmux MCP bundle next to this CLI. Open the wmux app once and use Settings → General → MCP → Re-register, or reinstall wmux.';
        if (jsonMode) console.log(JSON.stringify({ error: warning }, null, 2));
        else console.error(warning);
        process.exit(1);
        return;
      }
      // registerTarget propagates write/permission errors (only parse/edit
      // issues are 'malformed'); capture them per-target so one failure neither
      // aborts the rest nor is silently swallowed.
      const results = targets.map((t) => {
        try { return { target: t, result: registerTarget(t, home, wmuxScript, undefined, profile), error: null as string | null }; }
        catch (e) { return { target: t, result: null, error: e instanceof Error ? e.message : String(e) }; }
      });
      if (jsonMode) {
        console.log(JSON.stringify({ scripts: { wmux: wmuxScript }, results: results.map((r) => ({ id: r.target.id, error: r.error, ...(r.result ?? {}) })) }, null, 2));
        if (results.some((r) => r.error)) process.exit(1);
        return;
      }
      let wroteAny = false;
      let failed = false;
      for (const { target, result, error } of results) {
        if (error || !result) {
          failed = true;
          console.error(`${target.displayName}: registration FAILED — ${error}`);
          continue;
        }
        if (result.skipped === 'absent') {
          console.log(`${target.displayName}: not installed — skipped`);
          continue;
        }
        if (result.skipped === 'malformed') {
          console.warn(`${target.displayName}: config malformed — left untouched (${result.configPath})`);
          continue;
        }
        if (result.wrote.length > 0) {
          wroteAny = true;
          // Name the profile: without it there is no way to confirm a
          // `--profile core` landed, or to notice that a profile-less register
          // preserved a `core` you forgot about.
          console.log(`${target.displayName}: wrote ${result.wrote.join(', ')} (${result.profile}) → ${result.configPath}`);
        } else {
          console.log(`${target.displayName}: already up to date${result.profile ? ` (${result.profile})` : ''}`);
        }
        if (result.foreign.length > 0) {
          console.warn(`  left foreign key(s) ${result.foreign.join(', ')} untouched`);
        }
      }
      console.log(`  wmux → ${wmuxScript}`);
      if (wroteAny) console.log('Restart the affected agent(s) to pick up the new server.');
      if (failed) process.exit(1);
      return;
    }

    case 'unregister': {
      // #1151 — same warning as `register`: suffix-blind config paths mean
      // this removes the PRODUCTION entries. stderr in both modes — see the
      // `register` case for why.
      const unregisterNotice = isolatedInstanceNotice('unregister');
      if (unregisterNotice) console.error(unregisterNotice);
      // unregisterTarget propagates write errors — capture per-target (same as
      // register) so one failure neither crashes the CLI nor is swallowed.
      const results = targets.map((t) => {
        try { return { target: t, result: unregisterTarget(t, home), error: null as string | null }; }
        catch (e) { return { target: t, result: null, error: e instanceof Error ? e.message : String(e) }; }
      });
      if (jsonMode) {
        console.log(JSON.stringify({ results: results.map((r) => ({ id: r.target.id, error: r.error, ...(r.result ?? {}) })) }, null, 2));
        if (results.some((r) => r.error)) process.exit(1);
        return;
      }
      let failed = false;
      for (const { target, result, error } of results) {
        if (error || !result) {
          failed = true;
          console.error(`${target.displayName}: unregister FAILED — ${error}`);
        } else if (!result.configExisted) {
          console.log(`${target.displayName}: no config — nothing to unregister`);
        } else if (result.removed.length === 0) {
          console.log(`${target.displayName}: wmux not registered — nothing changed`);
        } else {
          console.log(`${target.displayName}: removed ${result.removed.join(', ')} from ${result.configPath}`);
        }
      }
      if (failed) process.exit(1);
      return;
    }

    default: {
      console.error(`Unknown mcp subcommand: "${sub}". Run 'wmux mcp --help' for usage.`);
      process.exit(1);
    }
  }
}
