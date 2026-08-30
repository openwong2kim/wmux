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
//
// ── Known residual: a claim minted onto a workspace that just died ─────────
//
// `mcp.claimWorkspace` mints AFTER the renderer answers, so a close that lands
// in that window is revoked before the token exists and the token is then
// issued bound to a dead id. Checking liveness at mint time does not fix it:
// the workspace was created microseconds earlier and has not reached the mirror
// yet, so a freshly claimed workspace would look absent and every honest claim
// would be refused instead.
//
// `reconcileWorkspaceClaims` clears it instead — one grace window plus the next
// structural or periodic mirror push, so bounded, not permanent. Until then the
// holder's calls resolve to a workspace that no longer exists, which fails as a
// missing target rather than as access to anyone else's workspace. Recorded
// rather than papered over: a lane that trusts `bound` should know the one case
// where it is briefly wrong.

import { randomUUID } from 'node:crypto';

/** token -> the workspace the claim created for its holder, and when it was issued. */
const live = new Map<string, { workspaceId: string; mintedAt: number }>();

/**
 * Grace window before `reconcileWorkspaceClaims` may retire a young token.
 *
 * The reconcile source is the renderer's workspace mirror, which is pushed
 * asynchronously. A push that was already in flight when a claim created its
 * workspace describes the tree BEFORE that workspace existed, so without a
 * grace window it would arrive just after the mint and retire a claim that is
 * perfectly live. The window only has to outlast an in-flight IPC push.
 */
const RECONCILE_GRACE_MS = 60_000;

/**
 * Hard cap on live claims, as a backstop for the case where reconcile never
 * runs (no renderer pushing a mirror). Claims are only minted through
 * `mcp.claimWorkspace`, which needs the renderer, so this should be
 * unreachable; it exists so a long-lived main can never accumulate secrets
 * without bound. Oldest first — a claim's usefulness ends with its workspace.
 */
const MAX_LIVE_CLAIMS = 512;

/** Injectable for deterministic tests. */
let now: () => number = Date.now;

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
  /**
   * No token was presented AT ALL — the field was absent (`undefined`). The
   * caller never claimed; nothing changes for it.
   *
   * `null` is deliberately NOT this. A `null` arrives over the wire as a value
   * the caller CHOSE to send, so it is a presented token that does not resolve,
   * not an absent one. Treating it as absent would let a caller whose claim was
   * revoked send `workspaceToken: null` and be read as "never claimed" — back to
   * naming any workspace it likes, which is the exact demotion this type exists
   * to make unwritable. The three states only close that hole if the mapping
   * from wire values onto them is airtight too.
   */
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
  live.set(token, { workspaceId: trimmed, mintedAt: now() });
  if (live.size > MAX_LIVE_CLAIMS) {
    // Map preserves insertion order, so the first key is the oldest claim.
    const oldest = live.keys().next();
    if (!oldest.done) live.delete(oldest.value);
  }
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
  for (const [token, entry] of live) {
    if (entry.workspaceId === target) {
      live.delete(token);
      revoked++;
    }
  }
  return revoked;
}

/**
 * Retire every claim whose workspace is no longer in the live set.
 *
 * `revokeWorkspaceClaimTokensFor` above only fires on the `workspace.close`
 * RPC, and that is not how most workspaces die: the sidebar's X, the
 * close-workspace keybinding, and the settings reset all call the renderer's
 * own `removeWorkspace` and never reach a main handler. Without this, a claim
 * for a workspace closed from the UI would stay `bound` forever — and `bound`
 * is exactly the fact a scoping lane trusts ("the workspace is alive and this
 * holder owns it"), so leaving it true after the workspace is gone means the
 * lane trusts something false.
 *
 * The live set comes from the renderer's workspace mirror, which is pushed on
 * every STRUCTURAL change (immediately, never debounced) plus a slow periodic
 * refresh — the authoritative lifecycle signal main already receives.
 *
 * Two guards, both deliberate:
 *   - a claim younger than `RECONCILE_GRACE_MS` is never retired here, because
 *     a push already in flight when its workspace was created describes a tree
 *     without it;
 *   - an EMPTY live set is ignored. The mirror's own contract says an empty
 *     push is legitimate ("every workspace was closed"), but the renderer store
 *     always keeps one workspace, so in practice an empty set means a caller
 *     handed us nothing rather than a real observation. Refusing to act on it
 *     costs one reconcile cycle and avoids retiring every claim on a bad frame.
 *
 * Returns how many were retired (for logging/tests).
 */
export function reconcileWorkspaceClaims(liveWorkspaceIds: Iterable<string>): number {
  const alive = new Set<string>();
  for (const id of liveWorkspaceIds) {
    if (typeof id === 'string' && id.trim().length > 0) alive.add(id.trim());
  }
  if (alive.size === 0) return 0;

  const cutoff = now() - RECONCILE_GRACE_MS;
  let retired = 0;
  for (const [token, entry] of live) {
    if (alive.has(entry.workspaceId)) continue;
    if (entry.mintedAt > cutoff) continue;
    live.delete(token);
    retired++;
  }
  return retired;
}

/**
 * Classify a presented token. See `WorkspaceClaimLookup` for why the absent
 * and stale cases are distinct — collapsing them is the fail-open this type
 * exists to prevent.
 */
export function lookupWorkspaceClaim(token: unknown): WorkspaceClaimLookup {
  // ONLY an absent field is "unclaimed". Every other value the wire can carry —
  // `null`, a number, an object, an empty string — is something the caller sent
  // and that does not resolve, i.e. `stale`. See `WorkspaceClaimLookup`.
  if (token === undefined) return { kind: 'unclaimed' };
  if (typeof token !== 'string' || token.length === 0) return { kind: 'stale' };
  const entry = live.get(token);
  if (entry === undefined) return { kind: 'stale' };
  return { kind: 'bound', workspaceId: entry.workspaceId };
}

/** Test-only: clear every registered token and restore the real clock. */
export function __resetWorkspaceClaimTrustForTesting(clock?: () => number): void {
  live.clear();
  now = clock ?? Date.now;
}
