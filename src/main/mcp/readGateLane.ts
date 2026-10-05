// Curated lane for Moa's read gate on the MAIN pipe (#1111 enforcer).
//
// The gate (src/main/deck/moaReadGate.ts) is a PreToolUse hook script main
// generates for the HQ brain. For each Read, Grep or Glob it asks main which
// repositories Moa may read without a prompt (`deck.moaReadRoots`) instead of
// trusting a file on disk that any same-user process could rewrite.
//
// `deck.moaReadRoots` is `wmux.internal`, so no declaration can grant it; a
// name-recognised lane is the only path, as for the hook bridge and the
// statusline. Recognition is by self-asserted `clientName` once local
// external-wire provenance is established, so anyone holding the main token
// may send it. What it grants is one read-only method that returns the roots
// main already holds in memory: it changes nothing and reveals only which
// delegated repositories are readable.

import type { RpcMethod } from '../../shared/rpc';
import { WMUX_READ_GATE_CLIENT_NAME } from '../../shared/rpc';

export { WMUX_READ_GATE_CLIENT_NAME };

export const READ_GATE_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>(['deck.moaReadRoots']);

export function isReadGateClient(clientName: string | undefined): boolean {
  return clientName === WMUX_READ_GATE_CLIENT_NAME;
}
