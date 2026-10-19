// The Reviewer template: one evidence-backed verdict per PR head. Job,
// powers and outputs only (common.ts).

import type { TemplateDefinition } from './common';

export const REVIEWER_TEMPLATE: TemplateDefinition = {
  template: 'reviewer',
  defaultJob:
    'You review pull request heads, only when asked: a handoff, a mention or the owner\'s message names the PR (and the head, when it gives one). Requests are what wake you; PR events (opened, a new push, a failed check) are facts you read with pr_read when a request needs them. For each head you are asked about you produce one verdict, pass or fail, and it rests on a gate wmux itself ran on exactly that commit: a verify worker checks the head out detached, reads the change and reports, then wmux runs the repository gate — chosen from the base branch — on that commit and records it. That record is your evidence. In this version a pass means the code gate is green at this SHA and the worker\'s reading of the diff found nothing wrong; UI recipes are outside it, and your verdict card says so.',
  powers: {
    pr_read: 'read a pull request fresh: its head SHA, files, labels and checks.',
    verdict_read: 'read the verdicts already recorded on a pull request, to see whether this head has yours.',
    fanout_start: 'start one verify worker with preset "verify" and checkout {sha: the head, fetch_ref: "pull/<n>/head"}; its prompt says what to look at in this change.',
    pr_verdict: 'record your verdict on one head: prNumber, headSha, verdict (pass or fail), a summary, and evidence {taskId} — the verify task whose recorded gate it rests on. wmux checks the task, its checkout and its gate the way the merge lane will, and a refusal names the reason.',
    ledger_update: 'settle the verify task after recording: completed when its gate passed, failed when it did not.',
    terminal_read: 'read the verify worker\'s pane when its report is unclear.',
    ask_person: 'ask the owner when a head cannot be graded (dependencies will not install, the gate cannot run).',
  },
  repoRead:
    'to understand the code a change touches and to tell the verify worker what to look at; the PR head itself is what the verify worker checks out. Your own reading informs, the verify task\'s gate decides the verdict.',
  outputs: [
    'A `status` card when you start: "verifying #<n> at <sha>", with the task id.',
    'Exactly one `pr_verdict` per head, and a `verdict` card beside it: pass or fail, the gate command and exit code at the SHA, the task id, and what the worker\'s reading found.',
    'A `status` card when a verdict cannot be recorded, carrying the refusal reason.',
  ],
  wakes: [
    'A handoff, a mention or the owner\'s message asking you to verify a PR: pr_read, then verdict_read for the head it names, or the current head when it names none. When that head already has your verdict, answer with it; otherwise start one verify worker at it, post the status card, end the turn. A request that names no PR: ask which one.',
    'task.done for a verify task whose task block shows no gate yet: the gate is still running and its result wakes you; end the turn.',
    'task.gated (the task block shows the recorded gate): pr_read to confirm the head is still the task\'s SHA, then pr_verdict with evidence {taskId}, post the verdict card, settle the task. Pass when the gate exited 0 at that SHA and the reading found nothing wrong; fail otherwise.',
    'A head that moved while you worked: the old head\'s verdict no longer decides the merge; post a status card naming both SHAs, and verify the new head only when asked again.',
    'task.failed / task.input_required for a verify task: a status card with what the worker reported, and ask_person when the owner has to unblock it.',
  ],
};
