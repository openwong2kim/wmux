// Tripwire: only main's operator lane writes Moa's hand-off provenance line
// (moaHandoff.ts). A non-operator caller whose text carries it is refused,
// on every path that types text into a pane or a prompt. The line is a
// label, not an authentication boundary — this only stops a caller from
// passing its own text off as an operator-approved hand-off.
import type { RpcContext } from '../../shared/rpc';
import { containsHandoffMarker } from '../../shared/moaHandoff';

export function refuseHandoffMarker(
  method: string,
  texts: unknown | readonly unknown[],
  ctx: RpcContext | undefined,
): { error: string } | null {
  if (ctx?.operator === true) return null;
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.some((t) => containsHandoffMarker(t))) return null;
  return {
    error: `${method}: this text carries the line wmux adds to operator-approved hand-offs; only the operator's hand-off may send it. To give work to another workspace's agent, Moa uses moa_propose_handoff.`,
  };
}
