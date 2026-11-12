#!/usr/bin/env node

process.on('SIGINT', () => {
  process.exit(130);
});

// Must stay the first import: turns off working-directory executable lookup (Windows) before any module runs.
import '../shared/exeSearchGuard';
// Next, before any module can print or hold process.stdout/stderr: on Windows wmux.exe's console output is otherwise garbled or lost.
import './consoleStdioPrelude';
import { hasFlag } from './utils';
import { handleWorkspace } from './commands/workspace';
import { handleSurface } from './commands/surface';
import { handlePane } from './commands/pane';
import { handleInput } from './commands/input';
import { handleNotify } from './commands/notify';
import { handleAction } from './commands/action';
import { handleSystem } from './commands/system';
import { handleBrowser, handleOpen } from './commands/browser';
import { handleGate } from './commands/gate';
import { handleMcp } from './commands/mcp';
import { handleSetupHooks } from './commands/setupHooks';
import { handleSetupStatusline } from './commands/setupStatusline';
import { handleUninstallIntegrations } from './commands/uninstallIntegrations';
import { handleDoctor } from './commands/doctor';
import { handleSecrets } from './commands/secretsCheck';
import { handleRole } from './commands/role';
import { handleDeck } from './commands/deck';
import { handleChannel } from './commands/channel';
import { handleRemote } from './commands/remote';
import { handleWeb } from './commands/web';
import { handleDaemon } from './commands/daemon';
import { CODEX_HANDOFF_FLAG, handleCodex, reportHandoffError } from './commands/codex';

const HELP_TEXT = `
wmux CLI

USAGE
  wmux <command> [options]

CODEX (NATIVE WINDOWS)
  codex [TUI options]               Launch Codex with this pane's identity
  codex resume                     Resume through the pane's shared-server link

WORKSPACE COMMANDS
  list-workspaces                   List all workspaces
  new-workspace [--name <name>]     Create a new workspace
  focus-workspace <id>              Focus a workspace by ID
  close-workspace <id> [--force]    Close a workspace by ID (--force: even your
                                    own workspace or one with live agent panes)
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
  send <text> [--submit] [--to <#pane|ptyId>]
                                    Type text into a pane (--submit presses Enter)
  send-key <keystroke> [--to <#pane|ptyId>]
                                    Send a key (e.g. Enter, ctrl-c, Tab)
  read-screen [--tail <n>] [--to <#pane|ptyId>]
                                    Read the current terminal screen content

  Without --to these target the pane you ran the command from (verified
  PID-map identity). An agent running "wmux send" from its own shell types
  into its OWN input that way: to reach another pane, name it with
  --to (a quoted #name as "wmux list-panes" shows it, e.g. '#w1-2', or a ptyId).
  --pane is the older spelling of --to; --active targets the UI-focused pane.

BROWSER PANE
  open <url> [--new] [--workspace <id>]
                                    Open/reuse a browser pane at <url> (--new: in a new tab)

DAEMON (headless lifecycle, no Electron/GUI required)
  daemon start                      Start the daemon if not already running
  daemon status                     Ping the daemon; reports whether it's up
  daemon stop                       Gracefully shut the daemon down
  daemon run                        Run the daemon in the foreground, for a
                                    service manager (never exits on idle)
  daemon install-service            Linux: start the daemon at boot and keep it
                                    after logout (systemd --user unit)
  daemon uninstall-service          Remove that unit (the running daemon stays)

WEB ACCESS (browser / PWA)
  web                               Serve wmux panes to a browser (read-only,
                                    LOCAL-ONLY by default). NOTE: even read-only
                                    exposes a pane's FULL scrollback to viewers.
                                    Re-running it on a running server keeps
                                    every option not given (port, scope, allowed
                                    hosts, TLS, allow-* grants); turn one off
                                    with --no-allow-<x>, --loopback or --no-tls
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
        [--no-tls]                  Drop native HTTPS on a re-run (revokes
                                    every paired device)
        [--loopback]                Drop --expose / --host / --tailscale /
                                    --allow-host on a re-run: loopback only
        [--allow-input]             Enable keyboard input (off by default)
        [--no-allow-<x>]            Turn a grant off on a re-run: input,
                                    upload, transcript, dangerous-launch,
                                    git-write
        [--allow-upload]            Enable photo upload from a paired phone
                                    (JPEG/PNG, 10 MB cap, files kept 24h in
                                    ~/.wmux/uploads/phone). Off by default
        [--allow-transcript]        Enable full Claude transcript access for a
                                    paired phone (thinking, tool inputs, and
                                    contents of files the agent read). Off by
                                    default
        [--allow-dangerous-launch]  Let a phone start Claude/Codex (chat or a
                                    new agent pane) with approvals off
                                    (bypass/yolo), after per-launch
                                    confirmation. Off by default
        [--allow-git-write]         Let a phone with an explicit input grant
                                    push, open PRs and squash-merge, after a
                                    preview and confirmation. Off by default
        [--git-write-login <login>] GitHub login those writes run as
        [--no-inline-images]        Stop the browser terminal drawing sixel and
                                    iTerm2 images (on by default; kept across
                                    re-runs, restarts and --stop;
                                    --inline-images turns it back on)
        [--allow-host <h1,h2>]      Extra Host names to accept and advertise,
                                    for a reverse proxy or native TLS DNS name
        [--new-token]               Mint a fresh access token, revoking every
                                    device already paired
        [--trust-proxy-header <name>]
                                    Sign in through a reverse proxy such as
                                    oauth2-proxy: a request with no token,
                                    from --trust-proxy-from, carrying
                                    --trust-proxy-user in this header (e.g.
                                    X-Auth-Request-Email), is you. All three
                                    together; needs a non-loopback bind; not
                                    kept on a re-run or daemon restart
        [--trust-proxy-user <email>]
                                    The signed-in email the proxy forwards
        [--trust-proxy-from <ip1,ip2>]
                                    The proxy's own addresses (single
                                    addresses, never this machine). Every
                                    connection from them must have passed
                                    the sign-in, and the proxy must drop a
                                    client's own copy of the header
        [--status]                  Show whether the web server is running
        [--stop]                    Stop the web server and revoke all web
                                    credentials
  web pair --name <device>          Start a pairing on the RUNNING web server
        [--kind desktop|phone]      and print its code (never restarts it, never
                                    prints the access token). desktop also lets
                                    that computer open new workspaces

APP ACTIONS (your own workspace; run from a wmux pane)
  action <id> [--target <id|#tag>] [--arg key=value ...]
                                    Run one app action: rename this workspace or
                                    a tab, balance the layout, move a pane, read
                                    or set a few settings, clear notifications.
                                    Without --target it acts on your own
                                    workspace, pane or tab; a target in another
                                    workspace is refused (not_owned)
  action --list                     List the actions and their arguments

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

REMOTE COMMANDS (another paired PC)
  remote spawn <pc> --agent <slug> --root <id> [--sub <path>] <prompt…>
                                    Ask that PC to start an agent; replies come here
  remote spawn-status [<spawnId>]   Your requests, and what each PC lets you ask for
  remote join <invite | ->          Join another PC's invite (this PC never listens)
  remote peers                      Paired PCs: host id, name, fingerprint
  remote unpair <host-id>           End the pairing with that PC

  join, peers and unpair talk to the daemon directly (no desktop app needed).

DIAGNOSTICS
  doctor                            Run health checks (env, daemon, boot phases,
                                    AV-tax hint, log pointers). Works even when
                                    the daemon is down.
         [--performance]            Also print reveal-mechanism performance
                                    stats (last reveal, 5-min + since-boot
                                    counters) from the running app.
  doctor detect --stats             How often the screen detector disagreed with
                                    the hook, from the opt-in local log
                                    (diagnostics.detectionAgreement in config.json)
         [--since <7d>] [--grace <5s>] [--sample <n>]
  secrets check-staged              Refuse a commit that adds a .env file, a
                                    private key or an API key (the pre-commit
                                    hook wmux installs runs this)

ROLES
  role resolve <Role>               Print what a role is bound to in Settings
             [--json]               {agent, model, effort, argv, flags}; exit 2 if unbound,
                                    exit 1 with {role, bound:true, unavailable} when
                                    its custom agent cannot launch
             [--session <path>]     Read another session.json (default: the app's)

COMMAND DECK
  deck state                        Report or prune orphan Deck state
             [--orphans]            List orphan workspace IDs across Deck store files
             [--prune --yes]        Prune orphan state (archives active work records)

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

REMOVING WMUX
  uninstall-integrations            Remove wmux's MCP entries, hooks, statusline and
                                    plugins from every agent's config, and report
                                    each one. Run it before deleting the app on
                                    macOS or Linux; the Windows uninstaller does it.
              [--force]             Also remove entries another wmux copy may use

GLOBAL FLAGS
  --json      Output raw JSON (useful for scripting)
  --help      Show this help text

EXAMPLES
  wmux list-workspaces
  wmux new-workspace --name dev
  wmux send "echo hello" --submit
  wmux send "run the tests" --submit --to '#w1-2'
  wmux notify "Done" "Build finished"
  wmux action workspace.rename --arg name=api
  wmux action settings.set --arg key=terminal.fontSize --arg value=16
  wmux open http://localhost:3000
  wmux identify --json
  wmux browser navigate "https://example.com"
  wmux browser close
  wmux doctor
  wmux doctor --json
  wmux doctor --performance
  wmux doctor detect --stats --since 7d
  wmux role resolve Builder --json
  wmux deck state --orphans
  wmux deck state --prune --yes
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

  // Codex owns its flags and terminal signals; do not consume --help/--json
  // or exit the parent before its relay cleanup can run.
  if (argv[0] === 'codex') {
    process.removeAllListeners('SIGINT');
    process.on('SIGINT', () => { /* the foreground TUI handles Ctrl-C */ });
    // Ctrl+Break would otherwise end this process before handleCodex's
    // finally closes the pane's relay lease.
    if (process.platform === 'win32') process.on('SIGBREAK', () => { /* the foreground TUI handles Ctrl+Break */ });
    try { await handleCodex(argv.slice(1)); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const handoff = argv.length === 2 && argv[1] === CODEX_HANDOFF_FLAG;
      if (!(handoff && await reportHandoffError(message))) console.error(message);
      process.exitCode = 1;
    }
    return;
  }

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
    } else if (cmd === 'action') {
      await handleAction(rest, jsonMode);
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
    } else if (cmd === 'uninstall-integrations') {
      await handleUninstallIntegrations(rest, jsonMode);
    } else if (cmd === 'secrets') {
      await handleSecrets(rest);
    } else if (cmd === 'doctor') {
      await handleDoctor(rest, jsonMode);
    } else if (cmd === 'role') {
      await handleRole(rest, jsonMode);
    } else if (cmd === 'deck') {
      await handleDeck(rest, jsonMode);
    } else if (cmd === 'channel') {
      await handleChannel(rest[0], rest.slice(1), jsonMode);
    } else if (cmd === 'remote') {
      await handleRemote(rest[0], rest.slice(1), jsonMode);
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
