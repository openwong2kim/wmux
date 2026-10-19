// The triggers a new bot profile starts with, per role (design §5). A profile
// stores its own copy and may edit it; these are only the defaults.
//
// The verifier has no event triggers: it verifies a PR head only when asked
// (a handoff, a mention or the owner's message names it). Waking it on every
// pr.opened / pr.head_moved / ci.failed started a verify worker per pushed
// commit of every trusted PR, which spent its turns and worker hours and
// filled its queue with heads nobody asked about. Triage starts on its own only
// for an issue by a trusted author: any other issue is still a fact and a
// thread the owner sees, and the owner can ask Triage about it in the room.
//
// Handoffs and the owner's messages are not triggers: the handoff router and
// the room composer wake their addressee directly (one wake per message), and
// their facts only record it.

import type { BotRole, BotTrigger } from '../../shared/bot';

const VERIFIER_BATCH = { windowMs: 20_000, max: 5 } as const;
const MAINTAINER_BATCH = { windowMs: 3_600_000, max: 20 } as const;

export const ROLE_DEFAULT_TRIGGERS: Readonly<Record<BotRole, readonly BotTrigger[]>> = {
  lead: [
    { kind: 'task.done' },
    { kind: 'task.failed' },
    { kind: 'task.input_required' },
    { kind: 'merge.refused' },
  ],
  triage: [
    { kind: 'issue.opened', filter: { authorTrusted: true } },
    { kind: 'issue.labelled', filter: { labelsAny: ['bug', 'triage'], authorTrusted: true } },
  ],
  verifier: [],
  maintainer: [
    { kind: 'merge.done', batch: MAINTAINER_BATCH },
  ],
  moa: [
    { kind: 'schedule.fired' },
    { kind: 'bot.budget_exhausted' },
  ],
};

/** The triage defaults before the trusted-author filter. A stored triage
 *  profile whose triggers are exactly these is moved to the current defaults
 *  when the bot store loads (botStore.ts); edited triggers are kept. */
export const LEGACY_TRIAGE_TRIGGERS: readonly BotTrigger[] = [
  { kind: 'issue.opened' },
  { kind: 'issue.labelled', filter: { labelsAny: ['bug', 'triage'] } },
];

/** The verifier defaults before it verified only on request. A stored
 *  verifier profile whose triggers are exactly these is moved to the current
 *  defaults (none) when the bot store loads (botStore.ts); edited triggers
 *  are kept. */
export const LEGACY_VERIFIER_TRIGGERS: readonly BotTrigger[] = [
  { kind: 'pr.opened', filter: { authorTrusted: true }, batch: VERIFIER_BATCH },
  { kind: 'pr.head_moved', filter: { authorTrusted: true }, batch: VERIFIER_BATCH },
  { kind: 'ci.failed', filter: { authorTrusted: true } },
];

/** A fresh, editable copy of a role's default triggers. */
export function defaultTriggers(role: BotRole): BotTrigger[] {
  return ROLE_DEFAULT_TRIGGERS[role].map((t) => ({
    kind: t.kind,
    ...(t.filter ? { filter: { ...t.filter, ...(t.filter.labelsAny ? { labelsAny: [...t.filter.labelsAny] } : {}) } } : {}),
    ...(t.batch ? { batch: { ...t.batch } } : {}),
  }));
}
