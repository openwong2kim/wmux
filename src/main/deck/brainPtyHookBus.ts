// ─── Brain-pty hook bus — private hook lane for the interactive TUI brain ────
//
// ClaudePtyBrainAdapter runs the user's own `claude` binary as an INTERACTIVE
// TUI inside a daemon pty session. An interactive session has no SDK message
// stream, so the adapter's only structured turn signal is Claude Code's own
// hook system: the generated settings profile wires `Stop` / `SessionStart` to
// the bundled `wmux-bridge.mjs`, which speaks the SAME `hooks.signal` RPC the
// fleet's panes already use.
//
// Those signals must NOT reach the fleet machinery. A brain pty is not a
// worker pane: routing its `agent.stop` into HookSignalRouter would (a) fan a
// desktop notification for the orchestrator's own turn, and (b) push an
// `agent.lifecycle` event into the deck's CommanderEventCoalescer, which wakes
// the owning workspace's brain — the brain would wake ITSELF on every turn it
// finishes, an unbounded self-wake loop.
//
// So this module is a claim-first registry consulted at the very top of
// `hooks.signal` (before the daemon relay): a signal whose `ptyId` belongs to a
// live brain pty is delivered to that adapter and consumed. One tiny module
// with no Electron/daemon imports so the RPC handler can depend on it without
// pulling the adapter's spawn machinery into its module graph.

import type { AgentSignal } from '../../shared/hooks/signal-types';

/** Verdict a listener may return to REFUSE the hook that produced the signal.
 *  Only the Stop gate uses it: the reason is relayed to the bridge, which turns
 *  it into exit 2 so the TUI keeps working instead of ending its turn. */
export interface BrainPtyHookBlock {
  block: string;
}

/** Receives every hook signal that fired inside one brain pty. Returning a
 *  block asks the caller to refuse the hook; returning nothing allows it. */
export type BrainPtyHookListener = (signal: AgentSignal) => void | BrainPtyHookBlock;

const listeners = new Map<string, BrainPtyHookListener>();

/**
 * Claim `ptyId` as a brain pty. Returns the unregister function; the adapter
 * calls it from dispose(), after which the id's signals fall through to the
 * ordinary fleet path again (it will never be reused — daemon ids are unique —
 * but leaving a dead listener registered would silently swallow signals).
 */
export function registerBrainPty(ptyId: string, listener: BrainPtyHookListener): () => void {
  listeners.set(ptyId, listener);
  return () => {
    if (listeners.get(ptyId) === listener) listeners.delete(ptyId);
  };
}

/** Whether `ptyId` is a live brain pty (used by pane-listing filters). */
export function isBrainPty(ptyId: string): boolean {
  return listeners.has(ptyId);
}

/**
 * Deliver a hook signal to its brain pty, if it belongs to one. `consumed` is
 * true when the signal was claimed — the caller must then stop processing it
 * (no daemon relay, no notification, no EventBus tee). `block` carries the
 * listener's refusal, if any, back to the RPC response.
 *
 * A throwing listener is swallowed and yields NO block: a hook must never fail
 * because a brain adapter misbehaved, and a gate whose predicate crashed must
 * fail open. The signal is still consumed (it was addressed to the brain either
 * way).
 */
export function deliverBrainPtyHookSignal(
  signal: AgentSignal,
): { consumed: boolean; block?: string } {
  const ptyId = signal.ptyId;
  if (!ptyId) return { consumed: false };
  const listener = listeners.get(ptyId);
  if (!listener) return { consumed: false };
  try {
    const verdict = listener(signal);
    if (verdict && typeof verdict.block === 'string' && verdict.block.length > 0) {
      return { consumed: true, block: verdict.block };
    }
  } catch (err) {
    console.warn(`[deck] brain pty ${ptyId} hook listener threw: ${String(err)}`);
  }
  return { consumed: true };
}

/** Test-only: drop every registration. */
export function __resetBrainPtyHookBusForTesting(): void {
  listeners.clear();
}
