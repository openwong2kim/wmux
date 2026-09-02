/**
 * Handler collector for the browser tool registration sites.
 *
 * The eight `registerXTools(server, deps)` modules hand their handlers to
 * `server.tool(...)` / `server.registerTool(...)` and discard the returned
 * handles, so nothing in the process can call a browser tool except the MCP
 * dispatcher. `browser_repl` needs exactly that: it runs an agent's script
 * whose `browser.click(...)` must go THROUGH the real `browser_click` handler
 * (automation lease, password redaction, action-trace recording, frame-aware
 * refs all live inside the handler bodies), not around it.
 *
 * `collectingServer` wraps the server so registration still reaches the real
 * instance unchanged while a copy of `{name, shape, handler}` lands in the
 * sink. The tool modules stay untouched — the same shape the replay-recording
 * tests already use to reach handlers directly.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

export type CollectedToolHandler = (
  args: Record<string, unknown>,
) => CallToolResult | Promise<CallToolResult>;

export interface CollectedTool {
  readonly name: string;
  /** The raw Zod shape the SDK validates against before dispatch. */
  readonly shape: z.ZodRawShape;
  readonly handler: CollectedToolHandler;
}

type ToolFn = McpServer['tool'];
type RegisterToolFn = McpServer['registerTool'];

function isShape(value: unknown): value is z.ZodRawShape {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Return a server whose `tool` and `registerTool` record every registration
 * into `sink` and then delegate to `server`. Only the 4-argument
 * `tool(name, description, shape, handler)` form and the
 * `registerTool(name, {inputSchema}, handler)` form are recorded; the browser
 * modules use nothing else. Any other arity is delegated without recording.
 */
export function collectingServer(
  server: McpServer,
  sink: Map<string, CollectedTool>,
): McpServer {
  const tool = ((name: string, ...rest: unknown[]) => {
    if (rest.length === 3 && isShape(rest[1]) && typeof rest[2] === 'function') {
      sink.set(name, {
        name,
        shape: rest[1],
        handler: rest[2] as CollectedToolHandler,
      });
    }
    return (server.tool as unknown as (...a: unknown[]) => ReturnType<ToolFn>)(name, ...rest);
  }) as ToolFn;

  const registerTool = ((name: string, config: unknown, handler: unknown) => {
    const inputSchema = (config as { inputSchema?: unknown } | undefined)?.inputSchema;
    if (isShape(inputSchema) && typeof handler === 'function') {
      sink.set(name, { name, shape: inputSchema, handler: handler as CollectedToolHandler });
    }
    return (server.registerTool as unknown as (...a: unknown[]) => ReturnType<RegisterToolFn>)(
      name,
      config,
      handler,
    );
  }) as RegisterToolFn;

  // A prototype-chained view: every other member (connect, close, server,
  // isConnected…) resolves to the real instance, so callers that only need
  // registration cannot tell the difference.
  return Object.create(server, {
    tool: { value: tool, enumerable: true },
    registerTool: { value: registerTool, enumerable: true },
  }) as McpServer;
}
