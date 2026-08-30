#!/usr/bin/env node
/**
 * Single-child stdio entry — one MCP server per agent pane, the legacy
 * (pre-broker) topology. The agent CLI spawns this bundle directly; the
 * server context comes straight from this process's own env/argv/pid,
 * which is byte-for-byte what src/mcp/index.ts read before the
 * createWmuxServer factory split.
 *
 * The broker topology (plans/mcp-broker-design-2026-07-16.md Option A)
 * replaces this entry with src/mcp/shim.ts + src/mcp/broker.ts.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { COMMANDER_MODE_ARG } from '../shared/commanderSurface';
import { clearClientIdentity } from './wmux-client';
import { PlaywrightEngine } from './playwright/PlaywrightEngine';
import { createWmuxServer } from './index';
import { disposeReplRegistry } from './repl/replRegistry';

async function main(): Promise<void> {
  const server = createWmuxServer({
    envWorkspaceHint: process.env.WMUX_WORKSPACE_ID || '',
    envPtyHint: process.env.WMUX_PTY_ID || '',
    commanderToken: process.env.WMUX_COMMANDER_TOKEN,
    commanderMode: process.argv.includes(COMMANDER_MODE_ARG),
    callerPid: process.pid,
    callerPpid: process.ppid,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Clean up Playwright connection when transport closes. Also drop the
  // declared plugin identity so any trailing RPC traffic falls back to
  // the substrate's legacy audit path instead of stamping a stale name —
  // a reconnect must re-run the MCP initialize handshake to re-establish
  // identity (see wireClientIdentityHook in index.ts).
  transport.onclose = async () => {
    // stdout belongs exclusively to MCP JSON-RPC for the lifetime of a stdio
    // child. Diagnostics must stay on stderr, including during shutdown.
    console.error('[wmux-mcp] Transport closed, disconnecting Playwright');
    clearClientIdentity();
    // REPL children hold live state and are ours alone; reap them with the
    // connection rather than leaving them to the disconnect watchdog.
    disposeReplRegistry();
    await PlaywrightEngine.getInstance().disconnect();
  };

  // Graceful shutdown
  const shutdown = async () => {
    disposeReplRegistry();
    await PlaywrightEngine.getInstance().disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('wmux MCP server failed to start:', err);
  process.exit(1);
});
