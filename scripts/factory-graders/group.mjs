// Group-room graders: an owner message to the whole room, bot-to-bot
// mentions and their caps across a restart, a bot's own routines, and the
// owner's chat stop reaching every bot.

import { arr, botCards, botId, cardsOfKind, criterion, factsOfKind, injected, parseToolText, stubEvents, stubTools, wakesOf } from './common.mjs';

const runOf = (cardId) => `run-${cardId}`;

/** group-hi-replies: one message to the room wakes every bot of it once, in
 *  one run; each answers in General. */
export function groupHiReplies(snap, expect) {
  const msg = injected(snap, expect.message);
  const card = arr(snap.cards).find((c) => c.id === msg?.id) ?? null;
  const ids = (expect.bots ?? []).map((k) => botId(snap, k));
  const human = arr(snap.wakes).filter((w) => w.reason?.kind === 'human');
  const facts = factsOfKind(snap, 'human.message').filter((f) => f.payload?.cardId === msg?.id);
  const out = [
    criterion('card_names_every_bot', !!card && [...arr(card.refs?.botIds)].sort().join() === [...ids].sort().join() && card.refs?.botId === undefined,
      JSON.stringify(card?.refs ?? null)),
    criterion('one_wake_per_bot', human.length === ids.length && ids.every((id) => human.filter((w) => w.botId === id).length === 1),
      human.map((w) => w.botId).join(', ') || 'no wake'),
    criterion('one_run_for_the_message', !!msg && human.every((w) => w.reason.runId === runOf(msg.id) && w.reason.room === true && w.priority === 0),
      [...new Set(human.map((w) => `${w.reason.runId}/${w.reason.room}`))].join(', ')),
    criterion('one_directed_fact_each', facts.length === ids.length && ids.every((id) => facts.some((f) => f.ref?.botId === id)), `${facts.length} fact(s)`),
  ];
  for (const key of expect.bots ?? []) {
    const cards = botCards(snap, key);
    out.push(criterion(`${key}_answered_in_general`, cards.length === 1 && cards[0].threadId === 'general', cards.map((c) => c.threadId).join(', ') || 'no card'));
  }
  return out;
}

/** group-chat-wakes-its-members: an untagged message in the owner's group
 *  chat with no coordinator in it wakes every member as one of the room's
 *  bots (roomWide), in the group's thread, never a bot outside it (the
 *  workspace's coordinator included); a message that picks one member wakes
 *  that one alone. */
export function groupChatWakesItsMembers(snap, expect) {
  const made = arr(snap.records).find((r) => r.label === 'make the group')?.result ?? null;
  const thread = made?.ok ? made.group?.threadId : null;
  const msg = injected(snap, expect.message);
  const card = arr(snap.cards).find((c) => c.id === msg?.id) ?? null;
  const ids = (expect.members ?? []).map((k) => botId(snap, k));
  const human = arr(snap.wakes).filter((w) => w.reason?.kind === 'human' && w.reason.runId === runOf(msg?.id));
  const facts = factsOfKind(snap, 'human.message').filter((f) => f.payload?.cardId === msg?.id);
  const picked = injected(snap, expect.picked);
  const pickedWakes = arr(snap.wakes).filter((w) => w.reason?.kind === 'human' && w.reason.runId === runOf(picked?.id));
  const pickedId = botId(snap, expect.pickedBot);
  const out = [
    criterion('group_made', !!thread && /^group:grp-[0-9a-f]{8}$/.test(thread) && [...arr(made.group.memberIds)].sort().join() === [...ids].sort().join(),
      JSON.stringify(made ?? null).slice(0, 200)),
    criterion('card_in_group_names_every_member', !!card && card.threadId === thread && [...arr(card.refs?.botIds)].sort().join() === [...ids].sort().join() && card.refs?.botId === undefined,
      JSON.stringify(card ? { threadId: card.threadId, refs: card.refs ?? null } : null)),
    criterion('one_wake_per_member', human.length === ids.length && ids.every((id) => human.filter((w) => w.botId === id).length === 1),
      human.map((w) => w.botId).join(', ') || 'no wake'),
    criterion('wakes_pinned_to_group', human.length > 0 && human.every((w) => w.threadId === thread && w.reason.room === true && w.reason.roomWide === true && w.reason.lead === undefined && w.priority === 0),
      human.map((w) => `${w.threadId}/${w.reason.room}/${w.reason.roomWide}/${w.reason.lead}`).join(', ') || 'no wake'),
    criterion('one_directed_fact_each', facts.length === ids.length && ids.every((id) => facts.some((f) => f.ref?.botId === id)), `${facts.length} fact(s)`),
    criterion('picked_wakes_one', pickedWakes.length === 1 && pickedWakes[0].botId === pickedId && pickedWakes[0].reason.room === undefined && pickedWakes[0].threadId === thread,
      pickedWakes.map((w) => `${w.botId}/${w.reason.room}`).join(', ') || 'no wake'),
  ];
  for (const key of expect.members ?? []) {
    const cards = botCards(snap, key);
    out.push(criterion(`${key}_answered_in_group`, cards.length >= 1 && cards.every((c) => c.threadId === thread), cards.map((c) => c.threadId).join(', ') || 'no card'));
  }
  for (const key of expect.silent ?? []) {
    out.push(criterion(`${key}_not_woken`, wakesOf(snap, key).length === 0 && botCards(snap, key).length === 0, `${wakesOf(snap, key).length} wake(s)`));
  }
  return out;
}

/** group-chat-coordinator-takes-it: in the owner's group chat with a
 *  coordinator, an untagged message wakes the coordinator alone (lead, not
 *  room-wide), in the group's thread, and it answers there; a message that
 *  picks bots wakes exactly those, as bots named. */
export function groupChatCoordinatorTakesIt(snap, expect) {
  const made = arr(snap.records).find((r) => r.label === 'make the group')?.result ?? null;
  const thread = made?.ok ? made.group?.threadId : null;
  const msg = injected(snap, expect.message);
  const card = arr(snap.cards).find((c) => c.id === msg?.id) ?? null;
  const lead = botId(snap, expect.lead);
  const human = arr(snap.wakes).filter((w) => w.reason?.kind === 'human' && w.reason.runId === runOf(msg?.id));
  const facts = factsOfKind(snap, 'human.message').filter((f) => f.payload?.cardId === msg?.id);
  const picked = injected(snap, expect.picked);
  const pickedIds = (expect.pickedBots ?? []).map((k) => botId(snap, k));
  const pickedWakes = arr(snap.wakes).filter((w) => w.reason?.kind === 'human' && w.reason.runId === runOf(picked?.id));
  const leadCards = botCards(snap, expect.lead);
  return [
    criterion('group_made', !!thread && /^group:grp-[0-9a-f]{8}$/.test(thread) && arr(made.group.memberIds).includes(lead),
      JSON.stringify(made ?? null).slice(0, 200)),
    criterion('card_names_the_lead', !!card && card.threadId === thread && JSON.stringify(card.refs?.botIds ?? null) === JSON.stringify([lead]) && card.refs?.botId === lead,
      JSON.stringify(card ? { threadId: card.threadId, refs: card.refs ?? null } : null)),
    criterion('only_the_lead_woken', human.length === 1 && human[0].botId === lead && human[0].state === 'done' && human[0].priority === 0 && human[0].threadId === thread,
      human.map((w) => `${w.botId}:${w.state}@${w.threadId}`).join(', ') || 'no wake'),
    criterion('woken_as_lead_not_room_wide', human.length === 1 && human[0].reason.lead === true && human[0].reason.room === undefined && human[0].reason.roomWide === undefined,
      human.map((w) => `${w.reason.room}/${w.reason.roomWide}/${w.reason.lead}`).join(', ') || 'no wake'),
    criterion('one_directed_fact_marked_lead', facts.length === 1 && facts[0].ref?.botId === lead && facts[0].payload?.lead === true, `${facts.length} fact(s)`),
    criterion('lead_answered_in_group', leadCards.length === 1 && leadCards[0].threadId === thread, leadCards.map((c) => c.threadId).join(', ') || 'no card'),
    criterion('picked_wake_exactly_theirs', pickedWakes.length === pickedIds.length && pickedIds.every((id) => pickedWakes.some((w) => w.botId === id))
      && pickedWakes.every((w) => w.reason.room === true && w.reason.roomWide === undefined && w.reason.lead === undefined && w.threadId === thread),
      pickedWakes.map((w) => `${w.botId}/${w.reason.room}/${w.reason.roomWide}/${w.reason.lead}`).join(', ') || 'no wake'),
  ];
}

/** structured-mention-wakes-target: the owner's mention wakes its bot; that
 *  bot's card mention wakes its target once; nobody else wakes. */
export function structuredMentionWakesTarget(snap, expect) {
  const speaker = botId(snap, expect.speaker);
  const target = botId(snap, expect.target);
  const msg = injected(snap, expect.message);
  const said = botCards(snap, expect.speaker)[0] ?? null;
  const speakerWakes = wakesOf(snap, expect.speaker);
  const targetWakes = wakesOf(snap, expect.target);
  const messages = arr(snap.handoffs).filter((h) => h.kind === 'message');
  const out = [
    criterion('speaker_woken_by_owner', speakerWakes.length === 1 && speakerWakes[0].reason?.kind === 'human' && speakerWakes[0].reason.runId === runOf(msg?.id), speakerWakes.map((w) => w.reason?.kind).join(', ') || 'no wake'),
    criterion('card_names_target', !!said && JSON.stringify(said.refs?.botIds ?? null) === JSON.stringify([target]), JSON.stringify(said?.refs ?? null)),
    criterion('target_woken_once_by_mention', targetWakes.length === 1 && targetWakes[0].reason?.kind === 'mention' && targetWakes[0].reason.cardId === said?.id
      && targetWakes[0].reason.fromBotId === speaker && targetWakes[0].state === 'done', targetWakes.map((w) => `${w.reason?.kind}:${w.state}`).join(', ') || 'no wake'),
    criterion('one_message_in_owner_run', messages.length === 1 && messages[0].runId === runOf(msg?.id) && messages[0].depth === 1 && messages[0].to?.botId === target, messages.map((h) => `${h.runId} d${h.depth}`).join(', ') || 'none'),
    criterion('target_answers_in_thread', botCards(snap, expect.target).length === 1 && botCards(snap, expect.target)[0].threadId === said?.threadId, botCards(snap, expect.target).map((c) => c.threadId).join(', ')),
  ];
  for (const key of expect.silent ?? []) out.push(criterion(`${key}_not_woken`, wakesOf(snap, key).length === 0, `${wakesOf(snap, key).length} wake(s)`));
  return out;
}

/** mention-loop-bounded: a mention ring never wakes a bot twice for one
 *  card, a restart cuts the running turn without a replay, and a round runs
 *  to the depth cap and stops there with a refusal card. */
export function mentionLoopBounded(snap, expect) {
  const [a, b] = (expect.rounds ?? []).map((l) => injected(snap, l));
  const max = expect.maxDepth ?? 6;
  const wakes = arr(snap.wakes);
  const mentionWakes = wakes.filter((w) => w.reason?.kind === 'mention');
  const keys = mentionWakes.map((w) => `${w.botId}:${w.reason.cardId}`);
  const handoffs = arr(snap.handoffs).filter((h) => h.kind === 'message');
  const runA = handoffs.filter((h) => h.runId === runOf(a?.id));
  const runB = handoffs.filter((h) => h.runId === runOf(b?.id));
  const deliveredB = runB.filter((h) => h.status !== 'refused').map((h) => h.depth).sort((x, y) => x - y);
  const refusedB = runB.filter((h) => h.status === 'refused');
  const interrupted = wakes.filter((w) => w.state === 'interrupted');
  const cutBot = botId(snap, expect.interrupted);
  const prompts = Object.values(snap.stub ?? {}).flatMap((log) => arr(log).filter((e) => e.event === 'prompt'));
  const finished = wakes.filter((w) => w.state === 'done' || w.state === 'interrupted');
  return [
    criterion('restarted', arr(snap.launches).filter((l) => l.ok).length === 2, `${arr(snap.launches).length} launch(es)`),
    criterion('no_card_wakes_a_bot_twice', new Set(keys).size === keys.length, `${keys.length} mention wake(s), ${new Set(keys).size} distinct`),
    criterion('cut_turn_interrupted_not_replayed', interrupted.length === 1 && interrupted[0].botId === cutBot && interrupted[0].reason?.kind === 'mention'
      && !wakes.some((w) => w !== interrupted[0] && w.botId === cutBot && w.reason?.kind === 'mention' && w.reason.cardId === interrupted[0].reason.cardId),
      interrupted.map((w) => `${w.botId}:${w.reason?.kind}`).join(', ') || 'none'),
    criterion('first_round_stopped_by_restart', runA.length >= 3 && runA.every((h) => h.status !== 'refused' && h.depth <= 3), runA.map((h) => `d${h.depth}:${h.status}`).join(', ') || 'none'),
    criterion('second_round_climbs_to_cap', JSON.stringify(deliveredB) === JSON.stringify(Array.from({ length: max }, (_, i) => i + 1)), `delivered depths ${deliveredB.join(',')}`),
    criterion('second_round_refused_at_cap', refusedB.length === 1 && refusedB[0].depth === max + 1 && refusedB[0].refusal?.code === 'max_depth', refusedB.map((h) => `d${h.depth}:${h.refusal?.code}`).join(', ') || 'none'),
    criterion('refusal_card', cardsOfKind(snap, 'refusal').length === 1, `${cardsOfKind(snap, 'refusal').length} refusal card(s)`),
    // A turn cut by the restart may end before its prompt was sent; no wake
    // is ever prompted twice.
    criterion('one_prompt_per_turn', prompts.length >= finished.length - interrupted.length && prompts.length <= finished.length, `${prompts.length} prompt(s), ${finished.length} finished wake(s), ${interrupted.length} cut`),
  ];
}

/** routine-create-fire-pause: a bot's routine, set on the owner's words,
 *  fires for that bot only, is listed for the operator, and is paused by the
 *  bot's own stop; nothing fires after. */
export function routineCreateFirePause(snap, expect) {
  const id = botId(snap, expect.bot);
  const routines = arr(snap.routines);
  const r = routines[0] ?? null;
  const routineWakes = arr(snap.wakes).filter((w) => w.reason?.kind === 'routine');
  const fired = factsOfKind(snap, 'schedule.fired').filter((f) => String(f.ref?.scheduleId ?? '').startsWith('routine:'));
  const factWakes = arr(snap.wakes).filter((w) => w.reason?.kind === 'facts' && arr(w.reason.factIds).some((fid) => fired.some((f) => f.id === fid)));
  const stop = stubTools(snap, expect.bot, 'stop_my_work')[0] ?? null;
  const stopAnswer = parseToolText(stop?.text);
  const listed = arr(snap.actions).find((x) => x.label === expect.record)?.result ?? null;
  const routineCards = cardsOfKind(snap, 'routine');
  const after = stop ? botCards(snap, expect.bot).filter((c) => c.at >= stop.at) : [];
  return [
    criterion('routine_created', routines.length === 1 && r.botId === id && r.schedule?.kind === 'interval' && r.schedule.everyMs === expect.everyMs
      && routineCards.some((c) => /^Routine created: /.test(c.title) && c.refs?.routineId === r.id && c.actor?.botId === id), `${routines.length} routine(s); ${routineCards.map((c) => c.title).join(' | ')}`),
    criterion('fired_for_its_bot_only', routineWakes.length >= 1 && routineWakes.every((w) => w.botId === id && w.reason.routineId === r?.id) && routineWakes.some((w) => w.state === 'done')
      && fired.length === routineWakes.length && fired.every((f) => f.ref?.botId === id) && factWakes.length === 0,
      `${routineWakes.length} routine wake(s), ${fired.length} fact(s), ${factWakes.length} fact wake(s)`),
    criterion('operator_lists_it', listed?.ok === true && arr(listed.routines).length === 1 && listed.routines[0].id === r?.id, JSON.stringify(listed ?? null).slice(0, 200)),
    criterion('stop_tool_ok', stopAnswer?.ok === true && stopAnswer.routinesPaused === 1, stop?.text?.slice(0, 200) ?? 'not called'),
    criterion('paused_by_stop', r?.state === 'paused' && r.paused?.reason === 'stop' && routineCards.some((c) => /^Routine paused \(stopped\): /.test(c.title)), `${r?.state}/${r?.paused?.reason ?? '-'}`),
    criterion('nothing_fires_after_stop', !!stop && routineWakes.every((w) => w.enqueuedAt < stop.at), routineWakes.map((w) => w.enqueuedAt - (stop?.at ?? 0)).join(', ')),
    criterion('one_line_after_stop', after.length === 1, `${after.length} card(s) after the stop`),
  ];
}

/** chat-stop-all: one owner message reaches every bot of the room; each
 *  stops its own workers and routines and says so in one line; no turn is
 *  cut. */
export function chatStopAll(snap, expect) {
  const msg = injected(snap, expect.message);
  const ids = (expect.bots ?? []).map((k) => botId(snap, k));
  const stopWakes = arr(snap.wakes).filter((w) => w.reason?.kind === 'human' && w.reason.runId === runOf(msg?.id));
  const routines = arr(snap.routines);
  const tasks = arr(snap.ledger).filter((e) => (expect.workers ?? []).some((k) => e.dispatch?.origin?.botId === botId(snap, k)));
  const out = [
    criterion('reached_every_bot', stopWakes.length === ids.length && ids.every((id) => stopWakes.some((w) => w.botId === id && w.state === 'done')), stopWakes.map((w) => `${w.botId}:${w.state}`).join(', ') || 'no wake'),
    criterion('workers_cancelled_by_owner_stop', tasks.length === (expect.workers ?? []).length && tasks.every((e) => e.status === 'cancelled' && e.summary === 'stopped by owner'),
      tasks.map((e) => `${e.status}:${e.summary ?? ''}`).join(', ') || 'no tasks'),
    criterion('routines_paused_by_stop', routines.length === ids.length && routines.every((x) => x.state === 'paused' && x.paused?.reason === 'stop'), routines.map((x) => `${x.state}/${x.paused?.reason ?? '-'}`).join(', ')),
    criterion('no_turn_cut', arr(snap.wakes).every((w) => w.state !== 'interrupted'), arr(snap.wakes).filter((w) => w.state === 'interrupted').length + ' interrupted'),
  ];
  for (const key of expect.bots ?? []) {
    const stop = stubTools(snap, key, 'stop_my_work')[0] ?? null;
    const answer = parseToolText(stop?.text);
    const after = stop ? botCards(snap, key).filter((c) => c.at >= stop.at) : [];
    out.push(criterion(`${key}_stopped_itself`, answer?.ok === true && answer.routinesPaused === 1, stop?.text?.slice(0, 160) ?? 'not called'));
    out.push(criterion(`${key}_one_line`, after.length === 1, `${after.length} card(s) after its stop`));
  }
  out.push(criterion('no_prompt_after_stop', Object.keys(snap.stub ?? {}).every((k) => stubEvents(snap, k, 'prompt').length === 2), Object.entries(snap.stub ?? {}).map(([k, l]) => `${k}:${arr(l).filter((e) => e.event === 'prompt').length}`).join(', ')));
  return out;
}
