// ─── Room card notice codes for the phone ─────────────────────────────────
//
// A factory system card carries a stable code and its values
// (RoomCard.notice, shared/room.ts), so the reader's language words it; its
// `title` and `body` stay the English text. The phone receives a card's
// notice only for a code listed here, with only the args listed for that
// code, each of the listed type (phoneRooms.ts parsePhoneRoomCard). Every
// code is published in docs/phone-client-contract.md ("Room card notice
// codes"), and a unit test keeps this table, that section and the desktop's
// English templates (renderer/i18n/locales/en.ts `room.notice.*`) in step:
// a code the desktop words but this table lacks fails it.

export type PhoneNoticeArgType = 'string' | 'number';

export interface PhoneNoticeCode {
  /** The values the words need, by name. Any other arg is dropped. */
  args: Readonly<Record<string, PhoneNoticeArgType>>;
  /** The desktop's English title template(s) for the code (en.ts keys): one,
   *  or one per variant (a hop's kind, a budget's limit, a PR with no title). */
  titles: readonly string[];
  /** The other en.ts keys the desktop words the card with: its body, and the
   *  words an arg's value is shown as. */
  more?: readonly string[];
}

/** The longest string arg the phone receives (a task title, a gate's error,
 *  the slot holders). */
export const PHONE_NOTICE_ARG_MAX = 500;

const STATUS = ['room.notice.status.completed', 'room.notice.status.cancelled', 'room.notice.status.failed', 'room.notice.pane.closes', 'room.notice.pane.stays'];
const GATE_REASONS = ['room.notice.gate.reason.gate_unavailable', 'room.notice.gate.reason.no_gate_command', 'room.notice.gate.reason.deps_missing', 'room.notice.gate.reason.no_changes'];
const HOLDERS = [
  'room.notice.holders.bot', 'room.notice.holders.bots', 'room.notice.holders.worker', 'room.notice.holders.workers',
  'room.notice.holders.other', 'room.notice.holders.others', 'room.notice.holders.more', 'room.notice.holders.none',
];
const START_CAUSES = ['fetch', 'worktree', 'repository', 'promptFile', 'slot', 'pane', 'setupStep', 'setup'].map((c) => `room.notice.worker.startFailed.cause.${c}`);
const BUDGET_LIMITS = ['turns_hour', 'turns_day', 'concurrent_workers', 'worker_hours_day', 'factory_workers'].map((l) => `room.notice.budget.exhausted.${l}`);

const k = (code: string): string => `room.notice.${code}`;
/** A code worded by its title alone (its body is the card's evidence). */
const titled = (code: string, args: PhoneNoticeCode['args'] = {}, more?: readonly string[]): PhoneNoticeCode => ({ args, titles: [k(code)], ...(more ? { more } : {}) });
/** A code whose body is worded too. */
const bodied = (code: string, args: PhoneNoticeCode['args'] = {}, more: readonly string[] = []): PhoneNoticeCode => ({ args, titles: [k(code)], more: [`${k(code)}.body`, ...more] });
/** A worker card that names its task by `title`; its second title is for a
 *  card with none (written before worker cards named their task). */
const taskNamed = (code: string, args: PhoneNoticeCode['args'] = {}, more: readonly string[] = []): PhoneNoticeCode => ({
  args: { title: 'string', ...args }, titles: [k(code), `${k(code)}.untitled`], more: [`${k(code)}.body`, ...more],
});

/** Every notice code the factory writes, as the phone may receive it. */
export const PHONE_ROOM_NOTICE_CODES: Readonly<Record<string, PhoneNoticeCode>> = {
  // A worker's lifecycle (workerReclaim.ts, workerLifecycleHost.ts, workerReportNudge.ts, botNotices.ts).
  'worker.paused': taskNamed('worker.paused'),
  'worker.pausedResumable': taskNamed('worker.pausedResumable', { kind: 'string' }, [`${k('worker.pausedResumable')}.body.research`]),
  'worker.idlePausedResumable': taskNamed('worker.idlePausedResumable', { kind: 'string' }, [`${k('worker.idlePausedResumable')}.body.research`]),
  'worker.done': taskNamed('worker.done', { status: 'string' }, STATUS),
  'worker.doneResumable': taskNamed('worker.doneResumable', { status: 'string', kind: 'string' }, [`${k('worker.doneResumable')}.body.research`, ...STATUS]),
  'worker.resumed': taskNamed('worker.resumed', { by: 'string', where: 'string' }, ['room.notice.by.owner', 'room.notice.by.bot', 'room.notice.where.folder', 'room.notice.where.newPane']),
  'worker.waiting': bodied('worker.waiting', {
    title: 'string', inUse: 'number', cap: 'number', holders: 'string', bots: 'string', botCount: 'number', workers: 'string', workerCount: 'number',
  }, HOLDERS),
  'worker.noReport': bodied('worker.noReport'),
  'worker.stillNoReport': bodied('worker.stillNoReport'),
  'worker.startFailed': titled('worker.startFailed', { title: 'string', cause: 'string' }, START_CAUSES),
  'worker.reportAfterEnd': bodied('worker.reportAfterEnd', { title: 'string' }),
  // The task gate (taskGate.ts).
  'gate.checked': titled('gate.checked'),
  'gate.passedNotCompleted': titled('gate.passedNotCompleted'),
  'gate.passed': titled('gate.passed'),
  'gate.killed': titled('gate.killed'),
  'gate.failed': titled('gate.failed', { exit: 'number' }),
  'gate.skipped': titled('gate.skipped', { reason: 'string' }, GATE_REASONS),
  'gate.busy': bodied('gate.busy'),
  'gate.noBase': bodied('gate.noBase', { detail: 'string' }),
  'gate.refused': titled('gate.refused'),
  'gate.notRunNoBot': bodied('gate.notRunNoBot'),
  'gate.notRunNoWorktree': bodied('gate.notRunNoWorktree'),
  'gate.notRunNoBaseRef': bodied('gate.notRunNoBaseRef'),
  'research.completed': bodied('research.completed'),
  'research.notCompleted': titled('research.notCompleted'),
  // A task its merged pull request ended (taskGate.ts).
  'task.merged': bodied('task.merged', { pr: 'number' }),
  // The verify gate (verifyPreset.ts); a skip's reason is worded as the task gate's.
  'verify.passed': titled('verify.passed'),
  'verify.killed': titled('verify.killed'),
  'verify.failed': titled('verify.failed', { exit: 'number' }),
  'verify.skipped': titled('verify.skipped', { reason: 'string' }),
  'verify.busy': bodied('verify.busy'),
  'verify.refused': titled('verify.refused'),
  'verify.notRunNoBot': bodied('verify.notRunNoBot'),
  'verify.notRunNoWorktree': bodied('verify.notRunNoWorktree'),
  'verify.notRunNoBaseRef': bodied('verify.notRunNoBaseRef'),
  // A bot's budget and errors (roomWriter.ts); `until` is a time in epoch ms.
  'budget.exhausted': {
    args: { bot: 'string', limit: 'string', until: 'number' },
    titles: BUDGET_LIMITS,
    more: ['room.notice.budget.exhausted.at', 'room.notice.budget.exhausted.manual', 'room.notice.budget.exhausted.workers'],
  },
  'budget.held': titled('budget.held', { bot: 'string', until: 'number' }, ['room.notice.budget.held.at', 'room.notice.budget.held.manual']),
  'bot.usageLimit': titled('bot.usageLimit', { bot: 'string', until: 'number' }),
  'bot.error': titled('bot.error', { bot: 'string' }),
  // A task's end (roomWriter.ts).
  'task.done': titled('task.done', { title: 'string' }),
  'task.reported': titled('task.reported', { title: 'string' }),
  'task.failed': titled('task.failed', { title: 'string' }),
  'task.cancelled': titled('task.cancelled', { title: 'string' }),
  'task.stoppedByOwner': titled('task.stoppedByOwner', { title: 'string' }),
  // A folder a stop kept, removed after 7 days with no changes (taskFolderCleanup.ts).
  'task.keptFolderCleaned': bodied('task.keptFolderCleaned', { title: 'string', days: 'number', kind: 'string' }, [`${k('task.keptFolderCleaned')}.body.research`]),
  'task.inputRequired': titled('task.inputRequired', { title: 'string', why: 'string' }, ['trustDialog', 'firstRun', 'launchFailed'].map((w) => `room.notice.task.inputRequired.why.${w}`)),
  // Pull requests and verdicts (roomWriter.ts).
  'pr.merged': { args: { pr: 'number', title: 'string' }, titles: [k('pr.merged'), k('pr.merged.untitled')] },
  'pr.closed': { args: { pr: 'number', title: 'string' }, titles: [k('pr.closed'), k('pr.closed.untitled')] },
  'verdict.recorded': titled('verdict.recorded', { verdict: 'string', pr: 'number', sha: 'string', bot: 'string' }, ['room.notice.verdict.pass', 'room.notice.verdict.fail']),
  // Hops between bots (roomWriter.ts) and a coordinator's thread pointer (handoffRouter.ts).
  'handoff.sent': {
    args: { hop: 'string', to: 'string', title: 'string', relay: 'number' },
    titles: ['dispatch', 'result', 'message', 'refusal', 'answer'].map((h) => `room.notice.handoff.${h}`),
    more: ['room.notice.handoff.forwarded'],
  },
  'thread.finished': titled('thread.finished', { title: 'string' }),
  'thread.stopped': titled('thread.stopped', { title: 'string' }),
  // The owner archived one of a bot's skills (skill.rpc.ts).
  'skill.archived': bodied('skill.archived', { skill: 'string' }),
  // The owner deleted a key a bot asked for or last used (botSecret.rpc.ts).
  'secret.deleted': bodied('secret.deleted', { name: 'string' }),
};
