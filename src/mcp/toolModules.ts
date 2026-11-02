// ─── Bot tool modules — where the factory's MCP tools plug in ──────────────
//
// The bundled server's bot mode (`--bot=<role>`, src/mcp/index.ts) lists
// exactly the shared bot surface (shared/botSurface.ts SHARED_SURFACE). The tools the
// server already has (workspace_list, fanout_start, ...) come from their usual
// registration sites; the factory's own tools come from modules that call
// `registerToolModule` at import time from their own files (imported once by
// src/mcp/botModules.ts), so no work package edits index.ts.
//
// A module declares the tool names it owns; it may only register those, and
// only the ones on the running role's surface are kept. Any surface tool that
// nothing registered is served by a placeholder that forwards its arguments
// to the tool's primary RPC (BOT_TOOL_RPC), which main answers
// `not_implemented` until the real handler exists — the listing is the role
// surface from the first build, and an unbuilt tool fails closed in main.
//
// Modules run only in bot mode: the full, core and commander profiles are
// untouched by anything registered here.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RpcMethod } from '../shared/rpc';
import type { BotRole } from '../shared/bot';
import { isBotRole } from '../shared/bot';
import { BOT_TOOL_RPC, SHARED_SURFACE, type BotToolName } from '../shared/botSurface';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ToolModuleDeps {
  /** The role this server runs as. */
  role: BotRole;
  /** The server's RPC helper (JSON text result, stale-route handling). Every
   *  call carries the bot token; main scopes it on the bot's binding. */
  callRpc: (method: RpcMethod, params?: Record<string, unknown>, timeoutMs?: number) => Promise<ToolResult>;
}

/** McpServer's two registration methods, gated to the module's own names on
 *  the running role's surface. A gated-out name returns undefined. */
export type ToolModuleHost = Pick<McpServer, 'tool' | 'registerTool'>;

export interface ToolModule {
  /** Unique, for diagnostics. */
  name: string;
  /** The bot tools this module registers (a name may belong to one module). */
  tools: readonly BotToolName[];
  register(host: ToolModuleHost, deps: ToolModuleDeps): void;
}

const modules: ToolModule[] = [];

/** Add a module. Throws on a duplicate module name, a name that is not a bot
 *  tool, or a tool another module already owns — all programming errors
 *  caught by the first test that imports the module. */
export function registerToolModule(module: ToolModule): void {
  if (modules.some((m) => m.name === module.name)) {
    throw new Error(`[wmux-mcp] tool module ${module.name} is registered twice`);
  }
  for (const tool of module.tools) {
    if (!Object.prototype.hasOwnProperty.call(BOT_TOOL_RPC, tool)) {
      throw new Error(`[wmux-mcp] tool module ${module.name}: ${tool} is not a bot tool (shared/botSurface.ts BOT_TOOL_RPC)`);
    }
    const owner = modules.find((m) => m.tools.includes(tool));
    if (owner) throw new Error(`[wmux-mcp] tool ${tool} is claimed by both ${owner.name} and ${module.name}`);
  }
  modules.push(module);
}

export function registeredToolModules(): readonly ToolModule[] {
  return modules;
}

/** Test-only. */
export function __resetToolModulesForTesting(): void {
  modules.length = 0;
}

export const BOT_PLACEHOLDER_DESCRIPTION_SUFFIX =
  'Not available in this build yet: the call is passed to wmux, which answers not_implemented.';

type RawTool = (name: string, ...rest: unknown[]) => unknown;

/**
 * Keep a registered tool on the name it was registered under: the SDK handle's
 * `update({name})` would otherwise re-key the tool past every name filter. A
 * rename to another name throws; removal (`name: null`) and every other
 * update pass through. Returns the same handle.
 */
export function pinToolName<T>(handle: T, name: string): T {
  if (!handle || typeof handle !== 'object') return handle;
  const h = handle as { update?: (updates: { name?: string | null }) => void };
  if (typeof h.update !== 'function') return handle;
  const update = h.update;
  h.update = (updates) => {
    if (updates && typeof updates.name === 'string' && updates.name !== name) {
      throw new Error(`[wmux-mcp] bot tool ${name} cannot be renamed to ${updates.name}`);
    }
    update(updates);
  };
  return handle;
}

export interface InstallBotToolsInput {
  role: BotRole;
  /** server.tool / server.registerTool WITHOUT any profile filter. */
  rawTool: RawTool;
  rawRegisterTool: RawTool;
  deps: ToolModuleDeps;
  /** Names already registered on this server; updated in place. */
  registered: Set<string>;
  /** Modules to install (default: every registered module). */
  modules?: readonly ToolModule[];
  /** The tools to list (default: the shared bot surface); a narrowed bot
   *  (`--bot-surface=`, shared/botSurface.ts botSurfaceTools) lists fewer. */
  surface?: ReadonlySet<string>;
}

/** Install the modules' tools and the placeholders for the rest of the
 *  role's surface. A module that throws is logged and skipped; its tools then
 *  get placeholders. */
export function installBotTools(input: InstallBotToolsInput): void {
  const surface = isBotRole(input.role) ? input.surface ?? SHARED_SURFACE.tools : new Set<string>();
  for (const module of input.modules ?? modules) {
    const owned = new Set<string>(module.tools);
    const gate = (raw: RawTool): RawTool => (name, ...rest) => {
      if (!owned.has(name)) {
        throw new Error(`[wmux-mcp] tool module ${module.name} registered ${name}, which it does not declare`);
      }
      if (!surface.has(name) || input.registered.has(name)) return undefined;
      const handle = raw(name, ...rest);
      if (handle !== undefined) input.registered.add(name);
      return pinToolName(handle, name);
    };
    const host = { tool: gate(input.rawTool), registerTool: gate(input.rawRegisterTool) } as unknown as ToolModuleHost;
    try {
      module.register(host, input.deps);
    } catch (err) {
      console.error(`[wmux-mcp] tool module ${module.name} failed to register:`, err);
    }
  }
  for (const name of surface) {
    if (input.registered.has(name)) continue;
    const method = BOT_TOOL_RPC[name as BotToolName]?.[0];
    if (!method) continue;
    const handle = input.rawTool(
      name,
      `${name} (${method}). ${BOT_PLACEHOLDER_DESCRIPTION_SUFFIX}`,
      { args: z.record(z.string(), z.unknown()).optional().describe('Arguments, passed through unchanged.') },
      async ({ args }: { args?: Record<string, unknown> }) => input.deps.callRpc(method, args ?? {}),
    );
    if (handle !== undefined) input.registered.add(name);
    pinToolName(handle, name);
  }
}
