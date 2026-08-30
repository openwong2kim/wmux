// ─── #922 PR-A — workspace claim token registry (wire caller track) ─────────
//
// The `declared` lane in `browser.rpc.ts` checks that a caller sent SOME
// workspaceId, not that it sent its own, because nothing in the main process
// records which workspace a wire caller belongs to. Workspace ids are not
// secret either — `workspace.list` hands them out under an ordinary declarable
// capability — so naming a foreign workspace has been enough.
//
// `mcp.claimWorkspace` is where that record can be made honestly: it is the
// one point where main CREATES a workspace *for* a specific caller, so the
// association is a fact main already knows rather than something the caller
// asserts. This registry stores it, keyed on a secret main mints and hands
// back in the claim response.
//
// Why a minted secret rather than the caller's name: `clientName` is
// self-asserted (spec §2.3), so keying on it would bind a claim to a string
// anyone can send — two callers claiming the same name would share one
// binding. The token is issued by main and never guessable, so possession is
// the whole check.
//
// Why not the pipe connection: `sendRpc` opens a fresh socket per call
// (`src/mcp/wmux-client.ts`), so there is no connection to bind to and a
// per-request credential is the only shape that works. Peer credentials
// (`GetNamedPipeClientProcessId`) would be the unforgeable version, but the OS
// handle behind a Node pipe socket is not reachable from JS — measured: the
// accepted socket reports `_handle.fd === -1` and the `Pipe` prototype exposes
// no accessor — so it needs a compiled native addon, which buys nothing here
// (see the ceiling below).
//
// ── Ceiling, so this is never read as more than it is ──────────────────────
//
// The token lives in the caller's process memory, exactly like the daemon auth
// token and the commander token before it. Same-user code can read another
// same-user process's memory, so this does NOT contain hostile code already
// running as the user — `firstParty.ts` states that ceiling and it still
// holds. What it changes is the bar for an APPROVED tool: from "name any
// workspace id" (and the ids are handed out on request) to "hold a secret
// wmux issued to you". That is confinement of an approved caller to the scope
// its approval implied, and nothing more.
//
// ── PR split ───────────────────────────────────────────────────────────────
//
// PR-A (this) mints, stores, and revokes. NOTHING reads a token to make an
// authorisation decision yet, so a caller that ignores the token behaves
// exactly as before. PR-B adds the lane that consults `lookupWorkspaceClaim`.

import { randomUUID } from 'node:crypto';

/** token -> the workspace the claim created for its holder. */
const live = new Map<string, string>();

/**
 * The result of presenting (or not presenting) a claim token.
 *
 * Deliberately NOT `string | null`. A nullable binding invites a plain
 * `if (!binding)` early-return, which silently DEMOTES a caller whose token
 * was revoked or has gone stale into an ordinary caller free to name its own
 * workspace — the exact fail-open the BYOB commander gate had to
 * write a paragraph about (`RpcRouter.dispatch`: "an invalid/stale token
 * rejects the whole request instead of demoting"). Three named states make the
 * demotion unrepresentable: a consumer must handle `stale` explicitly, and the
 * only correct handling is to refuse.
 */
export type WorkspaceClaimLookup =
  /** No token was presented. The caller never claimed; nothing changes for it. */
  | { kind: 'unclaimed' }
  /** A live token. Its holder owns this workspace by construction. */
  | { kind: 'bound'; workspaceId: string }
  /** A token was presented but is unknown, revoked, or its workspace is gone. */
  | { kind: 'stale' };

/**
 * Mint a token bound to `workspaceId`, or `null` when there is no workspace to
 * bind to. `null` means "issue nothing" — an unbound token would be a secret
 * that proves nothing, and handing one out invites a consumer to treat its
 * presence as meaningful.
 */
export function mintWorkspaceClaimToken(workspaceId: unknown): string | null {
  if (typeof workspaceId !== 'string') return null;
  const trimmed = workspaceId.trim();
  if (trimmed.length === 0) return null;
  const token = `${randomUUID()}${randomUUID()}`;
  live.set(token, trimmed);
  return token;
}

/** Revoke one token. Idempotent. */
export function revokeWorkspaceClaimToken(token: unknown): void {
  if (typeof token !== 'string' || token.length === 0) return;
  live.delete(token);
}

/**
 * Revoke every token bound to `workspaceId` — called when the workspace goes
 * away, so a re-minted id can never inherit a dead claim's binding. Returns
 * how many were revoked (for logging/tests).
 */
export function revokeWorkspaceClaimTokensFor(workspaceId: unknown): number {
  if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) return 0;
  const target = workspaceId.trim();
  let revoked = 0;
  for (const [token, ws] of live) {
    if (ws === target) {
      live.delete(token);
      revoked++;
    }
  }
  return revoked;
}

/**
 * Classify a presented token. See `WorkspaceClaimLookup` for why the absent
 * and stale cases are distinct — collapsing them is the fail-open this type
 * exists to prevent.
 */
export function lookupWorkspaceClaim(token: unknown): WorkspaceClaimLookup {
  if (token === undefined || token === null) return { kind: 'unclaimed' };
  if (typeof token !== 'string' || token.length === 0) return { kind: 'stale' };
  const workspaceId = live.get(token);
  if (workspaceId === undefined) return { kind: 'stale' };
  return { kind: 'bound', workspaceId };
}

/** Test-only: clear every registered token. */
export function __resetWorkspaceClaimTrustForTesting(): void {
  live.clear();
}
