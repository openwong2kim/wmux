/**
 * Single source of truth for cross-process timeout values.
 *
 * Why this file exists (RCA A2, 2026-05-29): the renderer's startup reconcile
 * timeout (`AppLayout.tsx`) and the main↔daemon RPC timeout (`DaemonClient.ts`)
 * were defined independently and drifted out of order — RECONCILE (5s) became
 * SHORTER than the RPC ceiling (10s). A daemon that legitimately answered in
 * 6–9s under load still lost the race, and the renderer's catch fired
 * `clearAllPtyState()`, replacing every live session with a fresh empty one.
 *
 * The invariant that must hold: RECONCILE_TIMEOUT_MS > DAEMON_RPC_TIMEOUT_MS,
 * so the RPC always gets a chance to resolve (or reject) before the renderer
 * gives up and falls back to its destructive path. Derive one from the other
 * here and import on both sides so they can never drift again.
 *
 * This module has zero runtime dependencies and is safe to import from the
 * daemon, main, and renderer bundles alike.
 */

/** main↔daemon JSON-RPC per-request timeout. */
export const DAEMON_RPC_TIMEOUT_MS = 10_000;

/**
 * Renderer startup reconcile timeout. Must exceed the RPC ceiling with a
 * margin so a single slow-but-successful `pty.list` (= daemon.listSessions)
 * never trips the destructive startup fallback.
 */
export const RECONCILE_TIMEOUT_MS = DAEMON_RPC_TIMEOUT_MS + 5_000;
