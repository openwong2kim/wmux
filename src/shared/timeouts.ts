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

/**
 * Phase 3 PR-B: per-request timeout for `daemon.resyncSession` /
 * `daemon.serializeSession`. These legitimately outlive the default RPC
 * ceiling — snapshot work is serialized behind a global daemon-side slot
 * (concurrency 1, up to ~4 s parse budget per pane), so under concurrent
 * dirty-pane reveals the Nth pane waits (N-1)×budget before its own work even
 * starts. Timing out early would disarm the stream scanner and fall back to a
 * socket-tearing reconnect while the daemon may still write the in-band
 * replay (Codex round-2 P2).
 *
 * Invariant: this must stay BELOW the renderer's total resync-abort ceiling
 * (RESYNC_TIMEOUT_MS × (1 + max re-arms) in useTerminal, currently 32 s) so
 * the RPC always settles — success or timeout — before the renderer stops
 * extending its timer and aborts.
 */
export const DAEMON_RESYNC_RPC_TIMEOUT_MS = 30_000;
