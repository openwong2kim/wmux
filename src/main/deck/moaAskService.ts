// ─── Moa's delegate — the moa_ask service (MoaDelegateServicePort) ───────────
//
// One agent's question to Moa, from ticket to settlement:
//
//   ask()      validate → claim the ticket (MoaDecisionStore.begin: on disk,
//              inFlight, before anything is judged) → return `pending` at once
//              → judge in the background → settle. A retry with the same key
//              (the MCP client's 10 s timeout) replays the ticket: the judge
//              runs once per ticket. A ticket found inFlight after a restart is
//              never judged again (the store reads it as uncertain).
//   modes      shadow: judge and record; the asker reads `escalated`.
//              suggest: the same, and the judge's proposal stays on the
//              owner's card (decision.judge).
//              auto: only a merge can settle by itself, and only when
//              moaAutoEligibility passes on a fresh lane read, the kill switch
//              is off and the daily cap has room. A free question has no
//              predicate, so it is NEVER auto.
//   merge      typed {prNumber, expectHead} only; the repo is the asker's
//              verified cwd (resolveRepo). The lane is read fresh before the
//              judge; a PR that is not open or has another head is refused, any
//              other failed predicate escalates. The judge only names the rule.
//              An auto answer is settled first, then its MergeEffect is
//              enqueued (startup repairs a crash between the two), then the
//              executor re-reads and re-checks everything before merging.
//
// The model never decides an action: validateJudgeReply rejects off-contract
// replies, moaAutoEligibility needs the book's `auto: true`, the owner's
// per-rule toggle (renderer IPC only) and the bound predicate passing, and
// agreement stats are display only. Every auto answer's decision row, with
// resolvedBy 'moa-auto' and the judge's verdict, is its receipt.

import type { MoaAsker, MoaAskMode, MoaAskRequest, MoaAskResult, MoaAskStatusResult } from '../../shared/moaAsk';
import {
  mergeEffectId,
  sanitizeAutoRules,
  ticketView,
  type MergeEffect,
  type MoaAuditEvent,
  type MoaAutoRuleSetRequest,
  type MoaAutoRuleSetResult,
  type MoaDecision,
  type MoaDecisionMode,
  type MoaDelegateListResult,
  type MoaJudgeResult,
  type MoaResolveRequest,
  type MoaResolveResult,
  type MoaRuleView,
  type MoaUnreceiptedMerge,
} from '../../shared/moaDecision';
import type { PrMergeFacts } from '../../shared/phoneGitWrite';
import type { PrLaneFacts } from '../../shared/prReview';
import type { MoaDelegateEvents, MoaDelegateServicePort } from './moaDelegatePorts';
import type { MoaDecisionStore, MoaSettlement } from './moaDecisionStore';
import type { MoaEffectStore } from './moaEffectStore';
import type { MoaMergeExecutor } from './moaMergeExecutor';
import { evaluateMergeLane, type MergeLaneFactsReader, type LaneVerdict } from './moaMergeLane';
import { buildMergeFacts, type MergeFactsExtras } from './moaMergeFacts';
import { moaAutoEligibility, type PolicyBook } from './deckPolicy';
import {
  SHADOW_DAILY_CAP_DEFAULT,
  buildDecisionPacket,
  buildJudgePrompt,
  precheckAlwaysEscalate,
  validateJudgeReply,
  type JudgeRunResult,
  type ShadowPrFacts,
} from './moaShadowJudge';
import { MOA_AUTO_DAILY_CAP_DEFAULT } from '../../shared/moa';
import { COURIER_MAX_WAIT_MS, MoaAnswerCourier, type AskerPaneState, type CourierSendResult } from './moaAnswerCourier';

/** What the service reads from the owner's settings, on every call. */
export interface MoaAskConfig {
  mode: MoaAskMode;
  /** The owner's per-rule auto toggles. */
  autoRules: readonly string[];
  /** MoaConfig.trustedAuthors plus the owner's own login, lowercase. */
  trustedAuthors: readonly string[];
  autoDailyCap?: number;
  /** The kill switch. */
  autoPaused?: boolean;
}

export interface MoaAskServicePorts {
  decisions: MoaDecisionStore;
  effects: MoaEffectStore;
  executor: MoaMergeExecutor;
  facts: MergeLaneFactsReader;
  getConfig: () => MoaAskConfig;
  /** Persist the owner's per-rule toggles; false when the store refused. */
  setAutoRules: (ids: string[]) => Promise<boolean>;
  loadBook: () => (PolicyBook & { text: string }) | null;
  /** One judge call (the shadow judge's runner). */
  judge: (prompt: string) => Promise<JudgeRunResult>;
  /** The asker pane's last screen lines (untrusted). */
  readScreen: (ptyId: string) => Promise<string[]>;
  /** The repo a cwd belongs to: its remote key and the path to run gh in. */
  resolveRepo: (cwd: string) => Promise<{ key: string; path: string } | null>;
  /** Branches bound to the asker: the one checked out at `repoPath` and its
   *  task ledger rows' branches. */
  askerBranches: (asker: MoaAsker, repoPath: string) => Promise<string[]>;
  /** A verdict the shadow judge already recorded for this question hash. */
  priorJudgment?: (questionHash: string) => MoaJudgeResult | null;
  /** What the decision's PrMergeFacts need beside the lane read: squash
   *  permission and the gh login. Null or absent: no facts. */
  mergeFactsExtras?: (repo: { key: string; path: string }) => Promise<MergeFactsExtras | null>;
  /** The gh login a merge in `repo` goes out as, read now (uncached); null
   *  when it cannot be read. */
  currentLogin?: (repo: { key: string; path: string }) => Promise<string | null>;
  /** PRs merged since `sinceIso` in a repo (the audit). */
  mergedSince?: (repo: { key: string; path: string }, sinceIso: string) => Promise<Array<Omit<MoaUnreceiptedMerge, 'repoKey'>> | null>;
  judgeDailyCap?: number;
  /** The asker's pane, for pasting a later answer back as a new turn
   *  (moaAnswerCourier.ts). Without it nothing is delivered. */
  answerPane?: {
    state: (asker: MoaAsker) => AskerPaneState;
    send: (asker: MoaAsker, text: string, wanted: () => boolean) => Promise<CourierSendResult>;
    retryMs?: number;
    setTimer?: (fn: () => void, ms: number) => () => void;
  };
  now?: () => number;
  log?: (line: string) => void;
}

/** What an asker told `escalated` should do next. */
export const ESCALATED_NEXT =
  "The owner answers this on Moa's card. End your turn now without restating the question; " +
  'the answer arrives in this pane as a new message.';

/** How long an automatic answer waits for the asker's own poll before it is
 *  pasted into the pane. */
export const AUTO_DELIVERY_GRACE_MS = 20_000;

const MERGE_CHOICES = [
  { key: 'go', label: 'Merge it' },
  { key: 'no-go', label: 'Do not merge' },
] as const;
const AUDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const esc = (reasonCode: string, why: string, judge: MoaJudgeResult | null = null): MoaSettlement => ({
  status: 'escalated', judge, ruleId: null, reasonCode, why,
});
const refuse = (reasonCode: string, why: string, judge: MoaJudgeResult | null = null): MoaSettlement => ({
  status: 'refused', judge, ruleId: null, reasonCode, why,
});

export class MoaAskService implements MoaDelegateServicePort {
  private readonly listeners = new Set<MoaDelegateEvents>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private lastAudit: MoaUnreceiptedMerge[] | undefined;
  /** Auto answers decided but not yet settled: they hold a slot of the
   *  daily cap, so concurrent judgements cannot all pass it. */
  private readonly autoReserved = new Set<string>();
  /** Background judging, by decision id (tests await it). */
  private readonly work = new Map<string, Promise<void>>();
  private readonly courier: MoaAnswerCourier | null;

  constructor(private readonly ports: MoaAskServicePorts) {
    this.now = ports.now ?? Date.now;
    this.log = ports.log ?? ((l) => console.log(l));
    const pane = ports.answerPane;
    this.courier = pane
      ? new MoaAnswerCourier({
          get: (id) => ports.decisions.get(id),
          setDelivery: (id, delivery, from) => ports.decisions.setDelivery(id, delivery, from),
          paneState: pane.state,
          send: pane.send,
          onChange: (d) => this.emitDecision('updated', d),
          now: this.now,
          log: this.log,
          ...(pane.retryMs !== undefined ? { retryMs: pane.retryMs } : {}),
          ...(pane.setTimer ? { setTimer: pane.setTimer } : {}),
        })
      : null;
  }

  // ── moa.ask / moa.askStatus ────────────────────────────────────────────────

  async ask(asker: MoaAsker, cwd: string, req: MoaAskRequest): Promise<MoaAskResult> {
    const mode = this.ports.getConfig().mode;
    if (mode === 'off') return { ok: false, code: 'off', message: 'moa_ask is off; ask the owner yourself' };
    const seen = this.ports.decisions.peek(asker, req.askId, req.body);
    if (seen?.kind === 'reused') return { ok: false, code: 'id-reused', message: 'this askId was already used for another question' };
    if (seen?.kind === 'replay') return { ok: true, ticket: this.ticketOf(seen.decision, true) };
    // A merge's repo comes from the verified cwd, never from the request.
    const repo = req.body.type === 'merge' && cwd ? await this.ports.resolveRepo(cwd).catch(() => null) : null;
    const begun = await this.ports.decisions.begin({
      asker, ...(req.askId ? { askId: req.askId } : {}), body: req.body, mode: mode as MoaDecisionMode, ...(repo ? { repo } : {}),
    });
    if (begun.kind === 'full') return { ok: false, code: 'full', message: 'too many open moa_ask tickets for this pane' };
    if (begun.kind === 'reused') return { ok: false, code: 'id-reused', message: 'this askId was already used for another question' };
    if (begun.kind === 'replay') return { ok: true, ticket: this.ticketOf(begun.decision, true) };
    this.emitDecision('created', begun.decision);
    const job = this.decide(begun.decision, cwd).catch((err) => this.log(`[moa-ask] ${begun.decision.id} failed: ${String(err)}`))
      .finally(() => this.work.delete(begun.decision.id));
    this.work.set(begun.decision.id, job);
    return { ok: true, ticket: this.ticketOf(begun.decision, false) };
  }

  async status(asker: MoaAsker, ticketId: string): Promise<MoaAskStatusResult> {
    if (this.ports.getConfig().mode === 'off') return { ok: false, code: 'off', message: 'moa_ask is off' };
    const d = this.ports.decisions.getForAsker(asker, ticketId);
    if (!d) return { ok: false, code: 'unknown-ticket', message: 'no such ticket for this pane' };
    const view = ticketView(d, d.kind === 'merge' ? this.ports.effects.get(mergeEffectId(d.id)) : null);
    // The asker has its final answer: nothing more to paste into its pane.
    if (view.status === 'answered' || view.status === 'refused') await this.courier?.seen(d.id);
    return { ok: true, ticket: view.status === 'escalated' ? { ...view, next: ESCALATED_NEXT } : view };
  }

  /** The delegate went off or this service is being replaced: no answer is
   *  pasted by this instance any more. */
  stop(): void {
    this.courier?.stop();
  }

  /** Wait for background judging (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.all([...this.work.values()]);
  }

  private ticketOf(d: MoaDecision, replayed: boolean) {
    const view = ticketView(d, d.kind === 'merge' ? this.ports.effects.get(mergeEffectId(d.id)) : null);
    return {
      ticketId: d.ticketId,
      status: view.status,
      ...(replayed ? { replayed: true as const } : {}),
      ...(view.pollAfterMs ? { pollAfterMs: view.pollAfterMs } : {}),
      ...(view.status === 'escalated' ? { next: ESCALATED_NEXT } : {}),
    };
  }

  // ── Judging ────────────────────────────────────────────────────────────────

  private async decide(d: MoaDecision, cwd: string): Promise<void> {
    let s: MoaSettlement;
    let auto = false;
    try {
      const r = d.body.type === 'question' ? await this.decideQuestion(d, cwd) : await this.decideMerge(d, cwd);
      s = r.settlement;
      auto = r.auto;
    } catch (err) {
      s = esc('internal-error', `Moa could not decide this: ${String(err)}`.slice(0, 300));
    }
    let settled: MoaDecision | null;
    try {
      settled = await this.ports.decisions.settle(d.id, s);
    } finally {
      // Settled (or not): the slot is now counted from the store, or freed.
      this.autoReserved.delete(d.id);
    }
    if (!settled) return;
    this.emitDecision('updated', settled);
    // An answer the asker may have stopped polling for: pasted back unless
    // its own poll reads it first.
    if (settled.status === 'answered') void this.courier?.schedule(settled, AUTO_DELIVERY_GRACE_MS);
    // Settled first, then the effect: a crash between the two is repaired at
    // startup (repairMissingEffects), and the executor re-checks everything.
    if (auto && settled.status === 'answered' && settled.receipt === 'done') await this.enqueueAndRun(settled, 'moa-auto');
  }

  /** The judge's verdict for a packet, or the reason none was asked for. */
  private async judgeOnce(
    d: MoaDecision,
    book: PolicyBook & { text: string },
    question: string,
    choices: ReadonlyArray<{ key: string; label: string }>,
    cwd: string,
    prs: ShadowPrFacts[],
    lane?: { passed: boolean; failed: string[] },
  ): Promise<MoaJudgeResult | MoaSettlement> {
    const prior = this.ports.priorJudgment?.(d.questionHash);
    if (prior) return prior;
    if (this.judgeCallsToday() >= (this.ports.judgeDailyCap ?? SHADOW_DAILY_CAP_DEFAULT)) {
      return esc('daily-cap', 'the daily cap of judge calls is reached; the owner answers it in the Moa panel');
    }
    const screen = await this.ports.readScreen(d.asker.ptyId).catch(() => [] as string[]);
    const notes = d.body.context ? [`[agent's note] ${d.body.context}`] : [];
    const packet = buildDecisionPacket({
      recordId: d.id,
      question,
      choices: choices.map((c) => ({ key: c.key, label: c.label })),
      asker: { ...d.asker, ...(cwd ? { cwd } : {}), attribution: 'exact' },
      screenLines: [...screen, ...notes],
      prs,
      ...(lane ? { lane } : {}),
    });
    const result = await this.ports.judge(buildJudgePrompt(book.text, packet));
    if (result.refused) return esc('judge-refused', `the judge was not run: ${result.error ?? 'refused'}`);
    if (result.reply === null) {
      return esc('judge-failed', `the judge call failed: ${result.error ?? 'unknown'}`, {
        verdict: 'escalate', reasonCode: 'judge-failed', why: result.error ?? '', tokens: result.tokens, ms: Math.max(1, result.ms),
      });
    }
    const v = validateJudgeReply(result.reply, { rules: book.rules, choiceKeys: choices.map((c) => c.key), alwaysEscalate: null });
    return {
      verdict: v.verdict === 'answer' && d.kind === 'merge' && v.choiceKey === 'go' ? 'go' : v.verdict === 'answer' && d.kind === 'question' ? 'answer' : 'escalate',
      ...(v.choiceKey ? { choiceKey: v.choiceKey } : {}),
      ...(v.ruleId ? { ruleId: v.ruleId } : {}),
      reasonCode: v.reasonCode,
      why: v.why,
      tokens: result.tokens,
      // A real model call always counts toward the cap.
      ms: Math.max(1, result.ms),
    };
  }

  private async decideQuestion(d: MoaDecision, cwd: string): Promise<{ settlement: MoaSettlement; auto: false }> {
    if (d.body.type !== 'question') throw new Error('not a question');
    const book = this.ports.loadBook();
    if (!book || book.rules.size === 0) return { settlement: esc('no-policy-book', 'the policy book has no rules; the owner answers it in the Moa panel'), auto: false };
    const category = precheckAlwaysEscalate(d.body.question, d.body.options.map((o) => o.label), book.alwaysEscalate);
    if (category) return { settlement: esc(`always-escalate-${category}`, `this is a "${category}" question; the owner answers it in the Moa panel`), auto: false };
    const j = await this.judgeOnce(d, book, d.body.question, d.body.options, cwd, []);
    if (!isJudge(j)) return { settlement: j, auto: false };
    // A free question has no deterministic predicate: never auto, in any mode.
    if (j.verdict !== 'answer' || !j.ruleId) return { settlement: esc(j.reasonCode, 'Moa would not settle this; the owner answers it in the Moa panel', j), auto: false };
    const why = d.mode === 'shadow' ? 'recorded only; the owner answers it in the Moa panel' : 'Moa suggested an answer to the owner; the owner answers it in the Moa panel';
    if (d.mode === 'auto') {
      const e = moaAutoEligibility({ book, ruleId: j.ruleId, ownerAutoRules: this.ports.getConfig().autoRules, kind: 'question', predicatePassed: false });
      return { settlement: esc(e.eligible ? 'auto-no-predicate' : `auto-${e.reason}`, 'a question never settles by itself; the owner answers it in the Moa panel', j), auto: false };
    }
    return { settlement: esc(d.mode === 'shadow' ? 'shadow' : 'suggested', why, j), auto: false };
  }

  private async decideMerge(d: MoaDecision, cwd: string): Promise<{ settlement: MoaSettlement; auto: boolean }> {
    if (d.body.type !== 'merge') throw new Error('not a merge');
    const body = d.body;
    if (!d.repo) return { settlement: refuse('no-repo', 'your working directory is not in a GitHub repository wmux can read'), auto: false };
    let facts: PrLaneFacts;
    try {
      facts = await this.ports.facts.readFresh(d.repo.path, d.repo.key, body.prNumber);
    } catch {
      return { settlement: esc('lane-read-failed', 'the pull request could not be read; the owner answers it in the Moa panel'), auto: false };
    }
    if (facts.number !== body.prNumber) return { settlement: refuse('pr-mismatch', 'GitHub answered for another pull request'), auto: false };
    if (facts.state !== 'OPEN') return { settlement: refuse('not-open', `the pull request is ${facts.state.toLowerCase() || 'not open'}`), auto: false };
    if (facts.headRefOid !== body.expectHead) return { settlement: refuse('head-moved', 'the pull request has another head than expectHead'), auto: false };
    const [lane, mergeFacts] = await Promise.all([this.evaluateLane(d, facts), this.mergeFacts(d.repo, facts)]);
    const laneFacts = { passed: lane.ok, failed: lane.failures.map((f) => f.reason) };
    const withLane = (r: { settlement: MoaSettlement; auto: boolean }) => ({
      ...r,
      settlement: { ...r.settlement, lane: { ok: lane.ok, reasons: laneFacts.failed }, ...(mergeFacts ? { facts: mergeFacts } : {}) },
    });
    const book = this.ports.loadBook();
    if (!book || book.rules.size === 0) return withLane({ settlement: esc('no-policy-book', 'the policy book has no rules; the owner answers it in the Moa panel'), auto: false });
    const question = `Merge pull request #${body.prNumber} (head ${body.expectHead.slice(0, 12)}) into ${facts.baseRefName || 'its base'}?`;
    // The facts a rule like "required checks green, the owner's own PR" needs,
    // as wmux read them; the lane's verdict rides in its own packet section.
    const prs: ShadowPrFacts[] = [{
      number: facts.number,
      state: facts.state,
      isDraft: facts.isDraft,
      headSha: facts.headRefOid,
      mergeStateStatus: facts.mergeStateStatus ?? 'UNKNOWN',
      author: facts.author,
      labels: facts.labels,
      checks: facts.checks.map((c) => ({ name: c.name, bucket: c.bucket, isRequired: c.isRequired === true })),
    }];
    const laneWhy = lane.ok ? '' : ` (lane: ${laneFacts.failed.join(', ')})`;
    const j = await this.judgeOnce(d, book, question, MERGE_CHOICES, cwd, prs, laneFacts);
    // A judge that failed (a timeout, the cap) still leaves the lane's own
    // objections on the card.
    if (!isJudge(j)) return withLane({ settlement: { ...j, ...(lane.ok ? {} : { reasonCode: laneCode(lane), why: `${j.why}${laneWhy}` }) }, auto: false });
    if (j.verdict !== 'go' || !j.ruleId) return withLane({ settlement: esc(lane.ok ? j.reasonCode : laneCode(lane), `Moa would not merge this${laneWhy}; the owner answers it in the Moa panel`, j), auto: false });
    if (d.mode !== 'auto') return withLane({ settlement: esc(d.mode === 'shadow' ? 'shadow' : 'suggested', `recorded for the owner${laneWhy}; the owner answers it in the Moa panel`, j), auto: false });
    const cfg = this.ports.getConfig();
    const e = moaAutoEligibility({ book, ruleId: j.ruleId, ownerAutoRules: cfg.autoRules, kind: 'merge', predicatePassed: lane.ok });
    if (!e.eligible) return withLane({ settlement: esc(e.reason === 'predicate-failed' ? laneCode(lane) : `auto-${e.reason}`, `Moa may not merge this by itself${laneWhy}; the owner answers it in the Moa panel`, j), auto: false });
    if (cfg.autoPaused) return withLane({ settlement: esc('auto-paused', 'automatic answers are paused; the owner answers it in the Moa panel', j), auto: false });
    // Checked and reserved in one synchronous step (no await in between), so
    // two judgements finishing together cannot both take the last slot.
    if (this.autoAnswersToday() + this.autoReserved.size >= (cfg.autoDailyCap ?? MOA_AUTO_DAILY_CAP_DEFAULT)) {
      return withLane({ settlement: esc('auto-daily-cap', 'the daily cap of automatic answers is reached; the owner answers it in the Moa panel', j), auto: false });
    }
    this.autoReserved.add(d.id);
    return withLane({
      settlement: { status: 'answered', judge: j, ruleId: j.ruleId, reasonCode: 'auto-merge', why: j.why || `rule ${j.ruleId}`, answer: { actionVerdict: 'go' } },
      auto: true,
    });
  }

  /** The card's PrMergeFacts on the lane read; null when the extras are unknown. */
  private async mergeFacts(repo: { key: string; path: string }, lane: PrLaneFacts): Promise<PrMergeFacts | null> {
    const extras = await this.ports.mergeFactsExtras?.(repo).catch(() => null);
    return extras ? buildMergeFacts(lane, extras) : null;
  }

  private async evaluateLane(d: MoaDecision, facts: PrLaneFacts): Promise<LaneVerdict> {
    if (d.body.type !== 'merge' || !d.repo) return { ok: false, failures: [{ predicate: 'head-unchanged', reason: 'not-a-merge' }] };
    const askerBranches = await this.ports.askerBranches(d.asker, d.repo.path).catch(() => [] as string[]);
    return evaluateMergeLane(facts, { expectHead: d.body.expectHead, trustedAuthors: this.ports.getConfig().trustedAuthors, askerBranches });
  }

  private judgeCallsToday(): number {
    const since = startOfLocalDay(this.now());
    return this.ports.decisions.list().filter((d) => d.createdAt >= since && d.judge !== null && d.judge.ms > 0).length;
  }

  private autoAnswersToday(): number {
    const since = startOfLocalDay(this.now());
    return this.ports.decisions.list().filter((d) => d.resolvedBy === 'moa-auto' && (d.resolvedAt ?? 0) >= since).length;
  }

  // ── Effects ────────────────────────────────────────────────────────────────

  private async enqueueAndRun(d: MoaDecision, approvedBy: MergeEffect['approvedBy']): Promise<MergeEffect | null> {
    if (d.body.type !== 'merge' || !d.repo) return null;
    const effect = await this.ports.effects.enqueue({
      decisionId: d.id, repoKey: d.repo.key, repoPath: d.repo.path, prNumber: d.body.prNumber, expectHead: d.body.expectHead, approvedBy,
    });
    this.emitEffect(effect);
    void this.ports.executor.run(effect.id);
    return effect;
  }

  /**
   * The executor's gate, asked on every try: the decision behind the effect
   * reads answered/go NOW, by the same party, and an auto merge is still
   * auto-eligible (book, toggle, kill switch). Null = may run.
   */
  authorize(effect: MergeEffect): string | null {
    const d = this.ports.decisions.get(effect.decisionId);
    if (!d || d.kind !== 'merge' || d.body.type !== 'merge') return 'no-decision';
    if (d.status !== 'answered' || !d.answer || !('actionVerdict' in d.answer) || d.answer.actionVerdict !== 'go') return 'not-approved';
    if (d.resolvedBy !== effect.approvedBy) return 'approver-mismatch';
    if (d.body.prNumber !== effect.prNumber || d.body.expectHead !== effect.expectHead || d.repo?.key !== effect.repoKey || d.repo?.path !== effect.repoPath) {
      return 'target-mismatch';
    }
    if (effect.approvedBy === 'moa-auto') {
      const cfg = this.ports.getConfig();
      if (cfg.mode !== 'auto') return 'auto-mode-off';
      if (cfg.autoPaused) return 'auto-paused';
      // This decision is one of today's auto answers; more than the cap (the
      // owner lowered it since) refuses.
      if (this.autoAnswersToday() > (cfg.autoDailyCap ?? MOA_AUTO_DAILY_CAP_DEFAULT)) return 'auto-daily-cap';
      const book = this.ports.loadBook();
      if (!book || !d.ruleId) return 'no-rule';
      // The lane predicate itself is re-run on the executor's fresh read.
      const e = moaAutoEligibility({ book, ruleId: d.ruleId, ownerAutoRules: cfg.autoRules, kind: 'merge', predicatePassed: true });
      if (!e.eligible) return `auto-${e.reason}`;
    }
    return null;
  }

  /**
   * The executor's identity gate: a decision whose card showed a gh login
   * merges only as that login. `identity-changed` when gh now signs in as
   * another account, `identity-unknown` when the login cannot be read.
   * Decisions without facts (stored before them) showed no login: null.
   */
  async identity(effect: MergeEffect): Promise<string | null> {
    const shown = this.ports.decisions.get(effect.decisionId)?.facts?.identity.login;
    if (!shown) return null;
    const now = await this.ports.currentLogin?.({ key: effect.repoKey, path: effect.repoPath }).catch(() => null) ?? null;
    if (!now) return 'identity-unknown';
    return now.toLowerCase() === shown.toLowerCase() ? null : 'identity-changed';
  }

  /** The lane context for an effect's asker, read now. */
  async laneContext(effect: MergeEffect): Promise<{ trustedAuthors: readonly string[]; askerBranches: readonly string[] }> {
    const d = this.ports.decisions.get(effect.decisionId);
    const askerBranches = d ? await this.ports.askerBranches(d.asker, effect.repoPath).catch(() => [] as string[]) : [];
    return { trustedAuthors: this.ports.getConfig().trustedAuthors, askerBranches };
  }

  // ── Startup and the periodic tick ──────────────────────────────────────────

  /** Re-enqueue answered-go merges whose effect a crash lost, reconcile the
   *  outbox, and run the audit. Never re-judges a decision. */
  async start(): Promise<void> {
    for (const d of this.ports.decisions.list()) {
      if (d.kind !== 'merge' || d.status !== 'answered' || !d.answer || !('actionVerdict' in d.answer) || d.answer.actionVerdict !== 'go') continue;
      if (d.resolvedBy !== 'owner' && d.resolvedBy !== 'moa-auto') continue;
      if (this.ports.effects.get(mergeEffectId(d.id))) continue;
      if (!d.repo || d.body.type !== 'merge') continue;
      const effect = await this.ports.effects.enqueue({
        decisionId: d.id, repoKey: d.repo.key, repoPath: d.repo.path, prNumber: d.body.prNumber, expectHead: d.body.expectHead, approvedBy: d.resolvedBy,
      });
      this.emitEffect(effect);
    }
    // Deliveries still queued when main stopped, and final answers main
    // stopped before it could queue (a crash between saving the answer and
    // saving `waiting`): recent ones only, so an old record is never pasted.
    const since = this.now() - COURIER_MAX_WAIT_MS;
    for (const d of this.ports.decisions.list()) {
      const queued = d.delivery?.state === 'waiting';
      const lost = !d.delivery && (d.resolvedBy === 'owner' || d.resolvedBy === 'moa-auto') && d.resolvedAt !== null && d.resolvedAt >= since;
      if (queued || lost) void this.courier?.schedule(d);
    }
    await this.tick();
  }

  /** Expire stale escalations, reconcile uncertain merges, run what is due. */
  async tick(): Promise<void> {
    try {
      for (const d of await this.ports.decisions.expire()) this.emitDecision('updated', d);
    } catch (err) {
      this.log(`[moa-ask] expire failed: ${String(err)}`);
    }
    await this.ports.executor.reconcileAll();
  }

  /** PRs merged in the last 24 h, in repos the lane touched, with no lane
   *  receipt. Display only. */
  async audit(): Promise<MoaUnreceiptedMerge[]> {
    if (!this.ports.mergedSince) return [];
    const repos = new Map<string, { key: string; path: string }>();
    for (const d of this.ports.decisions.list()) if (d.kind === 'merge' && d.repo) repos.set(d.repo.key, d.repo);
    for (const e of this.ports.effects.list()) repos.set(e.repoKey, { key: e.repoKey, path: e.repoPath });
    const receipts = new Set(this.ports.effects.list().filter((e) => e.status === 'done').map((e) => `${e.repoKey}#${e.prNumber}`));
    const sinceIso = new Date(this.now() - AUDIT_WINDOW_MS).toISOString().slice(0, 19) + 'Z';
    const out: MoaUnreceiptedMerge[] = [];
    for (const repo of repos.values()) {
      const merged = await this.ports.mergedSince(repo, sinceIso).catch(() => null);
      for (const m of merged ?? []) if (!receipts.has(`${repo.key}#${m.prNumber}`)) out.push({ repoKey: repo.key, ...m });
    }
    this.lastAudit = out;
    const event: MoaAuditEvent = { checkedAt: this.now(), unreceipted: out };
    for (const l of this.listeners) {
      try { l.audit?.(event); } catch { /* a listener never breaks the audit */ }
    }
    return out;
  }

  // ── Owner IPC (renderer only) ──────────────────────────────────────────────

  async list(): Promise<MoaDelegateListResult> {
    const cfg = this.ports.getConfig();
    const decisions = this.ports.decisions.list();
    const book = this.ports.loadBook();
    const rules: MoaRuleView[] = [];
    for (const [ruleId, text] of book?.rules ?? []) {
      const attrs = book?.attrs.get(ruleId);
      rules.push({
        ruleId,
        text,
        autoInBook: attrs?.auto === true,
        predicate: attrs?.predicate ?? null,
        autoOn: cfg.autoRules.includes(ruleId),
        agreement: agreementFor(ruleId, decisions),
      });
    }
    return {
      mode: cfg.mode,
      decisions,
      effects: this.ports.effects.list(),
      rules,
      ...(this.lastAudit ? { unreceiptedMerges: this.lastAudit } : {}),
    };
  }

  async resolveByOwner(req: MoaResolveRequest): Promise<MoaResolveResult> {
    const r = await this.ports.decisions.resolveByOwner(req.decisionId, req.answer);
    if (!r.ok) return r;
    this.emitDecision('updated', r.decision);
    // The asker ended its turn on the escalation: its answer is pasted back.
    void this.courier?.schedule(r.decision);
    if (req.answer.type === 'merge' && req.answer.approve) {
      const effect = await this.enqueueAndRun(r.decision, 'owner');
      return { ok: true, decision: r.decision, ...(effect ? { effect } : {}) };
    }
    return { ok: true, decision: r.decision };
  }

  async setAutoRule(req: MoaAutoRuleSetRequest): Promise<MoaAutoRuleSetResult> {
    const book = this.ports.loadBook();
    if (req.auto && !book?.rules.has(req.ruleId)) return { ok: false, code: 'invalid', message: 'the policy book has no such rule' };
    const current = new Set(this.ports.getConfig().autoRules);
    if (req.auto) current.add(req.ruleId);
    else current.delete(req.ruleId);
    const next = sanitizeAutoRules([...current]);
    const saved = await this.ports.setAutoRules(next).catch(() => false);
    if (!saved) return { ok: false, code: 'store-error', message: 'the setting could not be saved' };
    return { ok: true, autoRules: next };
  }

  subscribe(listener: MoaDelegateEvents): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emitEffect(effect: MergeEffect): void {
    for (const l of this.listeners) {
      try { l.effect({ effect }); } catch { /* a listener never breaks the service */ }
    }
  }

  private emitDecision(type: 'created' | 'updated', decision: MoaDecision): void {
    for (const l of this.listeners) {
      try { l.decision({ type, decision }); } catch { /* a listener never breaks the service */ }
    }
  }
}

function isJudge(v: MoaJudgeResult | MoaSettlement): v is MoaJudgeResult {
  return 'verdict' in v;
}

function laneCode(lane: LaneVerdict): string {
  const f = lane.failures[0];
  return f ? `lane-${f.reason}` : 'lane';
}

/** Owner-settled decisions whose judge answered under `ruleId`, and how many
 *  the owner answered the same way. DISPLAY ONLY. */
export function agreementFor(ruleId: string, decisions: readonly MoaDecision[]): { compared: number; agreed: number } {
  let compared = 0;
  let agreed = 0;
  for (const d of decisions) {
    if (d.resolvedBy !== 'owner' || !d.answer || !d.judge || d.judge.ruleId !== ruleId) continue;
    if (d.judge.verdict === 'answer' && 'choiceKey' in d.answer) {
      compared++;
      if (d.answer.choiceKey === d.judge.choiceKey) agreed++;
    } else if (d.judge.verdict === 'go' && 'actionVerdict' in d.answer) {
      compared++;
      if (d.answer.actionVerdict === 'go') agreed++;
    }
  }
  return { compared, agreed };
}
