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
import { handleBrowser } from './commands/browser';

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
  send <text>                       Send text to the active terminal
  send-key <keystroke>              Send a key (e.g. Enter, ctrl-c, Tab)
  read-screen                       Read the current terminal screen content

NOTIFICATION COMMANDS
  notify --title <title> --body <body>   Show a notification in wmux

SYSTEM COMMANDS
  set-status <text>                 Set a status message on the active workspace
  set-progress <0-100>              Set a progress value on the active workspace
  identify                          Show wmux app info
  capabilities                      List all supported RPC methods

BROWSER COMMANDS
  browser snapshot                  Return the full page HTML of the active browser surface
  browser click <selector>          Click an element by CSS selector
  browser fill <selector> <text>    Fill an input field by CSS selector
  browser eval <code>               Execute JavaScript in the browser context
  browser navigate <url>            Navigate the browser surface to a URL

GLOBAL FLAGS
  --json      Output raw JSON (useful for scripting)
  --help      Show this help text

EXAMPLES
  wmux list-workspaces
  wmux new-workspace --name dev
  wmux send "echo hello"
  wmux notify --title "Done" --body "Build finished"
  wmux identify --json
  wmux browser snapshot
  wmux browser navigate "https://example.com"
  wmux browser click "#login-btn"
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
    } else if (cmd === 'browser') {
      await handleBrowser(rest, jsonMode);
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
