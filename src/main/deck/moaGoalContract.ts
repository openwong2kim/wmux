// ─── Moa's goal contract — one operator approval per goal ───────────────────
//
// Moa (the HQ brain) proposes a goal with `moa_propose_goal` (deck.proposeGoal).
// Main validates it, vets the repository, stores it here as `pending` and
// raises ONE main-owned card (origin 'moa-goal') in the HQ's decision slot:
// "Approve goal" / "Decline". The card is never shown to a brain and no brain
// can resolve it (deckDecisionStore.MAIN_OWNED_ORIGINS); the operator's click
// reaches resolveCard through DECK_DECISION_RESOLVE.
//
// An approved contract is `active`. What it grants, and the rules it never
// relaxes, are in shared/moaGoal.ts. Its powers are read through powers() at
// the moment of use, from this store and the HQ store, never from the brain:
// turning Moa's level below 2 in Settings, a budget running out or the clock
// passing `approvedAt + maxHours` makes it inert at once, without a write.
// The lazy sweep (current()) then records why it ended.
//
// One contract at a time per HQ: a second proposal while one is pending or
// active is refused (`goal_open`), so "which goal is this task under" never
// has two answers.
//
// One JSON file (`moa-goals.json`) in the wmux data dir, atomic-written. A
// file that cannot be read starts empty (no contract = today's behaviour,
// which is the safe direction: nothing is granted).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { createSerialChain } from './serialChain';
import type { DecisionOrigin, WorkspaceDecision } from './deckDecisionStore';
import { DECISION_LIMITS } from './deckDecisionStore';
import type { MoaLevel } from '../../shared/moa';
import {
  MOA_GOAL_OPTIONS,
  buildMoaGoalCard,
  isMoaGoalId,
  moaGoalPowers,
  parseMoaGoalProposal,
  type MoaGoalContract,
  type MoaGoalInertReason,
  type MoaGoalStatus,
  type MoaGoalView,
} from '../../shared/moaGoal';
import type { FanoutWorkerPermissionMode } from '../../shared/workerLaunch';

const MAX_RECORDS = 50;

export interface MoaGoalPorts {
  hqWorkspaceId: () => string | null;
  hqLevel: () => MoaLevel;
  /** Moa on, the HQ designated and present. */
  moaReady: () => boolean;
  /** The repository's vetted root (realpath'd git toplevel, not $HOME), or null. */
  vetRepo: (p: string) => Promise<string | null>;
  workspaceExists: (id: string) => boolean;
  workspaceName: (id: string) => string | undefined;
  decisions: {
    raiseIfFree: (
      workspaceId: string,
      card: { question: string; options: string[]; context: string; origin: DecisionOrigin; ref: string },
    ) => Promise<WorkspaceDecision | null>;
    load: (workspaceId: string) => WorkspaceDecision | null;
    resolve: (workspaceId: string, id: string, resolution: string) => Promise<WorkspaceDecision | null>;
    clearResolved: (workspaceId: string, id: string) => Promise<void>;
    clearPendingIfUnchanged: (workspaceId: string, expected: WorkspaceDecision) => Promise<boolean>;
  };
  /** The fan-out worker permission mode in Settings right now. Shown on the
   *  card, pinned at approval (shared/moaGoal.ts workerPermissionMode). */
  workerPermissionMode?: () => FanoutWorkerPermissionMode;
  /** The HQ's current turn was woken by another PC's Moa (a2a.received). */
  turnWokenByRemoteMoa?: (hqWorkspaceId: string) => boolean;
  /** Something the panel shows moved. */
  notify?: () => void;
  now?: () => number;
  filePath?: string;
  /** Tests: the store's write (default atomicWriteJSON). */
  writeJSON?: (p: string, data: unknown) => Promise<void>;
}

interface GoalFile {
  version: 1;
  items: Record<string, MoaGoalContract>;
}

export type ProposeGoalResult =
  | { ok: true; id: string; status: 'pending' }
  | {
      ok: false;
      error:
        | 'moa_off' | 'not_hq' | 'level_too_low' | 'goal_open' | 'busy' | 'repo_not_git' | 'workspace_unknown'
        | 'card_too_long' | 'error' | string;
      id?: string;
      message?: string;
    };

export type ResolveGoalResult =
  | { ok: true; id: string; status: 'active' | 'declined'; note?: string }
  | { ok: false; code: 'not_pending' | 'error' };

export function getMoaGoalsPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'moa-goals.json');
}

/** The end log beside the store (see MoaGoalService.end). */
function endLogPath(p: string): string {
  return `${p}.ended`;
}

type EndRecord = Pick<MoaGoalContract, 'id' | 'createdAt' | 'status' | 'endedAt' | 'endNote'>;

/** Apply the end log: an end recorded there wins over an open record in the
 *  store, whose own save may never have landed. A log that exists but cannot
 *  be read ends every open contract (fail closed). A log with nothing left to
 *  apply is removed, which is what keeps it short. */
function applyEndLog(p: string, file: GoalFile): GoalFile {
  let raw: string;
  try {
    raw = fs.readFileSync(endLogPath(p), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return file;
    for (const c of Object.values(file.items)) {
      if (OPEN.includes(c.status)) {
        file.items[c.id] = { ...c, status: 'canceled', endedAt: Date.now(), endNote: 'the goal end log could not be read', decisionId: undefined };
      }
    }
    return file;
  }
  let applied = 0;
  for (const line of raw.split('\n')) {
    let e: EndRecord;
    try {
      e = JSON.parse(line) as EndRecord;
    } catch {
      continue; // a torn last line: an end that was never confirmed to anyone
    }
    const c = e && typeof e === 'object' ? file.items[e.id] : undefined;
    // Matched on the creation time too, so a reused id never ends a new goal.
    if (!c || c.createdAt !== e.createdAt || !OPEN.includes(c.status)) continue;
    if (e.status !== 'completed' && e.status !== 'canceled') continue;
    file.items[c.id] = { ...c, status: e.status, endedAt: e.endedAt, endNote: e.endNote, decisionId: undefined };
    applied++;
  }
  if (applied === 0) {
    try {
      fs.rmSync(endLogPath(p), { force: true });
    } catch {
      /* kept: it only ever ends goals */
    }
  }
  return file;
}

function readFile(p: string): GoalFile {
  return applyEndLog(p, readStore(p));
}

function readStore(p: string): GoalFile {
  try {
    const data = atomicReadJSONSync<unknown>(p);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const items = (data as { items?: unknown }).items;
      if (items && typeof items === 'object' && !Array.isArray(items)) {
        const out: Record<string, MoaGoalContract> = {};
        for (const [k, v] of Object.entries(items as Record<string, unknown>)) {
          if (isMoaGoalId(k) && v && typeof v === 'object' && (v as MoaGoalContract).id === k) out[k] = v as MoaGoalContract;
        }
        return { version: 1, items: out };
      }
    }
  } catch {
    /* unreadable: start empty (grants nothing) */
  }
  return { version: 1, items: {} };
}

function newGoalId(): string {
  return `G-${randomBytes(3).toString('hex')}`;
}

const OPEN: readonly MoaGoalStatus[] = ['pending', 'active'];

/** The status an inert reason ends an active contract with. */
function endStatusFor(reason: MoaGoalInertReason): MoaGoalStatus | null {
  if (reason === 'expired') return 'expired';
  if (reason === 'turns' || reason === 'tasks') return 'exhausted';
  return null;
}

export class MoaGoalService {
  private loaded: GoalFile | null = null;
  private readonly serialize = createSerialChain();
  /** propose, the operator's answer and end run one at a time: an answer that
   *  awaits the card store cannot bring back a goal that was ended meanwhile. */
  private readonly lifecycle = createSerialChain();
  /** The automatic HQ turn noteTurn counted against a goal, until it ends. In
   *  memory only: after a restart no turn is running. */
  private openTurn: { hq: string; goalId: string } | null = null;

  constructor(private readonly ports: MoaGoalPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  private get file(): GoalFile {
    if (!this.loaded) this.loaded = readFile(this.ports.filePath ?? getMoaGoalsPath());
    return this.loaded;
  }

  private put(c: MoaGoalContract): void {
    this.file.items[c.id] = c;
    const all = Object.values(this.file.items);
    if (all.length <= MAX_RECORDS) return;
    const old = all.filter((x) => !OPEN.includes(x.status)).sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt));
    for (const x of old.slice(0, all.length - MAX_RECORDS)) delete this.file.items[x.id];
  }

  save(): Promise<boolean> {
    return this.serialize(async () => {
      try {
        await (this.ports.writeJSON ?? atomicWriteJSON)(this.ports.filePath ?? getMoaGoalsPath(), this.file);
        return true;
      } catch (err) {
        console.warn(`[moa:goal] could not save: ${String(err)}`);
        return false;
      }
    });
  }

  private notify(): void {
    try {
      this.ports.notify?.();
    } catch {
      /* best-effort */
    }
  }

  get(id: string): MoaGoalContract | null {
    return this.file.items[id] ?? null;
  }

  byDecision(decisionId: string): MoaGoalContract | null {
    return Object.values(this.file.items).find((c) => c.decisionId === decisionId) ?? null;
  }

  private powersOf(c: MoaGoalContract | null): ReturnType<typeof moaGoalPowers> {
    return moaGoalPowers(c, { workspaceId: this.ports.hqWorkspaceId(), level: this.ports.hqLevel() }, this.now(), {
      turnOpen: c !== null && this.openTurn?.goalId === c.id,
    });
  }

  /** A pending contract whose approval card is gone (wmux stopped between
   *  clearing the card and recording the answer, on a build that did it in
   *  that order) can never be approved: decline it so a new proposal is not
   *  refused as `goal_open` forever. An unreadable card store changes nothing. */
  private orphaned(c: MoaGoalContract): boolean {
    if (c.status !== 'pending') return false;
    let d: WorkspaceDecision | null;
    try {
      d = this.ports.decisions.load(c.hqWorkspaceId);
    } catch {
      return false;
    }
    if (c.decisionId && d && d.id === c.decisionId) return false;
    this.put({ ...c, status: 'declined', endedAt: this.now(), endNote: 'its approval card is gone; propose it again', decisionId: undefined });
    void this.save();
    this.notify();
    return true;
  }

  /** The current HQ's open contract (pending or active), with an active one
   *  that has run out ended on the way (in memory now, on disk soon). */
  current(): MoaGoalContract | null {
    const hq = this.ports.hqWorkspaceId();
    if (!hq) return null;
    const open = Object.values(this.file.items)
      .filter((c) => c.hqWorkspaceId === hq && OPEN.includes(c.status))
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    if (open && this.orphaned(open)) return null;
    if (!open || open.status !== 'active') return open;
    const p = this.powersOf(open);
    if (!p.ok) {
      const end = endStatusFor(p.reason);
      if (end) {
        const ended: MoaGoalContract = { ...open, status: end, endedAt: this.now(), endNote: p.reason === 'expired' ? 'time budget used' : `${p.reason} budget used` };
        this.put(ended);
        void this.save();
        this.notify();
        return null;
      }
    }
    return open;
  }

  /** The active contract and its effective level, or why there is none.
   *  Read at the moment of every use; never cached by a caller. */
  powers(): { ok: true; level: 2 | 3; contract: MoaGoalContract } | { ok: false; reason: MoaGoalInertReason; contract: MoaGoalContract | null } {
    const c = this.current();
    const p = this.powersOf(c);
    return p.ok && c ? { ok: true, level: p.level, contract: c } : { ok: false, reason: p.ok ? 'none' : p.reason, contract: c };
  }

  view(): MoaGoalView | null {
    const c = this.current();
    if (!c) return null;
    const effective = this.powersOf(c);
    return {
      id: c.id,
      status: c.status,
      goal: c.goal,
      repoRoot: c.repoRoot,
      workspaceIds: [...c.workspaceIds],
      level: c.level,
      effective,
      budget: { ...c.budget },
      tasksUsed: c.tasksUsed,
      turnsUsed: c.turnsUsed,
      ...(c.approvedAt !== undefined ? { expiresAt: c.approvedAt + c.budget.maxHours * 3_600_000 } : {}),
      taskWorkspaceIds: [...c.taskWorkspaceIds],
      humanOnly: [...c.humanOnly],
    };
  }

  /** The most recent contract of the current HQ, open or ended (the panel). */
  latest(): MoaGoalContract | null {
    const hq = this.ports.hqWorkspaceId();
    return Object.values(this.file.items)
      .filter((c) => c.hqWorkspaceId === hq)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }

  // ── propose ───────────────────────────────────────────────────────────────

  propose(callerWorkspaceId: string, params: Record<string, unknown>): Promise<ProposeGoalResult> {
    return this.lifecycle(() => this.proposeNow(callerWorkspaceId, params));
  }

  private async proposeNow(callerWorkspaceId: string, params: Record<string, unknown>): Promise<ProposeGoalResult> {
    if (!this.ports.moaReady()) return { ok: false, error: 'moa_off' };
    const hq = this.ports.hqWorkspaceId();
    if (!hq || callerWorkspaceId !== hq) return { ok: false, error: 'not_hq' };
    if (this.ports.hqLevel() < 2) {
      return {
        ok: false,
        error: 'level_too_low',
        message: 'Moa is below level 2, so a goal contract would grant nothing. Ask the operator to raise the level in Settings › Moa, or work as before.',
      };
    }
    const open = this.current();
    if (open) return { ok: false, error: 'goal_open', id: open.id, message: `goal ${open.id} is ${open.status}; finish it (moa_goal complete) before proposing another` };
    const parsed = parseMoaGoalProposal(params);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    let repoRoot: string | null = null;
    if (parsed.repo) {
      repoRoot = await this.ports.vetRepo(parsed.repo).catch(() => null);
      if (!repoRoot) return { ok: false, error: 'repo_not_git', message: `${parsed.repo} is not a git repository wmux can vouch for (it must be inside a repository, not your home folder)` };
    }
    for (const w of parsed.workspaceIds) {
      if (w === hq || !this.ports.workspaceExists(w)) return { ok: false, error: 'workspace_unknown', message: `workspace ${w} is not a workspace Moa can give work to` };
    }
    const now = this.now();
    const workerMode = this.workerMode();
    const contract: MoaGoalContract = {
      id: newGoalId(),
      hqWorkspaceId: hq,
      goal: parsed.goal,
      repoRoot,
      workspaceIds: parsed.workspaceIds,
      level: parsed.level,
      budget: parsed.budget,
      humanOnly: parsed.humanOnly,
      status: 'pending',
      createdAt: now,
      taskWorkspaceIds: [],
      tasksUsed: 0,
      turnsUsed: 0,
      ...(workerMode ? { workerPermissionMode: workerMode } : {}),
    };
    const card = buildMoaGoalCard(contract, (id) => this.ports.workspaceName(id));
    // The operator approves what the card shows: a contract that does not fit
    // on one card is refused instead of cut.
    if (card.context.length > DECISION_LIMITS.MAX_CONTEXT_CHARS) {
      return { ok: false, error: 'card_too_long', message: `the contract does not fit on one card (${card.context.length}/${DECISION_LIMITS.MAX_CONTEXT_CHARS} characters); shorten the goal or the human-only list` };
    }
    const decision = await this.ports.decisions
      .raiseIfFree(hq, { ...card, origin: 'moa-goal', ref: contract.id })
      .catch(() => null);
    if (!decision) return { ok: false, error: 'busy', message: 'a card is already waiting in Moa\'s slot; let the operator answer it first' };
    this.put({ ...contract, decisionId: decision.id });
    if (!(await this.save())) {
      await this.ports.decisions.clearPendingIfUnchanged(hq, decision).catch(() => false);
      delete this.file.items[contract.id];
      return { ok: false, error: 'error', message: 'the goal could not be saved' };
    }
    this.notify();
    return { ok: true, id: contract.id, status: 'pending' };
  }

  // ── the operator's answer ─────────────────────────────────────────────────

  /** The operator answered the card. By card id only; null when the decision
   *  is not a goal card. Only an exact "Approve goal" approves. */
  resolveCard(workspaceId: string, decisionId: string, answer: string): Promise<ResolveGoalResult | null> {
    return this.lifecycle(() => this.resolveCardNow(workspaceId, decisionId, answer));
  }

  private async resolveCardNow(workspaceId: string, decisionId: string, answer: string): Promise<ResolveGoalResult | null> {
    const d = this.ports.decisions.load(workspaceId);
    const card = d && d.id === decisionId && d.origin === 'moa-goal' ? d : null;
    const c = this.byDecision(decisionId) ?? (card?.ref ? this.get(card.ref) : null);
    if (!c || c.hqWorkspaceId !== workspaceId) return null;
    if (c.status !== 'pending' || c.decisionId !== decisionId) {
      // The goal ended but its card is still up (the end could not clear it):
      // take the card down rather than leave a button that does nothing.
      if (card && card.status === 'pending') {
        await this.ports.decisions.clearPendingIfUnchanged(workspaceId, card).catch(() => false);
      }
      return { ok: false, code: 'not_pending' };
    }
    if (!d || d.id !== decisionId || d.status !== 'pending') return { ok: false, code: 'not_pending' };
    const approve = answer.trim() === MOA_GOAL_OPTIONS.approve;
    const label = approve ? MOA_GOAL_OPTIONS.approve : MOA_GOAL_OPTIONS.decline;
    const claimed = await this.ports.decisions.resolve(workspaceId, decisionId, label).catch(() => null);
    if (!claimed) return { ok: false, code: 'not_pending' };
    // The answer is recorded BEFORE the card is cleared: stopped in between,
    // the resolved card is settled on the next start (settleResolved), and a
    // contract is never left pending with no card to answer.
    const r = await this.apply(c.id, approve);
    if (r.ok || r.code === 'not_pending') await this.ports.decisions.clearResolved(workspaceId, decisionId).catch(() => undefined);
    return r;
  }

  /** A goal card the operator answered but whose effect was not recorded (the
   *  app stopped in between): settle it from the stored answer. */
  settleResolved(workspaceId: string, decision: WorkspaceDecision): Promise<ResolveGoalResult | null> {
    return this.lifecycle(async () => {
      if (decision.origin !== 'moa-goal' || decision.status !== 'resolved') return null;
      const c = this.byDecision(decision.id);
      if (!c || c.status !== 'pending' || c.hqWorkspaceId !== workspaceId) {
        await this.ports.decisions.clearResolved(workspaceId, decision.id).catch(() => undefined);
        return null;
      }
      const r = await this.apply(c.id, decision.resolvedBy !== 'brain' && decision.resolution === MOA_GOAL_OPTIONS.approve);
      if (r.ok || r.code === 'not_pending') await this.ports.decisions.clearResolved(workspaceId, decision.id).catch(() => undefined);
      return r;
    });
  }

  /** Record the answer on the contract as it is NOW (never a copy taken before
   *  an await): only a contract that is still pending can become active. */
  private async apply(id: string, approve: boolean): Promise<ResolveGoalResult> {
    const c = this.get(id);
    if (!c || c.status !== 'pending') return { ok: false, code: 'not_pending' };
    const now = this.now();
    // The card showed the worker permission mode; an approval is for that
    // mode only. Changed (or unreadable) since the card went up: nothing is
    // granted, and Moa is told to propose again.
    const modeNow = this.workerMode();
    const modeMoved = approve && (!c.workerPermissionMode || modeNow !== c.workerPermissionMode);
    const note = modeMoved
      ? `not approved: the fan-out worker permission mode is ${modeNow ?? 'unreadable'} now, but the card showed ${c.workerPermissionMode ?? 'none'}`
      : undefined;
    const granted = approve && !modeMoved;
    const next: MoaGoalContract = granted
      ? { ...c, status: 'active', approvedAt: now, decisionId: undefined }
      : { ...c, status: 'declined', endedAt: now, endNote: note ?? 'declined by the operator', decisionId: undefined };
    this.put(next);
    if (!(await this.save())) {
      // Not on disk: keep memory as the file has it, so the resolved card is
      // settled again on the next start instead of granting until a restart.
      this.put(c);
      return { ok: false, code: 'error' };
    }
    this.notify();
    return { ok: true, id: c.id, status: granted ? 'active' : 'declined', ...(note ? { note } : {}) };
  }

  private workerMode(): FanoutWorkerPermissionMode | undefined {
    try {
      return this.ports.workerPermissionMode?.();
    } catch {
      return undefined;
    }
  }

  /** The HQ's current turn was woken by another PC's Moa. Unreadable = yes
   *  (the caller refuses; fail closed). */
  turnWokenByRemoteMoa(hqWorkspaceId: string): boolean {
    try {
      return this.ports.turnWokenByRemoteMoa?.(hqWorkspaceId) === true;
    } catch {
      return true;
    }
  }

  // ── use ───────────────────────────────────────────────────────────────────

  /** Reserve `n` fan-out tasks against the active contract's budget. */
  reserveTasks(n: number): { ok: true; contract: MoaGoalContract } | { ok: false; reason: string } {
    const p = this.powers();
    if (!p.ok) return { ok: false, reason: p.reason };
    const c = p.contract;
    if (c.tasksUsed + n > c.budget.maxTasks) {
      return { ok: false, reason: `goal ${c.id} allows ${c.budget.maxTasks} task(s) and has used ${c.tasksUsed}` };
    }
    const next = { ...c, tasksUsed: c.tasksUsed + n };
    this.put(next);
    void this.save();
    return { ok: true, contract: next };
  }

  /** Give back a reservation whose fan-out did not run. */
  releaseTasks(goalId: string, n: number): void {
    const c = this.get(goalId);
    if (!c) return;
    this.put({ ...c, tasksUsed: Math.max(0, c.tasksUsed - n) });
    void this.save();
  }

  /** Fan-out task workspaces created under `goalId`. */
  attachTaskWorkspaces(goalId: string, workspaceIds: readonly string[]): void {
    const c = this.get(goalId);
    if (!c || workspaceIds.length === 0) return;
    const set = new Set([...c.taskWorkspaceIds, ...workspaceIds.filter((w) => typeof w === 'string' && w.length > 0)]);
    this.put({ ...c, taskWorkspaceIds: [...set] });
    void this.save();
    this.notify();
  }

  /** One automatic HQ turn starts: count it against the active contract. The
   *  contract keeps its powers until that turn ends (finishTurn), so the last
   *  turn of the budget runs under the goal it was counted against. */
  noteTurn(workspaceId: string): void {
    if (workspaceId !== this.ports.hqWorkspaceId()) return;
    const p = this.powers();
    if (!p.ok) return;
    this.put({ ...p.contract, turnsUsed: p.contract.turnsUsed + 1 });
    this.openTurn = { hq: workspaceId, goalId: p.contract.id };
    void this.save();
  }

  /** The automatic turn noteTurn counted has ended (whatever its outcome). */
  finishTurn(workspaceId: string): void {
    if (this.openTurn?.hq !== workspaceId) return;
    this.openTurn = null;
    // Ends it (lazily) when that was the last turn of the budget.
    this.current();
  }

  /** Why the HQ's running turn may not fan out without its goal, or null.
   *  A turn that started under a goal works under that goal until it ends:
   *  when the goal was ended (cancelled, completed, out of budget or time) or
   *  went inert while the turn runs, its fan-out is refused, never run as an
   *  ordinary fan-out over the HQ's own pane. Only automatic turns are
   *  tracked; an operator's own turn has the operator present. */
  turnGoalRefusal(workspaceId: string): { goalId: string; reason: string } | null {
    const t = this.openTurn;
    if (!t || t.hq !== workspaceId) return null;
    const c = this.get(t.goalId);
    if (!c) return { goalId: t.goalId, reason: 'gone' };
    if (c.status !== 'active') return { goalId: c.id, reason: c.status };
    const p = this.powersOf(c);
    return p.ok ? null : { goalId: c.id, reason: p.reason };
  }

  /** The active contract covers `workspaceId` (a workspace it names or one of
   *  its fan-out tasks), with its effective powers. Null otherwise. */
  covers(workspaceId: string): { goalId: string; humanOnly: string[]; level: 2 | 3; task: boolean } | null {
    const p = this.powers();
    if (!p.ok) return null;
    const task = p.contract.taskWorkspaceIds.includes(workspaceId);
    if (!task && !p.contract.workspaceIds.includes(workspaceId)) return null;
    return { goalId: p.contract.id, humanOnly: [...p.contract.humanOnly], level: p.level, task };
  }

  private logEnd(c: MoaGoalContract): boolean {
    const rec: EndRecord = { id: c.id, createdAt: c.createdAt, status: c.status, endedAt: c.endedAt, endNote: c.endNote };
    try {
      fs.appendFileSync(endLogPath(this.ports.filePath ?? getMoaGoalsPath()), `${JSON.stringify(rec)}\n`);
      return true;
    } catch (err) {
      console.warn(`[moa:goal] could not log the end of ${c.id}: ${String(err)}`);
      return false;
    }
  }

  /** End the open contract. Moa may end its own (`completed`, `canceled`);
   *  the operator may cancel it from Settings. Ending only ever takes powers
   *  away. A pending card is withdrawn, after the end is recorded.
   *
   *  The end is first appended to a small end log beside the store, then the
   *  store is saved. A store save that fails (atomicWriteJSON has already
   *  retried the transient Windows rename by then) would otherwise leave the
   *  goal open on disk, and a restart would bring it back; the log is read on
   *  load and wins. It is an append, not a tmp-and-rename of the whole store,
   *  so it does not share the store write's failure. Retrying the save
   *  instead would not survive the restart that matters. Only when both
   *  writes fail is the end in memory alone, and the caller is told. */
  end(by: 'moa' | 'operator', status: 'completed' | 'canceled', note: string): Promise<{ ok: boolean; id?: string; code?: string }> {
    return this.lifecycle(async () => {
      const c = this.current();
      if (!c) return { ok: false, code: 'no_goal' };
      const card = c.status === 'pending' ? c.decisionId : undefined;
      const trimmed = note.replace(/\s+/g, ' ').trim().slice(0, 300);
      const ended: MoaGoalContract = { ...c, status, endedAt: this.now(), endNote: `${by === 'operator' ? 'operator' : 'Moa'}: ${trimmed || status}`, decisionId: undefined };
      const logged = this.logEnd(ended);
      this.put(ended);
      const ok = (await this.save()) || logged;
      this.notify();
      if (card) {
        const d = this.ports.decisions.load(c.hqWorkspaceId);
        if (d && d.id === card && d.status === 'pending') {
          await this.ports.decisions.clearPendingIfUnchanged(c.hqWorkspaceId, d).catch(() => false);
        }
      }
      return ok ? { ok: true, id: c.id } : { ok: false, code: 'error' };
    });
  }
}

let service: MoaGoalService | null = null;

export function getMoaGoalService(): MoaGoalService | null {
  return service;
}

export function setMoaGoalService(s: MoaGoalService | null): void {
  service = s;
}

/** The `[goal]` block on the HQ's turns: what the open contract is and what it
 *  lets Moa do right now. Null when there is no open contract. */
export function renderGoalBlock(view: MoaGoalView | null): string | null {
  if (!view) return null;
  if (view.status === 'pending') {
    return `[goal] ${view.id} is waiting for the operator's approval card. Until they approve it, work as before; do not propose another goal.`;
  }
  const e = view.effective;
  const left = `budget: ${view.tasksUsed}/${view.budget.maxTasks} tasks, ${view.turnsUsed}/${view.budget.maxTurns} automatic turns${view.expiresAt ? `, ends ${new Date(view.expiresAt).toISOString()}` : ''}`;
  if (!e.ok) {
    return `[goal] ${view.id} is approved but grants nothing right now (${e.reason === 'level' ? 'Moa is below level 2' : e.reason}). Work as before; ${left}.`;
  }
  const scope = [
    view.repoRoot ? `repository ${view.repoRoot}` : null,
    view.workspaceIds.length ? `workspaces ${view.workspaceIds.join(', ')}` : null,
  ].filter(Boolean).join(' and ');
  return [
    `[goal] ${view.id} — approved by the operator (level ${e.level}). Goal (operator-approved text): "${view.goal}". Scope: ${scope}.`,
    'Inside it you may, without asking: fanout_start (it runs in the goal\'s repository, on claude workers only, with push, PR, release and delete commands denied and GitHub credentials withheld), answer and instruct the tasks it creates (send_message / terminal_send), and hand work to the goal\'s workspaces with moa_propose_handoff (without a card only while the operator\'s own request is live; from a wake it asks with a card). A turn woken by another PC\'s Moa cannot fan out under the goal.',
    `Never yours, whatever the goal says: push, PRs, merges, releases, secrets, deleting data, critical or permission approvals, other workspaces${view.humanOnly.length ? `, and: ${view.humanOnly.join('; ')}` : ''}. Raise those with deck_ask_decision; wmux refuses them in what you send.`,
    `${left}. When the goal is done and verified, call moa_goal({action:"complete", summary}) and report once.`,
  ].join('\n');
}

/**
 * The turn that tells Moa how the operator answered its goal card, or null
 * when there is nothing true to say. `live` is the goal's status when the wake
 * is sent: an approval that an End overtook (both on the same serial chain,
 * the End second) must not tell Moa to "start on it now".
 */
export function goalAnswerWakePrompt(
  goalId: string,
  answer: 'active' | 'declined',
  note: string | undefined,
  live: string | null | undefined,
): string | null {
  if (answer === 'active') {
    if (live !== 'active') return null;
    return `[goal] The operator APPROVED goal ${goalId} (see the [goal] block). Start on it now: plan it, fan out in its repository, answer and instruct its tasks, verify the results, then call moa_goal({action:"complete", summary}) and report once. Push, PRs and merges stay the operator's.`;
  }
  return note
    ? `[goal] Goal ${goalId} was NOT approved: ${note}. Do not act on it. If the work still stands, propose it again with moa_propose_goal so the card shows the current setting.`
    : `[goal] The operator DECLINED goal ${goalId}. Do not act on it. If the request still stands, ask them what they want instead, or work as before.`;
}
