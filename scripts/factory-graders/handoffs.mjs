// Handoff graders: dispatch / result callbacks, chain limits, questions to
// the owner, the owner's corrections, and the HQ bot's morning output.

import { arr, botCards, botId, cardsOfKind, criterion, factsOfKind, handoffsOfKind, injected, stubTools, parseToolText, wakesOf } from './common.mjs';

/** 8. callback-exactly-once. */
export function callbackExactlyOnce(snap, expect) {
  const sender = botId(snap, expect.sender);
  const receiver = botId(snap, expect.receiver);
  const results = handoffsOfKind(snap, 'result').filter((h) => h.from?.botId === sender);
  const delivered = results.filter((h) => h.status === 'delivered' || h.status === 'answered');
  const refused = results.filter((h) => h.status === 'refused' && h.refusal?.code === 'duplicate_result');
  const handoffWakes = wakesOf(snap, expect.receiver).filter((w) => w.reason?.kind === 'handoff' && w.state === 'done');
  const refusalCards = cardsOfKind(snap, 'refusal');
  return [
    criterion('two_results_sent', results.length === 2, `${results.length} result handoff(s)`),
    criterion('one_result_delivered', delivered.length === 1 && delivered[0].to?.botId === receiver, delivered.map((h) => `${h.id}:${h.status}`).join(', ') || 'none'),
    criterion('second_refused_duplicate', refused.length === 1, results.map((h) => `${h.status}/${h.refusal?.code ?? '-'}`).join(', ')),
    criterion('receiver_woken_once', handoffWakes.length === 1 && handoffWakes[0].reason.handoffId === delivered[0]?.id, `${handoffWakes.length} handoff wake(s)`),
    criterion('refusal_card', refusalCards.length >= 1, `${refusalCards.length} refusal card(s)`),
  ];
}

/** 11. hop-limit-refusal: depth climbs 1..maxDepth, the next hop is
 *  refused, nothing past it. */
export function hopLimitRefusal(snap, expect) {
  const max = expect.maxDepth ?? 6;
  const hs = arr(snap.handoffs);
  const refused = hs.filter((h) => h.status === 'refused' && h.refusal?.code === expect.code);
  const deliveredDepths = hs.filter((h) => h.status !== 'refused').map((h) => h.depth).sort((a, b) => a - b);
  const facts = factsOfKind(snap, 'handoff.refused');
  const runIds = new Set(hs.map((h) => h.runId));
  // A Coordinator's chain starts at depth 0, any other bot's at 1.
  const start = expect.startDepth ?? 0;
  const want = Array.from({ length: max - start + 1 }, (_, i) => i + start);
  return [
    criterion('chain_climbs_to_limit', JSON.stringify(deliveredDepths) === JSON.stringify(want), `delivered depths ${deliveredDepths.join(',')}`),
    criterion(`refused_${expect.code}`, refused.length === 1 && refused[0].depth === max + 1, refused.map((h) => `depth ${h.depth}`).join(', ') || 'none'),
    criterion('one_run', runIds.size === 1, `${runIds.size} run id(s)`),
    criterion('refused_fact', facts.length === 1 && facts[0].ref?.handoffId === refused[0]?.id, `${facts.length} handoff.refused fact(s)`),
    criterion('refusal_card', cardsOfKind(snap, 'refusal').length >= 1, `${cardsOfKind(snap, 'refusal').length} refusal card(s)`),
    criterion('nothing_past_limit', hs.every((h) => h.depth <= max + 1) && hs.length === want.length + 1, `${hs.length} handoff(s)`),
  ];
}

/** 4. interleaved-worker-reports. */
export function interleavedWorkerReports(snap, expect) {
  const leadId = botId(snap, expect.lead);
  const tasks = arr(snap.ledger).filter((e) => e.dispatch?.origin?.botId === leadId);
  // A report reaches the lead after main's gate on it (task.gated:…); a
  // snapshot from before that gate existed carries task.review_requested:….
  const reportWakes = wakesOf(snap, expect.lead).filter((w) => w.reason?.kind === 'facts' && arr(w.reason.factIds).some((id) => /^task\.(review_requested|gated):/.test(id)));
  const reported = new Set(reportWakes.flatMap((w) => arr(w.reason.factIds)).map((id) => (/^task\.[a-z_]+:(.+)@\d+$/.exec(id) ?? [])[1]).filter(Boolean));
  const results = handoffsOfKind(snap, 'result').filter((h) => h.from?.botId === leadId);
  const delivered = results.filter((h) => h.status === 'delivered' || h.status === 'answered');
  const moaHandoffWakes = wakesOf(snap, expect.moa).filter((w) => w.reason?.kind === 'handoff' && w.state === 'done');
  const others = arr(snap.wakes).filter((w) => w.botId !== leadId && w.botId !== botId(snap, expect.moa));
  return [
    // Reported, and completed when main's gate on the report passed.
    criterion('tasks_reported', tasks.length === expect.tasks && tasks.every((e) => e.status === 'review_requested' || e.status === 'completed'), tasks.map((e) => e.status).join(', ') || 'no tasks'),
    // Task wakes are pinned to each task's thread and merge only within one
    // thread (fanoutCallerNotify installBotFanoutWake), so N reports are N
    // lead turns by design; the count is reported, not graded.
    criterion('every_report_reached_lead', tasks.length === expect.tasks && tasks.every((e) => reported.has(e.id)),
      `${reported.size}/${tasks.length} task(s) in ${reportWakes.length} lead wake(s)`),
    criterion('one_result_to_moa', delivered.length === 1 && moaHandoffWakes.filter((w) => w.reason.handoffId === delivered[0].id).length === 1, `${delivered.length} delivered of ${results.length} result(s)`),
    criterion('extra_results_refused', results.length - delivered.length === results.filter((h) => h.refusal?.code === 'duplicate_result').length, results.map((h) => h.refusal?.code ?? h.status).join(', ')),
    criterion('no_other_bot_woken', others.length === 0, `${others.length} other wake(s)`),
  ];
}

/** 9. ask-person-question-card. */
export function askPersonQuestionCard(snap, expect) {
  const id = botId(snap, expect.bot);
  const question = cardsOfKind(snap, 'question')[0] ?? null;
  const ask = handoffsOfKind(snap, 'ask_person').find((h) => h.from?.botId === id) ?? null;
  const answer = handoffsOfKind(snap, 'answer').find((h) => h.to?.botId === id) ?? null;
  const answerWake = wakesOf(snap, expect.bot).find((w) => w.reason?.kind === 'handoff' && w.reason.handoffId === answer?.id) ?? null;
  const after = botCards(snap, expect.bot).filter((c) => c.title === 'Answer received');
  return [
    criterion('question_in_wake_thread', !!question && question.threadId === expect.thread, question?.threadId ?? 'no question card'),
    criterion('question_resolved', question?.state === 'resolved', question?.state ?? 'none'),
    criterion('ask_recorded', !!ask && ask.threadId === expect.thread, ask ? `${ask.status} in ${ask.threadId}` : 'no ask_person handoff'),
    criterion('answer_handoff_carries_choice', !!answer && JSON.stringify(answer.payload ?? {}).includes(expect.answer), answer ? answer.payload?.body?.slice(0, 120) ?? '' : 'no answer handoff'),
    criterion('asker_woken_with_answer', !!answerWake && answerWake.state === 'done' && answerWake.threadId === expect.thread, answerWake ? `${answerWake.state} ${answerWake.threadId}` : 'no answer wake'),
    criterion('followup_card_in_thread', after.length === 1 && after[0].threadId === expect.thread, after.map((c) => c.threadId).join(', ') || 'none'),
  ];
}

/** human.correction on plan decline. */
export function humanCorrectionPlanDecline(snap, expect) {
  const moa = botId(snap, expect.moa);
  const plan = cardsOfKind(snap, 'plan')[0] ?? null;
  const corrections = factsOfKind(snap, 'human.correction').filter((f) => f.ref?.botId === moa);
  // handoffs.jsonl exists only once a handoff was ever sent: also read the
  // facts a delivery writes, so a missing file cannot hide a dispatch.
  const dispatches = [...handoffsOfKind(snap, 'dispatch'), ...factsOfKind(snap, 'handoff.received')];
  const leadWakes = wakesOf(snap, expect.lead);
  const moaWakes = wakesOf(snap, expect.moa);
  return [
    criterion('plan_card_resolved', plan?.state === 'resolved', plan?.state ?? 'no plan card'),
    criterion('correction_recorded', corrections.length === 1 && corrections[0].payload?.category === expect.category, corrections.map((f) => f.payload?.category).join(', ') || 'none'),
    criterion('nothing_dispatched', dispatches.length === 0 && leadWakes.length === 0, `${dispatches.length} dispatch(es), ${leadWakes.length} lead wake(s)`),
    // A decline is recorded, not delivered: it costs Moa no turn (morningReport.ts routePlanAnswer).
    criterion('decline_costs_no_turn', moaWakes.length === 1, moaWakes.map((w) => `${w.reason?.kind}@${w.threadId ?? '-'}`).join(', ')),
  ];
}

/** 22. moa-morning-report (shape). */
export function moaMorningReport(snap, expect) {
  const moa = botId(snap, expect.moa);
  const wakes = wakesOf(snap, expect.moa);
  const reports = botCards(snap, expect.moa).filter((c) => c.kind === 'report');
  const plans = cardsOfKind(snap, 'plan');
  const propose = stubTools(snap, expect.moa, 'plan_propose').map((e) => parseToolText(e.text));
  const plan = plans[0] ?? null;
  return [
    criterion('woken_once_by_schedule', wakes.length === 1 && wakes[0].reason?.kind === 'facts' && wakes[0].reason.trigger?.kind === 'schedule.fired', wakes.map((w) => w.reason?.trigger?.kind ?? w.reason?.kind).join(', ')),
    criterion('one_report_card', reports.length === 1 && reports[0].workspaceId === snap.workspaceId, `${reports.length} report card(s)`),
    criterion('one_open_plan_card', plans.length === 1 && plan.state === 'open' && plan.actor?.botId === moa, `${plans.length} plan card(s), state ${plan?.state ?? '-'}`),
    criterion('plan_names_target_workspace', !!plan && !!snap.workspaceId
      && (`${plan.body ?? ''}`.includes(snap.workspaceId) || propose.some((p) => JSON.stringify(p ?? {}).includes(snap.workspaceId))), plan?.body?.slice(0, 160) ?? 'none'),
    criterion('no_lead_woken', arr(snap.wakes).every((w) => w.botId === moa), `${arr(snap.wakes).length} wake(s) total`),
  ];
}


/** lead-task-system-gate: a lead task's report is gated and completed by
 *  main, and the lead takes one turn after it without settling the task. */
export function leadTaskSystemGate(snap, expect) {
  const leadId = botId(snap, expect.lead);
  const lead = arr(snap.bots).find((b) => b.id === leadId) ?? null;
  const tasks = arr(snap.ledger).filter((e) => e.dispatch?.origin?.botId === leadId);
  const task = tasks.length === 1 ? tasks[0] : null;
  const gate = task?.gate ?? null;
  const reports = arr(snap.workers).filter((e) => e.event === 'ledger_update');
  const taskWakes = wakesOf(snap, expect.lead).filter((w) => w.reason?.kind === 'facts' && arr(w.reason.factIds).some((id) => /^task\./.test(id)));
  const gatedWakes = taskWakes.filter((w) => arr(w.reason.factIds).some((id) => id.startsWith(`task.gated:${task?.id}@`)));
  const settles = stubTools(snap, expect.lead, 'ledger_update');
  const checked = arr(snap.cards).filter((c) => c.actor?.kind === 'system' && c.title === 'Task checked: gate passed, task completed');
  return [
    criterion('one_task', !!task, `${tasks.length} lead task(s)`),
    criterion('worker_reported', reports.length >= 1, `${reports.length} worker report(s)`),
    criterion('system_gate_passed', !!gate && gate.recordedBy === 'system' && gate.exitCode === 0 && !gate.skipped, gate ? `exit ${gate.exitCode} by ${gate.recordedBy}${gate.skipped ? ` (${gate.skipped})` : ''}` : 'no gate'),
    criterion('completed_unforced_as_owner', task?.status === 'completed' && task.updatedBy?.kind === 'brain' && task.updatedBy.workspaceId === lead?.workspaceId && !String(task.summary ?? '').includes('[forced:'),
      task ? `${task.status} by ${task.updatedBy?.kind}` : 'no task'),
    criterion('lead_woken_once_after_gate', taskWakes.length === 1 && gatedWakes.length === 1 && gatedWakes[0].state === 'done',
      taskWakes.map((w) => `${arr(w.reason.factIds).join('+')}:${w.state}`).join(', ') || 'no task wake'),
    criterion('lead_did_not_settle', settles.length === 0, `${settles.length} ledger_update call(s) by the lead`),
    criterion('checked_card', checked.length === 1, `${checked.length} checked card(s)`),
  ];
}

/** research-no-repo-closes: a repo-less researcher's research task runs in
 *  a scratch folder under the bot's data folder and its report completes it
 *  without a gate; the researcher takes one turn after it. */
export function researchNoRepoCloses(snap, expect) {
  const id = botId(snap, expect.researcher);
  const bot = arr(snap.bots).find((b) => b.id === id) ?? null;
  const tasks = arr(snap.ledger).filter((e) => e.dispatch?.origin?.botId === id);
  const task = tasks.length === 1 ? tasks[0] : null;
  const reports = arr(snap.workers).filter((e) => e.event === 'ledger_update');
  const folders = arr(snap.workers).filter((e) => e.event === 'start').map((e) => String(e.cwd ?? ''));
  const taskWakes = wakesOf(snap, expect.researcher).filter((w) => w.reason?.kind === 'facts' && arr(w.reason.factIds).some((f) => /^task\./.test(f)));
  const settles = stubTools(snap, expect.researcher, 'ledger_update');
  const closed = arr(snap.cards).filter((c) => c.actor?.kind === 'system' && c.title === 'Research reported: task completed');
  return [
    criterion('bot_has_no_repo', !!bot && !bot.repo, bot ? `repo ${bot.repo ? 'set' : 'none'}` : 'no bot'),
    criterion('one_research_task', !!task && task.dispatch?.preset === 'research', `${tasks.length} task(s), preset ${task?.dispatch?.preset ?? '-'}`),
    criterion('scratch_folder_under_bot', folders.length >= 1 && folders.every((f) => f.includes(`/factory/bots/${id}/research/`)), folders.join(', ') || 'no worker start'),
    criterion('worker_reported', reports.length >= 1, `${reports.length} worker report(s)`),
    criterion('completed_without_gate', task?.status === 'completed' && !task.gate && task.updatedBy?.kind === 'brain' && !String(task.summary ?? '').includes('[forced:'),
      task ? `${task.status} by ${task.updatedBy?.kind}, gate ${task.gate ? 'recorded' : 'none'}` : 'no task'),
    criterion('research_is_tainted', task?.dispatch?.origin?.tainted === true, String(task?.dispatch?.origin?.tainted)),
    criterion('woken_once_after_report', taskWakes.length === 1 && taskWakes[0].state === 'done', taskWakes.map((w) => `${arr(w.reason.factIds).join('+')}:${w.state}`).join(', ') || 'no task wake'),
    criterion('bot_did_not_settle', settles.length === 0, `${settles.length} ledger_update call(s) by the bot`),
    criterion('closed_card', closed.length === 1, `${closed.length} card(s)`),
    // Reclaim found the worker in its scratch folder and stopped its agent.
    criterion('worker_reclaimed', arr(snap.cards).some((c) => c.actor?.kind === 'system' && String(c.title ?? '').startsWith('Worker done')), 'no "Worker done" card'),
  ];
}

/** chain-survives-worker: a result sent from a task wake answers the
 *  dispatch the task was started for, in the owner's run. */
export function chainSurvivesWorker(snap, expect) {
  const msg = injected(snap, expect.message);
  const lead = botId(snap, expect.lead);
  const dev = botId(snap, expect.worker);
  const hs = arr(snap.handoffs);
  const dispatch = hs.find((h) => h.kind === 'dispatch' && h.from?.botId === lead) ?? null;
  const result = hs.find((h) => h.kind === 'result' && h.from?.botId === dev) ?? null;
  const rows = arr(snap.ledger).filter((e) => e.dispatch?.origin?.botId === dev);
  const leadWakes = wakesOf(snap, expect.lead);
  const devFactsWakes = wakesOf(snap, expect.worker).filter((w) => w.reason?.kind === 'facts');
  return [
    criterion('dispatch_in_owner_run', !!dispatch && dispatch.runId === `run-${msg?.id}` && dispatch.depth === 0 && dispatch.to?.botId === dev,
      dispatch ? `${dispatch.runId} d${dispatch.depth} → ${dispatch.to?.botId}` : 'no dispatch'),
    criterion('task_records_the_dispatch', rows.length === 1 && rows[0].dispatch?.handoffId === dispatch?.id, rows.map((e) => e.dispatch?.handoffId ?? '-').join(', ') || 'no task'),
    // The coordinator sent it from the owner's own words: the task is clean.
    criterion('task_clean_from_owner_words', rows.length === 1 && rows[0].dispatch?.origin?.tainted === false, rows.map((e) => String(e.dispatch?.origin?.tainted)).join(', ') || 'no task'),
    criterion('result_from_task_wake', devFactsWakes.length >= 1 && !!result && result.createdAt >= Math.min(...devFactsWakes.map((w) => w.enqueuedAt)),
      `${devFactsWakes.length} task wake(s)`),
    criterion('result_answers_dispatch', !!result && result.replyTo === dispatch?.id && result.to?.botId === lead && result.runId === dispatch?.runId && result.depth === 1
      && result.status !== 'refused', result ? `${result.replyTo} → ${result.to?.botId} ${result.runId} d${result.depth} ${result.status}` : 'no result'),
    criterion('lead_woken_once_by_it', leadWakes.filter((w) => w.reason?.kind === 'handoff').length === 1 && leadWakes.some((w) => w.reason?.kind === 'handoff' && w.reason.handoffId === result?.id && w.state === 'done'),
      leadWakes.map((w) => `${w.reason?.kind}:${w.state}`).join(', ')),
    criterion('no_refusals', hs.every((h) => h.status !== 'refused'), hs.filter((h) => h.status === 'refused').map((h) => h.refusal?.code).join(', ') || 'none'),
  ];
}

/** team-relay-owner-flow: the owner's request walks researcher → developer
 *  → issue in one run and one thread; the coordinator is woken twice (the
 *  owner, the last result) and reports there; General points at it. */
export function teamRelayOwnerFlow(snap, expect) {
  const msg = injected(snap, expect.message);
  const lead = botId(snap, expect.lead);
  const relay = (expect.relay ?? []).map((k) => botId(snap, k));
  const hs = arr(snap.handoffs);
  const root = hs.find((h) => h.kind === 'dispatch' && h.from?.botId === lead && !h.relay) ?? null;
  const run = hs.filter((h) => h.runId === root?.runId);
  const results = relay.map((id) => run.find((h) => h.kind === 'result' && h.from?.botId === id) ?? null);
  const forwards = run.filter((h) => h.relay === true);
  const leadWakes = wakesOf(snap, expect.lead);
  const rows = arr(snap.ledger).filter((e) => (expect.workers ?? []).some((k) => e.dispatch?.origin?.botId === botId(snap, k)));
  const report = botCards(snap, expect.lead).find((c) => c.kind === 'report') ?? null;
  const pointer = arr(snap.cards).find((c) => c.threadId === 'general' && c.actor?.kind === 'system' && c.refs?.threadId === root?.threadId) ?? null;
  const devRow = rows.find((e) => e.dispatch?.origin?.botId === botId(snap, 'developer'));
  return [
    criterion('one_owner_run', !!root && root.runId === `run-${msg?.id}` && run.every((h) => h.attribution?.originator?.kind === 'human'), root ? `${root.runId}, ${run.length} hop(s)` : 'no dispatch'),
    criterion('depths', JSON.stringify(run.map((h) => h.depth).sort((a, b) => a - b)) === '[0,1,1,2,2,3]', run.map((h) => h.depth).sort((a, b) => a - b).join(',')),
    criterion('forwards_from_lead_carry_results', forwards.length === 2 && forwards.every((f, i) => f.from?.botId === lead && f.replyTo === results[i]?.id && f.to?.botId === relay[i + 1]),
      forwards.map((f) => `${f.from?.botId}→${f.to?.botId} re ${f.replyTo}`).join('; ') || 'none'),
    criterion('last_result_to_lead', !!results[2] && results[2].to?.botId === lead && results[2].replyTo === forwards[1]?.id, results[2] ? `${results[2].to?.botId} re ${results[2].replyTo}` : 'none'),
    criterion('lead_woken_twice', leadWakes.length === 2 && leadWakes[0].reason?.kind === 'human' && leadWakes[1].reason?.kind === 'handoff' && leadWakes[1].reason.handoffId === results[2]?.id,
      leadWakes.map((w) => `${w.reason?.kind}:${w.reason?.handoffId ?? ''}`).join(', ')),
    criterion('one_flow_thread', !!root && root.threadId === `handoff:${root.id}` && run.every((h) => h.threadId === root.threadId)
      && rows.length === (expect.workers ?? []).length && rows.every((e) => e.dispatch?.threadId === root.threadId),
      [...new Set([...run.map((h) => h.threadId), ...rows.map((e) => e.dispatch?.threadId)])].join(', ')),
    criterion('report_in_flow_thread', !!report && report.threadId === root?.threadId, report ? report.threadId : 'no report'),
    criterion('pointer_in_general', !!pointer && pointer.replyTo === msg?.id && pointer.refs?.handoffId === results[2]?.id && !pointer.body,
      pointer ? `${pointer.title} ↩ ${pointer.replyTo}` : 'no pointer'),
    criterion('research_taint_carried', !!devRow && devRow.dispatch?.origin?.tainted === true, devRow ? String(devRow.dispatch?.origin?.tainted) : 'no developer task'),
    criterion('no_refusals', hs.every((h) => h.status !== 'refused'), hs.filter((h) => h.status === 'refused').map((h) => `${h.kind}:${h.refusal?.code}`).join(', ') || 'none'),
  ];
}

/** team-relay-limit: a relay restarted on every wake stops at the depth
 *  cap: the last result of round two (depth 7) is refused, the coordinator
 *  is told, and nothing deeper than the cap is delivered. */
export function teamRelayLimit(snap, expect) {
  const max = expect.maxDepth ?? 6;
  const lead = botId(snap, expect.lead);
  const hs = arr(snap.handoffs);
  const delivered = hs.filter((h) => h.status !== 'refused');
  const refused = hs.filter((h) => h.status === 'refused');
  const capped = refused.find((h) => h.kind === 'result' && h.depth === max + 1 && h.refusal?.code === 'max_depth') ?? null;
  const roundTwo = hs.find((h) => h.kind === 'dispatch' && h.from?.botId === lead && !h.relay && h.depth === 4) ?? null;
  const stopWake = wakesOf(snap, expect.lead).find((w) => w.reason?.kind === 'handoff' && w.reason.handoffId === capped?.id) ?? null;
  const tooLong = stubTools(snap, expect.lead, 'handoff_send').find((t) => t.ok === false) ?? null;
  return [
    criterion('round_one_depths', JSON.stringify(delivered.filter((h) => h.depth <= 3).map((h) => h.depth).sort((a, b) => a - b)) === '[0,1,1,2,2,3]',
      delivered.filter((h) => h.depth <= 3).map((h) => h.depth).sort((a, b) => a - b).join(',')),
    criterion('round_two_starts_at_4', !!roundTwo && roundTwo.status !== 'refused' && roundTwo.next?.length === 2, roundTwo ? `d${roundTwo.depth} ${roundTwo.status}` : 'none'),
    criterion('depth_7_refused', !!capped && factsOfKind(snap, 'handoff.refused').some((f) => f.ref?.handoffId === capped.id)
      && arr(snap.cards).some((c) => c.kind === 'refusal' && c.refs?.handoffId === capped.id), capped ? `${capped.id} ${capped.refusal?.detail}` : refused.map((h) => `${h.kind} d${h.depth} ${h.refusal?.code}`).join(', ') || 'none'),
    criterion('lead_told_relay_stopped', !!stopWake && /depth limit/.test(capped?.relayStopped ?? ''), stopWake ? capped?.relayStopped ?? '' : 'no wake'),
    criterion('nothing_past_cap_delivered', delivered.every((h) => h.depth <= max), delivered.filter((h) => h.depth > max).map((h) => `${h.kind} d${h.depth}`).join(', ') || 'none'),
    criterion('five_next_refused', !!tooLong && /<=4|next is 1 to 4/.test(String(tooLong.text)), tooLong?.text?.slice(0, 160) ?? 'not refused'),
  ];
}

/** team-relay-owner-tags-researcher: the owner's mention mid-relay wakes the
 *  researcher once, in the relay's thread and the owner card's run; its
 *  result goes to the coordinator; the relay still completes. */
export function teamRelayOwnerTagsResearcher(snap, expect) {
  const tag = injected(snap, expect.tag);
  const lead = botId(snap, expect.lead);
  const res = botId(snap, expect.researcher);
  const dev = botId(snap, expect.developer);
  const iss = botId(snap, expect.issue);
  const hs = arr(snap.handoffs);
  const root = hs.find((h) => h.kind === 'dispatch' && h.from?.botId === lead && !h.relay) ?? null;
  const tagWakes = wakesOf(snap, expect.researcher).filter((w) => w.reason?.kind === 'human');
  const aside = hs.find((h) => h.kind === 'result' && h.from?.botId === res && h.runId === `run-${tag?.id}`) ?? null;
  const last = hs.find((h) => h.kind === 'result' && h.from?.botId === iss) ?? null;
  return [
    criterion('researcher_woken_once_in_thread', tagWakes.length === 1 && tagWakes[0].threadId === root?.threadId && tagWakes[0].reason.runId === `run-${tag?.id}`,
      tagWakes.map((w) => `${w.threadId} ${w.reason?.runId}`).join(', ') || 'no wake'),
    criterion('its_result_goes_to_lead', !!aside && aside.to?.botId === lead && aside.to?.botId !== dev && !aside.replyTo && aside.status === 'delivered',
      aside ? `${aside.to?.botId} re ${aside.replyTo ?? '-'} ${aside.status}` : 'no result'),
    criterion('relay_completes', !!last && last.to?.botId === lead && last.status === 'delivered' && last.runId === root?.runId
      && wakesOf(snap, expect.lead).some((w) => w.reason?.kind === 'handoff' && w.reason.handoffId === last.id && w.state === 'done'),
      last ? `${last.status} ${last.runId}` : 'no last result'),
    criterion('no_refusals', hs.every((h) => h.status !== 'refused'), hs.filter((h) => h.status === 'refused').map((h) => `${h.kind}:${h.refusal?.code}`).join(', ') || 'none'),
  ];
}

/** bot-worker-codex-engine: the owner's engine pick for a bot puts its
 *  fan-out worker on codex, on main's guarded line, and that worker reports
 *  through its own wmux tools (its pane's identity). */
export function botWorkerCodexEngine(snap, expect) {
  const leadId = botId(snap, expect.lead);
  const lead = arr(snap.bots).find((b) => b.id === leadId) ?? null;
  const tasks = arr(snap.ledger).filter((e) => e.dispatch?.origin?.botId === leadId);
  const task = tasks.length === 1 ? tasks[0] : null;
  // The worker of the lead's task: its start names the task.
  const starts = arr(snap.workers).filter((e) => e.event === 'start' && task && e.taskId === task.id);
  const start = starts.length === 1 ? starts[0] : null;
  const args = arr(start?.args);
  const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  // Its reports: the same process (the worker's own MCP calls).
  const reports = arr(snap.workers).filter((e) => e.event === 'ledger_update' && start && e.pid === start.pid);
  return [
    criterion('engine_set_in_profile', lead?.workerAgent?.agent === 'codex', JSON.stringify(lead?.workerAgent ?? null)),
    criterion('one_task', !!task, `${tasks.length} lead task(s)`),
    criterion('worker_ran_codex', start?.agent === 'codex', starts.map((s) => s.agent).join(', ') || 'no worker start for the task'),
    criterion('rules_file_in_place', start?.rulesPresent === true, String(start?.rulesPresent)),
    criterion('guarded_line', after('-a') === 'never' && after('-s') === 'workspace-write' && !!start && after('-C') === start.cwd && args.includes('--')
      && !args.some((a) => /danger-full-access|--yolo|--dangerously/.test(a)), args.slice(0, 16).join(' ').slice(0, 300)),
    criterion('reported_as_itself', reports.length >= 1 && reports.every((r) => r.ok === true), reports.map((r) => `${r.ok}:${String(r.text ?? '').slice(0, 80)}`).join(' | ') || 'no report from the worker'),
  ];
}
