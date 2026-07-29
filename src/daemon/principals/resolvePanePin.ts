// Pane-pin resolution — the daemon's answer to "may this mention be pinned to
// that pane, and which pty would act on it?"
//
// Split out of `daemon/index.ts` on purpose. The composition is the thing that
// broke before: the gate itself was an anonymous closure, so every test could
// only inject a fake and the production pairing (principal registry + session
// table) was never exercised. This module is pure — both lookups arrive as
// functions — so the real rules are testable without a daemon.
//
//   registry (ownership)          session table (liveness)
//   ────────────────────          ────────────────────────
//   pane:${ws}/${pane}            attached ─┐
//        │ hit ⇒ owned            detached ─┴─▶ live
//        │                        suspended ─┐
//        ▼                        dead      ─┴─▶ not live
//   rec.ptyId ─────────────────────▶ sessionState(ptyId)
//
// Two questions, two authorities, and they are deliberately NOT the same one:
//
//   OWNERSHIP is the registry's to answer. Its key embeds the workspace, so a
//   lookup hit IS the proof that the pane belongs to the workspace being
//   mentioned — without it, `pane_id` would be a cross-workspace paste
//   primitive.
//
//   LIVENESS is the daemon's own to answer, and used to be read off the
//   registry's `liveness` field. That field can only be refreshed by a
//   renderer, and the daemon backfills every pane-agent to `stale` on its own
//   restart (PrincipalService liveness rules). An agent sitting IDLE emits
//   nothing, so nothing re-registers it — meaning a pin aimed at an idle agent
//   was refused forever after any daemon restart, which is precisely the case
//   pane-pinned mentions exist to serve. The daemon owns the PTYs, so it can
//   answer this itself and does.
//
//   That answer survives a restart because the session table is REBUILT from
//   persisted metadata before anything asks it: recovery re-creates each
//   session through `createSession`, which stamps `detached`. Nothing in that
//   path waits on a renderer, which is the whole reason it can be trusted where
//   the registry's own field cannot.
//
// "Live" here means A LIVE PTY, not a live agent: an agent can exit back to its
// shell while the session stays attached. Callers get the same guarantee the
// rest of the daemon works from (`listLiveSessions` encodes the same two
// states) and no more — see `pane_not_live` in `shared/channels.ts`.

import { panePrincipalId } from '../../shared/principals';
import type { PrincipalRecord } from '../../shared/principals';
import type { DaemonSessionState } from '../types';

/** The two lookups the resolver needs, as functions so this stays pure. */
export interface PanePinLookups {
  /** Principal registry read, keyed by principal id. */
  findPrincipal: (principalId: string) => PrincipalRecord | undefined;
  /** Daemon session-table read. `undefined` when no session holds that id. */
  sessionState: (ptyId: string) => DaemonSessionState | undefined;
}

/**
 * The states that mean "a PTY is behind this session right now".
 *
 * `suspended` is excluded deliberately and is NOT a synonym for detached: the
 * shutdown-kill classifier demotes an involuntarily-killed session to it, and
 * `attachSession` rejects it because there is no live ptyProcess left to wire.
 * Same pair `DaemonSessionManager.listLiveSessions()` filters on — if that
 * definition ever moves, both should move together.
 */
const LIVE_SESSION_STATES: ReadonlySet<DaemonSessionState> = new Set<DaemonSessionState>([
  'attached',
  'detached',
]);

/**
 * Resolve a pane pin to the pty that would act on it.
 *
 * Three outcomes, and the caller reports each differently:
 *   - `undefined`  — that workspace has no such pane. Ownership is unproven, so
 *                    the pin is refused (`pane_not_in_workspace`).
 *   - `{}`         — the pane is that workspace's, but nothing live is behind
 *                    it. Refused as `pane_not_live`.
 *   - `{ ptyId }`  — proven. This pty is the route-time snapshot the receiving
 *                    renderer re-checks before pasting anything.
 *
 * The returned `ptyId` always comes from the registry, never from a caller: a
 * mention cannot carry its own pty coordinate past this point.
 */
export function resolvePanePin(
  lookups: PanePinLookups,
  workspaceId: string,
  paneId: string,
): { ptyId?: string } | undefined {
  const rec = lookups.findPrincipal(panePrincipalId(workspaceId, paneId));
  if (!rec || rec.kind !== 'pane-agent') return undefined;
  // Owned, but the record predates any pty (or was written without one): the
  // ownership proof stands, the delivery target does not.
  if (!rec.ptyId) return {};
  const state = lookups.sessionState(rec.ptyId);
  // A record's ptyId can name a session that is gone (the pane restarted, the
  // agent exited, the daemon reaped it). That is a miss, not an error: the pin
  // is refused and the mention still lands as a badge.
  return state !== undefined && LIVE_SESSION_STATES.has(state) ? { ptyId: rec.ptyId } : {};
}
