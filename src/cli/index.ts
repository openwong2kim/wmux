#!/usr/bin/env node

process.on('SIGINT', () => {
  process.exit(130);
});

import { hasFlag } from './utils';
import { handleWorkspace } from './commands/workspace';
import { handleSurface } from './commands/surface';
import { handlePane } from './commands/pane';
import { handleInput } from './commands/input';
import { handleNotify } from './commands/notify';
import { handleSystem } from './commands/system';
import { handleBrowser, handleOpen } from './commands/browser';
import { handleGate } from './commands/gate';
import { handleMcp } from './commands/mcp';
import { handleSetupHooks } from './commands/setupHooks';
import { handleSetupStatusline } from './commands/setupStatusline';
import { handleDoctor } from './commands/doctor';
import { handleChannel } from './commands/channel';
import { handleWeb } from './commands/web';
import { handleDaemon } from './commands/daemon';

const HELP_TEXT = `
wmux CLI

USAGE
  wmux <command> [options]

WORKSPACE COMMANDS
  list-workspaces                   List all workspaces
  new-workspace [--name <name>]     Create a new workspace
  focus-workspace <id>              Focus a workspace by ID
  close-workspace <id>              Close a workspace by ID
  current-workspace                 Show the active workspace

SURFACE COMMANDS
  list-surfaces                     List all surfaces in the active workspace
  new-surface                       Open a new surface (terminal tab)
  focus-surface <id>                Focus a surface by ID
  close-surface <id>                Close a surface by ID

PANE COMMANDS
  list-panes                        List all panes in the active workspace
  focus-pane <id>                   Focus a pane by ID
  split [--direction right|down]    Split the active pane (default: right)

INPUT COMMANDS
  send <text> [--submit]            Send text to your own pane (--submit presses Enter)
  send-key <keystroke>              Send a key (e.g. Enter, ctrl-c, Tab)
  read-screen [--tail <n>]          Read the current terminal screen content

  Inside a wmux pane these target the pane you ran the command from
  (verified PID-map identity). Options: --pane <ptyId> to target another
  pane explicitly, --active to target the UI-focused pane instead.

BROWSER PANE
  open <url> [--workspace <id>]     Open/reuse a browser pane at <url>

DAEMON (headless lifecycle, no Electron/GUI required)
  daemon start                      Start the daemon if not already running
  daemon status                     Ping the daemon; reports whether it's up
  daemon stop                       Gracefully shut the daemon down

WEB ACCESS (browser / PWA)
  web                               Serve wmux panes to a browser (read-only,
                                    LOCAL-ONLY by default). NOTE: even read-only
                                    exposes a pane's FULL scrollback to viewers.
        [--port <n>]                Listen port (default 7681)
        [--expose]                  Bind all interfaces (0.0.0.0) for phone
                                    access. Off by default (loopback only).
        [--host <addr>]             Explicit bind address (overrides --expose)
        [--tailscale]               One-shot tailnet setup: start 'tailscale
                                    serve' (HTTPS) in front of a loopback bind
                                    and accept the MagicDNS name. Removed again
                                    by --stop
        [--tls-cert <path>]         PEM certificate or full-chain file for
                                    native HTTPS (requires --tls-key)
        [--tls-key <path>]          Matching PEM private key (requires
                                    --tls-cert; incompatible with --tailscale)
                                    Re-supply both TLS paths when re-running
                                    'wmux web' to change other CLI options
        [--allow-input]             Enable keyboard input (off by default)
        [--allow-upload]            Enable photo upload from a paired phone
                                    (JPEG/PNG, 10 MB cap, files kept 24h in
                                    ~/.wmux/uploads/phone). Off by default
        [--allow-transcript]        Enable full Claude transcript access for a
                                    paired phone (thinking, tool inputs, and
                                    contents of files the agent read). Off by
                                    default
        [--allow-host <h1,h2>]      Extra Host names to accept and advertise,
                                    for a reverse proxy or native TLS DNS name
        [--new-token]               Mint a fresh access token, revoking every
                                    device already paired
        [--status]                  Show whether the web server is running
        [--stop]                    Stop the web server and revoke all web
                                    credentials

NOTIFICATION COMMANDS
  notify <title> [body]             Show a notification in wmux
         [--type info|warning|error|agent] [--workspace <id>]

SYSTEM COMMANDS
  set-status <text> [--pane <id>]   Set a status message on your own workspace
  set-progress <0-100> [--pane <id>]
                                    Set a progress value on your own workspace
                                    (both target the pane you are calling from;
                                     --pane names another pane's workspace)
  identify                          Show wmux app info
  capabilities                      List all supported RPC methods

CHANNEL COMMANDS (agent messaging — Channels v2 durable inbox)
  channel unread                    Your per-channel unread + mention counts
  channel read <ch> [--since <seq>] Print messages (id or name; oldest first)
  channel post <ch> <text…>         Post a message [--member <id>]
  channel ack <ch> <uptoSeq|all>    Mark consumed — clears unread, stops re-nudges
  channel join <ch>                 Join a public channel [--member <id>]
  channel list                      Channels visible to your workspace

  Works headless (talks to the daemon directly). Typical nudged-agent loop:
  unread → read → work → post → ack. Run 'wmux channel help' for details.

DIAGNOSTICS
  doctor                            Run health checks (env, daemon, boot phases,
                                    AV-tax hint, log pointers). Works even when
                                    the daemon is down.
         [--performance]            Also print reveal-mechanism performance
                                    stats (last reveal, 5-min + since-boot
                                    counters) from the running app.

BROWSER COMMANDS
  browser navigate <url>            Navigate your workspace's browser surface
  browser close                     Close the browser panel
  browser session start [--profile <name>]  Start a browser session
  browser session stop              Stop the active browser session
  browser session status            Show active session status
  browser session list              List available profiles

MCP COMMANDS
  mcp check                         Show whether wmux MCP servers are registered
  mcp clients                       List MCP clients wmux saw, by reported name
  mcp register [--profile <name>]   Add wmux entries to ~/.claude.json
                                    (full: every tool, the default; core: no browser_* tools)
  mcp unregister                    Remove wmux entries from ~/.claude.json

CLAUDE CODE INTEGRATION
  setup-hooks [--signals-only]      Install Claude Code hooks (no plugin needed).
                                    --signals-only omits the wide PreToolUse
                                    permission gate, so no wmux hook runs per
                                    tool call; --with-gate puts it back.
              [--remove]            Remove the wmux-owned hook entries
              [--status]            Report hook + bridge install state
  gate --list                       Show tools in the permission gate (#783)
  gate --add <tool>                 Add a tool to the permission gate
  gate --remove <tool>              Remove a tool from the permission gate
  setup-statusline                  Show per-account usage in Claude's statusline
              [--remove]            Remove the wmux-owned statusLine entries
              [--status]            Report statusline install state

GLOBAL FLAGS
  --json      Output raw JSON (useful for scripting)
  --help      Show this help text

EXAMPLES
  wmux list-workspaces
  wmux new-workspace --name dev
  wmux send "echo hello" --submit
  wmux notify "Done" "Build finished"
  wmux open http://localhost:3000
  wmux identify --json
  wmux browser navigate "https://example.com"
  wmux browser close
  wmux doctor
  wmux doctor --json
  wmux doctor --performance
`.trimStart();

const WORKSPACE_CMDS = new Set([
  'list-workspaces',
  'new-workspace',
  'focus-workspace',
  'close-workspace',
  'current-workspace',
]);

const SURFACE_CMDS = new Set([
  'list-surfaces',
  'new-surface',
  'focus-surface',
  'close-surface',
]);

const PANE_CMDS = new Set(['list-panes', 'focus-pane', 'split']);

const INPUT_CMDS = new Set(['send', 'send-key', 'read-screen']);

const SYSTEM_CMDS = new Set([
  'identify',
  'capabilities',
  'set-status',
  'set-progress',
]);

async function main(): Promise<void> {
  // process.argv = ['node', 'index.js', ...userArgs]
  const argv = process.argv.slice(2);

  if (argv.length === 0 || hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  const jsonMode = hasFlag(argv, '--json');

  // Strip global flags so commands see clean args
  const args = argv.filter((a) => a !== '--json' && a !== '--help' && a !== '-h');

  const cmd = args[0];
  const rest = args.slice(1);

  try {
    if (WORKSPACE_CMDS.has(cmd)) {
      await handleWorkspace(cmd, rest, jsonMode);
    } else if (SURFACE_CMDS.has(cmd)) {
      await handleSurface(cmd, rest, jsonMode);
    } else if (PANE_CMDS.has(cmd)) {
      await handlePane(cmd, rest, jsonMode);
    } else if (INPUT_CMDS.has(cmd)) {
      await handleInput(cmd, rest, jsonMode);
    } else if (cmd === 'notify') {
      await handleNotify(rest, jsonMode);
    } else if (SYSTEM_CMDS.has(cmd)) {
      await handleSystem(cmd, rest, jsonMode);
    } else if (cmd === 'open') {
      await handleOpen(rest, jsonMode);
    } else if (cmd === 'browser') {
      await handleBrowser(rest, jsonMode);
    } else if (cmd === 'web') {
      await handleWeb(rest, jsonMode);
    } else if (cmd === 'daemon') {
      await handleDaemon(rest[0], rest.slice(1), jsonMode);
    } else if (cmd === 'mcp') {
      await handleMcp(rest, jsonMode);
    } else if (cmd === 'setup-hooks') {
      await handleSetupHooks(rest, jsonMode);
    } else if (cmd === 'gate') {
      handleGate(rest[0] ?? '--list', rest.slice(1), jsonMode);
    } else if (cmd === 'setup-statusline') {
      await handleSetupStatusline(rest, jsonMode);
    } else if (cmd === 'doctor') {
      await handleDoctor(rest, jsonMode);
    } else if (cmd === 'channel') {
      await handleChannel(rest[0], rest.slice(1), jsonMode);
    } else {
      console.error(`Unknown command: "${cmd}". Run 'wmux --help' for usage.`);
      process.exit(1);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}

main();
