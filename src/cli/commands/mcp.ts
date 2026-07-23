import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

/**
 * Find the bundled wmux MCP script when this CLI is invoked from a packaged
 * install. The CLI bundle lives in `dist/cli-bundle/index.js` next to
 * `dist/mcp-bundle/index.js` (or the legacy `dist/mcp/mcp/index.js` layout).
 * Returns null when no candidate exists.
 */
function resolveWmuxScript(): string | null {
  const candidates = [
    path.join('mcp-bundle', 'index.js'),
    path.join('dist', 'mcp-bundle', 'index.js'),
    // Unbundled dev layout: entry.js is the stdio boot (index.js became a
    // side-effect-free factory after the broker split).
    path.join('dist', 'mcp', 'mcp', 'entry.js'),
    path.join('dist', 'mcp', 'mcp', 'index.js'),
  ];
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

    case 'register': {
      const wmuxScript = resolveWmuxScript();
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
