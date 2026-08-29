/**
 * Agent-facing error text for browser tool results.
 *
 * Playwright prefixes its errors with the API call it derives from the stack
 * ("locator.click: Timeout 30000ms exceeded"). wmux ships Playwright bundled
 * together with its own code, so that derivation resolves to wmux frame names
 * instead and the agent is handed internal symbols:
 *
 *   mcpServer.executeToolHandler: Timeout 30000ms exceeded
 *   automationLease: net::ERR_NAME_NOT_RESOLVED
 *
 * Neither prefix names anything an agent can act on — it points at a module
 * inside wmux, not at the tool that failed or the page that misbehaved — so it
 * is dropped before the message reaches the tool result. The part that carries
 * the diagnosis ("Timeout 30000ms exceeded", "net::ERR_NAME_NOT_RESOLVED") is
 * kept verbatim, and nothing here touches console logging.
 */

/**
 * Leading `<identifier>: ` or `<dotted.call.path>: ` prefix.
 *
 * Requires whitespace after the colon, so `net::ERR_NAME_NOT_RESOLVED` and
 * `https://example.test` are left alone.
 */
const CALL_PATH_PREFIX = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*):[ \t]+/;

/**
 * Message text for a caught tool error, with any internal call-path prefix
 * removed.
 *
 * Two prefix shapes are kept because they mean something to the reader:
 * wmux tool names (`browser_click: ...`, recognised by the underscore) and
 * error classes (`TypeError: ...`, `McpError: ...`). Anything else that looks
 * like a JS call path is treated as internal — including RPC method names such
 * as `browser.type.humanlike:`, which name a wire method the agent never calls.
 */
export function describeToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = CALL_PATH_PREFIX.exec(message);
  if (!match) return message;

  const head = match[1];
  if (head.includes('_') || /Error$/.test(head)) return message;

  const stripped = message.slice(match[0].length);
  // A message that is nothing but the prefix carries no diagnosis of its own;
  // an internal name beats an empty string.
  return stripped.length > 0 ? stripped : message;
}
