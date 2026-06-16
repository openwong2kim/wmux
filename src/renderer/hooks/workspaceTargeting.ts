// Pure A2A workspace-target resolution. Extracted from useRpcBridge so it can be
// unit-tested directly (useRpcBridge pulls in the store/window and can't be
// imported under vitest). Operates only on the {id,name} list passed in.

export type WorkspaceRef = { id: string; name: string };

export type WorkspaceTargetResult =
  | { kind: 'resolved'; id: string }
  | { kind: 'ambiguous'; matches: WorkspaceRef[] }
  | { kind: 'not-found' };

/**
 * Resolve an A2A `to` target (id / exact name / number / substring) to a single
 * workspace id. Tiered so a unique match always wins, but a DUPLICATE EXACT NAME
 * is REFUSED rather than silently resolving to whichever appears first in the
 * list (the bug where two same-named workspaces misrouted a send):
 *
 *   1. exact ID           → unique by construction (UUID); short-circuits.
 *   2. exact name (ci)    → STRICT: exactly 1 resolves; 2+ ⇒ ambiguous (caller
 *                           must re-address by ID).
 *   3. number / substring → first-match preserved. These are the documented
 *      heuristic addressing modes ("3", "3번", partial name); they were always
 *      order-dependent and stay so to avoid breaking that contract.
 *
 * Tier precedence means an exact name beats a substring of a different
 * workspace's name (more precise), where the old single-pass .find was
 * list-order dependent.
 */
export function resolveWorkspaceTarget(
  workspaces: WorkspaceRef[],
  to: string,
): WorkspaceTargetResult {
  const toTrimmed = to.trim();
  const toNorm = toTrimmed.toLowerCase();
  // Whitespace-only / empty target never matches — otherwise the substring tier
  // below would `includes('')` every workspace and silently route to the first.
  if (!toNorm) return { kind: 'not-found' };

  // 1. Exact ID — never ambiguous (UUID), highest precedence.
  const byId = workspaces.find((w) => w.id === toTrimmed);
  if (byId) return { kind: 'resolved', id: byId.id };

  // 2. Exact name (case-insensitive) — STRICT ambiguity refusal.
  const exact = workspaces.filter((w) => w.name.toLowerCase() === toNorm);
  if (exact.length === 1) return { kind: 'resolved', id: exact[0].id };
  if (exact.length > 1) {
    return { kind: 'ambiguous', matches: exact.map((w) => ({ id: w.id, name: w.name })) };
  }

  // 3. Number / substring — heuristic first-match (contract-preserving).
  // Parses "3", "3번", "ws3", "workspace 3", "#3".
  const numMatch = toNorm.match(/^#?(?:ws|workspace\s*)?(\d+)(?:번)?$/);
  const targetNum = numMatch ? parseInt(numMatch[1], 10) : NaN;
  const heuristic = workspaces.find((w) => {
    if (!isNaN(targetNum)) {
      const wsNumMatch = w.name.match(/(\d+)/);
      if (wsNumMatch && parseInt(wsNumMatch[1], 10) === targetNum) return true;
    }
    return w.name.toLowerCase().includes(toNorm);
  });
  if (heuristic) return { kind: 'resolved', id: heuristic.id };

  return { kind: 'not-found' };
}
