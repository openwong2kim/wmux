/**
 * tools/list diet: drop named tools from the listing while keeping them
 * callable.
 *
 * The MCP SDK couples the two — one `enabled` flag gates both tools/list
 * membership and tools/call dispatch — so "unlisted but callable" has no
 * first-class support. This helper wraps the low-level server's existing
 * ListToolsRequestSchema handler: the SDK still serializes every registered
 * tool's schema exactly as before, and the wrapper filters the finished page
 * by name. tools/call is untouched, so a hidden tool keeps dispatching to its
 * real handler.
 *
 * The names come from src/shared/unlistedTools.ts (UNLISTED_TOOLS), the SSOT
 * the profile manifests and drift tests also read.
 *
 * The same wrapper also drops two fields the SDK stamps on every tool that
 * only restate the protocol default (MCP 2025-11-25, server/tools):
 *   - `inputSchema.$schema` = draft-07. With no `$schema` a client reads the
 *     schema as 2020-12, and no wmux schema uses a keyword whose meaning
 *     differs between the two (tuple `items`, `$ref`/`definitions`,
 *     `dependencies`) — the tools/list diet test pins that for every
 *     profile. A schema that does use one keeps its stamp at runtime too.
 *   - `execution: { taskSupport: 'forbidden' }`. 'forbidden' is the default
 *     when `execution` is absent, and wmux registers no task tools.
 * Together they were ~9% of every profile's tools/list bytes.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** The handler map Protocol.setRequestHandler writes into (private in the
 *  SDK's types; read once here to capture the handler being wrapped). */
type ListedTool = { name?: unknown; inputSchema?: unknown; execution?: unknown };
type HandlerMap = Map<
  string,
  (request: never, extra: never) => Promise<{ tools?: ListedTool[] }>
>;

const DRAFT_SENSITIVE_KEYS = new Set(['$ref', 'definitions', '$defs', 'dependencies', 'additionalItems']);

/** True when dropping a draft-07 `$schema` could change how the schema reads. */
function usesDraftSensitiveKeyword(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(usesDraftSensitiveKeyword);
  if (!node || typeof node !== 'object') return false;
  return Object.entries(node as Record<string, unknown>).some(([key, value]) =>
    DRAFT_SENSITIVE_KEYS.has(key)
    || (key === 'items' && Array.isArray(value))
    || usesDraftSensitiveKeyword(value));
}

/** A listed tool without the fields that only restate protocol defaults.
 *  Anything else — a non-default `taskSupport`, a `$schema` other than the
 *  SDK's draft-07 stamp — passes through untouched. */
export function withoutDefaultFields<T extends ListedTool>(tool: T): T {
  let out: T = tool;
  const schema = tool.inputSchema;
  if (
    schema && typeof schema === 'object'
    && (schema as { $schema?: unknown }).$schema === 'http://json-schema.org/draft-07/schema#'
    && !usesDraftSensitiveKeyword(schema)
  ) {
    const { $schema: _dropped, ...rest } = schema as Record<string, unknown>;
    out = { ...out, inputSchema: rest };
  }
  const execution = tool.execution as { taskSupport?: unknown } | undefined;
  if (
    execution && typeof execution === 'object'
    && Object.keys(execution).length === 1 && execution.taskSupport === 'forbidden'
  ) {
    const { execution: _dropped, ...rest } = out;
    out = rest as T;
  }
  return out;
}

export function unlistToolsFromListing(
  server: McpServer,
  hidden: ReadonlySet<string>,
): void {
  const protocol = server.server as unknown as {
    _requestHandlers?: HandlerMap;
    setRequestHandler: McpServer['server']['setRequestHandler'];
  };
  // The map key is the protocol method literal the SDK derives from the
  // schema's method field ('tools/list').
  const original = protocol._requestHandlers?.get('tools/list');
  if (!original) {
    // The SDK installs the list handler lazily, on the first tool
    // registration, and _requestHandlers is a PRIVATE field an SDK upgrade
    // can rename or restructure at any time. A missing slot is exactly that
    // scenario — warn once and serve the UNFILTERED listing rather than
    // killing server boot: a fat tools/list beats no server at all, and the
    // protocol probe pins the listed surface so the regression surfaces in
    // CI instead of at boot.
    console.warn(
      '[wmux-mcp] tools/list handler not found; serving the unfiltered tool listing ' +
      '(the unlisted-tools diet is inactive — the MCP SDK likely changed shape)',
    );
    return;
  }
  protocol.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await original(request as never, extra as never);
    const tools = result.tools ?? [];
    return {
      ...result,
      tools: tools
        .filter((tool) => {
          const name = tool.name;
          return !(typeof name === 'string' && hidden.has(name));
        })
        .map(withoutDefaultFields),
    };
  });
}
