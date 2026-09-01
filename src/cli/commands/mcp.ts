import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { getMcpBrokerPipeName, getPluginTrustPath } from '../../shared/constants';
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

function formatModified(d: Date | null): string {
  if (!d) return 'does not exist';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `modified ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function printCheck(statuses: TargetRegStatus[], jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify({ targets: statuses }, null, 2));
    return;
  }
  for (const s of statuses) {
    const tag = s.verified ? '' : ' (experimental)';
    console.log(`${s.displayName}${tag}:`);
    if (!s.configExists) {
      console.log(`  not detected — ${s.configPath}`);
      continue;
    }
    const fmt = (srv: { registered: boolean; path: string | null }) =>
      srv.registered ? `registered → ${srv.path}` : 'NOT REGISTERED';
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
      // #1151 — explicit user action, so warn rather than skip: the target
      // configs are suffix-blind, so this writes the PRODUCTION entries even
      // when this CLI itself runs inside an isolated instance.
      if (process.env.WMUX_DATA_SUFFIX) {
        // stderr in BOTH modes: --json consumers (the most automated callers,
        // e.g. a CLI run from inside an isolated instance's pane) are exactly
        // who must see this, and stderr never pollutes the stdout JSON.
        console.error(`warning: WMUX_DATA_SUFFIX=${process.env.WMUX_DATA_SUFFIX} is set — this writes the production agent configs (~/.claude.json et al.), and the script path it registers may live inside a disposable checkout`);
      }
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
        try { return { target: t, result: registerTarget(t, home, wmuxScript), error: null as string | null }; }
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
          console.log(`${target.displayName}: wrote ${result.wrote.join(', ')} → ${result.configPath}`);
        } else {
          console.log(`${target.displayName}: already up to date`);
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
      // this removes the PRODUCTION entries.
      if (process.env.WMUX_DATA_SUFFIX) {
        // stderr in both modes — see the `register` case for why.
        console.error(`warning: WMUX_DATA_SUFFIX=${process.env.WMUX_DATA_SUFFIX} is set — this removes the production agent config entries (~/.claude.json et al.)`);
      }
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
