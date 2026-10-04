// What the right panel shows, from Moa's state. Pure, so the panel's routing
// (whose brain the chat talks to) is testable without mounting the dock.
import type { MoaHqState, MoaMascotState, MoaState } from '../../../../shared/moa';

export type MoaPanelMode =
  /** Moa runs: the panel is Moa, pinned to the HQ whatever is on screen. */
  | { kind: 'moa'; chatWorkspaceId: string; hqId: string }
  /** Moa is switched off: the panel only says how to turn it on. */
  | { kind: 'off' }
  /** Moa is on but its HQ cannot run (gone, not seen yet, unreadable store). */
  | { kind: 'hq-problem'; state: Exclude<MoaHqState, 'ok' | 'unset'> }
  /**
   * Today's per-workspace orchestrator: the chat follows the active workspace.
   * Moa on without an HQ (an install that kept its existing brains), or Moa's
   * state not known yet (boot, an older main) — the least surprising default.
   * `setupHint` asks for the "Set up Moa" link.
   */
  | { kind: 'legacy'; chatWorkspaceId: string; setupHint: boolean };

export function resolveMoaPanelMode(moa: MoaState | null, activeWorkspaceId: string | null | undefined): MoaPanelMode {
  const active = activeWorkspaceId ?? '';
  if (!moa) return { kind: 'legacy', chatWorkspaceId: active, setupHint: false };
  if (!moa.config.enabled) return { kind: 'off' };
  const { state, workspaceId } = moa.hq;
  if (state === 'ok' && workspaceId) return { kind: 'moa', chatWorkspaceId: workspaceId, hqId: workspaceId };
  if (state === 'unset' || state === 'ok') return { kind: 'legacy', chatWorkspaceId: active, setupHint: true };
  return { kind: 'hq-problem', state };
}

/** True when the panel belongs to Moa's HQ (entry points must not switch the
 *  active workspace to reach "its" orchestrator). */
export function moaOwnsPanel(moa: MoaState | null): boolean {
  return resolveMoaPanelMode(moa, null).kind === 'moa';
}

/** The header mascot: a decision waiting on you outranks a running turn. */
export function moaMascotState(args: { busy: boolean; pendingDecisions: number }): MoaMascotState {
  if (args.pendingDecisions > 0) return 'needs-you';
  return args.busy ? 'working' : 'idle';
}
