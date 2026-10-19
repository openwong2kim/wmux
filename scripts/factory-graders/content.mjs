// Real-model graders (`model: real`): the same routing checks as the stub
// scenarios plus what only a model decides — whether the output says the
// right things. The behaviour under test is never in the scenario's message;
// it has to come from the role prompt.

import { arr, botCards, botId, cardsOfKind, criterion, factsOfKind, handoffsOfKind, wakesOf } from './common.mjs';

/** 20. triage-real-issue: a triage card and a PR (draft or ready) from its repro worker. */
export function triageRealIssue(snap, expect) {
  const cards = botCards(snap, expect.bot);
  const triage = cards.filter((c) => c.kind === 'triage');
  const tasks = arr(snap.ledger).filter((e) => e.dispatch?.origin?.botId === botId(snap, expect.bot));
  const prs = arr(snap.gh?.state?.repos?.['github.com/acme/app']?.prs);
  const turns = wakesOf(snap, expect.bot).filter((w) => w.state === 'done').length;
  return [
    criterion('triage_card_in_issue_thread', triage.length >= 1 && triage.every((c) => c.threadId === expect.thread), triage.map((c) => c.threadId).join(', ') || 'none'),
    criterion('repro_worker_started', tasks.some((e) => e.dispatch?.preset === 'repro'), tasks.map((e) => e.dispatch?.preset).join(', ') || 'none'),
    criterion('names_the_bug', triage.some((c) => new RegExp(expect.bugPattern, 'i').test(`${c.title}\n${c.body ?? ''}`)), expect.bugPattern),
    criterion('pr_or_no_repro', prs.length > 0 || cards.some((c) => /no-repro/i.test(c.body ?? '')), `${prs.length} PR(s)`),
    criterion('within_turns', turns > 0 && turns <= (expect.maxTurns ?? 6), `${turns} turn(s)`),
  ];
}

/** 21. verifier-real-pr: a verdict with evidence at the head, in few turns. */
export function verifierRealPr(snap, expect) {
  const vid = botId(snap, expect.bot);
  const facts = factsOfKind(snap, 'verdict.recorded').filter((f) => f.ref?.botId === vid);
  const pr = arr(snap.gh?.state?.repos?.['github.com/acme/app']?.prs).find((p) => p.number === (expect.pr ?? 1)) ?? null;
  const rec = arr(snap.verdicts).find((v) => v.principal?.botId === vid && v.prNumber === (expect.pr ?? 1)) ?? null;
  const row = rec?.evidence?.taskId ? arr(snap.ledger).find((e) => e.id === rec.evidence.taskId) ?? null : null;
  const turns = wakesOf(snap, expect.bot).filter((w) => w.state === 'done').length;
  return [
    criterion('verdict_recorded', facts.length >= 1, `${facts.length} verdict fact(s)`),
    criterion('verdict_at_pr_head', !!rec && !!pr && rec.headSha === pr.headSha, rec ? `${rec.headSha.slice(0, 7)} vs PR ${pr?.headSha?.slice(0, 7) ?? '-'}` : 'none'),
    criterion('evidence_at_head', !!rec && rec.evidence?.gateHeadSha === rec.headSha, rec ? `${rec.headSha.slice(0, 7)} / ${rec.evidence?.gateHeadSha?.slice(0, 7)}` : 'none'),
    criterion('evidence_is_system_gate_on_verify_task', !!row && row.dispatch?.preset === 'verify' && row.dispatch?.origin?.botId === vid
      && row.gate?.recordedBy === 'system' && row.gate?.headSha === rec.headSha && !row.gate?.skipped, row ? `${row.id} ${row.dispatch?.preset} gate ${row.gate?.exitCode}` : 'no ledger row'),
    criterion('within_turns', turns > 0 && turns <= (expect.maxTurns ?? 5), `${turns} turn(s)`),
  ];
}

/** 22 (model). moa-morning-report-real: one report and one plan, and the
 *  report carries the trust numbers the role prompt asks for. */
export function moaMorningReportReal(snap, expect) {
  const moa = botId(snap, expect.moa);
  const reports = botCards(snap, expect.moa).filter((c) => c.kind === 'report');
  const plans = cardsOfKind(snap, 'plan').filter((c) => c.actor?.botId === moa);
  const text = reports.map((c) => `${c.title}\n${c.body ?? ''}`).join('\n');
  const wakes = wakesOf(snap, expect.moa);
  return [
    criterion('woken_once', wakes.length === 1 && wakes[0].state === 'done', wakes.map((w) => w.state).join(', ') || 'none'),
    criterion('one_report_card', reports.length === 1, `${reports.length} report card(s)`),
    criterion('at_most_one_plan', plans.length <= 1, `${plans.length} plan card(s)`),
    criterion('report_has_trust_metrics', /revert/i.test(text) && /surviv/i.test(text), text.slice(0, 200)),
    criterion('report_mentions_open_issue', new RegExp(expect.issuePattern, 'i').test(text), expect.issuePattern),
    criterion('no_dispatch_without_approval', handoffsOfKind(snap, 'dispatch').length + factsOfKind(snap, 'handoff.received').length === 0,
      `${handoffsOfKind(snap, 'dispatch').length} dispatch(es), ${factsOfKind(snap, 'handoff.received').length} delivery fact(s)`),
  ];
}

/** researcher-dispatch-real: the researcher's dispatch wake settles done and
 *  its answer went back as a result handoff (its wmux tools were reached);
 *  a wake that settled done with nothing sent is the 4.5.0 silent failure. */
export function researcherDispatchReal(snap, expect) {
  const lead = botId(snap, expect.lead);
  const researcher = botId(snap, expect.researcher);
  const dispatch = handoffsOfKind(snap, 'dispatch').find((h) => h.from?.botId === lead && h.to?.botId === researcher) ?? null;
  const wakes = wakesOf(snap, expect.researcher).filter((w) => w.reason?.kind === 'handoff' && w.reason.handoffId === dispatch?.id);
  // A refused attempt keeps its text but reached nobody.
  const results = handoffsOfKind(snap, 'result').filter((h) => h.from?.botId === researcher && h.replyTo === dispatch?.id && h.status !== 'refused');
  const sentSomething = results.length > 0 || botCards(snap, expect.researcher).length > 0;
  const text = results.map((h) => `${h.payload?.title ?? ''}\n${h.payload?.body ?? ''}`).join('\n');
  return [
    criterion('dispatch_delivered', dispatch !== null, dispatch ? dispatch.id : 'no dispatch to the researcher'),
    criterion('researcher_wake_done', wakes.length > 0 && wakes.every((w) => w.state === 'done'), wakes.map((w) => w.state).join(', ') || 'none'),
    criterion('result_sent', results.length > 0, `${results.length} result handoff(s)`),
    criterion('result_answers', new RegExp(expect.answerPattern, 'i').test(text), text.slice(0, 200)),
    criterion('no_silent_done', !(wakes.some((w) => w.state === 'done') && !sentSomething), sentSomething ? 'sent' : 'nothing sent'),
  ];
}
