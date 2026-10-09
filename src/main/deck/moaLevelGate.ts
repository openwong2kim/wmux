// ─── Moa's autonomy level, enforced on the commander RPC lane ───────────────
//
// Before this, Moa's level (deck-hq.json `moaLevel`) was a sentence in the
// HQ's prompt and nothing else. RpcRouter now asks this gate about every
// request that carries a VALID commander token, after the teardown gate and
// before any handler runs (Layer 2, beside COMMANDER_TEARDOWN_DENY):
//
//   level 0  observe — every method that writes (spawns, drives or messages a
//            pane, posts, fans out, gates, adopts, presses, proposes) is
//            refused. Reads, deck_ask_decision and deck_complete_work stay.
//   level 1  today's behaviour, unchanged (the default for every install).
//   level 2+ the same lane, plus whatever an ACTIVE goal contract grants
//            (moaGoalContract.ts). While a contract is active, what Moa sends
//            a worker (input.send / a2a.task.send / a2a.broadcast) is read
//            against the contract's hard rules (shared/moaGoal.ts).
//
// Only the HQ's own token is gated: a per-workspace brain (no HQ designated, or
// another workspace's brain before the HQ migration) keeps today's lane. The
// gate is installed by deck.handler; uninstalled (tests, early boot) it allows
// everything, which is today's behaviour.
//
// This gate only ever REFUSES. Nothing here can widen what a handler allows,
// and it never answers a permission gate (`allow` stays the phone's alone,
// src/daemon/index.ts).

import type { MoaLevel } from '../../shared/moa';
import { goalHardRuleHit } from '../../shared/moaGoal';

/** Methods that change something outside Moa's own records. Refused at level 0. */
export const MOA_L0_REFUSED_METHODS: ReadonlySet<string> = new Set<string>([
  'surface.new',
  'pane.split',
  'pane.focus',
  'pane.stash',
  'pane.unstash',
  'pane.setMetadata',
  'meta.setSkills',
  'input.send',
  'input.sendKey',
  'deck.proposeHandoff',
  'deck.proposeGoal',
  'a2a.task.send',
  'a2a.task.update',
  'a2a.task.cancel',
  'a2a.broadcast',
  'a2a.channel.create',
  'a2a.channel.join',
  'a2a.channel.leave',
  'a2a.channel.post',
  'a2a.channel.invite',
  'task.mission.start',
  'task.mission.close',
  'task.fanout.start',
  'ledger.update',
  'task.gate.run',
  'task.gate.cancel',
  'task.adopt',
  'task.close',
  'task.pr',
  'approval.press',
]);

/** Methods whose text reaches a worker, screened while a contract is active. */
const SCREENED_TEXT_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'input.send': ['text'],
  'a2a.task.send': ['message', 'title'],
  'a2a.broadcast': ['message'],
};

export interface MoaLevelGateDeps {
  hqWorkspaceId: () => string | null;
  level: () => MoaLevel;
  /** The active contract's id and human-only list when it currently grants
   *  powers; null otherwise. */
  activeGoal: () => { goalId: string; humanOnly: readonly string[] } | null;
}

/** The refusal for `method` from the commander bound to `workspaceId`, or null. Pure. */
export function moaLevelRefusal(
  deps: MoaLevelGateDeps,
  method: string,
  workspaceId: string,
  params: Record<string, unknown> | undefined,
): string | null {
  const hq = deps.hqWorkspaceId();
  if (!hq || workspaceId !== hq) return null;
  const level = deps.level();
  if (level === 0 && MOA_L0_REFUSED_METHODS.has(method)) {
    return `method ${method} is refused: Moa is at level 0 (observe only) in Settings › Moa. Read, report, or ask the operator with deck_ask_decision.`;
  }
  const fields = SCREENED_TEXT_PARAMS[method];
  if (!fields || level < 2) return null;
  const goal = deps.activeGoal();
  if (!goal) return null;
  for (const f of fields) {
    const v = params?.[f];
    if (typeof v !== 'string') continue;
    const hit = goalHardRuleHit(v, goal.humanOnly);
    if (hit) {
      return `method ${method} is refused under goal ${goal.goalId}: the text asks for something that stays the operator's (${hit.rule}: "${hit.match}"). Leave that step out and raise it with deck_ask_decision.`;
    }
  }
  return null;
}

type Gate = (method: string, workspaceId: string, params: Record<string, unknown> | undefined) => string | null;

let installed: Gate | null = null;

/** deck.handler installs the production gate; null uninstalls it. */
export function setMoaLevelGate(deps: MoaLevelGateDeps | null): void {
  installed = deps ? (m, w, p) => moaLevelRefusal(deps, m, w, p) : null;
}

/** RpcRouter's call. Never throws: a gate that fails refuses (fail closed). */
export function commanderLevelRefusal(method: string, workspaceId: string, params: Record<string, unknown> | undefined): string | null {
  if (!installed) return null;
  try {
    return installed(method, workspaceId, params);
  } catch (err) {
    return `method ${method} is refused: Moa's level could not be read (${String(err)})`;
  }
}
