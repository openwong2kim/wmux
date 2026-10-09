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
//            against the contract's hard rules (shared/moaGoal.ts), and what
//            it types, keys or messages DIRECTLY may only reach a workspace
//            inside the contract (moaScopeRefusal below). Anything else goes
//            through moa_propose_handoff, which asks the operator with a card.
//            Without an active contract both checks are off: today's lane.
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
  activeGoal: () => { goalId: string; humanOnly: readonly string[]; scope?: readonly string[] } | null;
  /** Which workspace owns a pane (the same mirror/renderer lookup the input
   *  handlers' ownership check uses). Absent or failing: unknown. */
  ptyOwner?: (ptyId: string) => Promise<string | null>;
  /** The workspace on the other side of an A2A task the HQ is party to, or
   *  null when it cannot be read. */
  taskCounterparty?: (hqWorkspaceId: string, taskId: string) => Promise<string | null>;
  /** Which workspace holds a pane (by paneId). Absent or failing: unknown. */
  paneOwner?: (paneId: string) => Promise<string | null>;
  /** The member workspaces of a channel, read as the HQ; null when unreadable. */
  channelMembers?: (hqWorkspaceId: string, channelId: string) => Promise<string[] | null>;
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
let installedDeps: MoaLevelGateDeps | null = null;

/** deck.handler installs the production gate; null uninstalls it. */
export function setMoaLevelGate(deps: MoaLevelGateDeps | null): void {
  installed = deps ? (m, w, p) => moaLevelRefusal(deps, m, w, p) : null;
  installedDeps = deps;
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

// ─── Contract scope for Moa's DIRECT sends (owner decision 2) ───────────────
//
// While a goal contract is active, what Moa types into a pane (input.send),
// the keys it presses (input.sendKey), and the messages and follow-ups it sends
// over A2A (a2a.task.send, a2a.task.update with a message, a2a.broadcast) may
// only reach the HQ itself, the workspaces the contract names, and the tasks
// it fanned out. A target outside that set is REFUSED rather than turned into
// a card: the card for "give this to another workspace" already exists
// (moa_propose_handoff, which asks the operator for any workspace the goal
// does not cover), and a raw keystroke or a reply parked behind a card would
// land late on a pane that has moved on. A target that cannot be resolved is
// refused too (fail closed). Without an active goal nothing here applies.
//
// The same check covers (owner decision 3) a channel post whose channel has a
// member — or whose mention names a workspace — outside the contract,
// pane.focus on a pane outside it, and creating panes (pane.split,
// surface.new) in a workspace outside it.

const SCOPED_METHODS: ReadonlySet<string> = new Set([
  'input.send',
  'input.sendKey',
  'a2a.task.send',
  'a2a.task.update',
  'a2a.broadcast',
  'a2a.channel.post',
  'pane.focus',
  'pane.split',
  'surface.new',
]);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The workspaces Moa may reach directly under the active goal, or null when
 *  no goal is active for this HQ (today's lane). Pure over `deps`. */
export function moaGoalScopeOf(deps: MoaLevelGateDeps, workspaceId: string): { goalId: string; scope: string[] } | null {
  const hq = deps.hqWorkspaceId();
  if (!hq || workspaceId !== hq || deps.level() < 2) return null;
  const goal = deps.activeGoal();
  if (!goal) return null;
  return { goalId: goal.goalId, scope: [...new Set([hq, ...(goal.scope ?? [])])] };
}

/** The refusal for a direct send outside the contract, or null. */
export async function moaScopeRefusal(
  deps: MoaLevelGateDeps,
  method: string,
  workspaceId: string,
  params: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!SCOPED_METHODS.has(method)) return null;
  const g = moaGoalScopeOf(deps, workspaceId);
  if (!g) return null;
  const p = params ?? {};
  const outside = (target: string): string =>
    `method ${method} is refused under goal ${g.goalId}: workspace ${target} is outside the goal's contract. `
    + 'While a goal is active Moa types, presses keys and sends messages only to the goal\'s own workspaces and tasks. '
    + 'To give work to another workspace use moa_propose_handoff (the operator gets a card), or ask with deck_ask_decision.';
  const unknown = (what: string): string =>
    `method ${method} is refused under goal ${g.goalId}: ${what}, so wmux cannot tell whether it is inside the goal's contract. Name a pane of the goal's own workspaces.`;
  let target: string | null = null;
  switch (method) {
    case 'a2a.broadcast':
      return `method a2a.broadcast is refused under goal ${g.goalId}: a broadcast reaches workspaces outside the goal's contract. Message the goal's own tasks with send_message instead.`;
    case 'input.send':
    case 'input.sendKey': {
      const pty = str(p.ptyId);
      if (pty) {
        try {
          target = deps.ptyOwner ? await deps.ptyOwner(pty) : null;
        } catch {
          target = null;
        }
        if (!target) return unknown(`the owner of pane ${pty} could not be resolved`);
      } else {
        target = str(p.workspaceId);
        if (!target) return unknown('no pane or workspace was named');
      }
      break;
    }
    case 'a2a.task.send':
    case 'a2a.task.update': {
      const taskId = str(p.taskId);
      if (method === 'a2a.task.update' && !str(p.message)) return null; // a status move sends nothing
      if (!taskId) {
        // A new task: `to` may be a name or number the renderer resolves; the
        // a2a handler narrows the renderer's allowed targets to the contract
        // (moaGoalSendScope). A literal workspace id is checked here as well.
        const to = str(p.to);
        if (to && to.startsWith('ws-') && !g.scope.includes(to)) return outside(to);
        return null;
      }
      try {
        target = deps.taskCounterparty ? await deps.taskCounterparty(g.scope[0], taskId) : null;
      } catch {
        target = null;
      }
      if (!target) return unknown(`the other side of task ${taskId} could not be read`);
      break;
    }
    case 'a2a.channel.post': {
      const channelId = str(p.channelId);
      if (!channelId) return unknown('no channel was named');
      const mentioned = Array.isArray(p.mentions)
        ? p.mentions.map((m) => (m && typeof m === 'object' ? str((m as Record<string, unknown>).workspaceId) : null))
        : [];
      for (const w of mentioned) if (w && !g.scope.includes(w)) return outside(w);
      let members: string[] | null = null;
      try {
        members = deps.channelMembers ? await deps.channelMembers(g.scope[0], channelId) : null;
      } catch {
        members = null;
      }
      if (!members || members.length === 0) return unknown(`the members of channel ${channelId} could not be read`);
      const out = members.find((w) => !g.scope.includes(w));
      return out ? outside(out) : null;
    }
    case 'pane.focus': {
      const pane = str(p.id);
      if (!pane) return unknown('no pane was named');
      try {
        target = deps.paneOwner ? await deps.paneOwner(pane) : null;
      } catch {
        target = null;
      }
      if (!target) return unknown(`the workspace of pane ${pane} could not be resolved`);
      break;
    }
    case 'pane.split':
    case 'surface.new':
      // Omitted, the handler pins it to the commander's own workspace.
      target = str(p.workspaceId) ?? g.scope[0];
      break;
    default:
      return null;
  }
  return g.scope.includes(target) ? null : outside(target);
}


/** RpcRouter's async call for the contract scope. Never throws: fails closed. */
export async function commanderScopeRefusal(
  method: string,
  workspaceId: string,
  params: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!installedDeps || !SCOPED_METHODS.has(method)) return null;
  try {
    return await moaScopeRefusal(installedDeps, method, workspaceId, params);
  } catch (err) {
    return `method ${method} is refused: the goal's scope could not be read (${String(err)})`;
  }
}

/** For the a2a handler: the targets a NEW task from the HQ may reach while a
 *  goal is active (the HQ and the contract's workspaces), or null (no goal). */
export function moaGoalSendScope(workspaceId: string): string[] | null {
  if (!installedDeps) return null;
  try {
    return moaGoalScopeOf(installedDeps, workspaceId)?.scope ?? null;
  } catch {
    return [workspaceId];
  }
}
