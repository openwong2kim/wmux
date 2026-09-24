/**
 * The time bounds on an A2A `execute: true` send, in one place (#1462).
 *
 * The send's reply is held while a person decides, and three layers each put a
 * deadline on that wait. They only work in this order:
 *
 *   approval window  <  renderer hard cap  <  main's wait  <  MCP client's wait
 *
 * Each layer must answer before the one above it gives up. If main gives up
 * first, a later approval creates the task in the renderer with nobody left to
 * spawn its worker; if the MCP client gives up first, the agent reads a timeout
 * while the prompt is still on screen, retries, and raises a second prompt.
 */

/** How long a prompt stays answerable once it is on screen. */
export const EXECUTE_APPROVAL_WINDOW_MS = 30_000;

/** Headroom each layer leaves the one below it to deliver its answer. */
export const EXECUTE_APPROVAL_LAYER_MARGIN_MS = 5_000;

/**
 * How long main waits on the renderer for a new execute send. Fixed, so the
 * renderer can bound a prompt against it (below).
 */
export const EXECUTE_SEND_MAIN_TIMEOUT_MS = 45_000;

/**
 * The longest a single execute request may stay pending in the renderer,
 * counted from when it was queued — even if it never reached the screen.
 * A prompt queued behind another one would otherwise start its 30 s late and
 * outlive main's wait. Past this point an approval could no longer start
 * anything, so the prompt is auto-denied instead.
 */
export const EXECUTE_APPROVAL_HARD_CAP_MS = EXECUTE_SEND_MAIN_TIMEOUT_MS - EXECUTE_APPROVAL_LAYER_MARGIN_MS;

/**
 * The MCP client's socket deadline for an execute send. Above main's wait, so
 * the caller reads main's answer (approved, denied, or timed out) rather than
 * its own timeout.
 */
export const EXECUTE_SEND_CLIENT_TIMEOUT_MS = EXECUTE_SEND_MAIN_TIMEOUT_MS + 15_000;
