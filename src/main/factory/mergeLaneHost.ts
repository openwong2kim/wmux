// ─── Merge lane host — bot PRs merge on facts, never on a model ────────────
//
// Watches the facts that can complete a bot PR's case — verdict.recorded,
// ci.green, pr.head_moved, pr.labelled — and for the head they name:
//
//   1. waits until CI is green at that head (a ci.green fact) AND a PASS
//      verdict exists for it (the verdict store). Before that nothing is
//      enqueued: the outbox keeps one lane effect per head whatever its
//      status, so an early refusal would stand for that head;
//   2. reads the PR fresh, and acts only on a PR whose head branch is a bot
//      task's (a fan-out row whose dispatch origin is a bot). A human's or an
//      outside PR is not the lane's;
//   3. a PR from a repro worker (an issue's text was in its prompt), or one
//      a bot task started from outside text touched (its dispatch is tainted,
//      wakeTaint.ts), is the owner's to merge: refused `repro-origin` /
//      `tainted-origin` (the executor checks the taint again at run time);
//   4. runs the lane predicates (moaMergeLane.ts) on the fresh read with a
//      context main builds from its own stores: trusted authors (settings,
//      plus the owner's gh login, read at evaluation, for a head a bot task
//      produced), the bot tasks' branch, the verdicts, the PR's
//      author workspaces, and the ledger rows behind each verdict's evidence
//      (bot verdicts only while the factory is on);
//   5. a failure → a merge.refused fact (its room card lists the reasons).
//      All passing → with lane auto-merge off (the default) a status card
//      "ready to merge" in the PR thread, and the owner merges; on → the lane
//      effect is enqueued and the executor (shared outbox, lane rows only)
//      merges it under the lane's own gate: factory on, auto-merge on as the
//      kill switch, the daily cap, and the gh login unchanged since the
//      evaluation.
//
// Every executor outcome becomes merge.done / merge.refused. Evaluations of
// one PR run one at a time.
//
// The same executor runs the merges the owner (or a remembered rule)
// approved for a bot (approvals.ts): `getApprovalMergeHost` enqueues and runs
// them, and the executor's approval port asks the approval store, this
// host's lane context (rule: every lane predicate) and the taint check.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { BotProfile } from '../../shared/bot';
import type { Fact, FactDraft } from '../../shared/facts';
import type { FactorySettings } from '../../shared/factorySettings';
import type { LedgerEntry } from '../../shared/ledger';
import type { MergeEffect } from '../../shared/moaDecision';
import { laneEffectId } from '../../shared/moaDecision';
import type { PrLaneFacts } from '../../shared/prReview';
import type { PrVerdictRecord } from '../../shared/prVerdict';
import { prThreadId } from '../../shared/room';
import { LANE_PREDICATES, evaluateMergeLane, type LaneEvidenceRow, type MergeLaneContext } from '../deck/moaMergeLane';
import { MoaMergeExecutor, ruleAuthorize, type LaneAuthorizeInputs } from '../deck/moaMergeExecutor';
import type { MoaEffectStore } from '../deck/moaEffectStore';
import { factFromMergeEffect } from './factIngest';
import { formatLaneRefusal } from './laneRefusalText';
import { normalizeRepoKey } from './repoWatch';
import { taskTainted } from './wakeTaint';
import type { ApprovalMergeHost, StoredApproval } from './approvals';
import type { BotDirectoryApi } from './triggerEngine';
import type { RoomWriter } from './roomWriter';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryModuleHandle } from './factoryHost';
import { guestSide } from './guestWorkspaces';

/** The facts that can complete a PR's case. */
export const LANE_FACT_KINDS: ReadonlySet<Fact['kind']> = new Set(['verdict.recorded', 'ci.green', 'pr.head_moved', 'pr.labelled']);

const SWEEP_MS = 10 * 60_000;
const STARTUP_LOOKBACK_MS = 24 * 3600_000;

export interface LaneHostPorts {
  settings: () => FactorySettings;
  bots: () => BotDirectoryApi | null;
  /** Whether a ci.green fact exists for this head. */
  ciGreen: (repoKey: string, prNumber: number, headSha: string) => boolean;
  /** This PR's verdicts, read fresh; throws when unreadable. */
  verdicts: (repoKeys: readonly string[], prNumber: number) => Promise<PrVerdictRecord[]>;
  /** The PR read fresh (the lane query); throws when it cannot be read. */
  laneFacts: (repoPath: string, repoKey: string, prNumber: number) => Promise<PrLaneFacts>;
  /** The ledger rows of bot fan-out tasks on `repoKey` (their bot acts on
   *  that repository) whose branch is `headRefName`; throws when the task
   *  branches cannot be read. */
  botTasksOnBranch: (repoKey: string, headRefName: string) => Promise<LedgerEntry[]>;
  /** A ledger row by task id. */
  ledgerRow: (taskId: string) => LedgerEntry | null;
  /** The bots whose fan-out tasks (on any repository) have `headRefName`
   *  as their branch; throws when the task branches cannot be read. Absent:
   *  the bots of `botTasksOnBranch`. */
  authorBotsOnBranch?: (headRefName: string) => Promise<string[]>;
  /** Lane and rule merges done (or uncertain) today, for a rule's gate
   *  check before it approves. Absent: 0. */
  laneMergesToday?: () => number;
  /** The workspaces that authored the PR; throws when unknown. */
  authorWorkspaces: (repoPath: string, headRefName: string, tasks: readonly LedgerEntry[]) => Promise<string[]>;
  /** The owner's gh login on a host, read when a head is evaluated (the
   *  caller may cache it), or null when it cannot be read. */
  ownerLogin: (host: string, repoPath: string) => Promise<string | null>;
  /** The gh login a merge would go out as now, or null. */
  currentLogin: (repo: { key: string; path: string }) => Promise<string | null>;
  effects: Pick<MoaEffectStore, 'enqueueLane' | 'get'>;
  /** The gh login each lane effect was evaluated under, kept across
   *  restarts (default: memory only). */
  logins?: LaneLoginStore;
  /** Runs a lane effect (the lane executor). */
  run: (effectId: string) => Promise<MergeEffect | null>;
  /** Appends a fact; null when deduplicated or refused. */
  appendFact: (draft: FactDraft) => Fact | null;
  rooms: () => RoomWriter | null;
  /** Whether the owner has been asked to merge this PR (an approval request
   *  in any state). With lane auto-merge off such a PR's lane refusal shows
   *  no card: the approval card is the owner's path. */
  hasApproval?: (repoKey: string, prNumber: number) => boolean;
  /** Whether a bot on the repo is in a turn now (one may be asking the
   *  owner to approve the PR the lane just refused). */
  botsBusy?: (repoKey: string) => boolean;
  /** Run `fn` after `ms` (tests inject); returns a cancel. */
  later?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  log?: (line: string) => void;
}

/** What one evaluation ended in (tests and logs). */
export type LaneOutcome =
  | 'off' | 'not-watched' | 'waiting-ci' | 'waiting-verdict' | 'read-failed' | 'stale-head'
  | 'not-bot-owned' | 'owner-only' | 'refused' | 'ready' | 'enqueued' | 'settled';

function host(repoKey: string): string {
  return repoKey.split('/')[0] ?? 'github.com';
}

function sha7(sha: string): string {
  return sha.slice(0, 7);
}

/** The gh login each lane effect was evaluated under. */
export interface LaneLoginStore {
  get(effectId: string): string | null;
  set(effectId: string, login: string): void;
  delete(effectId: string): void;
}

export function memoryLaneLogins(): LaneLoginStore {
  const m = new Map<string, string>();
  return { get: (id) => m.get(id) ?? null, set: (id, l) => void m.set(id, l), delete: (id) => void m.delete(id) };
}

export const LANE_LOGINS_FILENAME = 'lane-logins.json';
const LANE_LOGINS_MAX = 500;

/** `factory/lane-logins.json` ({version:1, logins}), written on every change.
 *  Unreadable reads as empty: a merge with no kept login is refused. */
export function fileLaneLogins(file: string): LaneLoginStore {
  let m = new Map<string, string>();
  try {
    if (fs.existsSync(file)) {
      const raw = atomicReadJSONSync<{ version?: unknown; logins?: unknown }>(file);
      if (raw?.version === 1 && raw.logins && typeof raw.logins === 'object') {
        for (const [k, v] of Object.entries(raw.logins as Record<string, unknown>)) if (typeof v === 'string') m.set(k, v);
      }
    }
  } catch {
    m = new Map();
  }
  const save = (): void => {
    while (m.size > LANE_LOGINS_MAX) {
      const first = m.keys().next().value;
      if (first === undefined) break;
      m.delete(first);
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteJSONSync(file, { version: 1, logins: Object.fromEntries(m) });
    } catch (err) {
      console.warn(`[factory] lane logins not written: ${String(err)}`);
    }
  };
  return {
    get: (id) => m.get(id) ?? null,
    set: (id, login) => { m.set(id, login); save(); },
    delete: (id) => { if (m.delete(id)) save(); },
  };
}

/** The bot fan-out rows whose bot acts on `repoKey`: a task counts for a PR
 *  only on its own bot's repository (a removed bot's tasks count for none). */
export function botRowsOnRepo(rows: readonly LedgerEntry[], repoKey: string, bots: Pick<BotDirectoryApi, 'get'> | null): LedgerEntry[] {
  return rows.filter((e) => {
    const botId = e.dispatch?.origin?.kind === 'bot' ? e.dispatch.origin.botId : undefined;
    if (!botId || !bots) return false;
    try {
      return normalizeRepoKey(bots.get(botId)?.repo?.repoKey) === repoKey;
    } catch {
      return false;
    }
  });
}

export function evidenceRowOf(e: LedgerEntry | null, taskId: string): LaneEvidenceRow | null {
  if (!e || e.id !== taskId) return null;
  return {
    taskId,
    origin: e.dispatch?.origin ? { ...e.dispatch.origin } : { kind: 'unknown' },
    preset: e.dispatch?.preset ?? null,
    checkout: e.dispatch?.checkout ? { ...e.dispatch.checkout } : null,
    gate: e.gate ?? null,
  };
}

/** How long a lane refusal's card waits at most for an approval request
 *  for the same PR while lane auto-merge is off, re-checked this often. */
export const LANE_REFUSAL_HOLD_MS = 90_000;
export const LANE_REFUSAL_POLL_MS = 2_000;

export class MergeLaneHost {
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Lane refusal cards held for an approval request (refuse). */
  private readonly holds = new Map<string, () => void>();
  private disposed = false;
  /** The gh login each enqueued lane effect was evaluated under. */
  private readonly logins: LaneLoginStore;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly ports: LaneHostPorts) {
    this.now = ports.now ?? Date.now;
    this.log = ports.log ?? ((l) => console.log(l));
    this.logins = ports.logins ?? memoryLaneLogins();
  }

  /** A fact from the log: evaluate the head it names (never throws). */
  onFact(f: Fact): Promise<LaneOutcome> | null {
    // A PR that merged, closed or moved its head: a refusal card still held
    // for it is about the past.
    if (f.kind === 'pr.merged' || f.kind === 'pr.closed' || f.kind === 'pr.head_moved' || f.kind === 'merge.done') {
      const repo = normalizeRepoKey(f.repoKey);
      if (repo && typeof f.ref?.pr === 'number') this.dropHolds(`${repo}#${f.ref.pr}:`, f.kind === 'pr.head_moved' ? f.ref?.headSha : undefined);
    }
    if (!LANE_FACT_KINDS.has(f.kind)) return null;
    if (f.kind === 'verdict.recorded' && f.payload?.verdict !== 'pass') return null;
    const repoKey = normalizeRepoKey(f.repoKey);
    const pr = f.ref?.pr;
    const sha = f.ref?.headSha;
    if (!repoKey || typeof pr !== 'number' || typeof sha !== 'string' || !sha) return null;
    return this.evaluate(repoKey, pr, sha);
  }

  /** Evaluate one PR head; runs after any evaluation of the same PR. */
  evaluate(repoKey: string, prNumber: number, headSha: string): Promise<LaneOutcome> {
    const key = `${repoKey}#${prNumber}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.evaluateOnce(repoKey, prNumber, headSha)).catch((err): LaneOutcome => {
      this.log(`[factory] merge lane ${key}@${sha7(headSha)} failed: ${String(err)}`);
      return 'read-failed';
    });
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  /** The enabled bots on a repo (their workspaces' rooms get the cards). */
  private botsOn(repoKey: string): BotProfile[] {
    try {
      // A guest workspace has no repository; skipped all the same.
      return (this.ports.bots()?.listEnabled() ?? []).filter((b) => normalizeRepoKey(b.repo?.repoKey) === repoKey && !guestSide(b.workspaceId));
    } catch {
      return [];
    }
  }

  private async evaluateOnce(repoKey: string, prNumber: number, headSha: string): Promise<LaneOutcome> {
    const settings = this.ports.settings();
    if (!settings.enabled) return 'off';
    const bots = this.botsOn(repoKey);
    const repoPath = bots.find((b) => b.repo?.repoPath)?.repo?.repoPath;
    if (!repoPath) return 'not-watched';
    if (!this.ports.ciGreen(repoKey, prNumber, headSha)) return 'waiting-ci';
    const keys = [...new Set([repoKey, ...bots.map((b) => b.repo?.repoKey ?? '').filter(Boolean)])];
    const verdicts = await this.ports.verdicts(keys, prNumber);
    if (!verdicts.some((v) => v.verdict === 'pass' && v.headSha === headSha)) return 'waiting-verdict';
    let facts: PrLaneFacts;
    try {
      facts = await this.ports.laneFacts(repoPath, repoKey, prNumber);
    } catch (err) {
      this.log(`[factory] merge lane: ${repoKey}#${prNumber} could not be read: ${String(err)}`);
      return 'read-failed';
    }
    if (facts.headRefOid !== headSha) return 'stale-head';
    if (facts.state !== 'OPEN') return 'settled';
    const tasks = await this.ports.botTasksOnBranch(repoKey, facts.headRefName);
    if (tasks.length === 0) return 'not-bot-owned';
    if (tasks.some((t) => t.dispatch?.preset === 'repro')) {
      this.refuse(repoKey, prNumber, headSha, 'repro-origin: a repro worker opened this PR from an issue; the owner merges it', bots);
      return 'owner-only';
    }
    if (tasks.some(taskTainted)) {
      this.refuse(repoKey, prNumber, headSha, 'tainted-origin: a bot task on this branch started from outside text; the owner merges it', bots);
      return 'owner-only';
    }
    const ctx = await this.laneContext(repoKey, repoPath, facts, verdicts, tasks, settings);
    const verdict = evaluateMergeLane(facts, { ...ctx, expectHead: headSha });
    if (!verdict.ok) {
      this.refuse(repoKey, prNumber, headSha, verdict.failures.map((f) => `${f.predicate}:${f.reason}`).join(', '), bots);
      return 'refused';
    }
    if (!settings.laneAutoMerge) {
      // Ready now: an earlier refusal of this PR is no longer the news.
      this.dropHolds(`${repoKey}#${prNumber}:`);
      const by = verdict.verifiedBy;
      this.card(bots, repoKey, prNumber, `lane-ready:${repoKey}#${prNumber}:${headSha}`, {
        kind: 'status',
        title: `Ready to merge #${prNumber} at ${sha7(headSha)}: every lane predicate passed`,
        body: [
          `Verified${by?.botId ? ` by ${by.botId}` : ''}${by?.taskId ? ` (task ${by.taskId})` : ''} at ${sha7(headSha)}; CI green.`,
          'Lane auto-merge is off: merge it from the PR when you are ready.',
        ].join('\n'),
      });
      return 'ready';
    }
    // The identity the merge must go out as: read before anything is
    // enqueued, so an unreadable login never burns the head's one effect.
    const login = await this.ports.currentLogin({ key: repoKey, path: repoPath }).catch(() => null);
    if (!login) return 'read-failed';
    const prior = this.ports.effects.get(laneEffectId(repoKey, prNumber, headSha));
    if (prior && prior.status !== 'pending') return 'settled';
    if (!prior) this.logins.set(laneEffectId(repoKey, prNumber, headSha), login);
    const effect = await this.ports.effects.enqueueLane({ repoKey, repoPath, prNumber, expectHead: headSha });
    if (effect.status !== 'pending') return 'settled';
    await this.ports.run(effect.id);
    return 'enqueued';
  }

  /** The lane context for a head, from main's own stores. */
  async laneContext(
    repoKey: string,
    repoPath: string,
    facts: PrLaneFacts,
    verdicts: readonly PrVerdictRecord[] | null,
    tasks: readonly LedgerEntry[],
    settings: FactorySettings,
  ): Promise<Omit<MergeLaneContext, 'expectHead'>> {
    // The owner's own login is trusted only for a head a bot task of this
    // factory produced (not a repro worker's); every other author must be
    // in the settings' list. An unreadable login trusts nobody extra.
    const botMade = tasks.some((t) => t.dispatch?.origin?.kind === 'bot') && !tasks.some((t) => t.dispatch?.preset === 'repro');
    const owner = botMade ? await this.ports.ownerLogin(host(repoKey), repoPath).catch(() => null) : null;
    const trustedAuthors = [...new Set([...settings.trustedAuthors, ...(owner ? [owner] : [])].map((a) => a.toLowerCase()))];
    let authorWorkspaces: string[] | null = null;
    try {
      authorWorkspaces = await this.ports.authorWorkspaces(repoPath, facts.headRefName, tasks);
    } catch {
      authorWorkspaces = null;
    }
    // Every bot whose worker has this branch, on any repository: none of
    // them verifies it. Unreadable: no PASS counts (every bot is an author).
    const taskBots = tasks.map((t) => t.dispatch?.origin?.botId).filter((b): b is string => typeof b === 'string' && b.length > 0);
    let authorBots: string[] | null;
    try {
      authorBots = [...new Set([...taskBots, ...(this.ports.authorBotsOnBranch ? await this.ports.authorBotsOnBranch(facts.headRefName) : [])])];
    } catch {
      authorBots = null;
    }
    let evidenceRows: Map<string, LaneEvidenceRow> | null = new Map();
    try {
      for (const v of verdicts ?? []) {
        const id = v.evidence?.taskId;
        if (!id || evidenceRows.has(id)) continue;
        const row = evidenceRowOf(this.ports.ledgerRow(id), id);
        if (row) evidenceRows.set(id, row);
      }
    } catch {
      evidenceRows = null;
    }
    return {
      trustedAuthors,
      // Bound when a bot task's branch is the head branch.
      askerBranches: tasks.length > 0 && !tasks.some((t) => t.dispatch?.preset === 'repro') ? [facts.headRefName] : [],
      verdicts,
      authorWorkspaces,
      // The bots that dispatched the PR's worker: a PASS from one of them is
      // self-verified, whatever workspace the verifier shares.
      ...(authorBots ? { authorBots } : { authorBots: [], verdicts: null }),
      // A lane merge rests on a bot's verdict with main-written evidence,
      // whatever the switch reads by the time the executor gets here.
      botVerdictsOnly: true,
      evidenceRows,
    };
  }

  /** The executor's lane context for an effect, read now. Fails closed:
   *  a PR no bot task owns gets no bound branch. */
  async effectContext(effect: MergeEffect, facts: PrLaneFacts): Promise<Omit<MergeLaneContext, 'expectHead'>> {
    const settings = this.ports.settings();
    const repoKey = normalizeRepoKey(effect.repoKey) ?? effect.repoKey;
    const keys = [...new Set([effect.repoKey, repoKey])];
    let verdicts: PrVerdictRecord[] | null;
    try {
      verdicts = await this.ports.verdicts(keys, effect.prNumber);
    } catch {
      verdicts = null;
    }
    let tasks: LedgerEntry[] = [];
    try {
      tasks = await this.ports.botTasksOnBranch(repoKey, facts.headRefName);
    } catch {
      tasks = [];
    }
    return this.laneContext(repoKey, effect.repoPath, facts, verdicts, tasks, settings);
  }

  /** Run-time refusal for a lane or rule effect: a bot task on the head
   *  branch started from outside text or is a repro worker's (or the tasks
   *  cannot be read). */
  async taintRefusal(effect: MergeEffect, facts: PrLaneFacts): Promise<string | null> {
    const repoKey = normalizeRepoKey(effect.repoKey) ?? effect.repoKey;
    let tasks: LedgerEntry[];
    try {
      tasks = await this.ports.botTasksOnBranch(repoKey, facts.headRefName);
    } catch {
      return 'tasks-unreadable';
    }
    if (tasks.some((t) => t.dispatch?.preset === 'repro')) return 'repro-origin';
    return tasks.some(taskTainted) ? 'tainted-origin' : null;
  }

  /** Whether a remembered rule may approve a bot's merge request now: the
   *  request is untainted, the PR reads open at the request's head, no bot
   *  task behind the head is tainted or a repro worker's, every lane
   *  predicate passes, and the rule's gate (factory on, room under the
   *  daily cap; not the lane auto-merge switch, see ruleAuthorize) allows
   *  it. Null = may; else why not. */
  async ruleCheck(r: Pick<StoredApproval, 'repoKey' | 'repoPath' | 'prNumber' | 'headSha' | 'tainted'>): Promise<string | null> {
    if (r.tainted) return 'tainted-origin';
    if (r.prNumber === undefined || !r.headSha) return 'no-head';
    const settings = this.ports.settings();
    const gate = ruleAuthorize(this.inputs(), this.ports.laneMergesToday?.() ?? 0);
    if (gate) return gate;
    let facts: PrLaneFacts;
    try {
      facts = await this.ports.laneFacts(r.repoPath, r.repoKey, r.prNumber);
    } catch {
      return 'read-failed';
    }
    if (facts.state !== 'OPEN') return 'not-open';
    if (facts.headRefOid !== r.headSha) return 'head-moved';
    let tasks: LedgerEntry[];
    try {
      tasks = await this.ports.botTasksOnBranch(r.repoKey, facts.headRefName);
    } catch {
      return 'tasks-unreadable';
    }
    if (tasks.some((t) => t.dispatch?.preset === 'repro')) return 'repro-origin';
    if (tasks.some(taskTainted)) return 'tainted-origin';
    let verdicts: PrVerdictRecord[] | null;
    try {
      verdicts = await this.ports.verdicts([r.repoKey], r.prNumber);
    } catch {
      verdicts = null;
    }
    const ctx = await this.laneContext(r.repoKey, r.repoPath, facts, verdicts, tasks, settings);
    const verdict = evaluateMergeLane(facts, { ...ctx, expectHead: r.headSha }, LANE_PREDICATES);
    return verdict.ok ? null : verdict.failures.map((f) => `${f.predicate}:${f.reason}`).join(', ');
  }

  /** The lane's gate inputs, read now. */
  inputs(): LaneAuthorizeInputs | null {
    const s = this.ports.settings();
    return { factoryEnabled: s.enabled, killSwitch: !s.laneAutoMerge, dailyCap: s.laneDailyCap };
  }

  /** The executor's last gate before a lane merge: the factory and lane
   *  auto-merge are still on, and the gh login the merge goes out as is
   *  readable and the one the lane evaluated the head under (kept with the
   *  effect; none kept refuses). */
  async identity(effect: MergeEffect): Promise<string | null> {
    const s = this.ports.settings();
    if (!s.enabled) return 'factory-disabled';
    if (!s.laneAutoMerge) return 'lane-paused';
    const expected = this.logins.get(effect.id);
    if (!expected) return 'identity-unknown';
    const now = await this.ports.currentLogin({ key: effect.repoKey, path: effect.repoPath }).catch(() => null);
    if (!now) return 'identity-unknown';
    return now.toLowerCase() === expected.toLowerCase() ? null : 'identity-changed';
  }

  /** An executor outcome: merge.done / merge.refused. */
  onEffect(effect: MergeEffect): void {
    if (effect.approvedBy !== 'lane') return;
    const draft = factFromMergeEffect(effect);
    if (!draft) return;
    if (effect.status === 'done' || effect.status === 'refused') this.logins.delete(effect.id);
    if (effect.status === 'refused') {
      this.refuse(normalizeRepoKey(effect.repoKey) ?? effect.repoKey, effect.prNumber, effect.expectHead, effect.reason ?? 'refused', this.botsOn(normalizeRepoKey(effect.repoKey) ?? effect.repoKey));
      return;
    }
    try {
      this.ports.appendFact(draft);
    } catch (err) {
      this.log(`[factory] merge.done fact not written: ${String(err)}`);
    }
  }

  /** merge.refused (its room card shows the reasons). A head already refused
   *  once keeps its fact; a later, different refusal of it is a card only.
   *  With lane auto-merge off, the lane would not have merged it anyway: a
   *  PR the owner was (or is soon) asked to approve gets no refusal card,
   *  and any other waits LANE_REFUSAL_HOLD_MS for such a request first. */
  private refuse(repoKey: string, prNumber: number, headSha: string, reason: string, bots: readonly BotProfile[]): void {
    const held = !this.ports.settings().laneAutoMerge;
    let fact: Fact | null = null;
    try {
      fact = this.ports.appendFact({
        kind: 'merge.refused',
        at: this.now(),
        repoKey,
        ref: { pr: prNumber, headSha },
        actor: { kind: 'system' },
        payload: { approvedBy: 'lane', reason: reason.slice(0, 500), ...(held ? { cardHeld: true } : {}) },
      });
    } catch (err) {
      this.log(`[factory] merge.refused fact not written: ${String(err)}`);
    }
    if (fact && !held) return;
    const tag = Buffer.from(reason).toString('base64url').slice(0, 48);
    const post = (): void => {
      if (held && this.asked(repoKey, prNumber)) return;
      this.card(bots, repoKey, prNumber, `lane-refused:${repoKey}#${prNumber}:${headSha}:${tag}`, {
        kind: 'refusal',
        title: `Merge refused for #${prNumber} at ${sha7(headSha)}`,
        body: formatLaneRefusal(reason.slice(0, 500)).slice(0, 2000),
      });
    };
    if (!held) {
      post();
      return;
    }
    if (this.asked(repoKey, prNumber)) return;
    // Nobody on the repo is in a turn: no request is coming, the owner reads
    // why now. Else the card waits while those turns run (the bot that just
    // recorded the verdict may be asking the owner), at most
    // LANE_REFUSAL_HOLD_MS.
    if (!this.busy(repoKey)) {
      post();
      return;
    }
    const key = `${repoKey}#${prNumber}:${headSha}:${tag}`;
    this.holds.get(key)?.();
    const later = this.ports.later ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });
    const deadline = this.now() + LANE_REFUSAL_HOLD_MS;
    const check = (): void => {
      this.holds.delete(key);
      if (this.disposed) return;
      if (this.busy(repoKey) && this.now() < deadline) {
        this.holds.set(key, later(check, LANE_REFUSAL_POLL_MS));
        return;
      }
      post();
    };
    this.holds.set(key, later(check, LANE_REFUSAL_POLL_MS));
  }

  /** Whether a bot on the repo is in a turn now (unknown: no). */
  private busy(repoKey: string): boolean {
    try {
      return this.ports.botsBusy?.(repoKey) === true;
    } catch {
      return false;
    }
  }

  /** Cancel the held refusal cards of one PR (`<repo>#<n>:`), all of them
   *  or those of heads other than `keepHead`. */
  private dropHolds(prefix: string, keepHead?: string): void {
    for (const [key, cancel] of [...this.holds]) {
      if (!key.startsWith(prefix) || (keepHead && key.startsWith(`${prefix}${keepHead}:`))) continue;
      cancel();
      this.holds.delete(key);
    }
  }

  private asked(repoKey: string, prNumber: number): boolean {
    try {
      return this.ports.hasApproval?.(repoKey, prNumber) === true;
    } catch {
      return false;
    }
  }

  /** Quit: held refusal cards are dropped (their facts stay). */
  dispose(): void {
    this.disposed = true;
    for (const cancel of this.holds.values()) cancel();
    this.holds.clear();
  }

  private card(bots: readonly BotProfile[], repoKey: string, prNumber: number, clientPostId: string, c: { kind: 'status' | 'refusal'; title: string; body: string }): void {
    const writer = this.ports.rooms();
    if (!writer) return;
    for (const workspaceId of new Set(bots.map((b) => b.workspaceId))) {
      writer.post({
        workspaceId,
        threadId: prThreadId(repoKey, prNumber),
        kind: c.kind,
        actor: { kind: 'system' },
        title: c.title,
        body: c.body,
        refs: { pr: prNumber },
        clientPostId: clientPostId.slice(0, 200),
      });
    }
  }
}

// ── Module ─────────────────────────────────────────────────────────────────

let approvalHost: ApprovalMergeHost | null = null;

/** The executor's side for owner and rule approvals (approvals.ts), or null
 *  while the merge lane host is not running. */
export function getApprovalMergeHost(): ApprovalMergeHost | null {
  return approvalHost;
}

export function setApprovalMergeHostForTests(h: ApprovalMergeHost | null): void {
  approvalHost = h;
}

/** Lane and rule merges done (or uncertain) since local midnight. */
export function laneMergesToday(rows: readonly MergeEffect[], now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return rows.filter((r) => (r.approvedBy === 'lane' || r.approvedBy === 'rule') && (r.status === 'done' || r.status === 'uncertain') && r.updatedAt >= d.getTime()).length;
}

/** The production ports (imported lazily: main-only singletons). */
async function productionHost(deps: FactoryHostDeps): Promise<{ host: MergeLaneHost; executor: MoaMergeExecutor; subscribe: (fn: (f: Fact) => void) => () => void; recent: () => Fact[] } | null> {
  const [{ getFactLog }, { getBotDirectory }, { getFactorySettings }, { getRoomWriter }, { getTaskLedger }, { getPrVerdictStore }, laneGh, hostLane, { getApprovalService }, { getBotRuntime }] = await Promise.all([
    import('./factLog'),
    import('./botStore'),
    import('./factorySettings'),
    import('./roomWriter'),
    import('../deck/taskLedgerHost'),
    import('../github/prVerdictStore'),
    import('./laneGh'),
    import('../github/hostLane'),
    import('./approvals'),
    import('./BotRuntime'),
  ]);
  /** The rows among `rows` whose task branch is `headRefName` (the daemon's
   *  task list, per owner workspace); throws when it cannot be read. */
  const rowsOnBranch = async (rows: LedgerEntry[], headRefName: string): Promise<LedgerEntry[]> => {
    if (rows.length === 0 || !headRefName) return [];
    const dc = deps.getDaemonClient();
    if (!dc?.isConnected) throw new Error('daemon not connected');
    const out: LedgerEntry[] = [];
    for (const owner of new Set(rows.map((r) => r.ownerWorkspaceId))) {
      const res = (await dc.rpc('task.mission.list', { verifiedWorkspaceId: owner })) as { ok?: unknown; tasks?: Array<{ id?: unknown; branch?: unknown }> };
      if (!res || res.ok === false || !Array.isArray(res.tasks)) throw new Error('task.mission.list failed');
      for (const t of res.tasks) {
        if (t.branch !== headRefName) continue;
        const row = rows.find((r) => r.id === t.id && r.ownerWorkspaceId === owner);
        if (row) out.push(row);
      }
    }
    return out;
  };
  const log = getFactLog() as (ReturnType<typeof getFactLog> & { readWhere?: (after: number, match: (f: Fact) => boolean, limit: number) => { facts: Fact[] } }) | null;
  if (!log) return null;
  const wmuxDir = deps.wmuxDir();
  const effects = laneGh.laneEffectStore(wmuxDir);
  const ledger = getTaskLedger();
  let laneHost: MergeLaneHost | null = null;
  const executor = new MoaMergeExecutor({
    effects,
    facts: laneGh.freshLaneFacts,
    merge: laneGh.squashMergeEffect,
    // Decision rows are Moa's executor's; this one runs lane rows only.
    laneContext: async () => { throw new Error('the lane executor runs lane effects only'); },
    authorize: () => 'not-a-lane-effect',
    lane: {
      inputs: () => laneHost?.inputs() ?? null,
      laneContext: (e, f) => (laneHost as MergeLaneHost).effectContext(e, f),
      refusal: (e, f) => (laneHost as MergeLaneHost).taintRefusal(e, f),
    },
    // Owner and rule approvals: the approval store decides whether the
    // request still allows the merge and which login it must go out as.
    approval: {
      authorize: (e) => {
        const approvals = getApprovalService();
        return approvals ? approvals.authorizeEffect(e) : 'approval-not-running';
      },
      laneContext: (e, f) => (laneHost as MergeLaneHost).effectContext(e, f),
      refusal: (e, f) => (laneHost as MergeLaneHost).taintRefusal(e, f),
      identity: async (e) => {
        const approvals = getApprovalService();
        return approvals ? approvals.identityEffect(e) : 'approval-not-running';
      },
    },
    updateBranch: laneGh.updateBranchEffect,
    identity: (e) => (laneHost as MergeLaneHost).identity(e),
    emit: (e) => {
      laneHost?.onEffect(e);
      getApprovalService()?.onEffect(e);
    },
    log: (l) => console.log(l),
  });
  laneHost = new MergeLaneHost({
    settings: getFactorySettings,
    bots: getBotDirectory,
    ciGreen: (repoKey, pr, sha) => {
      if (typeof log.readWhere !== 'function') return false;
      return log.readWhere(0, (f) => f.kind === 'ci.green' && f.ref?.pr === pr && f.ref?.headSha === sha && normalizeRepoKey(f.repoKey) === repoKey, 1).facts.length > 0;
    },
    verdicts: async (keys, pr) => {
      const store = getPrVerdictStore(wmuxDir);
      const out: PrVerdictRecord[] = [];
      for (const k of keys) out.push(...(await store.list(k, pr)));
      return out;
    },
    laneFacts: (repoPath, key, n) => laneGh.freshLaneFacts.readFresh(repoPath, key, n),
    botTasksOnBranch: (repoKey, headRefName) => rowsOnBranch(botRowsOnRepo(ledger.list({}), repoKey, getBotDirectory()), headRefName),
    authorBotsOnBranch: async (headRefName) => {
      const rows = await rowsOnBranch(ledger.list({}).filter((e) => e.dispatch?.origin?.kind === 'bot'), headRefName);
      return rows.map((r) => r.dispatch?.origin?.botId).filter((b): b is string => typeof b === 'string' && b.length > 0);
    },
    laneMergesToday: () => laneMergesToday(effects.list(), Date.now()),
    ledgerRow: (id) => ledger.get(id),
    authorWorkspaces: (repoPath, headRefName, tasks) => laneGh.prAuthorWorkspaces(deps.getDaemonClient, { workspaceId: tasks[0]?.taskWorkspaceId ?? '' }, repoPath, headRefName),
    // Read per evaluation, by host (gh or glab), so a bot added after start,
    // or a login that changed, is seen.
    ownerLogin: (h, cwd) => hostLane.signedInLogin(h, cwd),
    currentLogin: laneGh.currentGhLogin,
    effects,
    logins: fileLaneLogins(path.join(wmuxDir, 'factory', LANE_LOGINS_FILENAME)),
    run: (id) => executor.run(id),
    botsBusy: (repoKey) => {
      const runtime = getBotRuntime();
      return !!runtime && (getBotDirectory()?.listEnabled() ?? []).some((b) => normalizeRepoKey(b.repo?.repoKey) === repoKey && !guestSide(b.workspaceId) && runtime.currentTurn(b.id) !== null);
    },
    hasApproval: (repoKey, pr) => (getApprovalService()?.listForOperator() ?? []).some((r) => r.action === 'merge' && r.repoKey === repoKey && r.prNumber === pr),
    appendFact: (d) => log.append(d),
    rooms: getRoomWriter,
  });
  const recent = (): Fact[] => {
    if (typeof log.readWhere !== 'function') return [];
    const since = Date.now() - STARTUP_LOOKBACK_MS;
    return log.readWhere(0, (f) => f.at >= since && LANE_FACT_KINDS.has(f.kind), 1000).facts;
  };
  const host = laneHost;
  approvalHost = {
    enqueue: (r, approvedBy) => effects.enqueueApproval({
      requestId: r.requestId, approvedBy, repoKey: r.repoKey, repoPath: r.repoPath, prNumber: r.prNumber as number, expectHead: r.headSha as string,
    }),
    run: (id) => executor.run(id),
    ruleCheck: (r) => host.ruleCheck(r),
    effect: (id) => effects.get(id),
  };
  return { host: laneHost, executor, subscribe: (fn) => log.subscribe(fn), recent };
}

/** How long quit waits for a lane merge in flight. */
export const LANE_QUIT_WAIT_MS = 1_000;

export function createMergeLaneModule(deps: FactoryHostDeps): FactoryModuleHandle {
  let off: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let executor: MoaMergeExecutor | null = null;
  let laneHost: MergeLaneHost | null = null;
  let disposed = false;
  return {
    async start() {
      let built: Awaited<ReturnType<typeof productionHost>>;
      try {
        built = await productionHost(deps);
      } catch (err) {
        console.warn(`[factory] merge lane host did not start: ${String(err)}`);
        return;
      }
      if (!built || disposed) {
        if (!built) console.info('[factory] merge lane host: no fact log; the lane is not watched');
        return;
      }
      const { host, recent, subscribe } = built;
      executor = built.executor;
      laneHost = host;
      off = subscribe((f) => void host.onFact(f));
      // Facts that landed while the app was down: their heads are evaluated
      // once (every outcome is idempotent per head).
      for (const f of recent()) void host.onFact(f);
      const lane = built.executor;
      void lane.reconcileAll().catch(() => undefined);
      timer = setInterval(() => void lane.reconcileAll().catch(() => undefined), SWEEP_MS);
      timer.unref?.();
    },
    async dispose() {
      disposed = true;
      approvalHost = null;
      off?.();
      off = null;
      laneHost?.dispose();
      laneHost = null;
      if (timer) clearInterval(timer);
      timer = null;
      // A merge in flight gets a bounded moment to record its outcome; quit
      // never waits on gh beyond it (the next start reconciles the effect).
      let bound: NodeJS.Timeout | null = null;
      await Promise.race([
        executor?.idle().catch(() => undefined),
        new Promise<void>((resolve) => {
          bound = setTimeout(resolve, LANE_QUIT_WAIT_MS);
          bound.unref?.();
        }),
      ]);
      if (bound) clearTimeout(bound);
    },
  };
}

registerFactoryRpcModule('mergeLane', (_router, deps) => createMergeLaneModule(deps));
