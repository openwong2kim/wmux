import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `wmux mcp …` — inspect / manage Claude Code MCP registration without
 * touching the running wmux daemon. Reading and editing `~/.claude.json`
 * directly means the user can verify the integration even when the GUI app
 * is not running, which matches the DX-D4 decision (CLI as a one-line
 * verification path; Settings panel as the GUI parity).
 *
 * NOTE (cross-platform): currently uses `~/.claude.json` on every OS. macOS
 * Claude Desktop may use `~/Library/Application Support/Claude/` instead —
 * macOS verification pending — see plan Phase 1.17 prereq. Do NOT add the
 * macOS-specific path speculatively here; ship that as a separate change
 * once empirically verified.
 */

const HELP_TEXT = `
wmux mcp — inspect / manage Claude Code MCP registration

USAGE
  wmux mcp <subcommand> [--json]

SUBCOMMANDS
  check        Show whether wmux + wmux-a2a MCP servers are registered.
  register     Add wmux + wmux-a2a entries to ~/.claude.json (no-daemon).
               Note: written paths point at this CLI's own bundle layout — for
               a GUI re-register that uses the running app's resolved paths,
               use Settings → General → MCP → Re-register.
  unregister   Remove the wmux + wmux-a2a keys from ~/.claude.json.
               Other MCP entries are left untouched.

GLOBAL FLAGS
  --json       Output raw JSON (useful for scripting).
`.trimStart();

function getClaudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

interface ServerStatus {
  registered: boolean;
  path: string | null;
}

interface CheckResult {
  wmux: ServerStatus;
  wmuxA2a: ServerStatus;
  configPath: string;
  configExists: boolean;
  /** ISO 8601 string, or null when the config file does not exist. */
  configModified: string | null;
}

function extractScriptPath(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const args = (entry as { args?: unknown }).args;
  if (!Array.isArray(args) || args.length === 0) return null;
  const first = args[0];
  return typeof first === 'string' && first.length > 0 ? first : null;
}

/**
 * Read `~/.claude.json` and report which wmux MCP keys are present. Pure read
 * — never creates the file. Corrupted / partial JSON yields "not registered"
 * rather than throwing, mirroring `McpRegistrar.getStatus()` semantics.
 */
function checkStatus(): CheckResult {
  const configPath = getClaudeJsonPath();
  let configExists = false;
  let configModified: string | null = null;
  try {
    const stat = fs.statSync(configPath);
    configExists = stat.isFile();
    configModified = configExists ? stat.mtime.toISOString() : null;
  } catch {
    configExists = false;
  }

  let wmuxPath: string | null = null;
  let a2aPath: string | null = null;
  if (configExists) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw, (key, value) => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
        return value;
      }) as { mcpServers?: Record<string, unknown> };
      const servers = config && typeof config === 'object' ? config.mcpServers : null;
      if (servers && typeof servers === 'object') {
        wmuxPath = extractScriptPath(servers['wmux']);
        a2aPath = extractScriptPath(servers['wmux-a2a']);
      }
    } catch {
      // Malformed JSON — treat as not-registered.
    }
  }

  return {
    wmux: { registered: wmuxPath !== null, path: wmuxPath },
    wmuxA2a: { registered: a2aPath !== null, path: a2aPath },
    configPath,
    configExists,
    configModified,
  };
}

function formatModified(iso: string | null): string {
  if (!iso) return 'does not exist';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // YYYY-MM-DD HH:MM (local time) — readable, no locale-specific commas.
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `modified ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function printCheck(result: CheckResult, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const fmt = (status: ServerStatus): string =>
    status.registered ? `registered → ${status.path}` : 'NOT REGISTERED';

  console.log(`wmux:        ${fmt(result.wmux)}`);
  console.log(`wmux-a2a:    ${fmt(result.wmuxA2a)}`);
  if (result.configExists) {
    console.log(`config file: ${result.configPath} (${formatModified(result.configModified)})`);
  } else {
    console.log(`config file: ${result.configPath} (does not exist)`);
  }
  if (!result.wmux.registered || !result.wmuxA2a.registered) {
    console.log('Run `wmux mcp register` to enable Claude Code integration.');
  }
}

/**
 * Find the bundled MCP scripts when this CLI is invoked from a packaged
 * install. The CLI bundle lives in `dist/cli-bundle/index.js` next to
 * `dist/mcp-bundle/index.js` (or in the legacy `dist/mcp/mcp/index.js`
 * layout). Returns null when neither candidate exists, in which case the
 * caller should advise the user to use the GUI Re-register button instead.
 */
function findScript(candidateRelative: string[]): string | null {
  // Walk up from the bundled CLI's directory looking for the candidate path.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    for (const rel of candidateRelative) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface RegisterOutcome {
  configPath: string;
  wmuxScript: string | null;
  a2aScript: string | null;
  /** Keys this command actually wrote, e.g. ['wmux', 'wmux-a2a']. */
  wrote: string[];
  /** Warning shown when no script could be located. */
  warning: string | null;
}

/**
 * Atomic write — same pattern as McpRegistrar.writeJson — so a partial write
 * can never leave Claude Code with an unparseable config file.
 */
function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function registerEntries(): RegisterOutcome {
  const configPath = getClaudeJsonPath();
  // CLI-side script discovery: try the packaged dist layouts. When wmux is run
  // from source dev mode the GUI registers the dev paths on first launch, so
  // this branch only matters for CLI-only / no-GUI flows.
  const wmuxScript = findScript([
    path.join('mcp-bundle', 'index.js'),
    path.join('dist', 'mcp-bundle', 'index.js'),
    path.join('dist', 'mcp', 'mcp', 'index.js'),
  ]);
  const a2aScript = findScript([
    path.join('a2a-bundle', 'index.js'),
    path.join('dist', 'a2a-bundle', 'index.js'),
    path.join('dist', 'mcp', 'mcp', 'a2a', 'index.js'),
  ]);

  if (!wmuxScript && !a2aScript) {
    return {
      configPath,
      wmuxScript: null,
      a2aScript: null,
      wrote: [],
      warning:
        'Could not locate the wmux MCP bundle next to this CLI. Open the wmux app once and use Settings → General → MCP → Re-register, or reinstall wmux.',
    };
  }

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'), (key, value) => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
        return value;
      }) as Record<string, unknown>;
    } catch {
      // Corrupted — start fresh rather than overwrite silently? We choose
      // overwrite to recover a broken config; the prior contents are gone
      // but at least Claude Code can parse the file again.
      config = {};
    }
  }

  const servers = (config.mcpServers && typeof config.mcpServers === 'object'
    ? (config.mcpServers as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const wrote: string[] = [];
  if (wmuxScript) {
    servers['wmux'] = { command: 'node', args: [wmuxScript] };
    wrote.push('wmux');
  }
  if (a2aScript) {
    servers['wmux-a2a'] = { command: 'node', args: [a2aScript] };
    wrote.push('wmux-a2a');
  }
  config.mcpServers = servers;

  writeJsonAtomic(configPath, config);

  return {
    configPath,
    wmuxScript,
    a2aScript,
    wrote,
    warning: wmuxScript && a2aScript
      ? null
      : 'Only some MCP scripts were located — partial registration written. Use Settings → MCP → Re-register from the running app for full coverage.',
  };
}

interface UnregisterOutcome {
  configPath: string;
  removed: string[];
  configExisted: boolean;
}

function unregisterEntries(): UnregisterOutcome {
  const configPath = getClaudeJsonPath();
  if (!fs.existsSync(configPath)) {
    return { configPath, removed: [], configExisted: false };
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'), (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    }) as Record<string, unknown>;
  } catch {
    // Corrupted — nothing to remove safely; bail out to avoid silently
    // overwriting the user's broken-but-recoverable file.
    return { configPath, removed: [], configExisted: true };
  }

  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object') {
    return { configPath, removed: [], configExisted: true };
  }

  const serversMap = servers as Record<string, unknown>;
  const removed: string[] = [];
  for (const key of ['wmux', 'wmux-a2a']) {
    if (key in serversMap) {
      delete serversMap[key];
      removed.push(key);
    }
  }

  if (removed.length === 0) {
    return { configPath, removed, configExisted: true };
  }

  if (Object.keys(serversMap).length === 0) {
    delete config.mcpServers;
  }
  writeJsonAtomic(configPath, config);

  return { configPath, removed, configExisted: true };
}

export async function handleMcp(args: string[], jsonMode: boolean): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(HELP_TEXT);
    process.exit(sub ? 0 : 1);
    return;
  }

  switch (sub) {
    case 'check': {
      printCheck(checkStatus(), jsonMode);
      return;
    }

    case 'register': {
      const outcome = registerEntries();
      if (jsonMode) {
        console.log(JSON.stringify(outcome, null, 2));
        return;
      }
      if (outcome.wrote.length === 0) {
        if (outcome.warning) console.error(outcome.warning);
        process.exit(1);
        return;
      }
      console.log(`Wrote ${outcome.wrote.join(', ')} to ${outcome.configPath}`);
      if (outcome.wmuxScript) console.log(`  wmux     → ${outcome.wmuxScript}`);
      if (outcome.a2aScript) console.log(`  wmux-a2a → ${outcome.a2aScript}`);
      if (outcome.warning) console.warn(outcome.warning);
      console.log('Restart Claude Code to pick up the new servers.');
      return;
    }

    case 'unregister': {
      const outcome = unregisterEntries();
      if (jsonMode) {
        console.log(JSON.stringify(outcome, null, 2));
        return;
      }
      if (!outcome.configExisted) {
        console.log(`No config file at ${outcome.configPath} — nothing to unregister.`);
        return;
      }
      if (outcome.removed.length === 0) {
        console.log('wmux + wmux-a2a were not registered — nothing changed.');
        return;
      }
      console.log(`Removed ${outcome.removed.join(', ')} from ${outcome.configPath}`);
      return;
    }

    default: {
      console.error(`Unknown mcp subcommand: "${sub}". Run 'wmux mcp --help' for usage.`);
      process.exit(1);
    }
  }
}
